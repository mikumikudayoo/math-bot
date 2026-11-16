import type { ServiceConfig } from './config.js';
import { fastRoute } from './fast-router.js';
import type { RouteDecision } from './router.js';
import { UserError } from './types.js';
import { openAIRuntime, openaiContext, ProviderError } from './openai.js';
import { randomUUID } from 'node:crypto';
export class ProviderBackoff extends UserError { constructor(readonly retryAt:number,readonly reason='provider-backoff'){super('stronger inference is temporarily queued; no weaker answer was substituted.');} }
export class ProviderPayloadTooLarge extends UserError {constructor(){super('The inference request is too large (HTTP 413). Shorten or split the source before retrying.');}}
export const providerHealth=new Map<string,{state:'healthy'|'rate-limited'|'unavailable'|'misconfigured';retryAt:number;requestsRemaining:string|null;tokensRemaining:string|null}>();

export interface ProviderConfig {
  backend: string;
  model: string;
  backendKey: string;
  vision: boolean;
  nativeTools: boolean;
  /** 'openai' dispatches to the official Responses API runtime; absent means OpenAI-compatible chat completions. */
  kind?: 'openai';
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

/** Surface transient failures to the durable queue; never downgrade difficult work to Phi. */
export async function completeProvider(provider: ProviderConfig, body: Record<string, unknown>, signal: AbortSignal,
  complete: (url: string, init: RequestInit) => Promise<Response>): Promise<unknown> {
  if (provider.kind === 'openai') return completeOpenAI(provider, body, signal);
  const healthKey=provider.backend+':'+provider.model;
  const health=providerHealth.get(healthKey);
  if(health && health.retryAt>Date.now())throw new ProviderBackoff(health.retryAt);
  if(new URL(provider.backend).hostname==='api.groq.com' && !provider.backendKey){providerHealth.set(healthKey,{state:'misconfigured',retryAt:0,requestsRemaining:null,tokensRemaining:null});throw new UserError('Groq is not configured. Ask staff to add the secret privately.');}
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
      if (signal.aborted && signal.reason?.name!=='TimeoutError') throw error;
      const retryAt=Date.now()+30000;providerHealth.set(healthKey,{state:'unavailable',retryAt,requestsRemaining:null,tokensRemaining:null});
      throw new ProviderBackoff(retryAt,signal.aborted?'request-timeout':'transport-failure');
    }
    if (!response.ok) {
      await response.body?.cancel();
      if(response.status===413){providerHealth.set(healthKey,{state:'healthy',retryAt:0,requestsRemaining:null,tokensRemaining:null});throw new ProviderPayloadTooLarge();}
      if(response.status===429 || response.status>=500){
        const raw=response.headers.get('retry-after');const seconds=raw===null?NaN:Number(raw);
        const delay=Number.isFinite(seconds)?Math.max(1000,seconds*1000):raw?Math.max(1000,Date.parse(raw)-Date.now()):30000;
        const retryAt=Date.now()+(Number.isFinite(delay)?Math.min(delay,86400000):30000);
        providerHealth.set(healthKey,{state:response.status===429?'rate-limited':'unavailable',retryAt,requestsRemaining:response.headers.get('x-ratelimit-remaining-requests'),tokensRemaining:response.headers.get('x-ratelimit-remaining-tokens')});throw new ProviderBackoff(retryAt,`http-${response.status}`);
      }
      providerHealth.set(healthKey,{state:'misconfigured',retryAt:0,requestsRemaining:null,tokensRemaining:null});
      throw new UserError(`Inference backend returned HTTP ${response.status}. Ask a moderator to check its configuration.`);
    }
    providerHealth.set(healthKey,{state:'healthy',retryAt:0,requestsRemaining:response.headers.get('x-ratelimit-remaining-requests'),tokensRemaining:response.headers.get('x-ratelimit-remaining-tokens')});
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
    catch {
      console.warn('inference_response_failure', {failure:'invalid_json',httpStatus:response.status,attempt:attempt+1});
      throw new UserError('the model returned an unreadable response. try again.');
    }
  }
  throw new UserError('the model is unavailable right now.');
}

/**
 * Single chokepoint for OpenAI: every existing completeProvider call site (chat loop,
 * clarification, synthesis, image analysis, announcement extraction/writing) reaches the
 * budgeted Responses runtime with chat-shaped input and gets a chat-shaped body back.
 * Transient failures become ProviderBackoff for the existing durable queues; no call
 * ever switches to another provider here.
 */
async function completeOpenAI(provider: ProviderConfig, body: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  const runtime = openAIRuntime();
  if (!runtime) throw new UserError('the model is unavailable right now. try again later.');
  const healthKey = provider.backend + ':' + provider.model;
  const ctx = openaiContext.getStore();
  const requested = typeof body.max_tokens === 'number' && Number.isSafeInteger(body.max_tokens) ? body.max_tokens : 0;
  try {
    const result = await runtime.complete({
      messages: body.messages as never, ...(Array.isArray(body.tools) ? {tools: body.tools as never} : {}),
      role: 'luna', effort: ctx?.effort ?? runtime.config.lunaEffort,
      // Reasoning tokens count against the cap, so small legacy max_tokens values are raised to Luna's cap.
      maxOutputTokens: Math.max(runtime.config.maxOutputTokens.luna, requested),
      purpose: ctx?.purpose ?? 'system',
      job: ctx?.job ?? {id: `system:${randomUUID()}`, user: 'system'},
      ...(body.response_format ? {responseFormat: body.response_format} : {}),
    }, signal);
    providerHealth.set(healthKey, {state: 'healthy', retryAt: 0, requestsRemaining: null, tokensRemaining: null});
    return result;
  } catch (error) {
    if (error instanceof ProviderError && error.retryable && !signal.aborted) {
      const retryAt = Date.now() + 30_000;
      providerHealth.set(healthKey, {state: error.kind === 'rate_limit' ? 'rate-limited' : 'unavailable', retryAt, requestsRemaining: null, tokensRemaining: null});
      throw new ProviderBackoff(retryAt, `openai-${error.kind}`);
    }
    if (error instanceof ProviderError && ['auth', 'permission', 'model_not_found', 'unsupported_parameter'].includes(error.kind))
      providerHealth.set(healthKey, {state: 'misconfigured', retryAt: 0, requestsRemaining: null, tokensRemaining: null});
    throw error;
  }
}
