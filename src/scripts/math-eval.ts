/**
 * Mathematics evaluation harness for the OpenAI provider (see evals/math/README.md).
 *
 * Default: DRY RUN. Computes the production routing decision and a worst-case cost
 * estimate for every problem. No network, no API key, no money.
 *
 * --live: calls the configured models through the production OpenAIRuntime with a
 * private in-memory ledger whose daily/total budgets equal --max-usd (hard cap <= $5).
 * It measures raw model answers to a single system+user turn: no tools, no Discord
 * context, no reply chains. It never touches the bot's database or production traffic.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { describeOpenAIConfig, parseOpenAIConfig, PRICING_SOURCE, type OpenAIConfig, type ReasoningEffort, type Tier } from '../service/openai-config.js';
import { buildRoute, chooseOpenAIRoute, type OpenAIRoute } from '../service/openai-routing.js';
import { BudgetError, costMicros, estimateInputTokens } from '../service/openai-budget.js';
import { MATH_RELIABILITY, OpenAIRuntime, ProviderError, toResponsesInput } from '../service/openai.js';
import { system } from '../service/inference.js';
import { UserError } from '../service/types.js';
import { grade, type Check } from './math-eval-grade.js';

// ---- problems -----------------------------------------------------------------

export const CATEGORIES = ['arithmetic-algebra', 'precalculus', 'geometry', 'combinatorics', 'number-theory', 'olympiad', 'proof', 'ambiguous-unsolvable'] as const;
export type Category = typeof CATEGORIES[number];
export type Difficulty = 'routine' | 'advanced' | 'olympiad';
export type ExpectedTier = 'light' | 'advanced';
export interface Problem {id: string; category: Category; difficulty: Difficulty; prompt: string; expectedTier: ExpectedTier; check: Check}

export const PROBLEMS_PATH = fileURLToPath(new URL('../../evals/math/problems.json', import.meta.url));
export const RESULTS_DIR = fileURLToPath(new URL('../../evals/math/results/', import.meta.url));
export const LIVE_MAX_USD_CAP = 5;

/** Throws with a precise message on the first malformed problem; returns the typed list. */
export function validateProblems(raw: unknown): Problem[] {
  if (!Array.isArray(raw)) throw new Error('problems.json must be a JSON array');
  const ids = new Set<string>();
  const nonEmptyStrings = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every(s => typeof s === 'string' && s.trim().length > 0);
  return raw.map((p: Record<string, unknown>, i) => {
    const where = `problem #${i} (${String(p?.id)})`;
    if (!p || typeof p !== 'object') throw new Error(`${where}: not an object`);
    if (typeof p.id !== 'string' || !/^[a-z0-9-]+$/.test(p.id)) throw new Error(`${where}: id must be kebab-case`);
    if (ids.has(p.id)) throw new Error(`${where}: duplicate id`);
    ids.add(p.id);
    if (!CATEGORIES.includes(p.category as Category)) throw new Error(`${where}: unknown category`);
    if (!['routine', 'advanced', 'olympiad'].includes(p.difficulty as string)) throw new Error(`${where}: bad difficulty`);
    if (p.expectedTier !== 'light' && p.expectedTier !== 'advanced') throw new Error(`${where}: bad expectedTier`);
    if (typeof p.prompt !== 'string' || !p.prompt.trim()) throw new Error(`${where}: empty prompt`);
    const c = p.check as Record<string, unknown> | undefined;
    if (!c || typeof c !== 'object') throw new Error(`${where}: missing check`);
    if (c.type === 'numeric') {
      if (typeof c.answer !== 'number' || !Number.isFinite(c.answer)) throw new Error(`${where}: numeric answer must be finite`);
      if (c.tolerance !== undefined && (typeof c.tolerance !== 'number' || !(c.tolerance >= 0) || !Number.isFinite(c.tolerance))) throw new Error(`${where}: bad tolerance`);
    } else if (c.type === 'exact') {
      if (!nonEmptyStrings(c.answers)) throw new Error(`${where}: exact check needs answers`);
    } else if (c.type === 'contains-all' || c.type === 'flags-ambiguity') {
      if (!nonEmptyStrings(c.terms)) throw new Error(`${where}: ${String(c.type)} check needs terms`);
    } else throw new Error(`${where}: unknown check type`);
    return p as unknown as Problem;
  });
}

