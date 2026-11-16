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

  emit(job: string, type: JobEventType, data: JobEventData = {}, streamText?: string): JobEvent {
    const clean: JobEventData = {};
    if (typeof data.label === 'string' && LABEL.test(data.label)) clean.label = data.label;
    if (typeof data.ok === 'boolean') clean.ok = data.ok;
    for (const key of ['count', 'attempt'] as const) if (Number.isSafeInteger(data[key])) clean[key] = data[key]!;
    if (typeof data.effort === 'string' && LABEL.test(data.effort)) clean.effort = data.effort;
    const at = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.db.prepare('SELECT seq,phase FROM job_progress WHERE job=?').get(job) as {seq:number;phase:JobEventType} | undefined;
      if (previous && ['completed','failed','cancelled'].includes(previous.phase)) {
        const last = this.since(job,previous.seq-1,1)[0]!;
        this.db.exec('COMMIT');
        return last;
      }
      const seq = (previous?.seq ?? 0) + 1;
      this.db.prepare('INSERT INTO job_events(job,seq,type,at,data) VALUES(?,?,?,?,?)').run(job, seq, type, at, JSON.stringify(clean));
      // A new non-delta phase never clears streamed text; terminal events do.
      const clear = type === 'completed' || type === 'failed' || type === 'cancelled' || type === 'started';
      this.db.prepare(`INSERT INTO job_progress(job,seq,phase,label,stream,updated) VALUES(?,?,?,?,'',?)
        ON CONFLICT(job) DO UPDATE SET seq=excluded.seq,phase=excluded.phase,label=excluded.label,updated=excluded.updated${clear ? ",stream=''" : ''}`)
        .run(job, seq, type, clean.label ?? '', at);
      if (type === 'output_delta' && streamText !== undefined) {
        this.db.prepare('UPDATE job_progress SET stream=? WHERE job=?').run(streamText.slice(0, 6000), job);
      }
      this.db.exec('COMMIT');
      if (clear) this.lastStreamWrite.delete(job);
      return {job, seq, type, at, data: clean};
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  /** Replace the display-safe partial answer. Writes are throttled; `force` flushes. */
  stream(job: string, text: string, force = false) {
    const at = this.now();
    const last = this.lastStreamWrite.get(job);
    if (!force && last !== undefined && at - last < this.streamIntervalMs) return false;
    const terminal = this.db.prepare("SELECT 1 FROM job_progress WHERE job=? AND phase IN ('cancelled','completed','failed')").get(job);
    if (terminal) return false;
    this.emit(job, 'output_delta', {}, text);
    this.lastStreamWrite.set(job, at);
    return true;
  }
  /** Withdraw streamed text (e.g. the draft failed a validation and will be regenerated). */
  retract(job: string) {
    if (this.db.prepare("SELECT 1 FROM job_progress WHERE job=? AND stream<>''").get(job)) this.stream(job, '', true);
    this.lastStreamWrite.delete(job);
  }

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
  /** Repair the small crash window between persisting the queue transition and its event. */
  recover() {
    const rows=this.db.prepare(`SELECT jobs.id,jobs.state FROM jobs JOIN job_progress ON job_progress.job=jobs.id
      WHERE (jobs.state IN ('completed','failed','cancelled') AND job_progress.phase<>jobs.state)
         OR (jobs.state='queued' AND job_progress.stream<>'')`).all();
    for (const row of rows) {
      const id=String(row.id);
      if (row.state==='queued') this.retract(id);
      else if (row.state==='completed' || row.state==='failed' || row.state==='cancelled') this.emit(id,row.state);
    }
  }

  /** Drop events of jobs delivered long ago; keep active cursors through a bot disconnect. */
  prune(olderThanMs = 86_400_000) {
    const cutoff = this.now() - olderThanMs;
    this.db.prepare('DELETE FROM job_events WHERE at<? AND job IN (SELECT id FROM jobs WHERE delivered=1)').run(cutoff);
    this.db.prepare('DELETE FROM job_progress WHERE updated<? AND job IN (SELECT id FROM jobs WHERE delivered=1)').run(cutoff);
  }
}
