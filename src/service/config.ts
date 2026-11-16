import { config } from 'dotenv';
import { validateProvider, type ProviderConfig } from './providers.js';
import { parseOpenAIConfig, ConfigError } from './openai-config.js';

/** Legacy provider settings that OPENAI_EXCLUSIVE=true deactivates (names only are ever logged). */
export const LEGACY_PROVIDER_SETTINGS = ['INFERENCE_BASE_URL','INFERENCE_MODEL','INFERENCE_API_KEY','INFERENCE_VISION','INFERENCE_NATIVE_TOOLS',
  'EXTERNAL_INFERENCE_BASE_URL','EXTERNAL_INFERENCE_MODEL','EXTERNAL_INFERENCE_API_KEY','EXTERNAL_INFERENCE_VISION','EXTERNAL_INFERENCE_NATIVE_TOOLS','COGNITIVE_ROUTING'] as const;

export function serviceConfig() {
  const mode = process.env.BOT_ENV ?? 'development';
  if (!['development','production'].includes(mode)) throw new Error('Invalid BOT_ENV.');
  const env: NodeJS.ProcessEnv = {};
  config({path:`.env.ai.${mode}`,processEnv:env,quiet:true});
  return serviceConfigFrom(env, mode, process.env);
}

/** Pure configuration builder (testable without files). `inherited` may only supply OPENAI_API_KEY. */
export function serviceConfigFrom(env: NodeJS.ProcessEnv, mode: string, inherited: NodeJS.ProcessEnv = {}, warn: (event: string, data: unknown) => void = console.warn) {
  const integer = (key:string, fallback:number, min:number, max:number) => {
    const n = Number(env[key] ?? fallback);
    if (!Number.isInteger(n) || n<min || n>max) throw new Error(`Invalid ${key}.`);
    return n;
  };
  const secret = env.AI_SERVICE_TOKEN ?? '';
  if (secret.length < 32) throw new Error(`Run bun run setup:local or set AI_SERVICE_TOKEN in .env.ai.${mode}.`);
  let openai;
  try { openai = parseOpenAIConfig(env, {OPENAI_API_KEY: inherited.OPENAI_API_KEY}); }
  catch (error) { throw new Error(error instanceof ConfigError ? `${error.message} (in .env.ai.${mode})` : `Invalid OpenAI configuration in .env.ai.${mode}.`); }
  const exclusive = openai?.exclusive === true;
  if (exclusive) {
    // Retained for rollback, but structurally unreachable: no local/external provider exists in this config.
    const ignored = LEGACY_PROVIDER_SETTINGS.filter(key => env[key] !== undefined && env[key] !== '' && env[key] !== 'false');
    if (ignored.length) warn('openai_exclusive_ignoring_legacy_settings', ignored);
  }
  const backend = exclusive ? '' : env.INFERENCE_BASE_URL?.replace(/\/$/,'') ?? '';
  const external: ProviderConfig | undefined = !exclusive && (env.EXTERNAL_INFERENCE_BASE_URL || env.EXTERNAL_INFERENCE_MODEL)
    ? validateProvider({backend:env.EXTERNAL_INFERENCE_BASE_URL?.replace(/\/$/,'') ?? '',model:env.EXTERNAL_INFERENCE_MODEL ?? '',
      backendKey:env.EXTERNAL_INFERENCE_API_KEY ?? '',vision:env.EXTERNAL_INFERENCE_VISION==='true',nativeTools:env.EXTERNAL_INFERENCE_NATIVE_TOOLS==='true'},true)
    : undefined;
  if (openai?.fallback === 'external' && !external?.nativeTools) throw new Error('OPENAI_FALLBACK=external requires an external provider with EXTERNAL_INFERENCE_NATIVE_TOOLS=true.');
  if (backend) {
    const url = new URL(backend);
    if (url.username || url.password || !['http:','https:'].includes(url.protocol)) throw new Error('Invalid inference URL.');
    if (url.protocol === 'http:' && !['127.0.0.1','localhost','[::1]'].includes(url.hostname)) throw new Error('Remote inference must use HTTPS.');
  }
  return { ...(external?{external}:{}),...(openai?{openai}:{}),...(!exclusive&&env.COGNITIVE_ROUTING==='true'?{cognitiveRouting:true}:{}),mode, secret, port:integer('AI_PORT',8787,1024,65535), database:env.AI_DATABASE ?? `data/${mode}.sqlite`,
    concurrency:integer('AI_CONCURRENCY',1,1,16),reserved:integer('COACH_RESERVED_SLOTS',0,0,15),borrow:env.COACH_BORROW_RESERVED === 'true',
    timeoutMs:integer('AI_TIMEOUT_SECONDS',600,10,3600)*1000,maxQueue:integer('AI_MAX_QUEUE',50,1,500),
    backend,model:exclusive?'':env.INFERENCE_MODEL ?? '',backendKey:exclusive?'':env.INFERENCE_API_KEY ?? '',vision:!exclusive&&env.INFERENCE_VISION === 'true',
    nativeTools:!exclusive&&env.INFERENCE_NATIVE_TOOLS === 'true',
    python:env.PYTHON_EXECUTABLE ?? 'python3',searchKey:env.TAVILY_API_KEY ?? '',
    sandbox:env.PYTHON_SANDBOX_ENABLED === 'true',sandboxImage:env.PYTHON_SANDBOX_IMAGE ?? 'math-bot-python:local' };
}
export type ServiceConfig = ReturnType<typeof serviceConfigFrom>;
