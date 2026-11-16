import OpenAI from 'openai';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { DatabaseSync } from 'node:sqlite';
import type { ModelRole, OpenAIConfig, ReasoningEffort } from './openai-config.js';
import { UsageLedger, Semaphore, estimateInputTokens, BudgetError, type Usage } from './openai-budget.js';
import { UserError } from './types.js';

/**
 * Official OpenAI Responses API adapter (Aleph-Zero v2). It accepts the service's
 * chat-style message/tool arrays and returns a chat-completions-shaped body, so the
 * existing parser and host-side tool broker stay authoritative. The model can only
 * *request* tools; nothing here executes them. Every call is budget-reserved first.
 */

export type ErrorKind = 'auth' | 'permission' | 'model_not_found' | 'quota' | 'rate_limit' | 'unsupported_parameter' | 'bad_request'
  | 'transient' | 'timeout' | 'cancelled' | 'malformed' | 'unknown';
const messages: Record<ErrorKind, string> = {
  auth: "the model provider rejected my credentials. emu or a moderator needs to check the configuration.",
  permission: "i'm not allowed to use that model right now. emu or a moderator needs to check the configuration.",
  model_not_found: "the configured model isn't available. emu or a moderator needs to check the configuration.",
  quota: 'my ai credits are used up for now.',
  rate_limit: 'the model is busy right now. try again in a bit.',
  unsupported_parameter: 'the model rejected the request settings. emu or a moderator needs to check the configuration.',
  bad_request: "the model couldn't process that request.",
  transient: 'the model is unavailable right now. try again later.',
  timeout: 'the model took too long to answer. try again or ask something smaller.',
  cancelled: 'Request cancelled.',
  malformed: 'the model returned an unreadable response. try again.',
  unknown: 'the model is unavailable right now. try again later.',
};

export class ProviderError extends UserError {
  constructor(readonly kind: ErrorKind, readonly status?: number, readonly code?: string, readonly param?: string) { super(messages[kind]); }
  get retryable() { return this.kind === 'transient' || this.kind === 'timeout' || this.kind === 'rate_limit'; }
}

/** Classifies SDK (or SDK-shaped) errors without retaining their messages, which may echo request data. */
export function classifyOpenAIError(error: unknown, signal?: AbortSignal): ProviderError {
  if (error instanceof ProviderError) return error;
  const e = (error ?? {}) as {status?: unknown; code?: unknown; param?: unknown; name?: unknown; error?: {code?: unknown; param?: unknown}};
  const name = typeof e.name === 'string' ? e.name : (error as object)?.constructor?.name ?? '';
  const status = typeof e.status === 'number' ? e.status : undefined;
  const code = typeof e.code === 'string' ? e.code : typeof e.error?.code === 'string' ? e.error.code : undefined;
  const param = typeof e.param === 'string' ? e.param : typeof e.error?.param === 'string' ? e.error.param : undefined;
  if (signal?.aborted || error instanceof OpenAI.APIUserAbortError || name === 'AbortError' || name === 'APIUserAbortError') return new ProviderError('cancelled');
  if (error instanceof OpenAI.APIConnectionTimeoutError || name === 'APIConnectionTimeoutError' || name === 'TimeoutError') return new ProviderError('timeout');
  if (status === undefined) {
    if (error instanceof OpenAI.APIConnectionError || name === 'APIConnectionError' || error instanceof TypeError) return new ProviderError('transient');
    return new ProviderError('unknown');
  }
  if (status === 401) return new ProviderError('auth', status, code);
  if (status === 403) return new ProviderError('permission', status, code);
  if (status === 404) return new ProviderError('model_not_found', status, code);
  if (status === 429) return new ProviderError(code === 'insufficient_quota' || code === 'billing_hard_limit_reached' ? 'quota' : 'rate_limit', status, code);
  if (status === 400 || status === 422) {
    const unsupported = code === 'unsupported_parameter' || code === 'unsupported_value' || (param ?? '').startsWith('reasoning');
    return new ProviderError(unsupported ? 'unsupported_parameter' : 'bad_request', status, code, param);
  }
  if (status === 408 || status === 409 || status >= 500) return new ProviderError('transient', status, code);
  return new ProviderError('unknown', status, code);
}

// ---- request conversion -------------------------------------------------

