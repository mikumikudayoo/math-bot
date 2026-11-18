import type { ServiceTier } from '../luna-fast-control.js';
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
export interface Usage { inputTokens: number; cachedTokens: number; outputTokens: number; reasoningTokens: number; write30mTokens?: number; write12hTokens?: number }
export class BudgetError extends UserError {
  constructor(message: string, readonly scope: 'request' | 'daily' | 'total' | 'quota' | 'pricing') { super(message); }
}

const MICROS = 1_000_000;
function validUsage(u: Usage): boolean {
  const short=u.write30mTokens??0, long=u.write12hTokens??0;
  return [u.inputTokens,u.outputTokens,u.cachedTokens,u.reasoningTokens,short,long].every(n=>Number.isSafeInteger(n)&&n>=0)
    && u.cachedTokens+short+long<=u.inputTokens && u.reasoningTokens<=u.outputTokens;
}
export function costMicros(spec: ModelSpec, usage: Usage, multiplier = 1): number {
  if (!validUsage(usage)) throw new BudgetError('Invalid provider usage.', 'pricing');
  const long = usage.inputTokens > LONG_CONTEXT_TOKENS;
  const cached = Math.min(usage.cachedTokens, usage.inputTokens);
  const shortWrites = usage.write30mTokens ?? 0, longWrites = usage.write12hTokens ?? 0;
  const fresh = usage.inputTokens - cached - shortWrites - longWrites;
  const inputCost = (fresh + shortWrites * 1.25 + longWrites * 2.5) * spec.input + cached * spec.cachedInput;
  // Prices are USD per million tokens, hence tokens * price gives microdollars.
  return Math.ceil((inputCost * (long ? 2 : 1) + usage.outputTokens * spec.output * (long ? 1.5 : 1)) * multiplier);
}

/** Estimate text and image inputs before the provider returns its measured usage. */
export function estimateInputTokens(chars: number, images: number) {
  return Math.ceil(chars / 3) + images * 1600;
}

