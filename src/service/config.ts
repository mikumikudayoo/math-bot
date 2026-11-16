import { config } from 'dotenv';
import { validateProvider,type ProviderConfig } from './providers.js';
import { parseOpenAIConfig,ConfigError } from './openai-config.js';

/** Legacy provider settings that OPENAI_EXCLUSIVE=true deactivates (only names are ever logged). */
export const LEGACY_PROVIDER_SETTINGS=['INFERENCE_BASE_URL','INFERENCE_MODEL','INFERENCE_API_KEY','INFERENCE_VISION','INFERENCE_NATIVE_TOOLS',
  'EXTERNAL_INFERENCE_PROVIDER','EXTERNAL_INFERENCE_BASE_URL','EXTERNAL_INFERENCE_MODEL','GROQ_API_KEY','VISION_INFERENCE_MODEL','COGNITIVE_ROUTING'] as const;
export function serviceConfig() {
  const mode = process.env.BOT_ENV ?? 'development';
  if (!['development','production'].includes(mode)) throw new Error('Invalid BOT_ENV.');
  const env: NodeJS.ProcessEnv = {};
  config({path:`.env.ai.${mode}`,processEnv:env,quiet:true});
  return serviceConfigFrom(env,mode,process.env);
}

/** Pure configuration builder. `inherited` may only supply OPENAI_API_KEY. */
export function serviceConfigFrom(env:NodeJS.ProcessEnv,mode:string,inherited:NodeJS.ProcessEnv={},warn:(event:string,data:unknown)=>void=console.warn) {
  const integer = (key:string, fallback:number, min:number, max:number) => {
    const n = Number(env[key] ?? fallback);
    if (!Number.isInteger(n) || n<min || n>max) throw new Error(`Invalid ${key}.`);
    return n;
  };
  const secret = env.AI_SERVICE_TOKEN ?? '';
  if (secret.length < 32) throw new Error(`Run bun run setup:local or set AI_SERVICE_TOKEN in .env.ai.${mode}.`);
  let openai;
  try{openai=parseOpenAIConfig(env,{OPENAI_API_KEY:inherited.OPENAI_API_KEY});}
  catch(error){throw new Error(error instanceof ConfigError?`${error.message} (in .env.ai.${mode})`:`Invalid OpenAI configuration in .env.ai.${mode}.`);}
  // AI_PROVIDER=openai makes OpenAI the ONLY inference provider. Which OpenAI models may be
  // called is a separate setting (OPENAI_ALLOWED_MODELS). OPENAI_EXCLUSIVE is accepted for
  // compatibility but can no longer be turned off while the provider is openai.
  if(openai&&env.OPENAI_EXCLUSIVE==='false')throw new Error(`OPENAI_EXCLUSIVE=false is not supported: AI_PROVIDER=openai is always provider-exclusive (in .env.ai.${mode}).`);
  const exclusive=Boolean(openai);
  if(exclusive){
    const ignored=LEGACY_PROVIDER_SETTINGS.filter(key=>env[key]!==undefined&&env[key]!==''&&env[key]!=='false');
    if(ignored.length)warn('openai_exclusive_ignoring_legacy_settings',ignored);
  }
  const backend = exclusive?'https://api.openai.com/v1':env.INFERENCE_BASE_URL?.replace(/\/$/,'') ?? '';
  const external:ProviderConfig|undefined=!exclusive&&env.EXTERNAL_INFERENCE_PROVIDER==='groq'
    ? validateProvider({backend:env.EXTERNAL_INFERENCE_BASE_URL || 'https://api.groq.com/openai/v1',model:env.EXTERNAL_INFERENCE_MODEL || 'openai/gpt-oss-120b',backendKey:env.GROQ_API_KEY || '',vision:false,nativeTools:true},true)
    : undefined;
  if(!exclusive&&env.EXTERNAL_INFERENCE_PROVIDER && env.EXTERNAL_INFERENCE_PROVIDER!=='groq')throw new Error('Unsupported external provider. No paid fallback is configured.');
  if(external && new URL(external.backend).hostname!=='api.groq.com')throw new Error('Groq must use api.groq.com.');
  const visionModel=exclusive?undefined:env.VISION_INFERENCE_MODEL;
  if(visionModel&&visionModel!=='qwen/qwen3.8-27b')throw new Error('Unsupported vision model.');
  if(visionModel&&!external?.backendKey)throw new Error('Vision requires the existing Groq provider.');
  const visionProvider=visionModel&&external?{...external,model:visionModel,vision:true}:undefined;
  if (backend && !exclusive) {
    const url = new URL(backend);
    if (url.username || url.password || !['http:','https:'].includes(url.protocol)) throw new Error('Invalid inference URL.');
    if (url.protocol === 'http:' && !['127.0.0.1','localhost','[::1]'].includes(url.hostname)) throw new Error('Remote inference must use HTTPS.');
  }
  const sandboxRuntime=(env.PYTHON_SANDBOX_RUNTIME ?? 'docker') as 'docker'|'podman';
  if(!['docker','podman'].includes(sandboxRuntime))throw new Error('PYTHON_SANDBOX_RUNTIME must be docker or podman.');
  const resolved={ ...(visionProvider?{visionProvider:visionProvider as ProviderConfig}:{}),...(external?{external}:{}),...(openai?{openai}:{}),...(exclusive?{kind:'openai' as const}:{}),...(!exclusive&&env.COGNITIVE_ROUTING==='true'?{cognitiveRouting:true}:{}),mode, secret, port:integer('AI_PORT',8787,1024,65535), database:env.AI_DATABASE ?? `data/${mode}.sqlite`,
    concurrency:integer('AI_CONCURRENCY',1,1,16),reserved:integer('COACH_RESERVED_SLOTS',0,0,15),borrow:env.COACH_BORROW_RESERVED === 'true',
    timeoutMs:integer('AI_TIMEOUT_SECONDS',600,10,3600)*1000,maxQueue:integer('AI_MAX_QUEUE',50,1,500),
    backend,model:exclusive?openai!.models.luna:env.INFERENCE_MODEL ?? '',backendKey:exclusive?'':env.INFERENCE_API_KEY ?? '',vision:exclusive||env.INFERENCE_VISION === 'true',
    nativeTools:exclusive||env.INFERENCE_NATIVE_TOOLS === 'true',
    python:env.PYTHON_EXECUTABLE ?? 'python3',searchKey:env.TAVILY_API_KEY ?? '',
    sandbox:env.PYTHON_SANDBOX_ENABLED === 'true',sandboxRuntime,sandboxImage:env.PYTHON_SANDBOX_IMAGE ?? (sandboxRuntime==='podman'?'localhost/math-bot-python:local':'math-bot-python:local') };
  // Exclusive: the trusted "local" provider object IS Luna, including for images, so every
  // existing provider===config check (privacy boundary, no-downgrade fallback) keeps holding.
  if(exclusive)(resolved as {visionProvider?:ProviderConfig}).visionProvider=resolved;
  return resolved as typeof resolved & {visionProvider?:ProviderConfig};
}
type ResolvedServiceConfig = ReturnType<typeof serviceConfigFrom>;
export type ServiceConfig = Omit<ResolvedServiceConfig,'sandboxRuntime'> & {sandboxRuntime?:'docker'|'podman'};