export interface ChatMessage {role: string; content: unknown; tool_calls?: {id: string; function: {name: string; arguments: string}}[]; tool_call_id?: string; provider_items?: unknown[]}
export interface ChatTool {type: string; function: {name: string; description?: string; parameters?: unknown}}

function userContent(content: unknown): unknown {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? '');
  return content.map((part: {type?: string; text?: string; image_url?: {url?: string}}) => {
    if (part?.type === 'text') return {type: 'input_text', text: String(part.text ?? '')};
    if (part?.type === 'image_url' && typeof part.image_url?.url === 'string') return {type: 'input_image', image_url: part.image_url.url, detail: 'auto'};
    throw new UserError('Unsupported message content.');
  });
}

/** Converts the service's chat-style transcript to Responses API input items. */
export function toResponsesInput(chat: ChatMessage[]): unknown[] {
  const input: unknown[] = [];
  for (const m of chat) {
    if (m.role === 'system') input.push({role: 'developer', content: String(m.content ?? '')});
    else if (m.role === 'user') input.push({role: 'user', content: userContent(m.content)});
    else if (m.role === 'tool') input.push({type: 'function_call_output', call_id: String(m.tool_call_id), output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)});
    else if (m.role === 'assistant') {
      if (Array.isArray(m.provider_items) && m.provider_items.length) { input.push(...m.provider_items); continue; }
      if (typeof m.content === 'string' && m.content) input.push({role: 'assistant', content: m.content});
      for (const call of m.tool_calls ?? []) input.push({type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments});
    }
  }
  return input;
}

export function toResponsesTools(tools: ChatTool[] | undefined) {
  return (tools ?? []).map(t => ({type: 'function', name: t.function.name, description: t.function.description ?? '', parameters: t.function.parameters ?? {type: 'object', properties: {}}, strict: false}));
}

/** Chat-completions response_format -> Responses text.format (json_schema / json_object). */
export function toTextFormat(format: unknown): Record<string, unknown> | undefined {
  const f = format as {type?: string; json_schema?: {name?: string; schema?: unknown; strict?: boolean}} | undefined;
  if (!f || typeof f !== 'object') return undefined;
  if (f.type === 'json_schema' && f.json_schema?.schema) return {format: {type: 'json_schema', name: f.json_schema.name ?? 'output', schema: f.json_schema.schema, strict: f.json_schema.strict ?? true}};
  if (f.type === 'json_object') return {format: {type: 'json_object'}};
  return undefined;
}

// ---- response normalization ---------------------------------------------

