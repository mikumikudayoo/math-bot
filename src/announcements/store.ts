import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonical,canonicalEvent,digest,eventKey,validateExtraction,validateEvent,type Catalog,type Extraction,type ScheduleEvent,type Source } from './model.js';
import {validatePublicText,validatePublicDiscordPayload,sanitizeOrganizerEvidence} from './public-facts.js';
import { effectivePolicy,isEffectivePolicy,projectDelivery,type EffectivePolicySnapshot } from './delivery-identity.js';
import {normalizeCatalogAndEvents,catalogForEvent,semanticIssues,entityEvidenceIssues,sourceDispositions,classifySource,type SourceDisposition,type SemanticContext} from './semantics.js';
import {applyCorrectionPatch,assessCorrection,compareCorrectionSources,factFingerprint,type CorrectionSourceOrder} from './corrections.js';
import {attributeFields,attributeStaffEdit,attributionIssues,publicFactFields,type EvidenceLink,type RetainedEvidence} from './evidence.js';

export interface Candidate { id:string;public_id:number;guild:string;batch:string;event_key:string;event_json:string;catalog_json:string;issues_json:string;confidence:string;base_revision:number;review_version:number;state:string;public_safety_version:number;fact_semantics_version:number;evidence_ids_json:string;timezone_confirmed:number;fact_fingerprint:string|null;correction_patch_json:string|null;superseded_by:string|null;reconsideration_of:string|null;requires_correction_resolution:number }
export interface ApprovedEvent { event_key:string;guild:string;revision:number;event_json:string;catalog_json:string;approved_by:string;approved_at:number;public_safety_version:number;fact_semantics_version:number;authoritative_source_time:number|null;authoritative_source_hash:string|null }
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
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const additions:Record<string,[string,string][]>= {
        candidate_events:[['fact_fingerprint','TEXT'],['correction_patch_json','TEXT'],['superseded_by','TEXT'],['reconsideration_of','TEXT'],['requires_correction_resolution','INTEGER NOT NULL DEFAULT 0']],
        events:[['authoritative_source_time','INTEGER'],['authoritative_source_hash','TEXT']],
      };
      for(const [table,fields] of Object.entries(additions)){
        const columns=this.db.prepare(`PRAGMA table_info(${table})`).all();
        for(const [name,type] of fields)if(!columns.some(c=>c.name===name))this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
      }
      this.db.exec(`CREATE INDEX IF NOT EXISTS candidate_fact_identity ON candidate_events(guild,event_key,fact_fingerprint,state);
        CREATE TABLE IF NOT EXISTS rejected_facts(guild TEXT NOT NULL,event_key TEXT NOT NULL,fingerprint TEXT NOT NULL,candidate TEXT NOT NULL,event_json TEXT NOT NULL,catalog_json TEXT NOT NULL,evidence_digests_json TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(guild,event_key,fingerprint));
        CREATE TABLE IF NOT EXISTS candidate_reconsiderations(candidate TEXT PRIMARY KEY,previous TEXT NOT NULL,actor TEXT NOT NULL,reason TEXT NOT NULL,evidence_digest TEXT NOT NULL,at INTEGER NOT NULL);`);
      if(!this.db.prepare('SELECT version FROM schema_version WHERE version=6').get()){
        const rows=this.db.prepare('SELECT * FROM candidate_events').all() as unknown as Candidate[];
        for(const c of rows){
          try{
            const fingerprint=factFingerprint(JSON.parse(c.event_json) as ScheduleEvent,JSON.parse(c.catalog_json) as Catalog);
            this.db.prepare('UPDATE candidate_events SET fact_fingerprint=? WHERE id=?').run(fingerprint,c.id);
            if(c.state==='rejected')this.rememberRejection({...c,fact_fingerprint:fingerprint},0);
          }catch{
            // A digest is not public-safety attestation. Malformed legacy rows
            // retain history and require review instead of a fabricated identity.
            if(c.state==='pending')this.db.prepare('UPDATE candidate_events SET requires_correction_resolution=1,review_version=review_version+1 WHERE id=?').run(c.id);
          }
        }
        this.db.exec('INSERT INTO schema_version VALUES(6)');
      }
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    this.db.exec('BEGIN IMMEDIATE');
    try{
      for(const table of ['candidate_events','events','event_revisions']){
        const columns=this.db.prepare(`PRAGMA table_info(${table})`).all();
        if(!columns.some(c=>c.name==='field_evidence_json'))this.db.exec(`ALTER TABLE ${table} ADD COLUMN field_evidence_json TEXT NOT NULL DEFAULT '[]'`);
      }
      // A migration does not certify legacy fields as source-supported.
      this.db.exec('INSERT OR IGNORE INTO schema_version VALUES(7); COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    this.db.exec('BEGIN IMMEDIATE');
    try{
      this.db.exec(`CREATE TABLE IF NOT EXISTS announcement_job_public_ids(public_id INTEGER PRIMARY KEY AUTOINCREMENT,job TEXT NOT NULL UNIQUE);
        INSERT INTO announcement_job_public_ids(job) SELECT id FROM announcement_jobs WHERE id NOT IN (SELECT job FROM announcement_job_public_ids) ORDER BY rowid;
        CREATE TRIGGER IF NOT EXISTS announcement_job_public_id_insert AFTER INSERT ON announcement_jobs BEGIN
          INSERT INTO announcement_job_public_ids(job) VALUES(NEW.id);
        END;
        INSERT OR IGNORE INTO schema_version VALUES(8); COMMIT;`);
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    this.db.exec('BEGIN IMMEDIATE');
    try{
      if(!this.db.prepare('PRAGMA table_info(sources)').all().some(c=>c.name==='unresolved_barrier'))this.db.exec('ALTER TABLE sources ADD COLUMN unresolved_barrier INTEGER NOT NULL DEFAULT 1');
      this.db.exec(`CREATE INDEX IF NOT EXISTS unresolved_organizer_sources ON sources(guild,unresolved_barrier,state);
        CREATE TRIGGER IF NOT EXISTS source_admission_barrier AFTER INSERT ON sources WHEN NEW.state IN ('pending','retry','blocked') BEGIN
          INSERT OR IGNORE INTO source_holds SELECT NEW.id,event_key FROM events WHERE guild=NEW.guild;
          UPDATE announcement_jobs SET held_from=state,state='held' WHERE guild=NEW.guild AND state IN ('scheduled','pending_approval','blocked','draft');
        END;
        INSERT OR IGNORE INTO schema_version VALUES(9); COMMIT;`);
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  transaction<T>(fn:()=>T):T{if(this.state('maintenance:reset')==='true')throw new Error('Announcement storage reset in progress.');this.db.exec('BEGIN IMMEDIATE');try{const out=fn();this.db.exec('COMMIT');return out;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  audit(guild:string,actor:string,action:string,target:string,snapshot:unknown,now=Date.now()){if(!actor.trim())throw new Error('Actor required.');this.db.prepare('INSERT INTO audit_log(guild,actor,action,target,snapshot,at) VALUES(?,?,?,?,?,?)').run(guild,actor,action,target,canonical(snapshot),now);}
  state(key:string){return this.db.prepare('SELECT value FROM gmail_state WHERE key=?').get(key)?.value as string|undefined;}
  setState(key:string,value:string){this.db.prepare('INSERT INTO gmail_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value);}
  alert(guild:string,kind:string,target:string,now=Date.now()){this.db.prepare('INSERT OR IGNORE INTO staff_alerts(id,guild,kind,target,at) VALUES(?,?,?,?,?)').run(randomUUID(),guild,kind,target,now);}
  source(guild:string,source:Source){const id=digest([source.account,source.messageId]);this.db.prepare("INSERT OR IGNORE INTO sources(id,guild,account,message_id,hash,metadata,state) VALUES(?,?,?,?,?,?,'pending')").run(id,guild,source.account,source.messageId,source.sha256,canonical(source));return id;}
  sourceState(id:string,state:string,retryAt=0){this.db.prepare("UPDATE sources SET state=?,attempts=attempts+1,retry_at=?,unresolved_barrier=CASE WHEN ? IN ('extracted','private','ignored','dismissed') THEN 0 ELSE unresolved_barrier END WHERE id=?").run(state,retryAt,state,id);}
  private applySourceDisposition(guild:string,id:string,disposition:SourceDisposition,reason:string,sourceTime:number|null=null,correction=false){
    if(!sourceDispositions.includes(disposition)||!this.db.prepare('SELECT id FROM sources WHERE id=? AND guild=?').get(id,guild))throw new Error('Invalid source disposition.');
    validatePublicText(reason,'source disposition');
    this.db.prepare('UPDATE sources SET source_disposition=?,disposition_reason=?,source_time=COALESCE(source_time,?),is_correction=MAX(is_correction,?) WHERE id=? AND guild=?').run(disposition,reason,sourceTime,+correction,id,guild);
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
  private releaseSource(id:string){const rows=this.db.prepare('SELECT e.event_key FROM events e JOIN sources s ON s.guild=e.guild WHERE s.id=?').all(id) as {event_key:string}[];this.db.prepare('UPDATE sources SET unresolved_barrier=0 WHERE id=?').run(id);this.db.prepare('DELETE FROM source_holds WHERE source=?').run(id);for(const row of rows)this.unhold(row.event_key);}
  dismissSource(guild:string,id:string,actor:string){this.transaction(()=>{
    if(!this.db.prepare("SELECT id FROM sources WHERE id=? AND guild=? AND state IN ('blocked','retry','pending')").get(id,guild))throw new Error('Source not available for disposition.');
    this.sourceState(id,'dismissed');this.releaseSource(id);this.audit(guild,actor,'dismiss-source',id,{});
  });}
  saveEvidence(source:string,evidence:unknown){
    if(!evidence||typeof evidence!=='object'||Array.isArray(evidence))throw new Error('Invalid source evidence.');
    const data=evidence as {evidence?:RetainedEvidence[];blocked?:string[];sensitive?:boolean;incomplete?:boolean};
    if(!Array.isArray(data.evidence)||(data.blocked!==undefined&&!Array.isArray(data.blocked)))throw new Error('Invalid source evidence.');
    const safe={sensitive:data.sensitive===true,incomplete:data.incomplete===true,evidence:data.evidence.map(e=>{
      if(typeof e.id!=='string'||!e.id.trim()||e.id.length>200||typeof e.text!=='string')throw new Error('Invalid retained evidence statement.');
      return {id:e.id,text:sanitizeOrganizerEvidence(e.text).text,locations:(e.locations??[e.id]).filter(location=>typeof location==='string'&&/^(?:subject|body(?:\.\d+)*)(?::(?:pdf|page-\d+))?(?::chunk-\d+)?$/u.test(location))};
    }),blocked:(data.blocked??[]).map(x=>sanitizeOrganizerEvidence(x).text)};
    const json=canonical(safe);if(Buffer.byteLength(json)>100000)throw new Error('Source evidence too large.');
    const previous=this.db.prepare('SELECT evidence_json FROM source_evidence WHERE source=?').get(source);
    if(previous&&previous.evidence_json!==json&&this.db.prepare('SELECT event_key FROM event_revisions WHERE field_evidence_json LIKE ? LIMIT 1').get('%'+JSON.stringify(source)+'%'))throw new Error('Approved revision evidence is immutable; retain the replacement as a new source.');
    this.db.prepare('INSERT INTO source_evidence VALUES(?,?) ON CONFLICT(source) DO UPDATE SET evidence_json=excluded.evidence_json').run(source,json);
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
    return {evidence,sourceEvidence:evidence,...(evidenceIds?.length?{evidenceIds}:{}),sourceTime:typeof row?.source_time==='number'?row.source_time:null,timezoneConfirmed};
  }
  retainedEvidence(source:string,id:string):RetainedEvidence|undefined{
    try{return (JSON.parse(String(this.db.prepare('SELECT evidence_json FROM source_evidence WHERE source=?').get(source)?.evidence_json??'{}')) as {evidence?:RetainedEvidence[]}).evidence?.find(e=>e.id===id);}catch{return undefined;}
  }
  candidateEvidence(c:Candidate):EvidenceLink[]{try{return JSON.parse(String((c as Candidate&{field_evidence_json?:string}).field_evidence_json??'[]')) as EvidenceLink[];}catch{return [];}}
  private evidenceIssues(c:Candidate,event:ScheduleEvent){return attributionIssues(event,this.candidateEvidence(c),(source,id)=>this.db.prepare('SELECT id FROM sources WHERE id=? AND guild=?').get(source,c.guild)?this.retainedEvidence(source,id):undefined);}
  eventEvidenceCurrent(row:ApprovedEvent):boolean {
    try{const event=JSON.parse(row.event_json) as ScheduleEvent,links=JSON.parse(String((row as ApprovedEvent&{field_evidence_json?:string}).field_evidence_json??'[]')) as EvidenceLink[];
      return Array.isArray(links)&&!attributionIssues(event,links,(source,id)=>this.db.prepare('SELECT id FROM sources WHERE id=? AND guild=?').get(source,row.guild)?this.retainedEvidence(source,id):undefined).length;
    }catch{return false;}
  }
  private candidateSemanticContext(c:Candidate):SemanticContext{
    const source=String(this.db.prepare('SELECT source FROM candidate_batches WHERE id=?').get(c.batch)!.source);
    const context=this.sourceSemanticContext(source,JSON.parse(c.evidence_ids_json) as string[],c.timezone_confirmed===1);
    const links=this.candidateEvidence(c);
    if(links.length){
      const retained=[...new Map(links.map(link=>[`${link.source}/${link.id}`,link])).entries()].flatMap(([key,link])=>{
        if(!this.db.prepare('SELECT id FROM sources WHERE id=? AND guild=?').get(link.source,c.guild))return [];
        const e=this.retainedEvidence(link.source,link.id);return e?[{id:key,text:e.text}]:[];
      });
      context.evidence=[...(context.evidence??[]),...retained];context.evidenceIds=retained.map(e=>e.id);
    }else if(c.correction_patch_json){
      const related=this.db.prepare('SELECT source FROM candidate_sources WHERE candidate=? AND source<>?').all(c.id,source);
      context.evidence=[...(context.evidence??[]),...related.flatMap(row=>this.sourceSemanticContext(String(row.source)).evidence??[])];
    }
    return context;
  }
  private sourceAuthority(source:string):CorrectionSourceOrder {
    const row=this.db.prepare('SELECT source_time,hash FROM sources WHERE id=?').get(source);
    return {sourceTime:typeof row?.source_time==='number'?row.source_time:null,sourceHash:typeof row?.hash==='string'?row.hash:''};
  }
  private candidateAuthority(c:Candidate):CorrectionSourceOrder{return this.sourceAuthority(String(this.db.prepare('SELECT source FROM candidate_batches WHERE id=?').get(c.batch)!.source));}
  private sourceEvidenceDigest(source:string):string|null {
    try{
      const row=this.db.prepare('SELECT evidence_json FROM source_evidence WHERE source=?').get(source);
      const saved=JSON.parse(String(row?.evidence_json??'{}')) as {evidence?:{text?:string}[]};
      // Locators, ordering, timestamps, and redaction-only differences do not
      // constitute new factual evidence for reconsidering a rejected proposal.
      const lines=[...new Set((saved.evidence??[]).flatMap(e=>(e.text??'').split(/\r?\n/u)).map(line=>line.trim().replace(/\s+/gu,' ')).filter(line=>line&&!/^(?:\[.*withheld.*\]|credential content withheld)$/iu.test(line)))].sort();
      return lines.length?digest(lines):null;
    }catch{return null;}
  }
  private rememberRejection(c:Candidate,now:number){
    const fingerprint=c.fact_fingerprint??factFingerprint(JSON.parse(c.event_json) as ScheduleEvent,JSON.parse(c.catalog_json) as Catalog);
    const evidence=this.db.prepare('SELECT source FROM candidate_sources WHERE candidate=?').all(c.id).map(row=>this.sourceEvidenceDigest(String(row.source))).filter((value):value is string=>value!==null);
    const previous=this.db.prepare('SELECT evidence_digests_json FROM rejected_facts WHERE guild=? AND event_key=? AND fingerprint=?').get(c.guild,c.event_key,fingerprint);
    const digests=canonical([...new Set([...(JSON.parse(String(previous?.evidence_digests_json??'[]')) as string[]),...evidence])].sort());
    this.db.prepare('INSERT INTO rejected_facts VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(guild,event_key,fingerprint) DO UPDATE SET evidence_digests_json=excluded.evidence_digests_json').run(c.guild,c.event_key,fingerprint,c.id,c.event_json,c.catalog_json,digests,now);
  }
  private releaseCandidateSourceHolds(c:Candidate){
    this.db.prepare('DELETE FROM source_holds WHERE event_key=? AND source IN (SELECT source FROM candidate_sources WHERE candidate=?)').run(c.event_key,c.id);
    this.unhold(c.event_key);
  }
  private supersedeCandidate(c:Candidate,successor:string|null,now:number){
    this.db.prepare("UPDATE candidate_events SET state='superseded',superseded_by=?,review_version=review_version+1 WHERE id=? AND state='pending'").run(successor,c.id);
    this.releaseCandidateSourceHolds(c);
    this.audit(c.guild,'host','supersede-proposal',c.id,{successor,fingerprint:c.fact_fingerprint},now);
  }
  ingest(guild:string,input:Extraction,now=Date.now()){
    input=normalizeCatalogAndEvents(input);
    input={...input,events:input.events.map(c=>({...c,event:canonicalEvent(c.event)}))};
    if(!/^\d{17,20}$/.test(guild))throw new Error('Invalid guild.');validateExtraction(input);
    return this.transaction(()=>{
      const source=this.source(guild,input.source);
      if(input.evidence){
        const retained=this.db.prepare('SELECT evidence_json FROM source_evidence WHERE source=?').get(source);
        if(retained){
          const before=(JSON.parse(String(retained.evidence_json)) as {evidence:RetainedEvidence[]}).evidence.map(e=>({id:e.id,text:e.text}));
          const after=input.evidence.map(e=>({id:e.id,text:sanitizeOrganizerEvidence(e.text).text}));
          if(canonical(before)!==canonical(after))throw new Error('Retained source evidence cannot be replaced by an import; supply a new reviewed source.');
        }else this.saveEvidence(source,{evidence:input.evidence,blocked:[]});
      }
      let evidence:{blocked?:unknown[];complete?:boolean;incomplete?:boolean}={};try{evidence=JSON.parse(String(this.db.prepare('SELECT evidence_json FROM source_evidence WHERE source=?').get(source)?.evidence_json??'{}')) as typeof evidence;}catch{evidence={incomplete:true};}
      let correction=Boolean(input.correction||input.events.some(c=>c.correctionPatch)||this.db.prepare('SELECT is_correction FROM sources WHERE id=?').get(source)?.is_correction);
      const unresolved=Boolean(evidence.blocked?.length||evidence.complete===false||evidence.incomplete===true);
      let disposition:SourceDisposition=(correction&&unresolved)?'needs_review':input.disposition??'public';
      const saved=JSON.parse(String(this.db.prepare('SELECT evidence_json FROM source_evidence WHERE source=?').get(source)?.evidence_json??'{}')) as {evidence?:RetainedEvidence[];blocked?:string[]};
      if(saved.evidence?.length){
        const host=classifySource({evidence:saved.evidence??[],blocked:saved.blocked??[],sensitive:false});
        correction ||=host.correction;
        if(host.disposition!=='public')disposition=host.disposition;
        else if(input.disposition==='private'||input.disposition==='ignore')disposition='needs_review';
      }else if(correction&&(input.disposition==='private'||input.disposition==='ignore')){
        disposition='needs_review';
      }
      if(correction&&unresolved&&disposition!=='private'&&disposition!=='ignore')disposition='needs_review';
      this.applySourceDisposition(guild,source,disposition,input.dispositionReason??(correction&&unresolved?'Correction replacement evidence is unresolved; explicit factual review is required.':'Structured mathematics proposal requires factual review.'),input.sourceTime??null,correction);
      const hash=digest({input,evidenceDigest:this.sourceEvidenceDigest(source),unresolved});
      const old=this.db.prepare('SELECT id FROM candidate_batches WHERE source=? AND hash=?').get(source,hash) as {id:string}|undefined;
      if(old){if(disposition==='public'){this.sourceState(source,'extracted');this.releaseSource(source);}return old.id;}
      const batch=randomUUID();this.db.prepare('INSERT INTO candidate_batches VALUES(?,?,?)').run(batch,source,hash);
      if(disposition==='private'||disposition==='ignore'||!input.events.length){this.audit(guild,'host','source-disposition',source,{disposition,reason:input.dispositionReason??'Source requires disposition.'},now);return batch;}
      let reviews=0,corrections=0;
      for(const c of input.events){
        const key=guild+':'+eventKey(c.event),active=this.event(guild,key),authority=this.sourceAuthority(source),proposal=structuredClone(c.event);
        let catalogValue=catalogForEvent(input.catalog,c.event),context=this.sourceSemanticContext(source,c.evidenceIds);
        const previous=active?this.db.prepare("SELECT c.* FROM candidate_events c WHERE c.guild=? AND c.event_key=? AND c.state='approved' AND c.base_revision=? ORDER BY c.rowid DESC LIMIT 1").get(guild,key,active.revision-1) as unknown as Candidate|undefined:undefined;
        if(c.correctionPatch&&active){
          c.event=applyCorrectionPatch(JSON.parse(active.event_json) as ScheduleEvent,c.event,c.correctionPatch);
          const baseline=JSON.parse(active.catalog_json) as Catalog;
          const unique=<T extends {id:string}>(a:T[],b:T[])=>[...new Map([...a,...b].map(item=>[item.id,item])).values()];
          catalogValue=catalogForEvent({competitions:unique(baseline.competitions,input.catalog.competitions),rounds:unique(baseline.rounds,input.catalog.rounds),programs:unique(baseline.programs,input.catalog.programs)},c.event);
          if(c.correctionPatch.kind==='partial'&&previous){
            const beforeContext=this.candidateSemanticContext(previous);
            context={...context,evidence:[...(context.evidence??[]),...(beforeContext.evidence??[])],evidenceIds:[...new Set([...(c.evidenceIds??[]),...JSON.parse(previous.evidence_ids_json) as string[]])]};
          }
        }
        validateEvent(c.event,catalogValue);
        const patch=c.correctionPatch?{...c.correctionPatch,changedFields:c.correctionPatch.changedFields.filter(field=>(proposal as unknown as Record<string,unknown>)[field]!=null)}:undefined;
        const links=attributeFields(c.event,source,c.evidenceIds??[],c.fieldEvidence,previous?this.candidateEvidence(previous):[],patch);
        const evidenceIssues=attributionIssues(c.event,links,(s,id)=>this.retainedEvidence(s,id));
        const fingerprint=factFingerprint(c.event,catalogValue),json=canonical(c.event),catalog=canonical(catalogValue);
        const sameFacts=Boolean(active&&factFingerprint(JSON.parse(active.event_json) as ScheduleEvent,JSON.parse(active.catalog_json) as Catalog)===fingerprint);
        const assessment=assessCorrection({correction,unresolvedEvidence:unresolved,baselineExists:Boolean(active),sameFacts});
        const requiresResolution=Boolean(assessment.issues.length||disposition==='needs_review'||correction&&!c.correctionPatch);
        c.issues=[...new Set([...c.issues,...(saved.blocked??[]),...(unresolved?['Source evidence is incomplete; explicit factual review is required.']:[]),...evidenceIssues,...assessment.issues,...(correction&&!c.correctionPatch?['Correction patch requires explicit factual confirmation.']:[]),...(disposition==='needs_review'?[input.dispositionReason??'Source disposition requires explicit factual review.']:[]),...semanticIssues(c.event,context),...entityEvidenceIssues(c.event,catalogValue,context)])];
        const duplicate=this.db.prepare("SELECT c.* FROM candidate_events c WHERE c.guild=? AND c.event_key=? AND c.fact_fingerprint=? AND c.state='pending' ORDER BY c.rowid DESC LIMIT 1").get(guild,key,fingerprint) as unknown as Candidate|undefined;
        if(duplicate){
          const issues=canonical([...new Set([...(JSON.parse(duplicate.issues_json) as string[]),...c.issues])]);
          const currentAuthority=this.candidateAuthority(duplicate);
          // Equivalent later confirmations still advance source authority. A
          // delayed different proposal must not displace them just because the
          // public fact fingerprint and stable moderator number did not change.
          const newer=authority.sourceTime!==null&&currentAuthority.sourceTime!==null&&authority.sourceTime>currentAuthority.sourceTime;
          const retained=this.candidateEvidence(duplicate),proof=canonical([...new Map([...retained,...(evidenceIssues.length?[]:links)].map(link=>[canonical(link),link])).values()]);
          const proofChanged=proof!==canonical(retained),reviewChanged=issues!==duplicate.issues_json||requiresResolution&&duplicate.requires_correction_resolution!==1;
          if(reviewChanged||newer||proofChanged){
            const ids=canonical([...new Set([...(JSON.parse(duplicate.evidence_ids_json) as string[]),...(context.evidenceIds??c.evidenceIds??[])])]);
            this.db.prepare('UPDATE candidate_events SET batch=?,issues_json=?,requires_correction_resolution=MAX(requires_correction_resolution,?),field_evidence_json=?,evidence_ids_json=?,review_version=review_version+1 WHERE id=?').run(newer?batch:duplicate.batch,issues,+requiresResolution,proof,ids,duplicate.id);
            if(reviewChanged){reviews++;if(active)corrections++;}
            if(newer||proofChanged)this.audit(guild,'host','refresh-equivalent-provenance',duplicate.id,{beforeSourceTime:currentAuthority.sourceTime,afterSourceTime:newer?authority.sourceTime:currentAuthority.sourceTime,additionalEvidence:proofChanged},now);
          }
          this.db.prepare('INSERT OR IGNORE INTO candidate_sources VALUES(?,?)').run(duplicate.id,source);continue;
        }
        const rejected=this.db.prepare('SELECT candidate FROM rejected_facts WHERE guild=? AND event_key=? AND fingerprint=?').get(guild,key,fingerprint) as {candidate:string}|undefined;
        if(rejected&&!sameFacts){
          if(this.candidate(guild,rejected.candidate))this.db.prepare('INSERT OR IGNORE INTO candidate_sources VALUES(?,?)').run(rejected.candidate,source);
          this.audit(guild,'host','retain-rejected-duplicate',rejected.candidate,{fingerprint,newEvidenceDigest:this.sourceEvidenceDigest(source)},now);continue;
        }
        const unchanged=assessment.allowUnchanged&&!requiresResolution&&!c.issues.length;
        const pending=this.db.prepare("SELECT c.* FROM candidate_events c WHERE c.guild=? AND c.event_key=? AND c.state='pending'").all(guild,key) as unknown as Candidate[];
        const olderThanActive=active&&compareCorrectionSources(authority,{sourceTime:active.authoritative_source_time,sourceHash:active.authoritative_source_hash??''})==='older';
        const newerPending=pending.find(row=>compareCorrectionSources(authority,this.candidateAuthority(row))==='older');
        const state=olderThanActive||newerPending?'superseded':unchanged?'unchanged':'pending';
        const relatedRejection=this.db.prepare('SELECT candidate FROM rejected_facts WHERE guild=? AND event_key=? ORDER BY at DESC LIMIT 1').get(guild,key) as {candidate:string}|undefined;
        const candidateId=randomUUID();this.db.prepare('INSERT INTO candidate_events(id,guild,batch,event_key,event_json,catalog_json,issues_json,confidence,base_revision,state,public_safety_version,fact_semantics_version,evidence_ids_json,fact_fingerprint,correction_patch_json,superseded_by,reconsideration_of,requires_correction_resolution) VALUES(?,?,?,?,?,?,?,?,?,?,1,1,?,?,?,?,?,?)').run(candidateId,guild,batch,key,json,catalog,canonical(c.issues),c.confidence,active?.revision??0,state,canonical(context.evidenceIds??c.evidenceIds??[]),fingerprint,c.correctionPatch?canonical(c.correctionPatch):null,newerPending?.id??null,relatedRejection?.candidate??null,+requiresResolution);
        this.db.prepare('INSERT INTO candidate_sources VALUES(?,?)').run(candidateId,source);
        this.db.prepare('UPDATE candidate_events SET field_evidence_json=? WHERE id=?').run(canonical(links),candidateId);
        if(c.correctionPatch?.kind==='partial'&&previous)this.db.prepare('INSERT OR IGNORE INTO candidate_sources SELECT ?,source FROM candidate_sources WHERE candidate=?').run(candidateId,previous.id);
        if(state==='pending'){
          for(const oldProposal of pending){
            const order=compareCorrectionSources(authority,this.candidateAuthority(oldProposal));
            if(order==='newer')this.supersedeCandidate(oldProposal,candidateId,now);
            else this.db.prepare('UPDATE candidate_events SET review_version=review_version+1 WHERE id=?').run(oldProposal.id);
          }
          this.db.prepare("UPDATE announcement_jobs SET held_from=state,state='held' WHERE event_key=? AND state IN ('scheduled','pending_approval','blocked')").run(key);reviews++;if(active)corrections++;
          if(relatedRejection)this.audit(guild,'host','propose-materially-changed-reconsideration',candidateId,{previous:relatedRejection.candidate,fingerprint},now);
        }else if(state==='superseded'){
          this.releaseCandidateSourceHolds(this.candidate(guild,candidateId)!);
          this.audit(guild,'host','retain-older-proposal',candidateId,{successor:newerPending?.id??null,approvedRevision:active?.revision??null},now);
        }
      }
      if(reviews)this.alert(guild,corrections?'correction-held':'factual-review',batch,now);
      if(disposition==='public'){this.sourceState(source,'extracted');this.releaseSource(source);}
      else{
        // Identified proposals narrow an unresolved message to these milestones.
        // The blocked source/candidate remains reviewable; unrelated jobs resume.
        this.db.prepare('UPDATE sources SET unresolved_barrier=0 WHERE id=?').run(source);
        const keys=new Set(input.events.map(c=>guild+':'+eventKey(c.event)));
        for(const row of this.db.prepare('SELECT event_key FROM events WHERE guild=?').all(guild))if(!keys.has(String(row.event_key))){this.db.prepare('DELETE FROM source_holds WHERE source=? AND event_key=?').run(source,String(row.event_key));this.unhold(String(row.event_key));}
      }
      this.audit(guild,'ingestion','propose',batch,{hash},now);return batch;
    });
  }
  private pending(guild:string,id:string,version:number){const c=this.candidate(guild,id);if(!c||c.state!=='pending'||c.review_version!==version)throw new Error('Review is stale or candidate unavailable.');return c;}
  edit(guild:string,id:string,version:number,event:ScheduleEvent,issues:string[],actor:string,reason='Staff explicitly confirmed the edited public facts.'){return this.transaction(()=>{
    event=canonicalEvent(event);
    const c=this.pending(guild,id,version);validateEvent(event,JSON.parse(c.catalog_json) as Catalog);if(guild+':'+eventKey(event)!==c.event_key)throw new Error('Identity edits require rejection and a new proposal.');
    if(!Array.isArray(issues)||issues.some(x=>typeof x!=='string'||x.length>500))throw new Error('Invalid issues.');
    for(const issue of issues)validatePublicText(issue,'review issue');
    const timezoneConfirmed=event.timezoneAssumed===false,context={...this.candidateSemanticContext(c),timezoneConfirmed};
    if(typeof reason!=='string'||!reason.trim()||reason.length>500)throw new Error('A staff confirmation reason is required.');
    const before=JSON.parse(c.event_json) as Record<string,unknown>,at=Date.now();
    const changedFields=publicFactFields.filter(field=>canonical(before[field])!==canonical((event as unknown as Record<string,unknown>)[field]));
    let links=this.candidateEvidence(c),confirmationSource:string|null=null;
    if(changedFields.length){
      const facts=Object.fromEntries(changedFields.map(field=>[field,Object.hasOwn(event,field)?event[field]:null]));
      const confirmation=`Staff explicitly confirmed these public facts: ${canonical(facts)}`;
      validatePublicText(confirmation,'staff-confirmed public facts');
      confirmationSource=this.source(guild,{account:'moderator',messageId:randomUUID(),attachment:null,sha256:digest(confirmation),locator:'body'});
      this.saveEvidence(confirmationSource,{evidence:[{id:'body',text:confirmation}],blocked:[]});this.sourceState(confirmationSource,'extracted');this.releaseSource(confirmationSource);
      links=attributeStaffEdit(event,links,confirmationSource,changedFields);
    }
    const completeIssues=[...new Set([...issues,...attributionIssues(event,links,(s,id)=>this.retainedEvidence(s,id)),...semanticIssues(event,context),...entityEvidenceIssues(event,JSON.parse(c.catalog_json) as Catalog,context)])];
    this.db.prepare('UPDATE candidate_events SET field_evidence_json=? WHERE id=?').run(canonical(links),id);
    const fingerprint=factFingerprint(event,JSON.parse(c.catalog_json) as Catalog);
    this.db.prepare('UPDATE candidate_events SET event_json=?,issues_json=?,public_safety_version=1,fact_semantics_version=1,timezone_confirmed=?,fact_fingerprint=?,requires_correction_resolution=0,review_version=review_version+1 WHERE id=?').run(canonical(event),canonical(completeIssues),+timezoneConfirmed,fingerprint,id);
    this.audit(guild,actor,c.requires_correction_resolution?'resolve-correction':'edit',id,{beforeHash:digest(c.event_json),after:event,issues:completeIssues,timezoneConfirmed,reason,confirmationSource,changedFields},at);return this.candidate(guild,id)!;
  });}
  approve(guild:string,id:string,version:number,actor:string,now=Date.now()){return this.transaction(()=>{
    const c=this.pending(guild,id,version),active=this.event(guild,c.event_key);if((active?.revision??0)!==c.base_revision)throw new Error('Stale event revision; reject or rebase the proposal after inspecting the latest source.');
    if(c.requires_correction_resolution)throw new Error('Correction uncertainty requires explicit factual editing or dismissal before approval.');
    if(this.db.prepare("SELECT id FROM candidate_events WHERE guild=? AND event_key=? AND state='pending' AND id<>? LIMIT 1").get(guild,c.event_key,id))throw new Error('Competing correction proposals require explicit resolution; reject the conflicting proposal before approval.');
    if(c.public_safety_version!==1)throw new Error('Legacy facts require fresh public-safety review.');
    const event=JSON.parse(c.event_json) as ScheduleEvent,catalog=JSON.parse(c.catalog_json) as Catalog,context=this.candidateSemanticContext(c);
    if(c.fact_semantics_version!==1||this.evidenceIssues(c,event).length||semanticIssues(event,context).length||entityEvidenceIssues(event,catalog,context).length)throw new Error('Fact semantics or source support requires review.');
    if((JSON.parse(c.issues_json) as string[]).length)throw new Error('Resolve all factual issues before approval.');validateEvent(JSON.parse(c.event_json) as ScheduleEvent,JSON.parse(c.catalog_json) as Catalog,true);
    const revision=c.base_revision+1;
    this.db.prepare('INSERT INTO events(event_key,guild,revision,event_json,catalog_json,approved_by,approved_at,public_safety_version) VALUES(?,?,?,?,?,?,?,1) ON CONFLICT(event_key) DO UPDATE SET revision=excluded.revision,event_json=excluded.event_json,catalog_json=excluded.catalog_json,approved_by=excluded.approved_by,approved_at=excluded.approved_at,public_safety_version=1').run(c.event_key,guild,revision,c.event_json,c.catalog_json,actor,now);
    const authority=this.candidateAuthority(c);
    this.db.prepare('UPDATE events SET fact_semantics_version=1,authoritative_source_time=?,authoritative_source_hash=? WHERE event_key=?').run(authority.sourceTime,authority.sourceHash,c.event_key);
    this.db.prepare('INSERT INTO event_revisions(event_key,revision,event_json,catalog_json,actor,at) VALUES(?,?,?,?,?,?)').run(c.event_key,revision,c.event_json,c.catalog_json,actor,now);
    const proof=canonical(this.candidateEvidence(c));this.db.prepare('UPDATE events SET field_evidence_json=? WHERE event_key=?').run(proof,c.event_key);this.db.prepare('UPDATE event_revisions SET field_evidence_json=? WHERE event_key=? AND revision=?').run(proof,c.event_key,revision);
    this.db.prepare("UPDATE candidate_events SET state='approved' WHERE id=?").run(id);
    this.releaseCandidateSourceHolds(c);
    this.db.prepare("UPDATE announcement_jobs SET state='superseded' WHERE event_key=? AND state IN ('scheduled','held','pending_approval','blocked','draft')").run(c.event_key);
    if(this.db.prepare("SELECT id FROM announcement_jobs WHERE event_key=? AND state IN ('sent','delivering','uncertain') LIMIT 1").get(c.event_key))this.alert(guild,'correction-after-send',`${c.event_key}:${revision}`,now);
    this.audit(guild,actor,'approve-facts',id,{revision,event:c.event_json},now);return this.event(guild,c.event_key)!;
  });}
  reject(guild:string,id:string,version:number,actor:string){this.transaction(()=>{const c=this.pending(guild,id,version);this.rememberRejection(c,Date.now());this.db.prepare("UPDATE candidate_events SET state='rejected',review_version=review_version+1 WHERE id=?").run(id);this.audit(guild,actor,'reject',id,{fingerprint:c.fact_fingerprint});this.releaseCandidateSourceHolds(c);});}
  reconsider(guild:string,id:string,version:number,actor:string,reason:string,now=Date.now()){return this.transaction(()=>{
    const c=this.candidate(guild,id);if(!c||c.state!=='rejected'||c.review_version!==version)throw new Error('Rejected review is stale or unavailable.');
    if(!reason.trim()||reason.length>500)throw new Error('Explain the materially new evidence before reconsideration.');validatePublicText(reason,'reconsideration reason');
    const history=this.db.prepare('SELECT evidence_digests_json FROM rejected_facts WHERE guild=? AND event_key=? AND fingerprint=?').get(guild,c.event_key,c.fact_fingerprint!);
    const previous=new Set(JSON.parse(String(history?.evidence_digests_json??'[]')) as string[]);
    const sources=this.db.prepare('SELECT source FROM candidate_sources WHERE candidate=? ORDER BY rowid DESC').all(id);
    const fresh=sources.map(row=>({source:String(row.source),digest:this.sourceEvidenceDigest(String(row.source))})).find(row=>row.digest&&!previous.has(row.digest));
    if(!fresh?.digest)throw new Error('Reconsideration requires materially new saved source evidence, not an equivalent forward.');
    const existing=this.db.prepare("SELECT id FROM candidate_events WHERE guild=? AND event_key=? AND state='pending' LIMIT 1").get(guild,c.event_key);if(existing)throw new Error('Resolve the pending proposal before reconsidering rejected facts.');
    const batch=randomUUID(),candidate=randomUUID(),active=this.event(guild,c.event_key);
    this.db.prepare('INSERT INTO candidate_batches VALUES(?,?,?)').run(batch,fresh.source,digest({reconsider:id,evidence:fresh.digest,at:now}));
    this.db.prepare("INSERT INTO candidate_events(id,guild,batch,event_key,event_json,catalog_json,issues_json,confidence,base_revision,state,public_safety_version,fact_semantics_version,evidence_ids_json,timezone_confirmed,fact_fingerprint,correction_patch_json,reconsideration_of,requires_correction_resolution) VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?,?,?,?,?,?,?)").run(candidate,guild,batch,c.event_key,c.event_json,c.catalog_json,c.issues_json,c.confidence,active?.revision??0,c.public_safety_version,c.fact_semantics_version,c.evidence_ids_json,c.timezone_confirmed,c.fact_fingerprint,c.correction_patch_json,id,c.requires_correction_resolution);
    this.db.prepare('INSERT INTO candidate_sources SELECT ?,source FROM candidate_sources WHERE candidate=?').run(candidate,id);
    const freshIds=this.sourceSemanticContext(fresh.source).evidence?.map(e=>e.id)??[];
    this.db.prepare('UPDATE candidate_events SET field_evidence_json=? WHERE id=?').run(canonical([...this.candidateEvidence(c),...attributeFields(JSON.parse(c.event_json) as ScheduleEvent,fresh.source,freshIds)]),candidate);
    this.db.prepare('INSERT INTO candidate_reconsiderations VALUES(?,?,?,?,?,?)').run(candidate,id,actor,reason,fresh.digest,now);
    this.db.prepare("UPDATE announcement_jobs SET held_from=state,state='held' WHERE event_key=? AND state IN ('scheduled','pending_approval','blocked')").run(c.event_key);
    this.alert(guild,'correction-held',batch,now);this.audit(guild,actor,'reconsider-rejected',candidate,{previous:id,reason,evidenceDigest:fresh.digest},now);return this.candidate(guild,candidate)!;
  });}
  private unhold(key:string){if(!this.held(key))this.db.prepare("UPDATE announcement_jobs SET state=COALESCE(held_from,'blocked'),held_from=NULL WHERE event_key=? AND state='held'").run(key);}
  cancel(guild:string,key:string,status:'cancelled'|'postponed',actor:string,expectedRevision:number){return this.transaction(()=>{
    const e=this.event(guild,key);if(!e||e.revision!==expectedRevision)throw new Error('Event revision is stale.');const baseline=JSON.parse(e.event_json) as ScheduleEvent,event=applyCorrectionPatch(baseline,baseline,{kind:status==='cancelled'?'cancellation':'postponement',changedFields:[],clearFields:[]});
    const revision=e.revision+1;this.db.prepare('UPDATE events SET revision=?,event_json=?,approved_by=?,approved_at=? WHERE event_key=?').run(revision,canonical(event),actor,Date.now(),key);this.db.prepare('INSERT INTO event_revisions(event_key,revision,event_json,catalog_json,actor,at) VALUES(?,?,?,?,?,?)').run(key,revision,canonical(event),e.catalog_json,actor,Date.now());
    const confirmation=`Staff explicitly confirmed this event is ${status}. Operative start, end, and deadline are cleared.`,source=this.source(guild,{account:'moderator',messageId:randomUUID(),attachment:null,sha256:digest(confirmation),locator:'body'});
    this.saveEvidence(source,{evidence:[{id:'body',text:confirmation}],blocked:[]});this.sourceState(source,'extracted');
    const oldLinks=JSON.parse(String((e as ApprovedEvent&{field_evidence_json?:string}).field_evidence_json??'[]')) as EvidenceLink[];
    const links=attributeFields(event,source,['body'],undefined,oldLinks,{kind:status==='cancelled'?'cancellation':'postponement',changedFields:[],clearFields:[]});
    this.db.prepare('UPDATE events SET field_evidence_json=? WHERE event_key=?').run(canonical(links),key);this.db.prepare('UPDATE event_revisions SET field_evidence_json=? WHERE event_key=? AND revision=?').run(canonical(links),key,revision);this.releaseSource(source);
    this.db.prepare("UPDATE announcement_jobs SET state='cancelled' WHERE event_key=? AND state IN ('scheduled','held','pending_approval','blocked','draft')").run(key);this.alert(guild,'cancellation-review',`${key}:${revision}`);this.audit(guild,actor,status,key,event);return this.event(guild,key)!;
  });}
  held(key:string){return Boolean(this.db.prepare("SELECT id FROM candidate_events WHERE event_key=? AND state='pending'").get(key)||this.db.prepare('SELECT source FROM source_holds WHERE event_key=?').get(key)||this.db.prepare("SELECT s.id FROM sources s JOIN events e ON e.guild=s.guild WHERE e.event_key=? AND s.unresolved_barrier=1 AND s.state IN ('pending','retry','blocked') LIMIT 1").get(key));}
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
    if(Date.now()>j.expires)throw new Error('Publication window expired; review the missed-publication notice.');
    validatePublicDiscordPayload(JSON.parse(j.payload_json),{role:j.role,channel:j.channel});if(j.public_safety_version!==1||e.public_safety_version!==1||e.fact_semantics_version!==1||!this.eventEvidenceCurrent(e))throw new Error('Public-safety, evidence and fact-semantics review required.');
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
    if(j.public_safety_version!==1||e.public_safety_version!==1||e.fact_semantics_version!==1||!this.eventEvidenceCurrent(e))throw new Error('Public-safety, evidence and fact-semantics review required.');
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
    if(e.public_safety_version!==1||e.fact_semantics_version!==1||!this.eventEvidenceCurrent(e)){this.db.prepare("UPDATE announcement_jobs SET state='blocked',approved_by=NULL WHERE id=?").run(id);this.alert(j.guild,'public-safety-review',id);return undefined;}
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
