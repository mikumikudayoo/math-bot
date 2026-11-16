/**
 * Opt-in, explicitly bounded live check of the OpenAI integration.
 *   bun src/scripts/openai-smoke.ts --confirm            # models.retrieve (free) + one tiny Luna call
 *   bun src/scripts/openai-smoke.ts --confirm --sol      # also one tiny Sol call (low effort, ≤512 output tokens)
 * Worst-case cost is printed before any paid call. The key is read from the process
 * environment or .env.ai.<BOT_ENV> and is never printed.
 */
import OpenAI from 'openai';
import { config as dotenv } from 'dotenv';
import { DEFAULT_MODELS, validApiKey } from '../service/openai-config.js';
import { costMicros } from '../service/openai-budget.js';
import { classifyOpenAIError, extractUsage, normalizeResponse } from '../service/openai.js';

const args = new Set(process.argv.slice(2));
if (!args.has('--confirm')) {
  console.log('Refusing to call the paid API without --confirm. See docs/openai.md.');
  process.exit(2);
}
const mode = process.env.BOT_ENV ?? 'development';
const env: Record<string, string> = {};
dotenv({path: `.env.ai.${mode}`, processEnv: env, quiet: true});
const key = (process.env.OPENAI_API_KEY || env.OPENAI_API_KEY || '').trim();
if (!key) { console.log('OPENAI_API_KEY is not set in the environment or .env.ai.' + mode + '.'); process.exit(2); }
if (!validApiKey(key)) { console.log('OPENAI_API_KEY is malformed.'); process.exit(2); }

const light = env.OPENAI_LIGHT_MODEL || 'gpt-6-luna';
const advanced = env.OPENAI_ADVANCED_MODEL || 'gpt-6.1-sol';
const client = new OpenAI({apiKey: key, maxRetries: 0, timeout: 60_000});

let failed = false;
for (const model of [light, advanced]) {
  try { await client.models.retrieve(model); console.log(`models.retrieve ${model}: available`); }
  catch (error) { failed = true; const e = classifyOpenAIError(error); console.log(`models.retrieve ${model}: ${e.kind}${e.status ? ` (HTTP ${e.status})` : ''}`); }
}

const calls: {model: string; effort: 'none' | 'low'; max: number}[] = [{model: light, effort: DEFAULT_MODELS[light]?.efforts.includes('none') ? 'none' : 'low', max: 64}];
if (args.has('--sol')) calls.push({model: advanced, effort: 'low', max: 512});
for (const call of calls) {
  const spec = DEFAULT_MODELS[call.model];
  if (!spec) { console.log(`${call.model}: no pricing entry; skipping paid call.`); failed = true; continue; }
  const worst = costMicros(spec, {inputTokens: 200, cachedTokens: 0, outputTokens: call.max, reasoningTokens: 0}) / 1e6;
  console.log(`${call.model} effort=${call.effort} max_output_tokens=${call.max} worst-case ≈ $${worst.toFixed(6)}`);
  const started = Date.now();
  try {
    const raw = await client.responses.create({model: call.model, input: 'Reply with only the number: 17*23', reasoning: {effort: call.effort},
      max_output_tokens: call.max, store: false} as never);
    const body = normalizeResponse(raw) as {choices: {message: {content: string | null}; finish_reason: string}[]};
    const usage = extractUsage(raw);
    const text = body.choices[0]!.message.content ?? '';
    console.log(`  ${Date.now() - started} ms · finish=${body.choices[0]!.finish_reason} · answer=${JSON.stringify(text.slice(0, 40))} · correct=${/\b391\b/.test(text)}`);
    if (usage) console.log(`  usage in=${usage.inputTokens} cached=${usage.cachedTokens} out=${usage.outputTokens} reasoning=${usage.reasoningTokens} · est $${(costMicros(spec, usage) / 1e6).toFixed(6)}`);
    else console.log('  usage missing from response');
  } catch (error) {
    failed = true; const e = classifyOpenAIError(error);
    console.log(`  failed: ${e.kind}${e.status ? ` (HTTP ${e.status})` : ''}${e.code ? ` code=${e.code}` : ''}`);
  }
}
process.exitCode = failed ? 1 : 0;
