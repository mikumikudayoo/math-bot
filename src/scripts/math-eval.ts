import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {serviceConfigFrom} from '../service/config.js';
import {JobEvents} from '../service/events.js';
import {runner} from '../service/inference.js';
import {BudgetError} from '../service/openai-budget.js';
import {PRICING_SOURCE, validApiKey} from '../service/openai-config.js';
import {OpenAIRuntime, ProviderError, installOpenAIRuntime, type OpenAIRequest, type ResponsesClient} from '../service/openai.js';
import {Store} from '../service/store.js';
import {grade, type Check} from './math-eval-grade.js';

export const CATEGORIES = ['arithmetic-algebra', 'precalculus', 'geometry', 'combinatorics', 'number-theory', 'olympiad', 'proof', 'ambiguous-unsolvable'];
const profiles = {
  luna: [],
  'luna-terra': ['consult_terra'],
  'luna-sol': ['consult_sol'],
  tools: ['calculate', 'plot', 'regex'],
} as const;
type Profile = keyof typeof profiles;
const profileNames = Object.keys(profiles) as Profile[];

interface Problem {
  id: string; category: string; difficulty: string; prompt: string; expectedTier: string; check: Check;
}
const problemSource = () => readFileSync(resolve('evals/math/problems.json'), 'utf8');
export function loadProblems(): Problem[] { return JSON.parse(problemSource()) as Problem[]; }

interface Options {
  live: boolean; maxUsd: number; profiles: Profile[]; ids?: string[]; limit?: number;
}
export function parseCli(args: string[]): Options {
  const {values} = parseArgs({args, strict: true, options: {
    live: {type: 'boolean'}, 'max-usd': {type: 'string'}, profiles: {type: 'string'},
    ids: {type: 'string'}, limit: {type: 'string'},
  }});
  const maxUsd = Number(values['max-usd']);
  if ((values.live || values['max-usd'] !== undefined) && !(maxUsd >= 0.000001 && maxUsd <= 1))
    throw new Error('supply an explicit --max-usd between 0.000001 and 1.');
  const selected = values.profiles?.split(',') ?? profileNames;
  for (const name of selected) if (!Object.hasOwn(profiles, name)) throw new Error('unknown profile; choose ' + profileNames.join(', '));
  const limit = Number(values.limit);
  if (values.limit !== undefined && !(Number.isSafeInteger(limit) && limit > 0)) throw new Error('--limit must be a positive integer.');
  return {live: values.live ?? false, maxUsd: Number.isFinite(maxUsd) ? maxUsd : 0, profiles: [...new Set(selected)] as Profile[],
    ...(values.ids !== undefined ? {ids: [...new Set(values.ids.split(','))]} : {}), ...(values.limit !== undefined ? {limit} : {})};
}

export function selectProblems(options: Options, problems = loadProblems()) {
  const ids = options.ids;
  for (const id of ids ?? []) if (!problems.some(p => p.id === id)) throw new Error('unknown problem id: ' + id);
  return problems.filter(p => !ids || ids.includes(p.id)).slice(0, options.limit ?? problems.length);
}

// Observe provider/ledger rejections even when the production orchestrator returns a graceful partial answer.
class EvaluationRuntime extends OpenAIRuntime {
  stopReason = '';
  override async complete(request: OpenAIRequest, signal: AbortSignal) {
    if (this.stopReason) throw new Error(this.stopReason);
    try { return await super.complete(request, signal); }
    catch (error) {
      if (error instanceof BudgetError && (error.scope === 'daily' || error.scope === 'total'))
        this.stopReason = 'run budget exhausted';
      if (error instanceof ProviderError && ['auth', 'permission', 'quota', 'model_not_found', 'unsupported_parameter'].includes(error.kind))
        this.stopReason = 'provider: ' + error.kind;
      throw error;
    }
  }
}
interface MeteredCall {
  model: string; purpose: string; effort: string; status: string; input: number; cached: number;
  write30m: number; write12h: number; output: number; reasoning: number; micros: number; latencyMs: number;
}
function meteredCalls(store: Store, job: string) {
  return store.db.prepare(`SELECT model,tier AS purpose,effort,status,input_tokens AS input,cached_tokens AS cached,
    write_30m_tokens AS write30m,write_12h_tokens AS write12h,output_tokens AS output,
    reasoning_tokens AS reasoning,cost_micros AS micros,latency_ms AS latencyMs
    FROM openai_usage WHERE job=? ORDER BY id`).all(job) as unknown as MeteredCall[];
}
interface Sample {
  problem: string; category: string; profile: Profile; answer: string; passed: boolean; gradeDetail: string;
  error: string; latencyMs: number; costUsd: number; consultUsd: number; calls: MeteredCall[]; toolsCompleted: string[];
}
function summarize(samples: Sample[], selection: Profile[]) {
  return selection.map(profile => {
    const rows = samples.filter(row => row.profile === profile);
    const passed = rows.filter(row => row.passed).length;
    return {profile, attempted: rows.length, passed, errors: rows.filter(row => row.error).length,
      accuracy: rows.length ? passed / rows.length : null,
      meanLatencyMs: rows.length ? Math.round(rows.reduce((n, row) => n + row.latencyMs, 0) / rows.length) : null,
      costUsd: rows.reduce((n, row) => n + row.costUsd, 0), consultUsd: rows.reduce((n, row) => n + row.consultUsd, 0),
      actuallyConsulted: rows.filter(row => row.calls.some(call => call.purpose === 'consult' && call.status === 'ok')).length};
  });
}

