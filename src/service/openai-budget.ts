import type { DatabaseSync } from 'node:sqlite';
import { LONG_CONTEXT_TOKENS, PRICING_SOURCE, type ModelSpec, type OpenAIConfig, type ReasoningEffort, type Tier } from './openai-config.js';
import { UserError } from './types.js';

/**
 * Local, *estimated* spend accounting for the OpenAI provider. It cannot see the
 * real account balance or promotional credits: OpenAI does not expose them to a
 * project API key. Enforcement fails closed: every call reserves its worst-case
 * cost before it starts, and a call whose usage is unknown keeps that worst case.
 * No prompt or answer text is stored here.
 */
export interface Usage { inputTokens: number; cachedTokens: number; outputTokens: number; reasoningTokens: number }
export class BudgetError extends UserError {}

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

export class UsageLedger {
  constructor(readonly db: DatabaseSync, readonly config: OpenAIConfig, readonly now: () => number = Date.now) {
    db.exec(`CREATE TABLE IF NOT EXISTS openai_jobs(job TEXT PRIMARY KEY, guild TEXT NOT NULL, user TEXT NOT NULL,
        tier TEXT NOT NULL, requested TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS openai_jobs_user ON openai_jobs(user, created);
      CREATE TABLE IF NOT EXISTS openai_usage(id INTEGER PRIMARY KEY, job TEXT NOT NULL, user TEXT NOT NULL, day TEXT NOT NULL,
        created INTEGER NOT NULL, model TEXT NOT NULL, effort TEXT NOT NULL, tier TEXT NOT NULL, status TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0, cached_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0, cost_micros INTEGER NOT NULL, latency_ms INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS openai_usage_day ON openai_usage(day);`);
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private count(sql: string, ...args: (string | number)[]) { return Number((this.db.prepare(sql).get(...args) as {n: number}).n); }

  tierForJob(job: string): Tier | undefined {
    return (this.db.prepare('SELECT tier FROM openai_jobs WHERE job=?').get(job) as {tier?: Tier} | undefined)?.tier;
  }

  /**
   * Per-user quotas, counted once per job (tool rounds and retries do not consume
   * more quota). Automatically-routed advanced work over quota is downgraded to the
   * light tier; explicitly requested premium work is refused instead.
   */
  admitJob(input: {job: string; guild: string; user: string; tier: Tier; explicit: boolean}): {tier: Tier; downgraded: boolean} {
    return this.transaction(() => {
      const existing = this.tierForJob(input.job);
      if (existing) return {tier: existing, downgraded: false};
      const now = this.now(), hour = now - 3_600_000, day = now - 86_400_000;
      if (this.count('SELECT count(*) AS n FROM openai_jobs WHERE user=? AND created>?', input.user, hour) >= this.config.userHourly)
        throw new BudgetError('you hit the hourly limit for ai answers. try again later.');
      let tier = input.tier, downgraded = false;
      if (tier === 'max' && this.count("SELECT count(*) AS n FROM openai_jobs WHERE user=? AND created>? AND tier='max'", input.user, day) >= this.config.userMaxDaily)
        throw new BudgetError('you already used your !max request for today.');
      if (tier !== 'light' && this.count("SELECT count(*) AS n FROM openai_jobs WHERE user=? AND created>? AND tier IN ('advanced','max')", input.user, day) >= this.config.userAdvancedDaily) {
        if (input.explicit) throw new BudgetError('you used up your deep-reasoning quota for today. try without !deep, or tomorrow.');
        tier = 'light'; downgraded = true;
      }
      this.db.prepare('INSERT INTO openai_jobs(job,guild,user,tier,requested,created) VALUES(?,?,?,?,?,?)').run(input.job, input.guild, input.user, tier, input.tier, now);
      return {tier, downgraded};
    });
  }

  private spent(day?: string) {
    return day ? this.count('SELECT coalesce(sum(cost_micros),0) AS n FROM openai_usage WHERE day=?', day)
      : this.count('SELECT coalesce(sum(cost_micros),0) AS n FROM openai_usage');
  }

  /** Reserves the worst-case cost of one API call, or refuses it. */
  reserve(input: {job: string; user: string; model: string; effort: ReasoningEffort; tier: Tier; inputTokens: number; maxOutputTokens: number}): {id: number; worst: number} {
    const spec = this.config.models[input.model];
    if (!spec) throw new BudgetError('ai answers are paused: the model has no configured pricing.');
    const worst = costMicros(spec, {inputTokens: input.inputTokens, cachedTokens: 0, outputTokens: input.maxOutputTokens, reasoningTokens: 0});
    return this.transaction(() => {
      const now = this.now(), day = utcDay(now);
      if (this.spent(day) + worst > Math.floor(this.config.dailyBudgetUsd * MICROS))
        throw new BudgetError("today's ai budget is used up. try again tomorrow (UTC).");
      if (this.spent() + worst > Math.floor(this.config.totalBudgetUsd * MICROS))
        throw new BudgetError('the ai budget is used up. a moderator needs to raise it.');
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
      const cost = costMicros(this.config.models[row.model]!, u);
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
    const jobs = this.db.prepare('SELECT tier, count(*) AS n FROM openai_jobs WHERE created>? GROUP BY tier').all(now - 86_400_000) as {tier: string; n: number}[];
    return {
      day, estimated: true, pricingSource: PRICING_SOURCE,
      todayUsd: this.spent(day) / MICROS, totalUsd: this.spent() / MICROS,
      dailyBudgetUsd: this.config.dailyBudgetUsd, totalBudgetUsd: this.config.totalBudgetUsd,
      models: rows.map(r => ({model: r.model, calls: Number(r.calls), inputTokens: Number(r.input), cachedTokens: Number(r.cached),
        outputTokens: Number(r.output), reasoningTokens: Number(r.reasoning), usd: Number(r.cost) / MICROS, uncertain: Number(r.uncertain), errors: Number(r.errors)})),
      jobsLast24h: Object.fromEntries(jobs.map(j => [j.tier, j.n])),
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
    `jobs (24h): ${Object.entries(s.jobsLast24h).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`,
    `_${s.note} Prices: ${s.pricingSource}._`,
  ];
  return lines.join('\n');
}

/** Bounded global concurrency for OpenAI calls; waiting is abortable. */
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
