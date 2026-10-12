import { UserError } from './types.js';

export interface ToolCall {id: string; type: 'function'; function: {name: string; arguments: string}}
export interface ModelMessage {role: 'assistant'; content: string | null; tool_calls?: ToolCall[]}

export interface ResponseContext {provider: 'local' | 'external'; reasoning: 'fast' | 'standard' | 'deep'; stage?: 'answer' | 'clarification' | 'web_synthesis' | 'vision_search'}
type Failure = 'malformed' | 'truncated' | 'reasoning_only' | 'empty_final' | 'filtered';
const failures: Record<Failure, string> = {
  malformed: 'the model returned an unreadable response. try again.',
  truncated: 'the model ran out of response space before finishing. try a smaller question.',
  reasoning_only: "the model didn't produce a final answer after reasoning. try again or split the question up.",
  empty_final: "the model didn't send a final answer. try again.",
  filtered: "the model couldn't return an answer to that request.",
};

function textContent(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) throw new UserError(failures.malformed);
  return value.map(part => {
    if (!part || typeof part !== 'object' || !['text', 'output_text'].includes(part.type) || typeof part.text !== 'string') {
      throw new UserError(failures.malformed);
    }
    return part.text;
  }).join('');
}

/** Never let llama.cpp-style private reasoning become the delivered answer. */
function finalText(content: string): string {
  const clean = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (/<\/?think\b/i.test(clean)) throw new UserError(failures.reasoning_only);
  return clean;
}

export function extractFinalAnswer(content: string, envelope: Record<string, unknown> | undefined, context?: ResponseContext): string {
  if (envelope && typeof envelope.answer !== 'string') {
    console.warn('inference_response_failure', {failure:'malformed_envelope', ...context});
    throw new UserError('the model returned an unreadable answer. try again.');
  }
  const raw = typeof envelope?.answer === 'string' ? envelope.answer : content;
  try {
    const answer = finalText(raw);
    if (!answer) throw new UserError(failures[/<think>/i.test(raw) ? 'reasoning_only' : 'empty_final']);
    return answer;
  } catch (error) {
    const failure = error instanceof UserError && error.message === failures.reasoning_only ? 'reasoning_only' : 'empty_final';
    console.warn('inference_response_failure', {failure, ...context});
    throw error;
  }
}

export function parseModelResponse(value: unknown, context?: ResponseContext): ModelMessage {
  const body = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const choice = Array.isArray(body.choices) ? body.choices[0] : undefined;
  const message = choice?.message;
  const m = message && typeof message === 'object' && !Array.isArray(message) ? message as Record<string, unknown> : {};
  const usage = body.usage && typeof body.usage === 'object' ? body.usage as Record<string, unknown> : {};
  const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const finish = ['stop', 'length', 'tool_calls', 'function_call', 'content_filter'].includes(choice?.finish_reason) ? choice.finish_reason as string : 'unknown';
  const hasReasoning = [m.reasoning_content, m.reasoning].some(v => typeof v === 'string' && Boolean(v.trim()));
  const hasThink = typeof m.content === 'string' && /<think>/i.test(m.content);
  const fail = (failure: Failure): never => { throw new UserError(failures[failure]); };
  try {
    if (!message || typeof message !== 'object' || Array.isArray(message) || (m.role !== undefined && m.role !== 'assistant')) fail('malformed');
    if (choice.finish_reason !== undefined && choice.finish_reason !== null && typeof choice.finish_reason !== 'string') fail('malformed');
    if (finish === 'length') fail('truncated');
    if (finish === 'content_filter') fail('filtered');
    const content = textContent(m.content);
    if (m.tool_calls !== undefined && (!Array.isArray(m.tool_calls) || m.tool_calls.length > 8)) throw new UserError('Invalid model tool calls.');
    const calls: ToolCall[] = [];
    for (const raw of (m.tool_calls ?? []) as unknown[]) {
      if (!raw || typeof raw !== 'object') throw new UserError('Invalid model tool call.');
      const call = raw as ToolCall;
      if (call.type !== 'function' || typeof call.id !== 'string' || !call.id || call.id.length > 200 ||
          calls.some(c => c.id === call.id) || !call.function || typeof call.function.name !== 'string' ||
          typeof call.function.arguments !== 'string' || call.function.arguments.length > 8000) throw new UserError('Invalid model tool call.');
      calls.push({id:call.id,type:'function',function:{name:call.function.name,arguments:call.function.arguments}});
    }
    if (finish === 'tool_calls' && !calls.length) fail('malformed');
    // JSON/tool arguments and grounded excerpts are data; sanitize only the eventual answer.
    const clean = content === null ? null : /^(?:[{\[]|```)/.test(content.trim()) ? content : finalText(content);
    if (!calls.length && !clean?.trim()) fail(hasReasoning || hasThink ? 'reasoning_only' : 'empty_final');
    return {role:'assistant',content:clean,...(calls.length?{tool_calls:calls}:{})};
  } catch (error) {
    // Only allowlisted classifications and numeric usage leave the provider boundary.
    const failure = (Object.keys(failures) as Failure[]).find(key => error instanceof UserError && error.message === failures[key]) ?? 'malformed';
    console.warn('inference_response_failure', {failure, ...context, finishReason:finish,
      contentType:Array.isArray(m.content)?'parts':m.content === null?'null':typeof m.content,
      hasText:typeof m.content === 'string' && Boolean(m.content.trim()), hasReasoning,
      hasToolCalls:Array.isArray(m.tool_calls) && m.tool_calls.length > 0,
      promptTokens:count(usage.prompt_tokens), completionTokens:count(usage.completion_tokens)});
    throw error;
  }
}

export function parseEnvelope(content: string, context?: ResponseContext): Record<string, unknown> | undefined {
  const clean = content.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try {
    const value = JSON.parse(clean);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    if (/^[{\[]|^```/.test(content.trim())) {
      console.warn('inference_response_failure', {failure:'malformed_envelope', ...context});
      throw new UserError('the model returned an unreadable answer. try again.');
    }
    return undefined;
  }
}

export function toolArguments(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UserError('Invalid tool arguments.');
  return value as Record<string, unknown>;
}