export function loadProblems(path = PROBLEMS_PATH): Problem[] {
  return validateProblems(JSON.parse(readFileSync(path, 'utf8')));
}

// ---- config & routing -----------------------------------------------------------

export const DRY_RUN_KEY = 'sk-dryrun' + 'x'.repeat(30);

/** Only OPENAI_* tuning variables are honoured; the API key never comes from here. */
function openaiTuning(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('OPENAI_') && k !== 'OPENAI_API_KEY'));
}

export function evalConfig(env: Record<string, string | undefined>, apiKey: string, maxUsd?: number): OpenAIConfig {
  const config = parseOpenAIConfig({
    ...openaiTuning(env),
    AI_PROVIDER: 'openai',
    OPENAI_API_KEY: apiKey,
    ...(maxUsd !== undefined ? {OPENAI_DAILY_BUDGET_USD: String(maxUsd), OPENAI_TOTAL_BUDGET_USD: String(maxUsd)} : {}),
  });
  if (!config) throw new Error('internal: AI_PROVIDER=openai produced no config');
  return {...config, concurrency: 1};
}

export function evalMessages(prompt: string) {
  return [{role: 'system', content: system + '\n\n' + MATH_RELIABILITY}, {role: 'user', content: prompt}];
}

/** Mirrors OpenAIRuntime.complete's input estimate for a tool-less request. */
export function estimateRequestInputTokens(prompt: string) {
  const serialized = JSON.stringify(toResponsesInput(evalMessages(prompt))).length + JSON.stringify([]).length;
  return estimateInputTokens(serialized, 0);
}

export function worstCaseUsd(config: OpenAIConfig, route: OpenAIRoute, prompt: string) {
  const spec = config.models[route.model]!;
  return costMicros(spec, {inputTokens: estimateRequestInputTokens(prompt), cachedTokens: 0, outputTokens: route.maxOutputTokens, reasoningTokens: 0}) / 1_000_000;
}

export type TierMode = 'light' | 'advanced' | 'auto';
export function routeFor(config: OpenAIConfig, problem: Problem, mode: TierMode = 'auto'): OpenAIRoute {
  if (mode !== 'auto') return buildRoute(config, mode, `forced by --tier ${mode}`);
  // Production also feeds the local router's reasoning hint and reply-chain tier;
  // the eval routes on the bare prompt, as a fresh non-coach question.
  return chooseOpenAIRoute(config, {prompt: problem.prompt, coach: false});
}

// ---- dry run ----------------------------------------------------------------------

export interface DryRunRow {
  id: string; category: Category; difficulty: Difficulty; expectedTier: ExpectedTier;
  routedTier: Tier; model: string; effort: ReasoningEffort; reason: string;
  inputTokensEstimate: number; maxOutputTokens: number; worstCaseUsd: number; agrees: boolean;
}
export interface DryRunReport {rows: DryRunRow[]; agreed: number; total: number; agreement: number; worstCaseUsd: number; config: ReturnType<typeof describeOpenAIConfig>}

