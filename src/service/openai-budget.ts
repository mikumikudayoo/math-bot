import type { DatabaseSync } from 'node:sqlite';
import { LONG_CONTEXT_TOKENS, PRICING_SOURCE, type ModelSpec, type OpenAIConfig, type ReasoningEffort, type RequestClass } from './openai-config.js';
import { UserError } from './types.js';

/**
 * Local, *estimated* spend accounting. It cannot see the real account balance or
 * promotional credits: OpenAI does not expose them to a project API key.
 * Enforcement fails closed and is atomic across concurrent jobs and processes sharing
 * the database file: every API call reserves its worst-case cost inside one IMMEDIATE
 * transaction before it starts, and a call whose usage is unknown keeps that worst case.
 * No prompt or answer text is stored here.
 */
export interface Usage { inputTokens: number; cachedTokens: number; outputTokens: number; reasoningTokens: number }
export class BudgetError extends UserError {
  constructor(message: string, readonly scope: 'request' | 'daily' | 'total' | 'quota' | 'pricing') { super(message); }
}

const MICROS = 1_000_000;
export function costMicros(spec: ModelSpec, usage: Usage): number {
  const long = usage.inputTokens > LONG_CONTEXT_TOKENS;
  const cached = Math.min(usage.cachedTokens, usage.inputTokens);
  const fresh = usage.inputTokens - cached;
  // Reasoning tokens are already included in output_tokens; never add them twice.
  const usd = (fresh * spec.input * (long ? 2 : 1) + cached * spec.cachedInput * (long ? 2 : 1) + usage.outputTokens * spec.output * (long ? 1.5 : 1)) / 1_000_000;
  return Math.ceil(usd * MICROS);
}
/** Conservative token estimate: ~3 characters per token, plus a fixed allowance per image. */
export function estimateInputTokens(chars: number, images: number) {
  return Math.ceil(chars / 3) + images * 1600;
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const CLASS_RANK: RequestClass[] = ['system', 'ordinary', 'terra', 'sol', 'both', 'seven'];

export class UsageLedger {
  constructor(readonly db: DatabaseSync, readonly config: OpenAIConfig, readonly now: () => number = Date.now) {
    db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS ai_requests(job TEXT PRIMARY KEY, guild TEXT NOT NULL, user TEXT NOT NULL, class TEXT NOT NULL,
        created INTEGER NOT NULL, sol INTEGER NOT NULL DEFAULT 0, terra INTEGER NOT NULL DEFAULT 0, seven INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS ai_requests_user ON ai_requests(user, created);
      CREATE TABLE IF NOT EXISTS openai_usage(id INTEGER PRIMARY KEY, job TEXT NOT NULL, user TEXT NOT NULL, day TEXT NOT NULL,
        created INTEGER NOT NULL, model TEXT NOT NULL, effort TEXT NOT NULL, tier TEXT NOT NULL, status TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0, cached_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0, cost_micros INTEGER NOT NULL, latency_ms INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS openai_usage_day ON openai_usage(day);
      CREATE INDEX IF NOT EXISTS openai_usage_job ON openai_usage(job);`);
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private count(sql: string, ...args: (string | number)[]) { return Number((this.db.prepare(sql).get(...args) as {n: number}).n); }

  /** Per-user rate limit, counted once per job (tool rounds, retries and resumes never count twice). */
  admitJob(input: {job: string; guild: string; user: string}): void {
    this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM ai_requests WHERE job=?').get(input.job)) return;
      const now = this.now();
      if (this.count('SELECT count(*) AS n FROM ai_requests WHERE user=? AND created>?', input.user, now - 3_600_000) >= this.config.userHourly)
        throw new BudgetError("you've hit the hourly limit for my answers. go touch grass and try again later.", 'quota');
      this.db.prepare("INSERT INTO ai_requests(job,guild,user,class,created) VALUES(?,?,?,'ordinary',?)").run(input.job, input.guild, input.user, now);
    });
  }

  /**
   * Authorizes escalating a request (specialist consultation or seven-agent mode).
   * Quotas are per user per rolling day and are consumed once per job and kind.
   * Being a moderator or the creator grants nothing here.
   */
  authorizeEscalation(job: string, user: string, kind: 'sol' | 'terra' | 'seven'): {ok: true; class: RequestClass} | {ok: false; reason: string} {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT class,sol,terra,seven FROM ai_requests WHERE job=?').get(job) as {class: RequestClass; sol: number; terra: number; seven: number} | undefined;
      if (!row) return {ok: false as const, reason: 'request is not admitted'};
      const day = this.now() - 86_400_000;
      if (!row[kind]) {
        const used = this.count(`SELECT count(*) AS n FROM ai_requests WHERE user=? AND created>? AND ${kind}>0`, user, day);
        const limit = kind === 'sol' ? this.config.userSolDaily : kind === 'terra' ? this.config.userTerraDaily : this.config.userSevenDaily;
        if (used >= limit) return {ok: false as const, reason: `daily ${kind} quota for this user is used up`};
        if (kind === 'seven' && this.count('SELECT count(*) AS n FROM ai_requests WHERE created>? AND seven>0', day) >= this.config.sevenDaily)
          return {ok: false as const, reason: 'daily seven-agent limit is used up'};
      }
      const sol = row.sol || kind === 'sol', terra = row.terra || kind === 'terra', seven = row.seven || kind === 'seven';
      const next: RequestClass = seven ? 'seven' : sol && terra ? 'both' : sol ? 'sol' : terra ? 'terra' : row.class;
      const cls = CLASS_RANK.indexOf(next) > CLASS_RANK.indexOf(row.class) ? next : row.class;
      this.db.prepare(`UPDATE ai_requests SET class=?,${kind}=1 WHERE job=?`).run(cls, job);
      return {ok: true as const, class: cls};
    });
  }

  requestClass(job: string): RequestClass {
    return (this.db.prepare('SELECT class FROM ai_requests WHERE job=?').get(job) as {class?: RequestClass} | undefined)?.class ?? 'system';
  }
  private spent(day?: string) {
    return day ? this.count('SELECT coalesce(sum(cost_micros),0) AS n FROM openai_usage WHERE day=?', day)
      : this.count('SELECT coalesce(sum(cost_micros),0) AS n FROM openai_usage');
  }
  jobSpentMicros(job: string) { return this.count('SELECT coalesce(sum(cost_micros),0) AS n FROM openai_usage WHERE job=?', job); }
  /** Estimated USD still available to this request under its class ceiling. */
  jobRemainingUsd(job: string) { return Math.max(0, this.config.requestBudgetUsd[this.requestClass(job)] - this.jobSpentMicros(job) / MICROS); }

  /** Atomically reserves the worst-case cost of one API call against request, daily and total ceilings. */
  reserve(input: {job: string; user: string; model: string; effort: ReasoningEffort; tier: string; inputTokens: number; maxOutputTokens: number}): {id: number; worst: number} {
    const spec = this.config.pricing[input.model];
    if (!spec) throw new BudgetError("i'm paused: that model has no configured pricing.", 'pricing');
    const worst = costMicros(spec, {inputTokens: input.inputTokens, cachedTokens: 0, outputTokens: input.maxOutputTokens, reasoningTokens: 0});
    return this.transaction(() => {
      const now = this.now(), day = utcDay(now);
      const ceiling = Math.floor(this.config.requestBudgetUsd[this.requestClass(input.job)] * MICROS);
      if (this.jobSpentMicros(input.job) + worst > ceiling)
        throw new BudgetError('this request hit its spending limit, so i have to stop here.', 'request');
      if (this.spent(day) + worst > Math.floor(this.config.dailyBudgetUsd * MICROS))
        throw new BudgetError("today's budget for my brain is used up. try again tomorrow (UTC).", 'daily');
      if (this.spent() + worst > Math.floor(this.config.totalBudgetUsd * MICROS))
        throw new BudgetError('my budget is used up. emu or a moderator needs to raise it.', 'total');
      const result = this.db.prepare(`INSERT INTO openai_usage(job,user,day,created,model,effort,tier,status,cost_micros)
        VALUES(?,?,?,?,?,?,?,'reserved',?)`).run(input.job, input.user, day, now, input.model, input.effort, input.tier, worst);
      return {id: Number(result.lastInsertRowid), worst};
    });
  }

  /**
   * Replaces the reservation with actual usage. Without usage, `billed: false`
   * (an HTTP error response) releases it; anything uncertain (timeout, abort,
   * connection loss) keeps the worst-case estimate.
   */
  settle(id: number, outcome: {usage?: Usage | undefined; status: string; latencyMs: number; error?: string; billed?: boolean | undefined}) {
    const row = this.db.prepare('SELECT model FROM openai_usage WHERE id=?').get(id) as {model: string} | undefined;
    if (!row) return;
    const u = outcome.usage;
    if (u) {
      const cost = costMicros(this.config.pricing[row.model]!, u);
      this.db.prepare(`UPDATE openai_usage SET status=?,input_tokens=?,cached_tokens=?,output_tokens=?,reasoning_tokens=?,cost_micros=?,latency_ms=?,error=? WHERE id=?`)
        .run(outcome.status, u.inputTokens, u.cachedTokens, u.outputTokens, u.reasoningTokens, cost, outcome.latencyMs, outcome.error ?? '', id);
    } else {
      this.db.prepare(`UPDATE openai_usage SET status=?,latency_ms=?,error=?${outcome.billed === false ? ',cost_micros=0' : ''} WHERE id=?`)
        .run(outcome.status, outcome.latencyMs, outcome.error ?? '', id);
    }
  }

  summary() {
    const now = this.now(), day = utcDay(now);
    const rows = this.db.prepare(`SELECT model, count(*) AS calls, sum(input_tokens) AS input, sum(cached_tokens) AS cached,
        sum(output_tokens) AS output, sum(reasoning_tokens) AS reasoning, sum(cost_micros) AS cost,
        sum(status IN ('reserved','unmetered') OR (status='error' AND cost_micros>0)) AS uncertain, sum(error<>'') AS errors
      FROM openai_usage WHERE day=? GROUP BY model ORDER BY model`).all(day) as Record<string, number | string>[];
    const classes = this.db.prepare('SELECT class, count(*) AS n FROM ai_requests WHERE created>? GROUP BY class').all(now - 86_400_000) as {class: string; n: number}[];
    const top = this.db.prepare(`SELECT r.class AS class, max(t.cost) AS max, avg(t.cost) AS avg FROM ai_requests r
        JOIN (SELECT job, sum(cost_micros) AS cost FROM openai_usage WHERE created>? GROUP BY job) t ON t.job=r.job GROUP BY r.class`).all(now - 86_400_000) as {class: string; max: number; avg: number}[];
    return {
      day, estimated: true, pricingSource: PRICING_SOURCE,
      todayUsd: this.spent(day) / MICROS, totalUsd: this.spent() / MICROS,
      dailyBudgetUsd: this.config.dailyBudgetUsd, totalBudgetUsd: this.config.totalBudgetUsd,
      models: rows.map(r => ({model: String(r.model), calls: Number(r.calls), inputTokens: Number(r.input), cachedTokens: Number(r.cached),
        outputTokens: Number(r.output), reasoningTokens: Number(r.reasoning), usd: Number(r.cost) / MICROS, uncertain: Number(r.uncertain), errors: Number(r.errors)})),
      requestsLast24h: Object.fromEntries(classes.map(j => [j.class, j.n])),
      requestCostLast24h: Object.fromEntries(top.map(t => [t.class, {maxUsd: Number(t.max) / MICROS, avgUsd: Number(t.avg) / MICROS, ceilingUsd: this.config.requestBudgetUsd[t.class as RequestClass] ?? 0}])),
      note: 'Local estimate from token usage x configured prices. Not the account balance; check platform.openai.com billing for actual credits.',
    };
  }
}

export function formatUsageSummary(s: ReturnType<UsageLedger['summary']>) {
  const usd = (n: number) => `$${n.toFixed(4)}`;
  const lines = [
    `**OpenAI usage (estimated) — ${s.day} UTC**`,
    `today: ${usd(s.todayUsd)} / ${usd(s.dailyBudgetUsd)} · all time: ${usd(s.totalUsd)} / ${usd(s.totalBudgetUsd)}`,
    ...s.models.map(m => `\`${m.model}\` ${m.calls} calls · in ${m.inputTokens} (cached ${m.cachedTokens}) · out ${m.outputTokens} (reasoning ${m.reasoningTokens}) · ${usd(m.usd)}${m.uncertain ? ` · ${m.uncertain} worst-case` : ''}${m.errors ? ` · ${m.errors} errors` : ''}`),
    `requests (24h): ${Object.entries(s.requestsLast24h).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`,
    ...Object.entries(s.requestCostLast24h).map(([k, v]) => `${k}: avg ${usd(v.avgUsd)}, max ${usd(v.maxUsd)} of ${usd(v.ceilingUsd)} ceiling`),
    `_${s.note} Prices: ${s.pricingSource}._`,
  ];
  return lines.join('\n');
}

/** Bounded global concurrency for OpenAI calls; waiting is abortable and FIFO. */
export class Semaphore {
  private active = 0;
  private waiters: (() => void)[] = [];
  constructor(readonly limit: number) {}
  get inUse() { return this.active; }
  async acquire(signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.active < this.limit) { this.active++; return; }
    await new Promise<void>((resolve, reject) => {
      const wake = () => { signal.removeEventListener('abort', abort); this.active++; resolve(); };
      const abort = () => { this.waiters = this.waiters.filter(w => w !== wake); reject(signal.reason); };
      this.waiters.push(wake);
      signal.addEventListener('abort', abort, {once: true});
    });
  }
  release() { this.active--; this.waiters.shift()?.(); }
}
