import { config } from 'dotenv';
export function serviceConfig() {
  const mode = process.env.BOT_ENV ?? 'development';
  if (!['development','production'].includes(mode)) throw new Error('Invalid BOT_ENV.');
  const env: NodeJS.ProcessEnv = {};
  config({path:`.env.ai.${mode}`,processEnv:env,quiet:true});
  const integer = (key:string, fallback:number, min:number, max:number) => {
    const n = Number(env[key] ?? fallback);
    if (!Number.isInteger(n) || n<min || n>max) throw new Error(`Invalid ${key}.`);
    return n;
  };
  const secret = env.AI_SERVICE_TOKEN ?? '';
  if (secret.length < 32) throw new Error(`Run bun run setup:local or set AI_SERVICE_TOKEN in .env.ai.${mode}.`);
  const backend = env.INFERENCE_BASE_URL?.replace(/\/$/,'') ?? '';
  if (backend) {
    const url = new URL(backend);
    if (url.username || url.password || !['http:','https:'].includes(url.protocol)) throw new Error('Invalid inference URL.');
    if (url.protocol === 'http:' && !['127.0.0.1','localhost','[::1]'].includes(url.hostname)) throw new Error('Remote inference must use HTTPS.');
  }
  return { mode, secret, port:integer('AI_PORT',8787,1024,65535), database:env.AI_DATABASE ?? `data/${mode}.sqlite`,
    concurrency:integer('AI_CONCURRENCY',1,1,16),reserved:integer('COACH_RESERVED_SLOTS',0,0,15),borrow:env.COACH_BORROW_RESERVED === 'true',
    timeoutMs:integer('AI_TIMEOUT_SECONDS',600,10,3600)*1000,maxQueue:integer('AI_MAX_QUEUE',50,1,500),
    backend,model:env.INFERENCE_MODEL ?? '',backendKey:env.INFERENCE_API_KEY ?? '',vision:env.INFERENCE_VISION === 'true',
    nativeTools:env.INFERENCE_NATIVE_TOOLS === 'true',
    python:env.PYTHON_EXECUTABLE ?? '.venv/bin/python',searchKey:env.TAVILY_API_KEY ?? '',
    sandbox:env.PYTHON_SANDBOX_ENABLED === 'true',sandboxImage:env.PYTHON_SANDBOX_IMAGE ?? 'math-bot-python:local' };
}
export type ServiceConfig = ReturnType<typeof serviceConfig>;
