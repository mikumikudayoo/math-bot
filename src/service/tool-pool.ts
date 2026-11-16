import { createHash } from 'node:crypto';

/**
 * Bounded, order-preserving, error-isolating executor for the tool calls of ONE model response,
 * plus a small guard for the surrounding model/tool loop. See docs/openai.md.
 */
export interface PoolCall { id: string; name: string; run: (signal: AbortSignal) => Promise<unknown> }
export interface PoolOptions {
  /** Maximum number of calls in flight at once (positive integer, e.g. 4 per job). */
  concurrency: number;
  /** Calls sharing a group key run one at a time, in original order. `undefined` = independent. */
  exclusiveGroup?: (name: string) => string | undefined;
  /** Per-tool wall clock in ms. On timeout only that call's signal is aborted and it resolves to an error outcome. */
  timeoutMs?: (name: string) => number | undefined;
  onStart?: (call: PoolCall) => void;
  onFinish?: (call: PoolCall, outcome: PoolOutcome) => void;
}
export type PoolOutcome =
  | { id: string; name: string; ok: true; value: unknown; ms: number }
  | { id: string; name: string; ok: false; error: unknown; timedOut: boolean; ms: number };

/** Error outcome (and child-signal abort reason) of a call that exceeded its per-tool timeout. */
export class ToolTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(tool: string, timeoutMs: number) {
    super(`Tool call timed out after ${timeoutMs} ms: ${tool.slice(0, 64)}`);
    this.name = 'ToolTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

const MAX_TIMER_MS = 2_147_483_647;
interface Planned { call: PoolCall; group: string | undefined; timeout: number | undefined }
interface Running { controller: AbortController; started: number; timer: ReturnType<typeof setTimeout> | undefined }
type Settlement = { ok: true; value: unknown } | { ok: false; error: unknown; timedOut: boolean };

/**
 * Runs every call and resolves with one outcome per call, in the ORIGINAL call order.
 *
 * Programmer errors (duplicate ids, invalid concurrency, a throwing `exclusiveGroup`/`timeoutMs`
 * callback) are thrown synchronously, before any call starts. A failing or timed-out call never
 * rejects the batch. The returned promise rejects only when the parent `signal` aborts, with the
 * abort reason: cancellation is authoritative.
 */
export function runToolCalls(calls: PoolCall[], signal: AbortSignal, options: PoolOptions): Promise<PoolOutcome[]> {
  const concurrency = options.concurrency;
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError('Tool pool concurrency must be a positive integer.');
  const ids = new Set<string>();
  for (const call of calls) {
    if (ids.has(call.id)) throw new TypeError(`Duplicate tool call id in one batch: ${String(call.id).slice(0, 64)}`);
    ids.add(call.id);
  }
  // Classify everything up front so a throwing callback cannot fail a half-started batch.
  const plan: Planned[] = calls.map(call => {
    const timeout = options.timeoutMs?.(call.name);
    return {
      call,
      group: options.exclusiveGroup?.(call.name),
      timeout: typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, MAX_TIMER_MS) : undefined,
    };
  });
  return execute(plan, signal, concurrency, options);
}

function execute(plan: Planned[], signal: AbortSignal, concurrency: number, options: PoolOptions): Promise<PoolOutcome[]> {
  return new Promise<PoolOutcome[]>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    if (!plan.length) { resolve([]); return; }
    const outcomes = new Array<PoolOutcome>(plan.length);
    const running = new Map<number, Running>();
    const busyGroups = new Set<string>();
    let pending = plan.map((_, index) => index);
    let settled = 0;
    let done = false;

    // Observers must never be able to break the pool.
    const notifyStart = (call: PoolCall) => { try { options.onStart?.(call); } catch { /* isolated */ } };
    const notifyFinish = (call: PoolCall, outcome: PoolOutcome) => { try { options.onFinish?.(call, outcome); } catch { /* isolated */ } };

    /** Records the first settlement of a started call; later ones (late results after timeout/abort) are ignored. */
    const settle = (index: number, result: Settlement) => {
      const entry = running.get(index);
      if (!entry) return;
      running.delete(index);
      clearTimeout(entry.timer);
      const { call, group } = plan[index]!;
      if (group !== undefined) busyGroups.delete(group);
      const ms = Math.max(0, Math.round(performance.now() - entry.started));
      const outcome: PoolOutcome = result.ok
        ? { id: call.id, name: call.name, ok: true, value: result.value, ms }
        : { id: call.id, name: call.name, ok: false, error: result.error, timedOut: result.timedOut, ms };
      outcomes[index] = outcome;
      settled++;
      notifyFinish(call, outcome);
    };

    const start = (index: number) => {
      const { call, group, timeout } = plan[index]!;
      const controller = new AbortController();
      const entry: Running = { controller, started: performance.now(), timer: undefined };
      running.set(index, entry);
      if (group !== undefined) busyGroups.add(group);
      notifyStart(call);
      if (done) return; // the parent was aborted from inside onStart; the call was already settled
      if (timeout !== undefined) {
        entry.timer = setTimeout(() => {
          const error = new ToolTimeoutError(call.name, timeout);
          settle(index, { ok: false, error, timedOut: true });
          controller.abort(error);
          pump();
        }, timeout);
      }
      let promise: Promise<unknown>;
      try { promise = Promise.resolve(call.run(controller.signal)); } catch (error) { promise = Promise.reject(error); }
      // Both branches are always handled, so a late rejection can never become an unhandled rejection.
      promise.then(
        value => { settle(index, { ok: true, value }); pump(); },
        (error: unknown) => { settle(index, { ok: false, error, timedOut: false }); pump(); },
      );
    };

    const pump = () => {
      if (done) return;
      if (settled === plan.length) {
        done = true;
        signal.removeEventListener('abort', onAbort);
        resolve(outcomes);
        return;
      }
      // Scan in original order: the earliest waiting member of a group is always reached first,
      // so same-group calls keep their relative order while independent calls overtake them.
      const waiting: number[] = [];
      for (const index of pending) {
        if (done) return;
        const group = plan[index]!.group;
        if (running.size >= concurrency || (group !== undefined && busyGroups.has(group))) waiting.push(index);
        else start(index);
      }
      if (!done) pending = waiting;
    };

    const onAbort = () => {
      if (done) return;
      done = true;
      pending = [];
      const reason: unknown = signal.reason;
      for (const [index, entry] of [...running]) {
        settle(index, { ok: false, error: reason, timedOut: false });
        entry.controller.abort(reason);
      }
      reject(reason);
    };

    signal.addEventListener('abort', onAbort, { once: true });
    pump();
  });
}

