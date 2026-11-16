import type { DatabaseSync } from 'node:sqlite';

/**
 * Structured per-job progress events (Aleph-Zero v2). Events are isolated by job ID,
 * persisted in the AI-service database so a bot reconnect or service restart can resume,
 * and never contain hidden reasoning, private context or unverified tool output.
 * The bot renders them; it never receives anything it may not show publicly.
 */
export const JOB_EVENT_TYPES = ['started', 'thinking', 'tool_started', 'tool_completed', 'consultation_requested', 'consultation_approved',
  'consultation_denied', 'consultation_completed', 'reasoning_summary', 'output_delta', 'image_inspection', 'seven_agents',
  'limit_assessment', 'completed', 'failed', 'cancelled'] as const;
export type JobEventType = typeof JOB_EVENT_TYPES[number];

/** Public, display-safe detail. `label` is a machine key (tool name, specialist, agent), never user text. */
export interface JobEventData { label?: string; ok?: boolean; count?: number; attempt?: number; effort?: string }
export interface JobEvent { job: string; seq: number; type: JobEventType; at: number; data: JobEventData }

/**
 * Snapshot the bot polls (`GET /pending` rows carry it as `progress`).
 * `stream` is the display-safe partial final answer (empty until streaming is allowed for
 * this job); `recent` is the last few events, oldest first, for the progress line.
 */
export interface JobProgress { job: string; seq: number; phase: JobEventType; label: string; stream: string; recent: JobEvent[]; updated: number }

const LABEL = /^[a-z0-9_.:-]{0,48}$/i;

export class JobEvents {
  private lastStreamWrite = new Map<string, number>();
  constructor(readonly db: DatabaseSync, readonly now: () => number = Date.now, readonly streamIntervalMs = 400) {
    db.exec(`CREATE TABLE IF NOT EXISTS job_events(job TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, at INTEGER NOT NULL,
        data TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(job, seq));
      CREATE TABLE IF NOT EXISTS job_progress(job TEXT PRIMARY KEY, seq INTEGER NOT NULL, phase TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
        stream TEXT NOT NULL DEFAULT '', updated INTEGER NOT NULL);`);
  }

  emit(job: string, type: JobEventType, data: JobEventData = {}): JobEvent {
    const clean: JobEventData = {};
    if (typeof data.label === 'string' && LABEL.test(data.label)) clean.label = data.label;
    if (typeof data.ok === 'boolean') clean.ok = data.ok;
    for (const key of ['count', 'attempt'] as const) if (Number.isSafeInteger(data[key])) clean[key] = data[key]!;
    if (typeof data.effort === 'string' && LABEL.test(data.effort)) clean.effort = data.effort;
    const at = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const seq = Number((this.db.prepare('SELECT coalesce(max(seq),0)+1 AS n FROM job_events WHERE job=?').get(job) as {n: number}).n);
      this.db.prepare('INSERT INTO job_events(job,seq,type,at,data) VALUES(?,?,?,?,?)').run(job, seq, type, at, JSON.stringify(clean));
      // A new non-delta phase never clears streamed text; terminal events do.
      const terminal = type === 'completed' || type === 'failed' || type === 'cancelled';
      this.db.prepare(`INSERT INTO job_progress(job,seq,phase,label,stream,updated) VALUES(?,?,?,?,'',?)
        ON CONFLICT(job) DO UPDATE SET seq=excluded.seq,phase=excluded.phase,label=excluded.label,updated=excluded.updated${terminal ? ",stream=''" : ''}`)
        .run(job, seq, type, clean.label ?? '', at);
      this.db.exec('COMMIT');
      if (terminal) this.lastStreamWrite.delete(job);
      return {job, seq, type, at, data: clean};
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  /** Replace the display-safe partial answer. Writes are throttled; `force` flushes. */
  stream(job: string, text: string, force = false) {
    const at = this.now();
    if (!force && at - (this.lastStreamWrite.get(job) ?? 0) < this.streamIntervalMs) return false;
    this.lastStreamWrite.set(job, at);
    this.db.prepare('UPDATE job_progress SET stream=?,updated=? WHERE job=?').run(text.slice(0, 6000), at, job);
    return true;
  }
  /** Withdraw streamed text (e.g. the draft failed a validation and will be regenerated). */
  retract(job: string) { this.lastStreamWrite.delete(job); this.db.prepare("UPDATE job_progress SET stream='',updated=? WHERE job=?").run(this.now(), job); }

  since(job: string, after = 0, limit = 200): JobEvent[] {
    return (this.db.prepare('SELECT job,seq,type,at,data FROM job_events WHERE job=? AND seq>? ORDER BY seq LIMIT ?').all(job, after, limit) as unknown as (Omit<JobEvent, 'data'> & {data: string})[])
      .map(row => ({...row, data: JSON.parse(row.data) as JobEventData}));
  }
  progress(job: string): JobProgress | undefined {
    const row = this.db.prepare('SELECT job,seq,phase,label,stream,updated FROM job_progress WHERE job=?').get(job) as unknown as Omit<JobProgress, 'recent'> | undefined;
    if (!row) return undefined;
    const recent = (this.db.prepare('SELECT job,seq,type,at,data FROM job_events WHERE job=? ORDER BY seq DESC LIMIT 4').all(job) as unknown as (Omit<JobEvent, 'data'> & {data: string})[])
      .reverse().map(r => ({...r, data: JSON.parse(r.data) as JobEventData}));
    return {...row, recent};
  }
  /** Drop events of jobs finished long ago; progress rows of delivered jobs. */
  prune(olderThanMs = 86_400_000) {
    const cutoff = this.now() - olderThanMs;
    this.db.prepare('DELETE FROM job_events WHERE at<?').run(cutoff);
    this.db.prepare('DELETE FROM job_progress WHERE updated<?').run(cutoff);
  }
}