export function dryRun(problems: Problem[], env: Record<string, string | undefined> = {}): DryRunReport {
  const config = evalConfig(env, DRY_RUN_KEY);
  const rows = problems.map((p): DryRunRow => {
    const route = routeFor(config, p);
    return {id: p.id, category: p.category, difficulty: p.difficulty, expectedTier: p.expectedTier,
      routedTier: route.tier, model: route.model, effort: route.effort, reason: route.reason,
      inputTokensEstimate: estimateRequestInputTokens(p.prompt), maxOutputTokens: route.maxOutputTokens,
      worstCaseUsd: worstCaseUsd(config, route, p.prompt), agrees: route.tier === p.expectedTier};
  });
  const agreed = rows.filter(r => r.agrees).length;
  return {rows, agreed, total: rows.length, agreement: rows.length ? agreed / rows.length : 0,
    worstCaseUsd: rows.reduce((s, r) => s + r.worstCaseUsd, 0), config: describeOpenAIConfig(config)};
}

// ---- formatting -----------------------------------------------------------------

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const usd = (n: number) => `$${n.toFixed(4)}`;
function table(headers: string[], rows: (string | number)[][]) {
  const cells = [headers, ...rows.map(r => r.map(String))];
  const widths = headers.map((_, i) => Math.max(...cells.map(r => r[i]!.length)));
  const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd();
  return [line(headers), widths.map(w => '-'.repeat(w)).join('  '), ...cells.slice(1).map(line)].join('\n');
}
function groupBy<T>(items: T[], key: (t: T) => string) {
  const map = new Map<string, T[]>();
  for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item]);
  return map;
}

export function printDryRun(report: DryRunReport) {
  console.log('DRY RUN — no model calls made\n');
  console.log(`config: ${JSON.stringify(report.config)}`);
  console.log(`pricing: ${PRICING_SOURCE}\n`);
  console.log(table(['id', 'category', 'expected', 'routed', 'model', 'effort', 'worst-case', ''],
    report.rows.map(r => [r.id, r.category, r.expectedTier, r.routedTier, r.model, r.effort, usd(r.worstCaseUsd), r.agrees ? '' : 'MISMATCH'])));
  console.log('\nrouting agreement by category:');
  for (const [category, rows] of groupBy(report.rows, r => r.category))
    console.log(`  ${category.padEnd(22)} ${rows.filter(r => r.agrees).length}/${rows.length}`);
  const mismatches = report.rows.filter(r => !r.agrees);
  if (mismatches.length) {
    console.log('\nmismatches (expected -> routed, router reason):');
    for (const r of mismatches) console.log(`  ${r.id}: ${r.expectedTier} -> ${r.routedTier} (${r.reason})`);
  }
  console.log(`\nrouting agreement: ${report.agreed}/${report.total} = ${pct(report.agreement)}`);
  console.log(`worst-case cost of one live --tier auto pass (no retries): ${usd(report.worstCaseUsd)}`);
  console.log('DRY RUN — no model calls made');
}

// ---- CLI arguments ------------------------------------------------------------------

export type CliOptions =
  | {mode: 'help'}
  | {mode: 'dry'; ignored: string[]}
  | {mode: 'live'; maxUsd: number; tier: TierMode; limit?: number; ids?: string[]};