export function extractUsage(raw: unknown): Usage | undefined {
  const u = (raw as {usage?: Record<string, unknown>})?.usage;
  if (!u || typeof u !== 'object') return undefined;
  const n = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
  const input = n(u.input_tokens), output = n(u.output_tokens);
  if (input === undefined || output === undefined) return undefined;
  return {inputTokens: input, outputTokens: output,
    cachedTokens: n((u.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens) ?? 0,
    reasoningTokens: n((u.output_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens) ?? 0};
}

/** Returns a chat-completions-shaped body for `parseModelResponse`. Reasoning items are kept opaque, never shown. */
export function normalizeResponse(raw: unknown): Record<string, unknown> {
  const r = (raw && typeof raw === 'object' ? raw : {}) as {status?: string; output?: unknown; incomplete_details?: {reason?: string} | null; error?: unknown};
  if (r.status === 'failed' || (r.error && r.status !== 'completed')) throw new ProviderError('transient');
  if (!Array.isArray(r.output)) throw new ProviderError('malformed');
  let text = '', refused = false;
  const calls: {id: string; type: 'function'; function: {name: string; arguments: string}}[] = [];
  const replay: unknown[] = [];
  for (const item of r.output as Record<string, unknown>[]) {
    if (!item || typeof item !== 'object') throw new ProviderError('malformed');
    if (item.type === 'reasoning') replay.push(item);
    else if (item.type === 'function_call') {
      if (typeof item.call_id !== 'string' || typeof item.name !== 'string' || typeof item.arguments !== 'string') throw new ProviderError('malformed');
      calls.push({id: item.call_id, type: 'function', function: {name: item.name, arguments: item.arguments}});
      replay.push({type: 'function_call', call_id: item.call_id, name: item.name, arguments: item.arguments});
    } else if (item.type === 'message') {
      for (const part of (Array.isArray(item.content) ? item.content : []) as Record<string, unknown>[]) {
        if (part?.type === 'output_text' && typeof part.text === 'string') text += part.text;
        else if (part?.type === 'refusal') refused = true;
      }
    }
  }
  const reason = r.incomplete_details?.reason;
  const finish = r.status === 'incomplete'
    ? (reason === 'content_filter' ? 'content_filter' : 'length')
    : refused && !text ? 'content_filter' : calls.length ? 'tool_calls' : 'stop';
  const usage = extractUsage(raw);
  return {
    choices: [{finish_reason: finish, message: {role: 'assistant', content: text || null,
      ...(calls.length ? {tool_calls: calls, provider_items: replay} : {})}}],
    ...(usage ? {usage: {prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, reasoning_tokens: usage.reasoningTokens, cached_tokens: usage.cachedTokens}} : {}),
  };
}

// ---- runtime ------------------------------------------------------------

/** `create` resolves to a response object, or (when params.stream is true) to an async iterable of stream events. */
export interface ResponsesClient {
  create(params: Record<string, unknown>, options: {signal: AbortSignal; timeout: number}): Promise<unknown>;
}
export function officialClient(config: OpenAIConfig): ResponsesClient {
  // SDK retries are disabled: retries are bounded and budgeted here instead.
  const client = new OpenAI({apiKey: config.apiKey, maxRetries: 0, timeout: config.timeoutMs});
  return {create: (params, options) => client.responses.create(params as never, options) as Promise<unknown>};
}

export interface OpenAIRequest {
  messages: ChatMessage[]; tools?: ChatTool[];
  role: ModelRole; effort: ReasoningEffort; maxOutputTokens?: number;
  /** Usage-ledger label: orchestrator | consult | seven | vision-guard | system ... */
  purpose: string;
  job: {id: string; user: string};
  /** Chat-completions `response_format`, mapped to Responses `text.format`. */
  responseFormat?: unknown;
  /** Enables real Responses streaming; called with each visible-text delta and the text so far. */
  onTextDelta?: (delta: string, soFar: string) => void;
  /** Called when streamed text must be discarded (a retry restarts the response). */
  onStreamReset?: () => void;
}

/** Per-job context for calls reaching OpenAI through the shared completeProvider chokepoint. */
export interface OpenAICallContext { job: {id: string; user: string}; effort?: ReasoningEffort; purpose?: string }
export const openaiContext = new AsyncLocalStorage<OpenAICallContext>();
let installedRuntime: OpenAIRuntime | undefined;
/** One runtime per process (AI service, announcement worker); they share the usage ledger database. */
export function installOpenAIRuntime(runtime: OpenAIRuntime | undefined) { installedRuntime = runtime; }
export function openAIRuntime() { return installedRuntime; }

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  signal.throwIfAborted();
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  signal.addEventListener('abort', abort, {once: true});
});
const isStream = (value: unknown): value is AsyncIterable<Record<string, unknown>> =>
  Boolean(value) && typeof (value as {[Symbol.asyncIterator]?: unknown})[Symbol.asyncIterator] === 'function';

export class OpenAIRuntime {
  readonly ledger: UsageLedger;
  readonly semaphore: Semaphore;
  constructor(readonly config: OpenAIConfig, db: DatabaseSync, readonly client: ResponsesClient = officialClient(config),
    readonly options: {backoffMs?: (attempt: number) => number; now?: () => number} = {}) {
    this.ledger = new UsageLedger(db, config, options.now);
    this.semaphore = new Semaphore(config.concurrency);
  }

  private backoff(attempt: number) {
    return this.options.backoffMs?.(attempt) ?? Math.min(8000, 750 * 2 ** attempt) * (0.5 + Math.random() * 0.5);
  }

  /** Consumes a Responses stream; returns the final response object. */
  private async consume(stream: AsyncIterable<Record<string, unknown>>, request: OpenAIRequest): Promise<unknown> {
    let text = '', final: unknown;
    for await (const event of stream) {
      const type = event?.type;
      if (type === 'response.output_text.delta' && typeof event.delta === 'string') { text += event.delta; request.onTextDelta?.(event.delta, text); }
      else if (type === 'response.completed' || type === 'response.incomplete') final = event.response;
      else if (type === 'response.failed') throw new ProviderError('transient');
      else if (type === 'error') throw Object.assign(new Error('stream error'), {status: typeof event.status === 'number' ? event.status : undefined, code: event.code});
    }
    if (!final) throw new ProviderError('transient');
    return final;
  }