// https://developers.openai.com/api/docs/models/gpt-6-luna
const tierMultiplier = (model: string, tier: ServiceTier) => model === 'gpt-6-luna' && tier === 'fast' ? 2 : 1;

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
      CREATE INDEX IF NOT EXISTS openai_usage_job ON openai_usage(job);
      CREATE TABLE IF NOT EXISTS luna_runtime(id INTEGER PRIMARY KEY CHECK(id=1), fast INTEGER NOT NULL CHECK(fast IN (0,1)));
      CREATE TABLE IF NOT EXISTS search_usage(request TEXT PRIMARY KEY, job TEXT NOT NULL, day TEXT NOT NULL, credits INTEGER NOT NULL);`);
    this.transaction(() => {
      const columns = new Set(db.prepare('PRAGMA table_info(openai_usage)').all().map(row => String(row.name)));
      for (const field of ['write_30m_tokens', 'write_12h_tokens', 'requested_service_tier', 'actual_service_tier']) {
        if (!columns.has(field)) db.exec(`ALTER TABLE openai_usage ADD COLUMN ${field} ${field.endsWith('_tier') ? 'TEXT' : 'INTEGER NOT NULL DEFAULT 0'}`);
      }
    });
  }

  lunaFastEnabled(): boolean {
    return this.db.prepare('SELECT fast FROM luna_runtime WHERE id=1').get()?.fast === 1;
  }

  setLunaFast(enabled: boolean) {
    this.db.prepare('INSERT INTO luna_runtime(id,fast) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET fast=excluded.fast').run(enabled ? 1 : 0);
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
      const previous = this.db.prepare('SELECT user,guild FROM ai_requests WHERE job=?').get(input.job);
      if (previous) {
        if (previous.user !== input.user || previous.guild !== input.guild) throw new BudgetError('request owner mismatch.', 'quota');
        return;
      }
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
      const row = this.db.prepare('SELECT user,class,sol,terra,seven FROM ai_requests WHERE job=?').get(job) as {user: string; class: RequestClass; sol: number; terra: number; seven: number} | undefined;
      if (!row || row.user !== user) return {ok: false as const, reason: 'request not admitted for this user'};
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
  reserve(input: {job: string; user: string; model: string; effort: ReasoningEffort; tier: string; serviceTier?: ServiceTier; inputTokens: number; maxOutputTokens: number}): {id: number; worst: number} {
    const spec = this.config.pricing[input.model];
    if (!spec) throw new BudgetError("i'm paused: that model has no configured pricing.", 'pricing');
    if (![input.inputTokens, input.maxOutputTokens].every(n => Number.isSafeInteger(n) && n >= 0))
      throw new BudgetError('Invalid token reservation.', 'pricing');
    // The reservation covers every input token at the more expensive of a 12h write and a cache read.
    const expensiveReads = spec.cachedInput > 2.5 * spec.input;
    const worst = costMicros(spec, {inputTokens: input.inputTokens, cachedTokens: expensiveReads ? input.inputTokens : 0,
      write12hTokens: expensiveReads ? 0 : input.inputTokens, outputTokens: input.maxOutputTokens, reasoningTokens: 0}, tierMultiplier(input.model,input.serviceTier ?? 'default'));
    return this.transaction(() => {
      const now = this.now(), day = utcDay(now);
      const owner = this.db.prepare('SELECT class,user FROM ai_requests WHERE job=?').get(input.job);
      if (owner ? owner.user !== input.user : input.user !== 'system')
        throw new BudgetError('request not admitted for this user.', 'quota');
      const ceiling = Math.floor(this.config.requestBudgetUsd[(owner?.class as RequestClass) ?? 'system'] * MICROS);
      if (this.jobSpentMicros(input.job) + worst > ceiling)
        throw new BudgetError('this request hit its spending limit, so i have to stop here.', 'request');
      if (this.spent(day) + worst > Math.floor(this.config.dailyBudgetUsd * MICROS))
        throw new BudgetError("today's budget for my brain is used up. try again tomorrow (UTC).", 'daily');
      if (this.spent() + worst > Math.floor(this.config.totalBudgetUsd * MICROS))
        throw new BudgetError('my budget is used up. emu or a moderator needs to raise it.', 'total');
      const result = this.db.prepare(`INSERT INTO openai_usage(job,user,day,created,model,effort,tier,status,cost_micros,requested_service_tier)
        VALUES(?,?,?,?,?,?,?,'reserved',?,?)`).run(input.job, input.user, day, now, input.model, input.effort, input.tier, worst, input.serviceTier ?? null);
      return {id: Number(result.lastInsertRowid), worst};
    });
  }

  /**
   * Replaces the reservation with actual usage. Without usage, `billed: false`
   * (an HTTP error response) releases it; anything uncertain (timeout, abort,
   * connection loss) keeps the worst-case estimate.
   */
  settle(id: number, outcome: {usage?: Usage | undefined; actualServiceTier?: ServiceTier | undefined; status: string; latencyMs: number; error?: string; billed?: boolean | undefined}) {
    const row = this.db.prepare("SELECT model,requested_service_tier FROM openai_usage WHERE id=? AND status='reserved'").get(id) as {model: string; requested_service_tier: ServiceTier | null} | undefined;
    if (!row) return;
    const u = outcome.usage;
    if (u && row.requested_service_tier && !outcome.actualServiceTier) {
      this.db.prepare("UPDATE openai_usage SET status='unmetered',error='missing_service_tier',latency_ms=? WHERE id=? AND status='reserved'").run(outcome.latencyMs,id);
      return;
    }
    if (u && !validUsage(u)) {
      this.db.prepare("UPDATE openai_usage SET status='unmetered',error='invalid_usage',latency_ms=? WHERE id=? AND status='reserved'").run(outcome.latencyMs,id);
      return;
    }
    if (u) {
      const cost = costMicros(this.config.pricing[row.model]!, u, tierMultiplier(row.model, outcome.actualServiceTier ?? 'default'));
      this.db.prepare(`UPDATE openai_usage SET status=?,input_tokens=?,cached_tokens=?,output_tokens=?,reasoning_tokens=?,write_30m_tokens=?,write_12h_tokens=?,cost_micros=?,latency_ms=?,error=?,actual_service_tier=? WHERE id=? AND status='reserved'`)
        .run(outcome.status, u.inputTokens, u.cachedTokens, u.outputTokens, u.reasoningTokens, u.write30mTokens ?? 0, u.write12hTokens ?? 0, cost, outcome.latencyMs, outcome.error ?? '', outcome.actualServiceTier ?? null, id);
    } else {
      this.db.prepare(`UPDATE openai_usage SET status=?,latency_ms=?,error=?,actual_service_tier=?${outcome.billed === false ? ',cost_micros=0' : ''} WHERE id=? AND status='reserved'`)
        .run(outcome.status, outcome.latencyMs, outcome.error ?? '', outcome.actualServiceTier ?? null, id);
    }
  }

  recordSearchCredits(job: string, request: string, credits: number) {
    if (!Number.isSafeInteger(credits) || credits < 0) throw new Error('Invalid search usage.');
    this.db.prepare('INSERT OR IGNORE INTO search_usage(request,job,day,credits) VALUES(?,?,?,?)').run(request,job,utcDay(this.now()),credits);
  }
  summary() {
    const now = this.now(), day = utcDay(now);
    const rows = this.db.prepare(`SELECT model, count(*) AS calls, sum(input_tokens) AS input, sum(cached_tokens) AS cached,
        sum(output_tokens) AS output, sum(reasoning_tokens) AS reasoning, sum(write_30m_tokens) AS writes30m, sum(write_12h_tokens) AS writes12h, sum(cost_micros) AS cost,
        sum(status IN ('reserved','unmetered') OR (status='error' AND cost_micros>0)) AS uncertain, sum(error<>'') AS errors
      FROM openai_usage WHERE day=? GROUP BY model ORDER BY model`).all(day) as Record<string, number | string>[];
    const classes = this.db.prepare('SELECT class, count(*) AS n FROM ai_requests WHERE created>? GROUP BY class').all(now - 86_400_000) as {class: string; n: number}[];
    const top = this.db.prepare(`SELECT r.class AS class, max(t.cost) AS max, avg(t.cost) AS avg FROM ai_requests r
        JOIN (SELECT job, sum(cost_micros) AS cost FROM openai_usage WHERE created>? GROUP BY job) t ON t.job=r.job GROUP BY r.class`).all(now - 86_400_000) as {class: string; max: number; avg: number}[];
    return {
      day, estimated: true, pricingSource: PRICING_SOURCE,
      searchCreditsToday: this.count('SELECT coalesce(sum(credits),0) AS n FROM search_usage WHERE day=?',day),
      todayUsd: this.spent(day) / MICROS, totalUsd: this.spent() / MICROS,
      dailyBudgetUsd: this.config.dailyBudgetUsd, totalBudgetUsd: this.config.totalBudgetUsd,
      models: rows.map(r => ({model: String(r.model), calls: Number(r.calls), inputTokens: Number(r.input), cachedTokens: Number(r.cached),
        outputTokens: Number(r.output), reasoningTokens: Number(r.reasoning), write30mTokens: Number(r.writes30m), write12hTokens: Number(r.writes12h), usd: Number(r.cost) / MICROS, uncertain: Number(r.uncertain), errors: Number(r.errors)})),
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
    ...s.models.map(m => `\`${m.model}\` ${m.calls} calls · in ${m.inputTokens} (cached ${m.cachedTokens}, cache writes 30m/12h ${m.write30mTokens}/${m.write12hTokens}) · out ${m.outputTokens} (reasoning ${m.reasoningTokens}) · ${usd(m.usd)}${m.uncertain ? ` · ${m.uncertain} worst-case` : ''}${m.errors ? ` · ${m.errors} errors` : ''}`),
    ...(s.searchCreditsToday ? [`web search today: ${s.searchCreditsToday} Tavily credits`] : []),
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