/** Pure argument validation. Live mode is refused unless every precondition holds. */
export function parseCli(argv: string[], env: Record<string, string | undefined>): CliOptions | {error: string} {
  let live = false, maxUsd: string | undefined, limit: string | undefined, ids: string | undefined, tier: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const [flag, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
      return v;
    };
    try {
      if (flag === '--help' || flag === '-h') return {mode: 'help'};
      else if (flag === '--live') live = true;
      else if (flag === '--max-usd') maxUsd = value();
      else if (flag === '--limit') limit = value();
      else if (flag === '--ids') ids = value();
      else if (flag === '--tier') tier = value();
      else return {error: `unknown argument ${arg}`};
    } catch (error) { return {error: (error as Error).message}; }
  }
  if (!live) return {mode: 'dry', ignored: [maxUsd && '--max-usd', limit && '--limit', ids && '--ids', tier && '--tier'].filter((x): x is string => !!x)};

  if (maxUsd === undefined) return {error: `--live requires an explicit --max-usd <n> (at most ${LIVE_MAX_USD_CAP}).`};
  const cap = Number(maxUsd);
  if (!Number.isFinite(cap) || cap <= 0) return {error: '--max-usd must be a positive number.'};
  if (cap > LIVE_MAX_USD_CAP) return {error: `--max-usd ${cap} refused: the harness cap is $${LIVE_MAX_USD_CAP}.`};
  if (!(env.OPENAI_API_KEY ?? '').trim()) return {error: '--live requires OPENAI_API_KEY in the process environment.'};
  const tierMode = (tier ?? 'auto') as TierMode;
  if (!['light', 'advanced', 'auto'].includes(tierMode)) return {error: '--tier must be light, advanced or auto.'};
  let limitN: number | undefined;
  if (limit !== undefined) {
    limitN = Number(limit);
    if (!Number.isInteger(limitN) || limitN < 1) return {error: '--limit must be a positive integer.'};
  }
  const idList = ids?.split(',').map(s => s.trim()).filter(Boolean);
  if (ids !== undefined && !idList?.length) return {error: '--ids needs at least one id.'};
  return {mode: 'live', maxUsd: cap, tier: tierMode, ...(limitN !== undefined ? {limit: limitN} : {}), ...(idList ? {ids: idList} : {})};
}

const HELP = `usage: bun src/scripts/math-eval.ts [--live --max-usd <n> [--limit <k>] [--ids a,b] [--tier light|advanced|auto]]

Without --live this is a DRY RUN: routing + worst-case cost only, no network, no key needed.
--live calls the OpenAI API and spends money. It requires OPENAI_API_KEY in the environment and
an explicit --max-usd (at most ${LIVE_MAX_USD_CAP}); the budget ledger refuses any call that could exceed it.`;

// ---- live run --------------------------------------------------------------------

export interface LiveResult {
  id: string; category: Category; difficulty: Difficulty; expectedTier: ExpectedTier;
  routedTier: Tier; model: string; effort: ReasoningEffort; routeReason: string;
  status: 'answered' | 'error';
  pass: boolean; gradeDetail: string;
  answer: string | null; finishReason: string | null;
  latencyMs: number; attempts: number;
  usage: {inputTokens: number; cachedTokens: number; outputTokens: number; reasoningTokens: number};
  costUsd: number; costIncludesWorstCase: boolean;
  error?: {kind: string; status?: number; code?: string};
}

interface LedgerRow {attempts: number; input: number; cached: number; output: number; reasoning: number; cost: number; uncertain: number}
function ledgerForJob(db: DatabaseSync, job: string): LedgerRow {
  const r = db.prepare(`SELECT count(*) AS attempts, coalesce(sum(input_tokens),0) AS input, coalesce(sum(cached_tokens),0) AS cached,
      coalesce(sum(output_tokens),0) AS output, coalesce(sum(reasoning_tokens),0) AS reasoning, coalesce(sum(cost_micros),0) AS cost,
      coalesce(sum(status<>'ok' AND cost_micros>0),0) AS uncertain
    FROM openai_usage WHERE job=?`).get(job) as Record<string, number>;
  return {attempts: Number(r.attempts), input: Number(r.input), cached: Number(r.cached), output: Number(r.output),
    reasoning: Number(r.reasoning), cost: Number(r.cost), uncertain: Number(r.uncertain)};
}

/** Configuration failures that would make every remaining call fail the same way. */
const FATAL_KINDS = new Set(['auth', 'permission', 'model_not_found', 'quota', 'unsupported_parameter', 'cancelled']);

function summarize(results: LiveResult[], key: (r: LiveResult) => string) {
  return Object.fromEntries([...groupBy(results, key)].map(([k, rs]) => {
    const passed = rs.filter(r => r.pass).length;
    return [k, {n: rs.length, passed, accuracy: rs.length ? passed / rs.length : 0, errors: rs.filter(r => r.status === 'error').length,
      meanLatencyMs: Math.round(rs.reduce((s, r) => s + r.latencyMs, 0) / rs.length), costUsd: rs.reduce((s, r) => s + r.costUsd, 0)}];
  }));
}