  /**
   * One model turn. Retries only transient failures, with bounded backoff, before any tool
   * runs (tools execute later in the host loop), so retries cannot duplicate tool side
   * effects. Every attempt is reserved against the request, daily and total budgets.
   */
  async complete(request: OpenAIRequest, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (!this.config.allowed[request.role]) throw new UserError('that model is not enabled on this server.');
    const model = this.config.models[request.role];
    const maxOutputTokens = Math.min(128_000, request.maxOutputTokens ?? this.config.maxOutputTokens[request.role]);
    const input = toResponsesInput(request.messages);
    const tools = toResponsesTools(request.tools);
    const inputJson = JSON.stringify(input);
    const serialized = inputJson.length + JSON.stringify(tools).length;
    const images = inputJson.split('"input_image"').length - 1;
    const imageChars = (inputJson.match(/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+/g) ?? []).reduce((n, s) => n + s.length, 0);
    if (serialized - imageChars > this.config.maxInputChars) throw new UserError('that conversation is too long for me to send. start a new question.');
    const inputTokens = estimateInputTokens(serialized - imageChars, images);
    const streaming = Boolean(request.onTextDelta) && this.config.streaming;

    const params: Record<string, unknown> = {
      model, input,
      ...(tools.length ? {tools, tool_choice: 'auto', parallel_tool_calls: true} : {}),
      max_output_tokens: maxOutputTokens,
      reasoning: {effort: request.effort},
      // Stateless: nothing is retained server-side; reasoning is carried between tool
      // rounds as encrypted items instead.
      store: false,
      include: ['reasoning.encrypted_content'],
      // A one-way hash lets OpenAI attribute abuse without receiving the Discord ID.
      safety_identifier: createHash('sha256').update(`aleph-zero:${request.job.user}`).digest('hex').slice(0, 32),
      prompt_cache_key: 'aleph-zero-v2',
      ...(toTextFormat(request.responseFormat) ? {text: toTextFormat(request.responseFormat)} : {}),
      ...(streaming ? {stream: true} : {}),
    };

    await this.semaphore.acquire(signal);
    try {
      let droppedEffort = false;
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        const reservation = this.ledger.reserve({job: request.job.id, user: request.job.user, model, effort: request.effort,
          tier: request.purpose, inputTokens, maxOutputTokens});
        const started = Date.now();
        let raw: unknown;
        try {
          raw = await this.client.create(params, {signal, timeout: this.config.timeoutMs});
          if (isStream(raw)) raw = await this.consume(raw, request);
        } catch (error) {
          const failure = classifyOpenAIError(error, signal);
          // HTTP error responses are not billed; timeouts, aborts and broken streams might be, so they keep the worst case.
          this.ledger.settle(reservation.id, {status: 'error', latencyMs: Date.now() - started, error: failure.kind,
            billed: failure.status !== undefined && failure.status !== 408 ? false : undefined});
          console.warn('openai_request_failure', {kind: failure.kind, status: failure.status, code: failure.code, param: failure.param,
            model, effort: request.effort, purpose: request.purpose, attempt: attempt + 1});
          if (failure.kind === 'cancelled') throw signal.aborted ? signal.reason ?? error : failure;
          request.onStreamReset?.();
          // Never assume every model accepts every parameter: retry once with the model's default effort.
          if (failure.kind === 'unsupported_parameter' && !droppedEffort && params.reasoning) {
            droppedEffort = true; delete params.reasoning; attempt--; continue;
          }
          if (failure.retryable && attempt < this.config.maxRetries) { await sleep(this.backoff(attempt), signal); continue; }
          throw failure;
        }
        const usage = extractUsage(raw);
        this.ledger.settle(reservation.id, {usage, status: usage ? 'ok' : 'unmetered', latencyMs: Date.now() - started});
        return normalizeResponse(raw);
      }
    } finally {
      this.semaphore.release();
    }
  }
}

export { BudgetError };

/** Discord does not render LaTeX: convert common delimiters to code formatting. Dollar signs are left alone. */
export function formatForDiscord(answer: string) {
  return answer
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, m: string) => `\n\`\`\`\n${m.trim()}\n\`\`\`\n`)
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, m: string) => `\n\`\`\`\n${m.trim()}\n\`\`\`\n`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, m: string) => `\`${m.trim()}\``)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