export interface LoopLimits { softRounds: number; hardRounds: number; maxRepeatedCall?: number; maxConsecutiveFailures?: number }

function positiveInteger(value: number | undefined, name: string): number {
  if (value === undefined) return Number.POSITIVE_INFINITY;
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer.`);
  return value;
}
/** JSON with object keys sorted, so argument order does not hide a repeated call. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 32);
/** Short stable digest of a tool output, suitable for `LoopGuard.recordCall`'s `outputDigest`. */
export function digestToolOutput(value: unknown): string {
  let text: string;
  try { text = stable(value); } catch { text = String(value); }
  return sha(text);
}

/**
 * Bounds one model/tool loop: a soft round budget (nudge the model to wrap up), a hard round cap,
 * and stall detection for a model that keeps repeating the same call or keeps failing.
 */
export class LoopGuard {
  readonly #soft: number;
  readonly #hard: number;
  readonly #maxRepeated: number;
  readonly #maxFailures: number;
  readonly #seen = new Map<string, { count: number; digest: string; unchangedRun: number }>();
  #rounds = 0;
  #calls = 0;
  #failures = 0;
  #repeatedCalls = 0;
  #consecutiveFailures = 0;
  #softIssued = false;
  #stalled = false;

  constructor(limits: LoopLimits) {
    this.#soft = positiveInteger(limits.softRounds, 'softRounds');
    this.#hard = positiveInteger(limits.hardRounds, 'hardRounds');
    if (!Number.isFinite(this.#soft) || !Number.isFinite(this.#hard)) throw new RangeError('softRounds and hardRounds are required.');
    if (this.#soft > this.#hard) throw new RangeError('softRounds must not exceed hardRounds.');
    this.#maxRepeated = positiveInteger(limits.maxRepeatedCall, 'maxRepeatedCall');
    this.#maxFailures = positiveInteger(limits.maxConsecutiveFailures, 'maxConsecutiveFailures');
  }

  /**
   * Call before each model round. `hardRounds` rounds are admitted; every later call returns
   * 'hard' and is not counted. The round that reaches `softRounds` returns 'soft' exactly once
   * (it is still admitted); every other admitted round returns 'ok'.
   */
  beginRound(): 'ok' | 'soft' | 'hard' {
    if (this.#rounds >= this.#hard) return 'hard';
    this.#rounds++;
    if (!this.#softIssued && this.#rounds >= this.#soft) { this.#softIssued = true; return 'soft'; }
    return 'ok';
  }

  /**
   * Record one finished tool call. `repeated` is how many times this exact call (same name and
   * same arguments, key order ignored) was made before; `unchanged` is true when the previous
   * identical call produced the same outcome (same ok flag and output digest).
   */
  recordCall(name: string, argsJson: string, outcome: { ok: boolean; outputDigest: string }): { repeated: number; unchanged: boolean } {
    this.#calls++;
    if (outcome.ok) this.#consecutiveFailures = 0;
    else {
      this.#failures++;
      if (++this.#consecutiveFailures >= this.#maxFailures) this.#stalled = true;
    }
    let canonical = argsJson;
    try { canonical = stable(JSON.parse(argsJson)); } catch { /* not JSON: compare the raw text */ }
    const key = sha(`${name}\u0000${canonical}`);
    const digest = `${outcome.ok ? 'ok' : 'error'}:${outcome.outputDigest}`;
    const prior = this.#seen.get(key);
    if (!prior) {
      this.#seen.set(key, { count: 1, digest, unchangedRun: 0 });
      return { repeated: 0, unchanged: false };
    }
    this.#repeatedCalls++;
    const unchanged = prior.digest === digest;
    prior.unchangedRun = unchanged ? prior.unchangedRun + 1 : 0;
    prior.digest = digest;
    if (prior.unchangedRun >= this.#maxRepeated) this.#stalled = true;
    return { repeated: prior.count++, unchanged };
  }

  /**
   * True once the same call was re-issued `maxRepeatedCall` times running with unchanged output,
   * or `maxConsecutiveFailures` calls failed in a row. Latched: it never returns to false.
   */
  get stalled(): boolean { return this.#stalled; }

  summary(): { rounds: number; calls: number; failures: number; repeatedCalls: number } {
    return { rounds: this.#rounds, calls: this.#calls, failures: this.#failures, repeatedCalls: this.#repeatedCalls };
  }
}
