import { UserError } from './types.js';

export interface ToolCall {id: string; type: 'function'; function: {name: string; arguments: string}}
export interface ModelMessage {role: 'assistant'; content: string | null; tool_calls?: ToolCall[]}

export function parseModelResponse(value: unknown): ModelMessage {
  const message = (value as {choices?: {message?: unknown}[] } | null)?.choices?.[0]?.message;
  if (!message || typeof message !== 'object') throw new UserError('Inference backend returned no answer.');
  const m = message as Record<string, unknown>;
  if (m.content !== null && m.content !== undefined && typeof m.content !== 'string') throw new UserError('Invalid model answer format.');
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
  return {role:'assistant',content:typeof m.content === 'string' ? m.content : null,...(calls.length?{tool_calls:calls}:{})};
}

export function parseEnvelope(content: string): Record<string, unknown> | undefined {
  const clean = content.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try {
    const value = JSON.parse(clean);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    if (/^[{\[]|^```/.test(content.trim())) throw new UserError('the model returned an unreadable answer. try again.');
    return undefined;
  }
}

export function toolArguments(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UserError('Invalid tool arguments.');
  return value as Record<string, unknown>;
}
