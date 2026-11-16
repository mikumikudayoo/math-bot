import { config as dotenv } from 'dotenv';
import { DatabaseSync } from 'node:sqlite';
import { parseOpenAIConfig, type OpenAIConfig } from '../service/openai-config.js';
import { OpenAIRuntime, installOpenAIRuntime, openAIRuntime, openaiContext, type ResponsesClient } from '../service/openai.js';
import { completeProvider, type ProviderConfig } from '../service/providers.js';

export function announcementProvider(env: NodeJS.ProcessEnv): ProviderConfig {
  const kind = (env.AI_PROVIDER ?? 'legacy').trim();
  if (kind === 'openai') return {kind, backend: 'https://api.openai.com/v1', model: 'gpt-6-luna', backendKey: '', vision: false, nativeTools: false};
  if (kind !== 'legacy') throw new Error('Invalid announcement AI_PROVIDER.');
  return {backend: 'https://api.groq.com/openai/v1', model: env.EXTERNAL_INFERENCE_MODEL ?? 'openai/gpt-oss-120b', backendKey: env.GROQ_API_KEY ?? '', vision: false, nativeTools: false};
}

export function announcementAISettings(mode: string) {
  if (mode !== 'development' && mode !== 'production') throw new Error('Invalid BOT_ENV.');
  const env: NodeJS.ProcessEnv = {};
  const read = dotenv({path: `.env.ai.${mode}`, processEnv: env, quiet: true});
  if (read.error) throw new Error('Cannot read the shared AI service configuration.');
  const config = parseOpenAIConfig({...env, AI_PROVIDER: 'openai'}, {OPENAI_API_KEY: process.env.OPENAI_API_KEY})!;
  return {config, database: env.AI_DATABASE ?? `data/${mode}.sqlite`};
}

/** Only the worker process opens this handle. Bot status and policy refresh never receive the API key. */
export function installAnnouncementAI(config: OpenAIConfig, database: string, client?: ResponsesClient) {
  const db = new DatabaseSync(database);
  try {
    const runtime = new OpenAIRuntime(config, db, client);
    installOpenAIRuntime(runtime);
    return () => {
      if (openAIRuntime() === runtime) installOpenAIRuntime(undefined);
      db.close();
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

export function completeAnnouncement(provider: ProviderConfig, purpose: 'extract' | 'draft', id: string,
  body: Record<string, unknown>, signal: AbortSignal, transport: typeof fetch) {
  const run = () => completeProvider(provider, body, signal, transport);
  if (provider.kind !== 'openai') return run();
  // Stable across queue retries and restarts. The ledger assigns these host-owned jobs the system class.
  return openaiContext.run({job: {id: `announcement:${purpose}:${id}`, user: 'system'}, purpose: `announcement-${purpose}`}, run);
}
