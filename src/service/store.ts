import { DatabaseSync } from 'node:sqlite';
import type { Job, Submission, Result } from './types.js';
import { UserError } from './types.js';

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings(guild TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, guild TEXT NOT NULL, channel TEXT NOT NULL,
        user TEXT NOT NULL, coach INTEGER NOT NULL, kind TEXT NOT NULL, prompt TEXT NOT NULL,
        parent TEXT, image TEXT, state TEXT NOT NULL, status TEXT NOT NULL, answer TEXT NOT NULL DEFAULT '',
        artifact TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL, message TEXT NOT NULL DEFAULT '', delivered INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS job_queue ON jobs(state, created);
      CREATE INDEX IF NOT EXISTS job_message ON jobs(guild, channel, message);
      CREATE TABLE IF NOT EXISTS rules(id INTEGER PRIMARY KEY, guild TEXT NOT NULL, term TEXT NOT NULL, action TEXT NOT NULL, UNIQUE(guild, term));
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, guild TEXT NOT NULL, actor TEXT NOT NULL, event TEXT NOT NULL, created INTEGER NOT NULL);`);
    if(!this.db.prepare('PRAGMA table_info(jobs)').all().some(row=>row.name==='discordContext'))this.db.exec("ALTER TABLE jobs ADD COLUMN discordContext TEXT NOT NULL DEFAULT '{}'");
  }
  get(id: string): Job | undefined { return this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as unknown as Job | undefined; }
  enabled(guild: string) { return (this.db.prepare('SELECT enabled FROM settings WHERE guild=?').get(guild)?.enabled ?? 1) === 1; }
  setEnabled(guild: string, enabled: boolean, actor: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(guild) DO UPDATE SET enabled=excluded.enabled').run(guild, +enabled);
      this.audit(guild, actor, enabled ? 'ai enabled' : 'ai disabled');
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  audit(guild: string, actor: string, event: string) {
    this.db.prepare('INSERT INTO audit(guild,actor,event,created) VALUES(?,?,?,?)').run(guild, actor, event.slice(0, 1000), Date.now());
  }
  admit(input: Submission, limit: number) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.get(input.id);
      if (existing) {
        if (existing.user !== input.user || existing.guild !== input.guild || existing.channel !== input.channel) throw new UserError('Request ID already used.');
        this.db.exec('COMMIT'); return existing;
      }
      if (!this.enabled(input.guild)) throw new UserError('AI assistance is currently disabled. Already accepted requests will finish.');
      const count = this.db.prepare("SELECT count(*) AS n FROM jobs WHERE state IN ('queued','running')").get()!.n as number;
      if (count >= limit) throw new UserError('The queue is full. Please try again later.');
      const mine = this.db.prepare("SELECT count(*) AS n FROM jobs WHERE user=? AND guild=? AND state IN ('queued','running')").get(input.user, input.guild)!.n as number;
      if (mine >= 2) throw new UserError('You already have two accepted requests. Please wait or cancel one.');
      if (input.parent) {
        const parent = this.get(input.parent);
        if (!parent || parent.guild !== input.guild || parent.channel !== input.channel || parent.user !== input.user || parent.state !== 'completed') throw new UserError('Reply to your own completed answer in this channel.');
      }
      this.db.prepare(`INSERT INTO jobs(id,guild,channel,user,coach,kind,prompt,parent,image,state,status,created)
        VALUES(?,?,?,?,?,?,?,?,?,'queued','queued',?)`).run(input.id,input.guild,input.channel,input.user,+input.coach,input.kind,input.prompt,input.parent ?? null,input.image ?? null,Date.now());
      this.db.prepare('UPDATE jobs SET discordContext=? WHERE id=?').run(input.discordContext??'{}',input.id);
      this.db.exec('COMMIT'); return this.get(input.id)!;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  recover() { this.db.exec("UPDATE jobs SET state='queued',status='queued after service restart' WHERE state='running'"); }
  requeue(id:string) { this.db.prepare("UPDATE jobs SET state='queued',status='queued after service restart' WHERE id=? AND state='running'").run(id); }
  queued() { return this.db.prepare("SELECT * FROM jobs WHERE state='queued' ORDER BY coach DESC,created,id").all() as unknown as Job[]; }
  running(id: string) { this.db.prepare("UPDATE jobs SET state='running',status='thinking' WHERE id=? AND state='queued'").run(id); }
  status(id: string, status: string) { this.db.prepare("UPDATE jobs SET status=? WHERE id=? AND state='running'").run(status,id); }
  complete(id: string, result: Result) { this.db.prepare("UPDATE jobs SET state='completed',status='completed',answer=?,artifact=? WHERE id=? AND state='running'").run(result.answer.slice(0, 24000),result.artifact ?? '',id); }
  fail(id: string, message: string) { this.db.prepare("UPDATE jobs SET state='failed',status='failed',answer=? WHERE id=? AND state='running'").run(message,id); }
  cancel(id: string) { this.db.prepare("UPDATE jobs SET state='cancelled',status='cancelled',answer='Request cancelled.' WHERE id=? AND state IN ('running','queued')").run(id); }
  bind(id: string, message: string) { this.db.prepare('UPDATE jobs SET message=? WHERE id=?').run(message,id); }
  delivered(id: string) { this.db.prepare('UPDATE jobs SET delivered=1 WHERE id=?').run(id); }
  pending() { return this.db.prepare("SELECT * FROM jobs WHERE message != '' AND delivered=0 ORDER BY created LIMIT 100").all() as unknown as Job[]; }
  byMessage(guild: string, channel: string, message: string) { return this.db.prepare('SELECT * FROM jobs WHERE guild=? AND channel=? AND message=?').get(guild,channel,message) as unknown as Job | undefined; }
  history(job: Job) {
    const history: Job[] = []; let parent = job.parent;
    for (let i=0; parent && i<8; i++) {
      const row = this.get(parent);
      if (!row || row.guild !== job.guild || row.channel !== job.channel || row.user !== job.user) break;
      history.unshift(row); parent = row.parent;
    }
    return history;
  }
  rules(guild: string) { return this.db.prepare('SELECT id,term,action FROM rules WHERE guild=? ORDER BY id').all(guild) as unknown as {id:number;term:string;action:'flag'|'delete'}[]; }
  addRule(guild: string, term: string, action: string) {
    if (this.rules(guild).length >= 100) throw new UserError('Maximum 100 rules per server.');
    this.db.prepare('INSERT INTO rules(guild,term,action) VALUES(?,?,?) ON CONFLICT(guild,term) DO UPDATE SET action=excluded.action').run(guild,term,action);
  }
  removeRule(guild: string, id: number) { this.db.prepare('DELETE FROM rules WHERE guild=? AND id=?').run(guild,id); }
  close() { this.db.close(); }
}