export async function liveRun(problems: Problem[], options: Extract<CliOptions, {mode: 'live'}>, env: Record<string, string | undefined>) {
  let selected = options.ids ? problems.filter(p => options.ids!.includes(p.id)) : problems;
  const unknown = (options.ids ?? []).filter(id => !problems.some(p => p.id === id));
  if (unknown.length) throw new Error(`unknown problem id(s): ${unknown.join(', ')}`);
  if (options.limit !== undefined) selected = selected.slice(0, options.limit);

  // The key is handed straight to the SDK client; it is never logged or written to results.
  const config = evalConfig(env, (env.OPENAI_API_KEY ?? '').trim(), options.maxUsd);
  const db = new DatabaseSync(':memory:');
  const runtime = new OpenAIRuntime(config, db);
  const controller = new AbortController();
  const onSigint = () => controller.abort(new Error('interrupted'));
  process.once('SIGINT', onSigint);

  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const results: LiveResult[] = [];
  let stoppedReason: string | undefined;

  console.log(`LIVE RUN — ${selected.length} problem(s), tier=${options.tier}, budget cap ${usd(options.maxUsd)} (estimated, enforced by the ledger)`);
  try {
    for (const [index, problem] of selected.entries()) {
      if (controller.signal.aborted) { stoppedReason = 'interrupted'; break; }
      const route = routeFor(config, problem, options.tier);
      const job = `math-eval-${stamp}-${problem.id}`;
      const started = performance.now();
      let content: string | null = null, finishReason: string | null = null;
      let error: LiveResult['error'] | undefined;
      try {
        const body = await runtime.complete({messages: evalMessages(problem.prompt), model: route.model, effort: route.effort,
          tier: route.tier, maxOutputTokens: route.maxOutputTokens, job: {id: job, user: 'math-eval'}}, controller.signal);
        const choice = (body.choices as {finish_reason?: string; message?: {content?: string | null}}[] | undefined)?.[0];
        content = typeof choice?.message?.content === 'string' ? choice.message.content : null;
        finishReason = choice?.finish_reason ?? null;
        if (!content) error = {kind: 'empty'};
      } catch (e) {
        if (e instanceof BudgetError) {
          stoppedReason = `budget: ${e.message}`;
          error = {kind: 'budget'};
        } else if (e instanceof ProviderError) error = {kind: e.kind, ...(e.status !== undefined ? {status: e.status} : {}), ...(e.code !== undefined ? {code: e.code} : {})};
        else if (controller.signal.aborted) error = {kind: 'cancelled'};
        else if (e instanceof UserError) error = {kind: 'rejected_locally'};
        else error = {kind: 'unknown'};
      }
      const latencyMs = Math.round(performance.now() - started);
      const ledger = ledgerForJob(db, job);
      // Refused before any request for this problem was sent: nothing ran, so nothing is recorded.
      if (error?.kind === 'budget' && ledger.attempts === 0) break;
      const graded = content ? grade(problem.check, content) : {pass: false, detail: `no answer (${error?.kind ?? 'unknown'})`};
      const result: LiveResult = {
        id: problem.id, category: problem.category, difficulty: problem.difficulty, expectedTier: problem.expectedTier,
        routedTier: route.tier, model: route.model, effort: route.effort, routeReason: route.reason,
        status: content ? 'answered' : 'error', pass: graded.pass, gradeDetail: graded.detail,
        answer: content, finishReason, latencyMs, attempts: ledger.attempts,
        usage: {inputTokens: ledger.input, cachedTokens: ledger.cached, outputTokens: ledger.output, reasoningTokens: ledger.reasoning},
        costUsd: ledger.cost / 1_000_000, costIncludesWorstCase: ledger.uncertain > 0,
        ...(error ? {error} : {}),
      };
      results.push(result);
      console.log(`[${index + 1}/${selected.length}] ${problem.id}: ${result.pass ? 'PASS' : 'FAIL'} ${route.tier}/${route.model}/${route.effort} ${latencyMs}ms ${usd(result.costUsd)}${error ? ` error=${error.kind}` : ''}`);
      if (error?.kind === 'budget') break;
      if (error && FATAL_KINDS.has(error.kind)) { stoppedReason = `fatal provider error: ${error.kind}`; break; }
    }
  } finally {
    process.off('SIGINT', onSigint);
  }

  const passed = results.filter(r => r.pass).length;
  const ledgerSummary = runtime.ledger.summary();
  const output = {
    meta: {
      harness: 'math-eval/1', mode: 'live', startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
      measures: 'raw model answers to one system+user turn; no tools, no Discord context, no reply chains',
      maxUsd: options.maxUsd, tier: options.tier, ids: options.ids ?? null, limit: options.limit ?? null,
      config: describeOpenAIConfig(config), pricingSource: PRICING_SOURCE,
      problemsSha256: createHash('sha256').update(readFileSync(PROBLEMS_PATH)).digest('hex'),
      selected: selected.length, completed: results.length, stoppedReason: stoppedReason ?? null,
    },
    summary: {
      total: results.length, passed, accuracy: results.length ? passed / results.length : 0,
      estimatedCostUsd: ledgerSummary.totalUsd,
      byCategory: summarize(results, r => r.category), byRoutedTier: summarize(results, r => r.routedTier),
      routingAgreement: options.tier === 'auto' && results.length ? results.filter(r => r.routedTier === r.expectedTier).length / results.length : null,
    },
    results,
  };

  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, {recursive: true});
  // Results are local artefacts (model output); keep them out of git without touching the repo .gitignore.
  const ignore = `${RESULTS_DIR}.gitignore`;
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
  const file = `${RESULTS_DIR}${stamp}.json`;
  writeFileSync(file, JSON.stringify(output, null, 2) + '\n');

  console.log('\n' + table(['category', 'n', 'pass', 'acc', 'errors', 'mean ms', 'cost'],
    Object.entries(output.summary.byCategory).map(([k, s]) => [k, s.n, s.passed, pct(s.accuracy), s.errors, s.meanLatencyMs, usd(s.costUsd)])));
  console.log('\n' + table(['routed tier', 'n', 'pass', 'acc', 'errors', 'mean ms', 'cost'],
    Object.entries(output.summary.byRoutedTier).map(([k, s]) => [k, s.n, s.passed, pct(s.accuracy), s.errors, s.meanLatencyMs, usd(s.costUsd)])));
  console.log(`\npassed ${passed}/${results.length}${results.length < selected.length ? ` (of ${selected.length} selected)` : ''} · estimated spend ${usd(ledgerSummary.totalUsd)} of ${usd(options.maxUsd)}`);
  if (stoppedReason) console.log(`stopped early: ${stoppedReason}`);
  console.log(`results: ${file}`);
  return output;
}

// ---- entry point --------------------------------------------------------------------

if (import.meta.main) {
  const options = parseCli(process.argv.slice(2), process.env);
  if ('error' in options) {
    console.error(`math-eval: ${options.error}\n\n${HELP}`);
    process.exit(2);
  }
  try {
    const problems = loadProblems();
    if (options.mode === 'help') console.log(HELP);
    else if (options.mode === 'dry') {
      if (options.ignored.length) console.log(`note: ${options.ignored.join(', ')} ignored without --live\n`);
      printDryRun(dryRun(problems, process.env));
    } else {
      await liveRun(problems, options, process.env);
    }
  } catch (error) {
    // Config errors never contain secret values (see openai-config.ts).
    console.error(`math-eval: ${(error as Error).message}`);
    process.exit(1);
  }
}