export async function evaluate(options: Options, problems: Problem[], env: NodeJS.ProcessEnv, signal: AbortSignal, client?: ResponsesClient) {
  if (!options.live || !(options.maxUsd >= 0.000001 && options.maxUsd <= 1))
    throw new Error('live evaluation requires --live and a valid --max-usd.');
  if (!validApiKey(env.OPENAI_API_KEY ?? '')) throw new Error('live evaluation requires a valid OPENAI_API_KEY.');
  const store = new Store(':memory:');
  const events = new JobEvents(store.db);
  const samples: Sample[] = [];
  let stoppedReason = '';
  const started = new Date().toISOString();
  try {
    outer: for (const [i, problem] of problems.entries()) {
      for (const [j, profile] of options.profiles.entries()) {
        if (signal.aborted) { stoppedReason = 'cancelled'; break outer; }
        const config = serviceConfigFrom({
          AI_PROVIDER: 'openai', AI_SERVICE_TOKEN: 'synthetic-evaluation'.repeat(2), AI_DATABASE: ':memory:',
          OPENAI_API_KEY: env.OPENAI_API_KEY, OPENAI_ALLOWED_MODELS: profile === 'luna-terra' ? 'luna,terra' : profile === 'luna-sol' ? 'luna,sol' : 'luna',
          OPENAI_DAILY_BUDGET_USD: String(options.maxUsd), OPENAI_TOTAL_BUDGET_USD: String(options.maxUsd),
          AI_SEVEN_AGENT_CHANCE: '0', AI_STREAMING: 'false', OPENAI_CONCURRENCY: '1',
          ...(env.PYTHON_EXECUTABLE ? {PYTHON_EXECUTABLE: env.PYTHON_EXECUTABLE} : {}),
        }, 'development');
        // Every profile uses the same database for the entire run cap. Each independent job gets a fresh synthetic identity.
        const runtime = new EvaluationRuntime(config.openai!, store.db, client);
        const run = runner(config, store, {openai: runtime, toolAllowlist: profiles[profile], protectedProblems: () => [], events});
        const id = String(100000000000000000n + BigInt(i * options.profiles.length + j));
        const job = store.admit({id, user: id, guild: '200000000000000000', channel: '300000000000000000', coach: false, kind: 'ask', prompt: problem.prompt}, 1);
        store.running(id);
        let answer = '', error = '';
        const before = performance.now();
        try {
          const result = await run(job, AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]), s => store.status(id, s));
          answer = result.answer;
          store.complete(id, result);
        } catch (failure) {
          // SDK/transport errors can contain request data. Only persist a classifier.
          error = failure instanceof ProviderError ? failure.kind : failure instanceof BudgetError ? 'budget-' + failure.scope : 'inference-error';
          store.fail(id, error);
        }
        const latencyMs = Math.round(performance.now() - before);
        const calls = meteredCalls(store, id);
        stoppedReason = signal.aborted ? 'cancelled' : runtime.stopReason;
        if (stoppedReason) error = stoppedReason;
        const verdict = grade(problem.check, answer);
        const toolsCompleted = events.since(id, 0, 2048).filter(e => e.type === 'tool_completed' && e.data.ok !== false && e.data.label).map(e => e.data.label!);
        samples.push({problem: problem.id, category: problem.category, profile, answer, passed: !error && verdict.pass, toolsCompleted,
          gradeDetail: verdict.detail, error, latencyMs, calls, costUsd: runtime.ledger.jobSpentMicros(id) / 1e6,
          consultUsd: calls.filter(c => c.purpose === 'consult').reduce((total, call) => total + call.micros, 0) / 1e6});
        if (stoppedReason) break outer;
      }
    }
  } finally { installOpenAIRuntime(undefined); store.close(); }
  return {started, finished: new Date().toISOString(), maxUsd: options.maxUsd, pricingSource: PRICING_SOURCE,
    profiles: options.profiles, selectedProblems: problems.map(p => p.id), corpusSha256: createHash('sha256').update(problemSource()).digest('hex'),
    stoppedReason, summary: summarize(samples, options.profiles), samples};
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  const selected = selectProblems(options);
  if (!options.live) {
    console.log('dry run: no model calls made. ' + selected.length + ' problems × ' + options.profiles.length + ' profiles.');
    for (const profile of options.profiles) console.log(profile + ': ' + (profiles[profile].join(', ') || 'direct answer'));
    console.log('selected: ' + selected.map(p => p.id).join(', '));
    return;
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  try {
    const report = await evaluate(options, selected, process.env, controller.signal);
    const directory = resolve('evals/math/results');
    mkdirSync(directory, {recursive: true});
    const path = resolve(directory, report.started.replace(/[:.]/g, '-') + '.json');
    writeFileSync(path, JSON.stringify(report, null, 2) + '\n', {flag: 'wx', mode: 0o600});
    console.table(report.summary);
    console.log('saved: ' + path);
    if (report.stoppedReason) { console.error('stopped early: ' + report.stoppedReason); process.exitCode = 1; }
  } finally { process.off('SIGINT', stop); }
}
if (import.meta.main) main().catch(error => {
  console.error(error instanceof Error ? error.message : 'evaluation failed');
  process.exitCode = 1;
});
