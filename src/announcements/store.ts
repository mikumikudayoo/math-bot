import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonical,canonicalEvent,digest,eventKey,validateExtraction,validateEvent,type Catalog,type Extraction,type ScheduleEvent,type Source } from './model.js';

export interface Candidate { id:string;guild:string;batch:string;event_key:string;event_json:string;catalog_json:string;issues_json:string;confidence:string;base_revision:number;review_version:number;state:string }
export interface ApprovedEvent { event_key:string;guild:string;revision:number;event_json:string;catalog_json:string;approved_by:string;approved_at:number }
export interface Payload {content:string;allowedMentions:{parse:[];roles:string[];users:string[];repliedUser:boolean}}
export interface AnnouncementJob {id:string;guild:string;event_key:string;revision:number;policy:string;channel:string;role:string|null;due:number;expires:number;major:number;asset_policy:string;asset:string|null;payload_json:string;state:string;message:string|null;approved_by:string|null}
export class AnnouncementStore {
  readonly db:DatabaseSync;
  constructor(path:string){
    if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});this.db=new DatabaseSync(path);
    const other=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('reminders','jobs','qotd_questions','automation_events')").all();
    if(other.length){this.db.close();throw new Error('Announcement storage must be a dedicated database.');}
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS schema_version(version INTEGER PRIMARY KEY); INSERT OR IGNORE INTO schema_version VALUES(1);
      CREATE TABLE IF NOT EXISTS gmail_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,guild TEXT NOT NULL,account TEXT NOT NULL,message_id TEXT NOT NULL,hash TEXT NOT NULL,metadata TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0,UNIQUE(account,message_id));
      CREATE TABLE IF NOT EXISTS source_attachments(id TEXT PRIMARY KEY,source TEXT NOT NULL REFERENCES sources(id),hash TEXT NOT NULL,mime TEXT NOT NULL,bytes INTEGER NOT NULL,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_evidence(source TEXT PRIMARY KEY REFERENCES sources(id),evidence_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_holds(source TEXT NOT NULL REFERENCES sources(id),event_key TEXT NOT NULL REFERENCES events(event_key),PRIMARY KEY(source,event_key));
      CREATE TABLE IF NOT EXISTS candidate_batches(id TEXT PRIMARY KEY,source TEXT NOT NULL REFERENCES sources(id),hash TEXT NOT NULL,UNIQUE(source,hash));
      CREATE TABLE IF NOT EXISTS candidate_events(id TEXT PRIMARY KEY,guild TEXT NOT NULL,batch TEXT NOT NULL REFERENCES candidate_batches(id),event_key TEXT NOT NULL,event_json TEXT NOT NULL,catalog_json TEXT NOT NULL,issues_json TEXT NOT NULL,confidence TEXT NOT NULL,base_revision INTEGER NOT NULL,review_version INTEGER NOT NULL DEFAULT 1,state TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS candidate_holds ON candidate_events(guild,event_key,state);
      CREATE TABLE IF NOT EXISTS candidate_sources(candidate TEXT NOT NULL REFERENCES candidate_events(id),source TEXT NOT NULL REFERENCES sources(id),PRIMARY KEY(candidate,source));
      CREATE TABLE IF NOT EXISTS events(event_key TEXT PRIMARY KEY,guild TEXT NOT NULL,revision INTEGER NOT NULL,event_json TEXT NOT NULL,catalog_json TEXT NOT NULL,approved_by TEXT NOT NULL,approved_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS event_revisions(event_key TEXT NOT NULL REFERENCES events(event_key),revision INTEGER NOT NULL,event_json TEXT NOT NULL,catalog_json TEXT NOT NULL,actor TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(event_key,revision));
      CREATE TABLE IF NOT EXISTS announcement_assets(id TEXT PRIMARY KEY,guild TEXT NOT NULL,hash TEXT NOT NULL,path TEXT NOT NULL,mime TEXT NOT NULL,bytes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS announcement_jobs(id TEXT PRIMARY KEY,guild TEXT NOT NULL,event_key TEXT NOT NULL REFERENCES events(event_key),revision INTEGER NOT NULL,policy TEXT NOT NULL,channel TEXT NOT NULL,role TEXT,due INTEGER NOT NULL,expires INTEGER NOT NULL,major INTEGER NOT NULL,asset_policy TEXT NOT NULL,asset TEXT REFERENCES announcement_assets(id),payload_json TEXT NOT NULL,state TEXT NOT NULL,message TEXT,approved_by TEXT,held_from TEXT,UNIQUE(event_key,revision,policy,channel));
      CREATE INDEX IF NOT EXISTS announcement_due ON announcement_jobs(state,due);
      CREATE TABLE IF NOT EXISTS announcement_drafts(job TEXT PRIMARY KEY REFERENCES announcement_jobs(id),state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS delivery_attempts(job TEXT PRIMARY KEY REFERENCES announcement_jobs(id),state TEXT NOT NULL,message TEXT,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit_log(id INTEGER PRIMARY KEY,guild TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,snapshot TEXT NOT NULL,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS staff_alerts(id TEXT PRIMARY KEY,guild TEXT NOT NULL,kind TEXT NOT NULL,target TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',message TEXT,at INTEGER NOT NULL,UNIQUE(guild,kind,target));
      CREATE TABLE IF NOT EXISTS operational_incidents(guild TEXT NOT NULL,provider TEXT NOT NULL,episode TEXT NOT NULL,active INTEGER NOT NULL,last_notice INTEGER NOT NULL,count INTEGER NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(guild,provider));
      CREATE TABLE IF NOT EXISTS source_failures(source TEXT PRIMARY KEY REFERENCES sources(id),provider TEXT NOT NULL,reason TEXT NOT NULL,at INTEGER NOT NULL);`);
  }
  transaction<T>(fn:()=>T):T{if(this.state('maintenance:reset')==='true')throw new Error('Announcement storage reset in progress.');this.db.exec('BEGIN IMMEDIATE');try{const out=fn();this.db.exec('COMMIT');return out;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  audit(guild:string,actor:string,action:string,target:string,snapshot:unknown,now=Date.now()){if(!actor.trim())throw new Error('Actor required.');this.db.prepare('INSERT INTO audit_log(guild,actor,action,target,snapshot,at) VALUES(?,?,?,?,?,?)').run(guild,actor,action,target,canonical(snapshot),now);}
  state(key:string){return this.db.prepare('SELECT value FROM gmail_state WHERE key=?').get(key)?.value as string|undefined;}
  setState(key:string,value:string){this.db.prepare('INSERT INTO gmail_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value);}
  alert(guild:string,kind:string,target:string,now=Date.now()){this.db.prepare('INSERT OR IGNORE INTO staff_alerts(id,guild,kind,target,at) VALUES(?,?,?,?,?)').run(randomUUID(),guild,kind,target,now);}
  source(guild:string,source:Source){const id=digest([source.account,source.messageId]);this.db.prepare("INSERT OR IGNORE INTO sources(id,guild,account,message_id,hash,metadata,state) VALUES(?,?,?,?,?,?,'pending')").run(id,guild,source.account,source.messageId,source.sha256,canonical(source));return id;}
  sourceState(id:string,state:string,retryAt=0){this.db.prepare('UPDATE sources SET state=?,attempts=attempts+1,retry_at=? WHERE id=?').run(state,retryAt,id);}
  holdSource(guild:string,id:string){this.transaction(()=>{
    if(!this.db.prepare('SELECT id FROM sources WHERE id=? AND guild=?').get(id,guild))throw new Error('Source not found.');
    this.db.prepare('INSERT OR IGNORE INTO source_holds SELECT ?,event_key FROM events WHERE guild=?').run(id,guild);
    this.db.prepare("UPDATE announcement_jobs SET held_from=state,state='held' WHERE guild=? AND state IN ('scheduled','pending_approval','blocked')").run(guild);
  });}
  private releaseSource(id:string){const rows=this.db.prepare('SELECT event_key FROM source_holds WHERE source=?').all(id) as {event_key:string}[];this.db.prepare('DELETE FROM source_holds WHERE source=?').run(id);for(const row of rows)this.unhold(row.event_key);}
  dismissSource(guild:string,id:string,actor:string){this.transaction(()=>{
    if(!this.db.prepare("SELECT id FROM sources WHERE id=? AND guild=? AND state IN ('blocked','retry','pending')").get(id,guild))throw new Error('Source not available for disposition.');
    this.sourceState(id,'dismissed');this.releaseSource(id);this.audit(guild,actor,'dismiss-source',id,{});
  });}
  saveEvidence(source:string,evidence:unknown){const json=canonical(evidence);if(Buffer.byteLength(json)>100000)throw new Error('Source evidence too large.');this.db.prepare('INSERT INTO source_evidence VALUES(?,?) ON CONFLICT(source) DO UPDATE SET evidence_json=excluded.evidence_json').run(source,json);}
  candidates(guild:string){return this.db.prepare('SELECT * FROM candidate_events WHERE guild=? ORDER BY rowid DESC LIMIT 100').all(guild) as unknown as Candidate[];}
  candidate(guild:string,id:string){return this.db.prepare('SELECT * FROM candidate_events WHERE guild=? AND id=?').get(guild,id) as unknown as Candidate|undefined;}
  event(guild:string,key:string){return this.db.prepare('SELECT * FROM events WHERE guild=? AND event_key=?').get(guild,key) as unknown as ApprovedEvent|undefined;}
  events(guild:string){return this.db.prepare('SELECT * FROM events WHERE guild=?').all(guild) as unknown as ApprovedEvent[];}
  ingest(guild:string,input:Extraction,now=Date.now()){
    input={...input,events:input.events.map(c=>({...c,event:canonicalEvent(c.event)}))};
    if(!/^\d{17,20}$/.test(guild))throw new Error('Invalid guild.');validateExtraction(input);
    return this.transaction(()=>{
      const source=this.source(guild,input.source),hash=digest(input);
      const old=this.db.prepare('SELECT id FROM candidate_batches WHERE source=? AND hash=?').get(source,hash) as {id:string}|undefined;if(old)return old.id;
      const batch=randomUUID();this.db.prepare('INSERT INTO candidate_batches VALUES(?,?,?)').run(batch,source,hash);
      let reviews=0,corrections=0;
      for(const c of input.events){
        const key=guild+':'+eventKey(c.event),active=this.event(guild,key),json=canonical(c.event),catalog=canonical(input.catalog);
        const duplicate=this.db.prepare("SELECT id,issues_json,review_version FROM candidate_events WHERE guild=? AND event_key=? AND event_json=? AND catalog_json=? AND state='pending' LIMIT 1").get(guild,key,json,catalog) as {id:string;issues_json:string;review_version:number}|undefined;
        if(duplicate){
          const issues=canonical([...new Set([...(JSON.parse(duplicate.issues_json) as string[]),...c.issues])]);
          if(issues!==duplicate.issues_json){this.db.prepare('UPDATE candidate_events SET issues_json=?,review_version=review_version+1 WHERE id=?').run(issues,duplicate.id);reviews++;if(active)corrections++;}
          this.db.prepare('INSERT OR IGNORE INTO candidate_sources VALUES(?,?)').run(duplicate.id,source);continue;
        }
        const unchanged=active?.event_json===json&&active.catalog_json===catalog;
        const candidateId=randomUUID();this.db.prepare('INSERT INTO candidate_events(id,guild,batch,event_key,event_json,catalog_json,issues_json,confidence,base_revision,state) VALUES(?,?,?,?,?,?,?,?,?,?)').run(candidateId,guild,batch,key,json,catalog,canonical(c.issues),c.confidence,active?.revision??0,unchanged?'unchanged':'pending');
        this.db.prepare('INSERT INTO candidate_sources VALUES(?,?)').run(candidateId,source);
        if(!unchanged){this.db.prepare("UPDATE announcement_jobs SET held_from=state,state='held' WHERE event_key=? AND state IN ('scheduled','pending_approval','blocked')").run(key);reviews++;if(active)corrections++;}
      }
      if(reviews)this.alert(guild,corrections?'correction-held':'factual-review',batch,now);
      this.sourceState(source,'extracted');this.releaseSource(source);this.audit(guild,'ingestion','propose',batch,{hash},now);return batch;
    });
  }
  private pending(guild:string,id:string,version:number){const c=this.candidate(guild,id);if(!c||c.state!=='pending'||c.review_version!==version)throw new Error('Review is stale or candidate unavailable.');return c;}
  edit(guild:string,id:string,version:number,event:ScheduleEvent,issues:string[],actor:string){return this.transaction(()=>{
    event=canonicalEvent(event);
    const c=this.pending(guild,id,version);validateEvent(event,JSON.parse(c.catalog_json) as Catalog);if(guild+':'+eventKey(event)!==c.event_key)throw new Error('Identity edits require rejection and a new proposal.');
    if(!Array.isArray(issues)||issues.some(x=>typeof x!=='string'||x.length>500))throw new Error('Invalid issues.');
    this.db.prepare('UPDATE candidate_events SET event_json=?,issues_json=?,review_version=review_version+1 WHERE id=?').run(canonical(event),canonical(issues),id);this.audit(guild,actor,'edit',id,{before:c.event_json,after:event,issues});return this.candidate(guild,id)!;
  });}
  approve(guild:string,id:string,version:number,actor:string,now=Date.now()){return this.transaction(()=>{
    const c=this.pending(guild,id,version),active=this.event(guild,c.event_key);if((active?.revision??0)!==c.base_revision)throw new Error('Stale event revision; reject or rebase the proposal after inspecting the latest source.');
    if((JSON.parse(c.issues_json) as string[]).length)throw new Error('Resolve all factual issues before approval.');validateEvent(JSON.parse(c.event_json) as ScheduleEvent,JSON.parse(c.catalog_json) as Catalog,true);
    const revision=c.base_revision+1;
    this.db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?) ON CONFLICT(event_key) DO UPDATE SET revision=excluded.revision,event_json=excluded.event_json,catalog_json=excluded.catalog_json,approved_by=excluded.approved_by,approved_at=excluded.approved_at').run(c.event_key,guild,revision,c.event_json,c.catalog_json,actor,now);
    this.db.prepare('INSERT INTO event_revisions VALUES(?,?,?,?,?,?)').run(c.event_key,revision,c.event_json,c.catalog_json,actor,now);
    this.db.prepare("UPDATE candidate_events SET state='approved' WHERE id=?").run(id);
    this.db.prepare("UPDATE announcement_jobs SET state='superseded' WHERE event_key=? AND state IN ('scheduled','held','pending_approval','blocked','draft')").run(c.event_key);
    if(this.db.prepare("SELECT id FROM announcement_jobs WHERE event_key=? AND state IN ('sent','delivering','uncertain') LIMIT 1").get(c.event_key))this.alert(guild,'correction-after-send',`${c.event_key}:${revision}`,now);
    this.audit(guild,actor,'approve-facts',id,{revision,event:c.event_json},now);return this.event(guild,c.event_key)!;
  });}
  reject(guild:string,id:string,version:number,actor:string){this.transaction(()=>{const c=this.pending(guild,id,version);this.db.prepare("UPDATE candidate_events SET state='rejected' WHERE id=?").run(id);this.audit(guild,actor,'reject',id,{});this.unhold(c.event_key);});}
  private unhold(key:string){if(!this.held(key))this.db.prepare("UPDATE announcement_jobs SET state=COALESCE(held_from,'blocked'),held_from=NULL WHERE event_key=? AND state='held'").run(key);}
  cancel(guild:string,key:string,status:'cancelled'|'postponed',actor:string,expectedRevision:number){return this.transaction(()=>{
    const e=this.event(guild,key);if(!e||e.revision!==expectedRevision)throw new Error('Event revision is stale.');const event={...JSON.parse(e.event_json) as ScheduleEvent,status,start:null,end:null,deadline:null};
    const revision=e.revision+1;this.db.prepare('UPDATE events SET revision=?,event_json=?,approved_by=?,approved_at=? WHERE event_key=?').run(revision,canonical(event),actor,Date.now(),key);this.db.prepare('INSERT INTO event_revisions VALUES(?,?,?,?,?,?)').run(key,revision,canonical(event),e.catalog_json,actor,Date.now());
    this.db.prepare("UPDATE announcement_jobs SET state='cancelled' WHERE event_key=? AND state IN ('scheduled','held','pending_approval','blocked','draft')").run(key);this.alert(guild,'cancellation-review',`${key}:${revision}`);this.audit(guild,actor,status,key,event);return this.event(guild,key)!;
  });}
  held(key:string){return Boolean(this.db.prepare("SELECT id FROM candidate_events WHERE event_key=? AND state='pending'").get(key)||this.db.prepare('SELECT source FROM source_holds WHERE event_key=?').get(key));}
  jobs(guild:string){return this.db.prepare('SELECT * FROM announcement_jobs WHERE guild=? ORDER BY due DESC LIMIT 100').all(guild) as unknown as AnnouncementJob[];}
  dueJobs(guild:string,now:number){return this.db.prepare("SELECT * FROM announcement_jobs WHERE guild=? AND state='scheduled' AND due<=? ORDER BY due,id LIMIT 25").all(guild,now) as unknown as AnnouncementJob[];}
  job(guild:string,id:string){return this.db.prepare('SELECT * FROM announcement_jobs WHERE guild=? AND id=?').get(guild,id) as unknown as AnnouncementJob|undefined;}
  addJob(job:Omit<AnnouncementJob,'id'|'asset'|'message'|'approved_by'>){const id=randomUUID();this.db.prepare('INSERT OR IGNORE INTO announcement_jobs(id,guild,event_key,revision,policy,channel,role,due,expires,major,asset_policy,payload_json,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,job.guild,job.event_key,job.revision,job.policy,job.channel,job.role,job.due,job.expires,job.major,job.asset_policy,job.payload_json,job.state);const row=this.db.prepare('SELECT * FROM announcement_jobs WHERE event_key=? AND revision=? AND policy=? AND channel=?').get(job.event_key,job.revision,job.policy,job.channel) as unknown as AnnouncementJob;return row;}
  approveJob(guild:string,id:string,actor:string,expectedHash:string){this.transaction(()=>{
    const j=this.job(guild,id),e=j?this.event(guild,j.event_key):undefined;if(!j||j.state!=='pending_approval'||!e||e.revision!==j.revision||this.held(j.event_key)||digest([j.payload_json,j.asset])!==expectedHash)throw new Error('Message preview is stale or held.');
    if(j.asset_policy==='required'&&!j.asset)throw new Error('Canva asset is required before approval.');
    this.db.prepare("UPDATE announcement_jobs SET state='scheduled',approved_by=? WHERE id=?").run(actor,id);this.audit(guild,actor,'approve-message',id,{hash:expectedHash});
  });}
  attach(guild:string,jobId:string,asset:{hash:string;path:string;mime:string;bytes:number},actor:string){this.transaction(()=>{
    const j=this.job(guild,jobId);if(!j||!j.major||!['pending_approval','blocked'].includes(j.state))throw new Error('Attach media to an unapproved major post.');const id=randomUUID();this.db.prepare('INSERT INTO announcement_assets VALUES(?,?,?,?,?,?)').run(id,guild,asset.hash,asset.path,asset.mime,asset.bytes);this.db.prepare("UPDATE announcement_jobs SET asset=?,approved_by=NULL,state='pending_approval' WHERE id=?").run(id,jobId);this.audit(guild,actor,'attach',jobId,{hash:asset.hash});
  });}
  asset(guild:string,id:string){return this.db.prepare('SELECT path,hash,mime FROM announcement_assets WHERE guild=? AND id=?').get(guild,id) as {path:string;hash:string;mime:string}|undefined;}
  claim(id:string,now=Date.now()){return this.transaction(()=>{
    const j=this.db.prepare('SELECT * FROM announcement_jobs WHERE id=?').get(id) as unknown as AnnouncementJob|undefined;if(!j||j.state!=='scheduled'||j.due>now)return undefined;
    const e=this.event(j.guild,j.event_key);if(!e||e.revision!==j.revision||this.held(j.event_key)){this.db.prepare("UPDATE announcement_jobs SET state='held' WHERE id=?").run(id);return undefined;}
    if((JSON.parse(e.event_json) as ScheduleEvent).status && (JSON.parse(e.event_json) as ScheduleEvent).status!=='active'){this.db.prepare("UPDATE announcement_jobs SET state='cancelled' WHERE id=?").run(id);return undefined;}
    if(now>j.expires){this.db.prepare("UPDATE announcement_jobs SET state='skipped' WHERE id=?").run(id);this.alert(j.guild,'missed-reminder',id);return undefined;}
    this.db.prepare("UPDATE announcement_jobs SET state='delivering' WHERE id=? AND state='scheduled'").run(id);this.db.prepare("INSERT INTO delivery_attempts VALUES(?,'reserved',NULL,?)").run(id,now);return j;
  });}
  finish(j:AnnouncementJob,message:string|null){this.transaction(()=>{this.db.prepare('UPDATE delivery_attempts SET state=?,message=? WHERE job=?').run(message?'sent':'uncertain',message,j.id);this.db.prepare("UPDATE announcement_jobs SET state=?,message=? WHERE id=? AND state='delivering'").run(message?'sent':'uncertain',message,j.id);if(!message)this.alert(j.guild,'uncertain-delivery',j.id);});}
  reconcile(guild:string,id:string,message:string|null,actor:string){this.transaction(()=>{const j=this.job(guild,id);if(!j||!['uncertain','delivering'].includes(j.state))throw new Error('Only uncertain deliveries can be reconciled.');this.db.prepare('UPDATE announcement_jobs SET state=?,message=? WHERE id=?').run(message?'sent':'cancelled',message,id);this.audit(guild,actor,'reconcile',id,{message});});}
  close(){this.db.close();}
}
