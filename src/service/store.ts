import { DatabaseSync } from 'node:sqlite';
import type { Job, Submission, Result } from './types.js';
import { discordIntent } from '../discord-context.js';
import { UserError } from './types.js';
import {mergeProvenance,rowProvenance,readProvenance,type Provenance} from './provenance.js';

import { snapshotProvenance, type ContextSnapshot } from './context-snapshot.js';

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
      CREATE TABLE IF NOT EXISTS tool_attempts(job TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(job,digest));
      CREATE TABLE IF NOT EXISTS delivery_parts(job TEXT NOT NULL, part INTEGER NOT NULL, message TEXT NOT NULL,
        PRIMARY KEY(job,part), UNIQUE(message));
      CREATE TABLE IF NOT EXISTS rules(id INTEGER PRIMARY KEY, guild TEXT NOT NULL, term TEXT NOT NULL, action TEXT NOT NULL, UNIQUE(guild, term));
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, guild TEXT NOT NULL, actor TEXT NOT NULL, event TEXT NOT NULL, created INTEGER NOT NULL);`);
    if(!this.db.prepare('PRAGMA table_info(jobs)').all().some(row=>row.name==='discordContext'))this.db.exec("ALTER TABLE jobs ADD COLUMN discordContext TEXT NOT NULL DEFAULT '{}'");
    if(!this.db.prepare('PRAGMA table_info(jobs)').all().some(row=>row.name==='sourceMessageId'))
      this.db.exec("ALTER TABLE jobs ADD COLUMN sourceMessageId TEXT");
    for(const column of ['images','retrievalContext'])if(!this.db.prepare('PRAGMA table_info(jobs)').all().some(row=>row.name===column))this.db.exec(`ALTER TABLE jobs ADD COLUMN ${column} TEXT NOT NULL DEFAULT '[]'`);
    if(!this.db.prepare('PRAGMA table_info(jobs)').all().some(row=>row.name==='provenance'))this.db.exec("ALTER TABLE jobs ADD COLUMN provenance TEXT NOT NULL DEFAULT '{}'");
    const columns = new Set(this.db.prepare('PRAGMA table_info(jobs)').all().map(row => row.name));
    for (const column of ['context', 'protectionVersion']) {
      if (!columns.has(column)) this.db.exec(`ALTER TABLE jobs ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
    }
    if (!columns.has('recoverDelivery')) this.db.exec('ALTER TABLE jobs ADD COLUMN recoverDelivery INTEGER NOT NULL DEFAULT 0');
    // Repair old unlabelled descendants using host ancestry, never answer text.
    const legacy=this.db.prepare(`WITH RECURSIVE private_jobs(id) AS (
      SELECT id FROM jobs WHERE CASE WHEN json_valid(retrievalContext) THEN json_extract(retrievalContext,'$.kind')='discord' ELSE 0 END
      OR CASE WHEN json_valid(provenance) THEN json_extract(provenance,'$.classification')='private-discord' ELSE 0 END
      UNION SELECT child.id FROM jobs child JOIN jobs parent ON child.parent=parent.id JOIN private_jobs p ON p.id=parent.id
      WHERE child.guild=parent.guild AND child.channel=parent.channel AND child.user=parent.user
      AND COALESCE(CASE WHEN json_valid(child.provenance) THEN json_extract(child.provenance,'$.version')=1 AND json_extract(child.provenance,'$.classification')='public' ELSE 0 END,0)=0
    ) SELECT j.* FROM jobs j JOIN private_jobs p ON p.id=j.id ORDER BY j.rowid`).all() as unknown as Job[];
    const inherited=new Map<string,Provenance>();
    for(const row of legacy){
      const value=mergeProvenance(rowProvenance(row),...(row.parent&&inherited.has(row.parent)?[inherited.get(row.parent)!]:[]));
      inherited.set(row.id,value);this.db.prepare('UPDATE jobs SET provenance=? WHERE id=?').run(JSON.stringify(value),row.id);
    }
  }
  previousLookupMessageIds(job:Job):string[]{
    const rows=this.db.prepare(
      'SELECT id,sourceMessageId,prompt FROM jobs WHERE guild=? AND user=? AND id<>? ORDER BY created DESC LIMIT 500'
    ).all(job.guild,job.user,job.id) as {
      id:string;sourceMessageId:string|null;prompt:string
    }[];
    return rows
      .filter(row=>discordIntent(row.prompt)==='discord_search')
      .map(row=>row.sourceMessageId??row.id)
      .filter(id=>/^\d{17,20}$/.test(id))
      .slice(0,100);
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
      this.db.prepare('UPDATE jobs SET sourceMessageId=?,recoverDelivery=1 WHERE id=?').run(input.sourceMessageId??null,input.id);
      this.db.prepare('UPDATE jobs SET images=? WHERE id=?').run(input.images??'[]',input.id);
      if (input.context) {
        const provenance = snapshotProvenance(JSON.parse(input.context) as ContextSnapshot, input.guild);
        this.db.prepare('UPDATE jobs SET context=?,provenance=? WHERE id=?').run(input.context, JSON.stringify(provenance), input.id);
      }
      this.db.exec('COMMIT'); return this.get(input.id)!;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  recover() { this.db.exec("UPDATE jobs SET state='queued',status='queued after service restart' WHERE state='running'"); }
  defer(id:string,retryAt:number){
    if(!this.db.prepare('PRAGMA table_info(jobs)').all().some(r=>r.name==='ready_at'))this.db.exec('ALTER TABLE jobs ADD COLUMN ready_at INTEGER NOT NULL DEFAULT 0');
    if(!this.db.prepare('PRAGMA table_info(jobs)').all().some(r=>r.name==='provider_attempts'))this.db.exec('ALTER TABLE jobs ADD COLUMN provider_attempts INTEGER NOT NULL DEFAULT 0');
    const attempts=Number(this.db.prepare('SELECT provider_attempts FROM jobs WHERE id=?').get(id)?.provider_attempts??0);
    const next=Math.max(retryAt,Date.now()+Math.min(3600000,1000*2**Math.min(attempts,12)));
    this.db.prepare("UPDATE jobs SET state='queued',status='queued for provider recovery',ready_at=?,provider_attempts=provider_attempts+1 WHERE id=? AND state='running'").run(next,id);
  }
  requeue(id:string) { this.db.prepare("UPDATE jobs SET state='queued',status='queued after service restart' WHERE id=? AND state='running'").run(id); }
  queued() { const deferred=this.db.prepare('PRAGMA table_info(jobs)').all().some(r=>r.name==='ready_at');return this.db.prepare(`SELECT * FROM jobs WHERE state='queued' ${deferred?'AND ready_at<=?':''} ORDER BY coach DESC,created,id`).all(...(deferred?[Date.now()]:[])) as unknown as Job[]; }
  running(id: string) { this.db.prepare("UPDATE jobs SET state='running',status='thinking' WHERE id=? AND state='queued'").run(id); }
  status(id: string, status: string) { this.db.prepare("UPDATE jobs SET status=? WHERE id=? AND state='running'").run(status,id); }
  markProtectionVersion(id: string, version: string) {
    this.db.prepare('UPDATE jobs SET protectionVersion=? WHERE id=?').run(version, id);
  }
  /** An ambiguous attempt after a worker restart must not dispatch the same side effect again. */
  claimToolAttempt(id: string, digest: string): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO tool_attempts(job,digest) VALUES(?,?)').run(id,digest).changes === 1;
  }
  deliveryParts(id: string): string[] {
    return this.db.prepare('SELECT message FROM delivery_parts WHERE job=? ORDER BY part').all(id).map(row => String(row.message));
  }
  bindDeliveryPart(id: string, index: number, message: string, previous?: string) {
    if (!Number.isSafeInteger(index) || index < 1 || index > 64) throw new UserError('Invalid continuation index.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const job = this.get(id);
      if (!job?.message || !['completed','failed','cancelled'].includes(job.state) || message === job.message) throw new UserError('Invalid delivery.');
      const parts = this.deliveryParts(id);
      if (parts[index - 1] !== message) {
        if (job.delivered || parts.includes(message)) throw new UserError('Continuation conflicts with existing delivery.');
        if (previous && previous === parts[index - 1]) {
          this.db.prepare('UPDATE delivery_parts SET message=? WHERE job=? AND part=? AND message=?').run(message,id,index,previous);
        } else if (!previous && index === parts.length + 1) {
          this.db.prepare('INSERT INTO delivery_parts(job,part,message) VALUES (?,?,?)').run(id,index,message);
        } else throw new UserError('Continuation conflicts with existing delivery.');
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  markProvenance(id:string,value:Provenance){const current=this.get(id);if(!current)return;this.db.prepare('UPDATE jobs SET provenance=? WHERE id=?').run(JSON.stringify(mergeProvenance(rowProvenance(current),value)),id);}
  complete(id: string, result: Result) {
    const current=this.get(id);const provenance=mergeProvenance(readProvenance(result.provenance),...(current?[rowProvenance(current)]:[]));
    this.db.prepare("UPDATE jobs SET state='completed',status='completed',answer=?,artifact=?,retrievalContext=?,provenance=? WHERE id=? AND state='running'").run(result.answer.slice(0, 24000),result.artifact ?? '',result.retrievalContext??'[]',JSON.stringify(provenance),id);
  }
  fail(id: string, message: string) { this.db.prepare("UPDATE jobs SET state='failed',status='failed',answer=? WHERE id=? AND state='running'").run(message,id); }
  cancel(id: string) { this.db.prepare("UPDATE jobs SET state='cancelled',status='cancelled',answer='Request cancelled.' WHERE id=? AND state IN ('running','queued')").run(id); }
  bind(id: string, message: string) {
    const result=this.db.prepare("UPDATE jobs SET message=? WHERE id=? AND (message='' OR message=?)").run(message,id,message);
    if (result.changes) return {ok:true, message};
    const job=this.get(id);
    if (!job) throw new UserError('Unknown job.');
    return {ok:false, message:job.message};
  }
  unbound() {
    return this.db.prepare("SELECT * FROM jobs WHERE recoverDelivery=1 AND message='' AND delivered=0 AND created<? ORDER BY created LIMIT 50").all(Date.now()-15_000) as unknown as Job[];
  }
  delivered(id: string) { this.db.prepare('UPDATE jobs SET delivered=1 WHERE id=?').run(id); }
  pending() { return this.db.prepare("SELECT * FROM jobs WHERE message != '' AND delivered=0 ORDER BY created LIMIT 100").all() as unknown as Job[]; }
  byMessage(guild: string, channel: string, message: string) {
    return this.db.prepare('SELECT j.* FROM jobs j WHERE guild=? AND channel=? AND (message=? OR id IN (SELECT job FROM delivery_parts WHERE message=?))').get(guild,channel,message,message) as unknown as Job | undefined;
  }
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
