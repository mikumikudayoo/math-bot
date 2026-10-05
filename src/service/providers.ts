import type { ServiceConfig } from './config.js';
import { fastRoute } from './fast-router.js';
import type { RouteDecision } from './router.js';
import { UserError } from './types.js';

export interface ProviderConfig {
  backend: string;
  model: string;
  backendKey: string;
  vision: boolean;
  nativeTools: boolean;
}

export function validateProvider(provider: ProviderConfig, remote = false) {
  const url = new URL(provider.backend);
  if (!provider.model.trim() || url.username || url.password || url.search || url.hash ||
      !['http:', 'https:'].includes(url.protocol) ||
      (url.protocol === 'http:' && (remote || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('Invalid inference provider configuration.');
  }
  return provider;
}

/** Retrieval classification never grants permission to use the weaker model. */
export function selectProvider(config: ServiceConfig, prompt: string, route: Pick<RouteDecision, 'reasoning' | 'knowledge'>,
  options: { image: boolean; discord: boolean }): ProviderConfig {
  const local: ProviderConfig = config;
  if (!config.cognitiveRouting) return local;
  // Private Discord lookup stays within the existing service boundary.
  if (options.discord && !options.image) return local;
  const fast = fastRoute(prompt);
  const simple = fast.kind === 'final' && route.reasoning === 'fast' && route.knowledge === 'internal';
  if (simple && !options.image) return local;
  if (!config.external) throw new UserError('this needs the stronger model, but it is not configured right now.');
  if (options.image && !config.external.vision) throw new UserError('the stronger model does not have vision enabled.');
  return config.external;
}

/** Retry transient transport failures once; never downgrade difficult work to Phi. */
export async function completeProvider(provider: ProviderConfig, body: Record<string, unknown>, signal: AbortSignal,
  complete: (url: string, init: RequestInit) => Promise<Response>): Promise<unknown> {
  for (let attempt = 0; attempt < 2; attempt++) {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await complete(`${provider.backend.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST', signal, redirect: 'error',
        headers: { 'Content-Type': 'application/json', ...(provider.backendKey ? { Authorization: `Bearer ${provider.backendKey}` } : {}) },
        body: JSON.stringify({ ...body, model: provider.model }),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      if (attempt === 0) continue;
      throw new UserError('the model is unavailable right now. try again later.');
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (attempt === 0 && [502, 503, 504].includes(response.status)) continue;
      throw new UserError(`Inference backend returned HTTP ${response.status}. Ask a moderator to check its configuration.`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new UserError('Empty inference response.');
    let raw = '', bytes = 0;
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > 1_000_000) throw new UserError('Inference response exceeded the size limit.');
        raw += decoder.decode(value, { stream: true });
      }
      raw += decoder.decode();
    } finally { await reader.cancel(); }
    try { return JSON.parse(raw); }
    catch { throw new UserError('the model returned an unreadable response. try again.'); }
  }
  throw new UserError('the model is unavailable right now.');
}
