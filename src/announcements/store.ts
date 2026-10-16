import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonical,canonicalEvent,digest,eventKey,validateExtraction,validateEvent,type Catalog,type Extraction,type ScheduleEvent,type Source } from './model.js';
import {validatePublicText,validatePublicDiscordPayload,sanitizeOrganizerEvidence} from './public-facts.js';
import { effectivePolicy,isEffectivePolicy,projectDelivery,type EffectivePolicySnapshot } from './delivery-identity.js';
import {normalizeCatalogAndEvents,catalogForEvent,semanticIssues,entityEvidenceIssues,sourceDispositions,type SourceDisposition,type SemanticContext} from './semantics.js';

export interface Candidate { id:string;public_id:number;guild:string;batch:string;event_key:string;event_json:string;catalog_json:string;issues_json:string;confidence:string;base_revision:number;review_version:number;state:string;public_safety_version:number;fact_semantics_version:number;evidence_ids_json:string;timezone_confirmed:number }
export interface ApprovedEvent { event_key:string;guild:string;revision:number;event_json:string;catalog_json:string;approved_by:string;approved_at:number;public_safety_version:number;fact_semantics_version:number }
export interface Payload {content:string;allowedMentions:{parse:[];roles:string[];users:string[];repliedUser:boolean}}
export interface AnnouncementJob {id:string;guild:string;event_key:string;revision:number;policy:string;channel:string;role:string|null;due:number;expires:number;major:number;asset_policy:string;asset:string|null;payload_json:string;state:string;message:string|null;approved_by:string|null;public_safety_version?:number;logical_delivery_id?:string|null;rule_id?:string|null;policy_revision?:number|null;plan_hash?:string|null;approved_payload_hash?:string|null}
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
    // Retain tombstones: deleting a candidate must never recycle its moderator number.
    this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS candidate_public_ids(public_id INTEGER PRIMARY KEY AUTOINCREMENT,candidate TEXT NOT NULL UNIQUE);
      INSERT INTO candidate_public_ids(candidate) SELECT id FROM candidate_events WHERE id NOT IN (SELECT candidate FROM candidate_public_ids) ORDER BY rowid;
      CREATE TRIGGER IF NOT EXISTS candidate_public_id_insert AFTER INSERT ON candidate_events BEGIN
        INSERT INTO candidate_public_ids(candidate) VALUES(NEW.id);
      END;
      INSERT OR IGNORE INTO schema_version VALUES(2);
      COMMIT;`);
    this.db.exec('BEGIN IMMEDIATE');
    try{
      for(const table of ['candidate_events','events','announcement_jobs']){
        if(!this.db.prepare(`PRAGMA table_info(${table})`).all().some(c=>c.name==='public_safety_version')){
          this.db.exec(`ALTER TABLE ${table} ADD COLUMN public_safety_version INTEGER NOT NULL DEFAULT 0`);
          if(table==='announcement_jobs')this.db.exec("UPDATE announcement_jobs SET state='blocked',approved_by=NULL WHERE state IN ('scheduled','held','pending_approval','blocked','draft')");
        }
      }
      this.db.exec('INSERT OR IGNORE INTO schema_version VALUES(3); COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const columns=this.db.prepare('PRAGMA table_info(announcement_jobs)').all();
      for(const [name,type] of [['logical_delivery_id','TEXT'],['rule_id','TEXT'],['policy_revision','INTEGER'],['plan_hash','TEXT'],['approved_payload_hash','TEXT']]){
        if(!columns.some(c=>c.name===name))this.db.exec(`ALTER TABLE announcement_jobs ADD COLUMN ${name} ${type}`);
      }
      this.db.exec(`CREATE INDEX IF NOT EXISTS announcement_logical_jobs ON announcement_jobs(guild,logical_delivery_id);
        CREATE TABLE IF NOT EXISTS logical_delivery_reservations(logical_delivery_id TEXT PRIMARY KEY,job TEXT NOT NULL UNIQUE REFERENCES announcement_jobs(id),at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS legacy_delivery_guards(job TEXT PRIMARY KEY REFERENCES announcement_jobs(id),guild TEXT NOT NULL,event_key TEXT NOT NULL,revision INTEGER NOT NULL,channel TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS announcement_legacy_delivery_guard ON legacy_delivery_guards(guild,event_key,revision,channel);`);
      if(!this.db.prepare('SELECT version FROM schema_version WHERE version=4').get()){
        // Old policy hashes do not reliably recover a rule identity. Preserve
        // the ledger and conservatively hold this event revision/destination.
        this.db.exec(`INSERT OR IGNORE INTO legacy_delivery_guards SELECT id,guild,event_key,revision,channel FROM announcement_jobs WHERE logical_delivery_id IS NULL;
          UPDATE announcement_jobs SET state='blocked',held_from=NULL,approved_by=NULL WHERE logical_delivery_id IS NULL AND state IN ('scheduled','held','pending_approval','blocked','draft');`);
        const legacy=this.db.prepare('SELECT job,guild FROM legacy_delivery_guards').all() as {job:string;guild:string}[];
        for(const row of legacy)this.alert(row.guild,'delivery-identity-review',row.job);
        this.db.exec('INSERT INTO schema_version VALUES(4)');
      }
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const additions:Record<string,[string,string][]>= {
        sources:[['source_disposition',"TEXT NOT NULL DEFAULT 'needs_review'"],['disposition_reason',"TEXT NOT NULL DEFAULT 'Legacy source requires review.'"],['source_time','INTEGER'],['is_correction','INTEGER NOT NULL DEFAULT 0']],
        candidate_events:[['fact_semantics_version','INTEGER NOT NULL DEFAULT 0'],['evidence_ids_json',"TEXT NOT NULL DEFAULT '[]'"],['timezone_confirmed','INTEGER NOT NULL DEFAULT 0']],
        events:[['fact_semantics_version','INTEGER NOT NULL DEFAULT 0']],
      };
      for(const [table,fields] of Object.entries(additions)){
        const columns=this.db.prepare(`PRAGMA table_info(${table})`).all();
        for(const [name,type] of fields)if(!columns.some(c=>c.name===name))this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
      }
      this.db.exec('INSERT OR IGNORE INTO schema_version VALUES(5); COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  transaction<T>(fn:()=>T):T{if(this.state('maintenance:reset')==='true')throw new Error('Announcement storage reset in progress.');this.db.exec('BEGIN IMMEDIATE');try{const out=fn();this.db.exec('COMMIT');return out;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  audit(guild:string,actor:string,action:string,target:string,snapshot:unknown,now=Date.now()){if(!actor.trim())throw new Error('Actor required.');this.db.prepare('INSERT INTO audit_log(guild,actor,action,target,snapshot,at) VALUES(?,?,?,?,?,?)').run(guild,actor,action,target,canonical(snapshot),now);}
  state(key:string){return this.db.prepare('SELECT value FROM gmail_state WHERE key=?').get(key)?.value as string|undefined;}
  setState(key:string,value:string){this.db.prepare('INSERT INTO gmail_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value);}
  alert(guild:string,kind:string,target:string,now=Date.now()){this.db.prepare('INSERT OR IGNORE INTO staff_alerts(id,guild,kind,target,at) VALUES(?,?,?,?,?)').run(randomUUID(),guild,kind,target,now);}
  source(guild:string,source:Source){const id=digest([source.account,source.messageId]);this.db.prepare("INSERT OR IGNORE INTO sources(id,guild,account,message_id,hash,metadata,state) VALUES(?,?,?,?,?,?,'pending')").run(id,guild,source.account,source.messageId,source.sha256,canonical(source));return id;}
  sourceState(id:string,state:string,retryAt=0){this.db.prepare('UPDATE sources SET state=?,attempts=attempts+1,retry_at=? WHERE id=?').run(state,retryAt,id);}
  private applySourceDisposition(guild:string,id:string,disposition:SourceDisposition,reason:string,sourceTime:number|null=null,correction=false){
    if(!sourceDispositions.includes(disposition)||!this.db.prepare('SELECT id FROM sources WHERE id=? AND guild=?').get(id,guild))throw new Error('Invalid source disposition.');
    validatePublicText(reason,'source disposition');
    this.db.prepare('UPDATE sources SET source_disposition=?,disposition_reason=?,source_time=?,is_correction=? WHERE id=? AND guild=?').run(disposition,reason,sourceTime,+correction,id,guild);
    if(disposition==='private'||disposition==='ignore'){this.sourceState(id,disposition==='private'?'private':'ignored');this.releaseSource(id);}
    else if(disposition==='needs_review'){
      this.sourceState(id,'blocked');
      this.db.prepare('INSERT OR IGNORE INTO source_holds SELECT ?,event_key FROM events WHERE guild=?').run(id,guild);
      this.db.prepare("UPDATE announcement_jobs SET held_from=state,state='held' WHERE guild=? AND state IN ('scheduled','pending_approval','blocked')").run(guild);
      this.alert(guild,'blocked-source',id);
    }
  }
  resolveSource(guild:string,id:string,disposition:SourceDisposition,reason:string,sourceTime:number|null=null,correction=false){this.transaction(()=>{this.applySourceDisposition(guild,id,disposition,reason,sourceTime,correction);this.audit(guild,'host','source-disposition',id,{disposition,reason});});}
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
  saveEvidence(source:string,evidence:unknown){
    if(!evidence||typeof evidence!=='object'||Array.isArray(evidence))throw new Error('Invalid source evidence.');
    const data=evidence as {evidence?:{id:string;text:string}[];blocked?:string[];sensitive?:boolean};
    if(!Array.isArray(data.evidence)||(data.blocked!==undefined&&!Array.isArray(data.blocked)))throw new Error('Invalid source evidence.');
    const safe={...data,evidence:data.evidence.map(e=>({id:e.id,text:sanitizeOrganizerEvidence(e.text).text})),blocked:(data.blocked??[]).map(x=>sanitizeOrganizerEvidence(x).text)};
    const json=canonical(safe);if(Buffer.byteLength(json)>100000)throw new Error('Source evidence too large.');this.db.prepare('INSERT INTO source_evidence VALUES(?,?) ON CONFLICT(source) DO UPDATE SET evidence_json=excluded.evidence_json').run(source,json);
  }
  candidates(guild:string){return this.candidatePage(guild,0,100).items;}
  candidatePage(guild:string,page=0,size=5){
    const limit=Math.min(100,Math.max(1,Math.floor(size))),total=Number(this.db.prepare('SELECT count(*) n FROM candidate_events WHERE guild=?').get(guild)!.n);
    const pages=Math.max(1,Math.ceil(total/limit)),current=Math.min(pages-1,Math.max(0,Math.floor(page)||0));
    const items=this.db.prepare('SELECT c.*,p.public_id FROM candidate_events c JOIN candidate_public_ids p ON p.candidate=c.id WHERE c.guild=? ORDER BY p.public_id DESC LIMIT ? OFFSET ?').all(guild,limit,current*limit) as unknown as Candidate[];
    return {items,total,page:current,pages};
  }
  candidate(guild:string,id:string){return this.db.prepare('SELECT c.*,p.public_id FROM candidate_events c JOIN candidate_public_ids p ON p.candidate=c.id WHERE c.guild=? AND c.id=?').get(guild,id) as unknown as Candidate|undefined;}
  resolveCandidate(guild:string,value:string){
    if(/^#?\d+$/.test(value)){const id=Number(value.replace('#',''));if(!Number.isSafeInteger(id)||id<1)return undefined;return this.db.prepare('SELECT c.*,p.public_id FROM candidate_events c JOIN candidate_public_ids p ON p.candidate=c.id WHERE c.guild=? AND p.public_id=?').get(guild,id) as unknown as Candidate|undefined;}
    return this.candidate(guild,value);
  }
  event(guild:string,key:string){return this.db.prepare('SELECT * FROM events WHERE guild=? AND event_key=?').get(guild,key) as unknown as ApprovedEvent|undefined;}
  events(guild:string){return this.db.prepare('SELECT * FROM events WHERE guild=?').all(guild) as unknown as ApprovedEvent[];}
  private sourceSemanticContext(source:string,evidenceIds?:string[],timezoneConfirmed=false):SemanticContext {
    const row=this.db.prepare('SELECT s.source_time,e.evidence_json FROM sources s LEFT JOIN source_evidence e ON e.source=s.id WHERE s.id=?').get(source);
    let evidence:{id:string;text:string}[]=[];try{evidence=(JSON.parse(String(row?.evidence_json??'{}')) as {evidence?:{id:string;text:string}[]}).evidence??[];}catch{}
    return {evidence,...(evidenceIds?.length?{evidenceIds}:{}),sourceTime:typeof row?.source_time==='number'?row.source_time:null,timezoneConfirmed};
  }
  private candidateSemanticContext(c:Candidate):SemanticContext{
    const source=String(this.db.prepare('SELECT source FROM candidate_batches WHERE id=?').get(c.batch)!.source);
    return this.sourceSemanticContext(source,JSON.parse(c.evidence_ids_json) as string[],c.timezone_confirmed===1);
  }
  ingest(guild:string,input:Extraction,now=Date.now()){
    input=normalizeCatalogAndEvents(input);
    input={...input,events:input.events.map(c=>({...c,event:canonicalEvent(c.event)}))};
    if(!/^\d{17,20}$/.test(guild))throw new Error('Invalid guild.');validateExtraction(input);
    return this.transaction(()=>{
      const source=this.source(guild,input.source),hash=digest(input);
      this.applySourceDisposition(guild,source,input.disposition??'public',input.dispositionReason??'Structured mathematics proposal requires factual review.',input.sourceTime??null,input.correction??false);
      const old=this.db.prepare('SELECT id FROM candidate_batches WHERE source=? AND hash=?').get(source,hash) as {id:string}|undefined;if(old)return old.id;
      const batch=randomUUID();this.db.prepare('INSERT INTO candidate_batches VALUES(?,?,?)').run(batch,source,hash);
      if(input.disposition&&input.disposition!=='public'){this.audit(guild,'host','source-disposition',source,{disposition:input.disposition,reason:input.dispositionReason??'Source requires disposition.'},now);return batch;}
      let reviews=0,corrections=0;
      for(const c of input.events){
        const key=guild+':'+eventKey(c.event),active=this.event(guild,key),json=canonical(c.event),catalog=canonical(catalogForEvent(input.catalog,c.event));
        const context=this.sourceSemanticContext(source,c.evidenceIds);
        c.issues=[...new Set([...c.issues,...semanticIssues(c.event,context),...entityEvidenceIssues(c.event,input.catalog,context)])];
        const duplicate=this.db.prepare("SELECT id,issues_json,review_version FROM candidate_events WHERE guild=? AND event_key=? AND event_json=? AND catalog_json=? AND state='pending' LIMIT 1").get(guild,key,json,catalog) as {id:string;issues_json:string;review_version:number}|undefined;
        if(duplicate){
          const issues=canonical([...new Set([...(JSON.parse(duplicate.issues_json) as string[]),...c.issues])]);
          if(issues!==duplicate.issues_json){this.db.prepare('UPDATE candidate_events SET issues_json=?,review_version=review_version+1 WHERE id=?').run(issues,duplicate.id);reviews++;if(active)corrections++;}
          this.db.prepare('INSERT OR IGNORE INTO candidate_sources VALUES(?,?)').run(duplicate.id,source);continue;
        }
        const unchanged=active?.event_json===json&&active.catalog_json===catalog;
        const candidateId=randomUUID();this.db.prepare('INSERT INTO candidate_events(id,guild,batch,event_key,event_json,catalog_json,issues_json,confidence,base_revision,state) VALUES(?,?,?,?,?,?,?,?,?,?)').run(candidateId,guild,batch,key,json,catalog,canonical(c.issues),c.confidence,active?.revision??0,unchanged?'unchanged':'pending');
        this.db.prepare('UPDATE candidate_events SET public_safety_version=1 WHERE id=?').run(candidateId);
        this.db.prepare('UPDATE candidate_events SET fact_semantics_version=1,evidence_ids_json=? WHERE id=?').run(canonical(c.evidenceIds??[]),candidateId);
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
    for(const issue of issues)validatePublicText(issue,'review issue');
    const timezoneConfirmed=event.timezoneAssumed===false,context={...this.candidateSemanticContext(c),timezoneConfirmed};
    const completeIssues=[...new Set([...issues,...semanticIssues(event,context),...entityEvidenceIssues(event,JSON.parse(c.catalog_json) as Catalog,context)])];
    this.db.prepare('UPDATE candidate_events SET event_json=?,issues_json=?,public_safety_version=1,fact_semantics_version=1,timezone_confirmed=?,review_version=review_version+1 WHERE id=?').run(canonical(event),canonical(completeIssues),+timezoneConfirmed,id);this.audit(guild,actor,'edit',id,{beforeHash:digest(c.event_json),after:event,issues:completeIssues,timezoneConfirmed});return this.candidate(guild,id)!;
  });}
  approve(guild:string,id:string,version:number,actor:string,now=Date.now()){return this.transaction(()=>{
    const c=this.pending(guild,id,version),active=this.event(guild,c.event_key);if((active?.revision??0)!==c.base_revision)throw new Error('Stale event revision; reject or rebase the proposal after inspecting the latest source.');
    if(c.public_safety_version!==1)throw new Error('Legacy facts require fresh public-safety review.');
    const event=JSON.parse(c.event_json) as ScheduleEvent,catalog=JSON.parse(c.catalog_json) as Catalog,context=this.candidateSemanticContext(c);
    if(c.fact_semantics_version!==1||semanticIssues(event,context).length||entityEvidenceIssues(event,catalog,context).length)throw new Error('Fact semantics or source support requires review.');
    if((JSON.parse(c.issues_json) as string[]).length)throw new Error('Resolve all factual issues before approval.');validateEvent(JSON.parse(c.event_json) as ScheduleEvent,JSON.parse(c.catalog_json) as Catalog,true);
    const revision=c.base_revision+1;
    this.db.prepare('INSERT INTO events(event_key,guild,revision,event_json,catalog_json,approved_by,approved_at,public_safety_version) VALUES(?,?,?,?,?,?,?,1) ON CONFLICT(event_key) DO UPDATE SET revision=excluded.revision,event_json=excluded.event_json,catalog_json=excluded.catalog_json,approved_by=excluded.approved_by,approved_at=excluded.approved_at,public_safety_version=1').run(c.event_key,guild,revision,c.event_json,c.catalog_json,actor,now);
    this.db.prepare('UPDATE events SET fact_semantics_version=1 WHERE event_key=?').run(c.event_key);
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
  legacyDeliveryGuard(guild:string,key:string,revision:number,channel:string){return !!this.db.prepare('SELECT job FROM legacy_delivery_guards WHERE guild=? AND event_key=? AND revision=? AND channel=? LIMIT 1').get(guild,key,revision,channel);}
  logicalDeliveryConsumed(logicalId:string){return !!this.db.prepare(`SELECT job FROM logical_delivery_reservations WHERE logical_delivery_id=?
    UNION ALL SELECT j.id FROM announcement_jobs j WHERE j.logical_delivery_id=? AND (j.state IN ('sent','delivering','uncertain','cancelled','skipped') OR EXISTS(SELECT 1 FROM delivery_attempts a WHERE a.job=j.id)) LIMIT 1`).get(logicalId,logicalId);}
  addJob(job:Omit<AnnouncementJob,'id'|'asset'|'message'|'approved_by'>){
    const id=randomUUID();let safety=0;
    if(job.state!=='blocked'&&job.payload_json!==''&&JSON.parse(job.payload_json).content){validatePublicDiscordPayload(JSON.parse(job.payload_json),{role:job.role,channel:job.channel});safety=1;}
    this.db.prepare('INSERT OR IGNORE INTO announcement_jobs(id,guild,event_key,revision,policy,channel,role,due,expires,major,asset_policy,payload_json,state,public_safety_version,logical_delivery_id,rule_id,policy_revision,plan_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,job.guild,job.event_key,job.revision,job.policy,job.channel,job.role,job.due,job.expires,job.major,job.asset_policy,job.payload_json,job.state,safety,job.logical_delivery_id??null,job.rule_id??null,job.policy_revision??null,job.plan_hash??null);const row=this.db.prepare('SELECT * FROM announcement_jobs WHERE event_key=? AND revision=? AND policy=? AND channel=?').get(job.event_key,job.revision,job.policy,job.channel) as unknown as AnnouncementJob;return row;
  }
  approveJob(guild:string,id:string,actor:string,expectedHash:string){this.transaction(()=>{
    const j=this.job(guild,id),e=j?this.event(guild,j.event_key):undefined;if(!j||j.state!=='pending_approval'||!e||e.revision!==j.revision||this.held(j.event_key)||digest([j.payload_json,j.asset])!==expectedHash)throw new Error('Message preview is stale or held.');
    validatePublicDiscordPayload(JSON.parse(j.payload_json),{role:j.role,channel:j.channel});if(j.public_safety_version!==1||e.public_safety_version!==1||e.fact_semantics_version!==1)throw new Error('Public-safety and fact-semantics review required.');
    const snapshot=effectivePolicy(this,guild);if(!snapshot||!this.jobPolicyCurrent(j,snapshot))throw new Error('Message policy is stale.');
    if(j.asset_policy==='required'&&!j.asset)throw new Error('Canva asset is required before approval.');
    this.db.prepare("UPDATE announcement_jobs SET state='scheduled',approved_by=?,approved_payload_hash=? WHERE id=?").run(actor,expectedHash,id);this.audit(guild,actor,'approve-message',id,{hash:expectedHash});
  });}
  attach(guild:string,jobId:string,asset:{hash:string;path:string;mime:string;bytes:number},actor:string){this.transaction(()=>{
    const j=this.job(guild,jobId);if(!j||!j.major||!['pending_approval','blocked'].includes(j.state))throw new Error('Attach media to an unapproved major post.');const snapshot=effectivePolicy(this,guild);if(!snapshot||!this.jobPolicyCurrent(j,snapshot))throw new Error('Message policy is stale.');const id=randomUUID();this.db.prepare('INSERT INTO announcement_assets VALUES(?,?,?,?,?,?)').run(id,guild,asset.hash,asset.path,asset.mime,asset.bytes);this.db.prepare("UPDATE announcement_jobs SET asset=?,approved_by=NULL,approved_payload_hash=NULL,state='pending_approval' WHERE id=?").run(id,jobId);this.audit(guild,actor,'attach',jobId,{hash:asset.hash});
  });}
  asset(guild:string,id:string){return this.db.prepare('SELECT path,hash,mime FROM announcement_assets WHERE guild=? AND id=?').get(guild,id) as {path:string;hash:string;mime:string}|undefined;}
  jobPolicyCurrent(j:AnnouncementJob,snapshot:EffectivePolicySnapshot):boolean {
    if(j.guild!==snapshot.guild||!isEffectivePolicy(this,snapshot)||!j.logical_delivery_id||!j.rule_id||!j.plan_hash)return false;
    const row=this.event(j.guild,j.event_key),rule=snapshot.policy.policies.find(r=>r.id===j.rule_id);if(!row||row.revision!==j.revision||!rule)return false;
    try{const p=projectDelivery(row,snapshot.policy,rule);return !p.blocked&&p.logical_delivery_id===j.logical_delivery_id&&p.plan_hash===j.plan_hash&&p.channel===j.channel&&p.role===j.role&&p.due===j.due&&p.expires===j.expires&&p.major===j.major&&p.asset_policy===j.asset_policy&&(!j.major||!!j.rule_id)&&(!j.major?canonical(JSON.parse(j.payload_json))===p.payload_json:true);}catch{return false;}
  }
  validateDelivery(id:string,snapshot:EffectivePolicySnapshot,now=Date.now(),expectedPayload?:Payload):AnnouncementJob {
    const j=this.job(snapshot.guild,id);if(!j||j.state!=='delivering'||!j.logical_delivery_id||!this.jobPolicyCurrent(j,snapshot))throw new Error('Delivery policy/reservation is stale.');
    if(!this.db.prepare('SELECT job FROM logical_delivery_reservations WHERE logical_delivery_id=? AND job=?').get(j.logical_delivery_id,j.id)||!this.db.prepare("SELECT job FROM delivery_attempts WHERE job=? AND state='reserved'").get(j.id))throw new Error('Delivery reservation is unavailable.');
    const e=this.event(j.guild,j.event_key);if(!e||e.revision!==j.revision||this.held(j.event_key)||(JSON.parse(e.event_json) as ScheduleEvent).status&& (JSON.parse(e.event_json) as ScheduleEvent).status!=='active')throw new Error('Delivery event changed or is held.');
    if(now<j.due||now>j.expires)throw new Error('Delivery is outside its publication window.');
    const payload=JSON.parse(j.payload_json) as Payload;validatePublicDiscordPayload(payload,{role:j.role,channel:j.channel});
    if(j.public_safety_version!==1||e.public_safety_version!==1||e.fact_semantics_version!==1)throw new Error('Public-safety and fact-semantics review required.');
    if(expectedPayload!==undefined&&canonical(expectedPayload)!==canonical(payload))throw new Error('Persisted delivery payload changed.');
    if(j.major&&(!j.approved_by||j.approved_payload_hash!==digest([j.payload_json,j.asset])||(j.asset_policy==='required'&&!j.asset)))throw new Error('Exact message/asset approval is stale.');
    if(this.legacyDeliveryGuard(j.guild,j.event_key,j.revision,j.channel))throw new Error('Legacy delivery identity requires review.');
    return j;
  }
  claim(id:string,now=Date.now(),snapshot?:EffectivePolicySnapshot){return this.transaction(()=>{
    const j=this.db.prepare('SELECT * FROM announcement_jobs WHERE id=?').get(id) as unknown as AnnouncementJob|undefined;if(!j||j.state!=='scheduled'||j.due>now)return undefined;
    if(snapshot&&(snapshot.guild!==j.guild||!isEffectivePolicy(this,snapshot)))return undefined;
    try{if(j.public_safety_version!==1)throw new Error('Legacy safety unknown.');validatePublicDiscordPayload(JSON.parse(j.payload_json),{role:j.role,channel:j.channel});}catch{this.db.prepare("UPDATE announcement_jobs SET state='blocked',approved_by=NULL WHERE id=?").run(id);this.alert(j.guild,'public-safety-review',j.id);return undefined;}
    const e=this.event(j.guild,j.event_key);if(!e||e.revision!==j.revision||this.held(j.event_key)){this.db.prepare("UPDATE announcement_jobs SET state='held' WHERE id=?").run(id);return undefined;}
    if(e.public_safety_version!==1||e.fact_semantics_version!==1){this.db.prepare("UPDATE announcement_jobs SET state='blocked',approved_by=NULL WHERE id=?").run(id);this.alert(j.guild,'public-safety-review',id);return undefined;}
    if((JSON.parse(e.event_json) as ScheduleEvent).status && (JSON.parse(e.event_json) as ScheduleEvent).status!=='active'){this.db.prepare("UPDATE announcement_jobs SET state='cancelled' WHERE id=?").run(id);return undefined;}
    if(now>j.expires){this.db.prepare("UPDATE announcement_jobs SET state='skipped' WHERE id=?").run(id);this.alert(j.guild,'missed-reminder',id);return undefined;}
    const current=snapshot??effectivePolicy(this,j.guild);
    if(!current||!this.jobPolicyCurrent(j,current)||!j.logical_delivery_id||this.legacyDeliveryGuard(j.guild,j.event_key,j.revision,j.channel)){this.db.prepare("UPDATE announcement_jobs SET state='blocked',approved_by=NULL WHERE id=?").run(id);this.alert(j.guild,'delivery-identity-review',id);return undefined;}
    if(j.major&&(!j.approved_by||j.approved_payload_hash!==digest([j.payload_json,j.asset])||(j.asset_policy==='required'&&!j.asset))){this.db.prepare("UPDATE announcement_jobs SET state='pending_approval',approved_by=NULL,approved_payload_hash=NULL WHERE id=?").run(id);return undefined;}
    if(this.logicalDeliveryConsumed(j.logical_delivery_id)){this.db.prepare("UPDATE announcement_jobs SET state='superseded' WHERE id=?").run(id);return undefined;}
    const reserved=this.db.prepare('INSERT OR IGNORE INTO logical_delivery_reservations VALUES(?,?,?)').run(j.logical_delivery_id,id,now);if(!reserved.changes)return undefined;
    this.db.prepare("UPDATE announcement_jobs SET state='delivering' WHERE id=? AND state='scheduled'").run(id);this.db.prepare("INSERT INTO delivery_attempts VALUES(?,'reserved',NULL,?)").run(id,now);return this.job(j.guild,id)!;
  });}
  finish(j:AnnouncementJob,message:string|null){this.transaction(()=>{const changed=this.db.prepare("UPDATE announcement_jobs SET state=?,message=? WHERE id=? AND guild=? AND state='delivering'").run(message?'sent':'uncertain',message,j.id,j.guild);if(!changed.changes){if(message)this.alert(j.guild,'delivery-reconciled-during-send',j.id);return;}this.db.prepare("UPDATE delivery_attempts SET state=?,message=? WHERE job=? AND state='reserved'").run(message?'sent':'uncertain',message,j.id);if(!message)this.alert(j.guild,'uncertain-delivery',j.id);});}
  reconcile(guild:string,id:string,message:string|null,actor:string){this.transaction(()=>{const j=this.job(guild,id);if(!j||!['uncertain','delivering'].includes(j.state))throw new Error('Only uncertain deliveries can be reconciled.');if(j.logical_delivery_id)this.db.prepare('INSERT OR IGNORE INTO logical_delivery_reservations VALUES(?,?,?)').run(j.logical_delivery_id,j.id,Date.now());this.db.prepare('UPDATE announcement_jobs SET state=?,message=? WHERE id=?').run(message?'sent':'cancelled',message,id);this.audit(guild,actor,'reconcile',id,{message,previousState:j.state});});}
  close(){this.db.close();}
}
