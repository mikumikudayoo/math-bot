import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { describeEvent,digest,eventKey,renderEvent,validateConfig,validateEvent,validateExtraction,type Catalog,type Extraction,type PreviewConfig,type ScheduleEvent } from './model.js';

interface DraftRow { id:string; batch:string; event_key:string; event_json:string; catalog_json:string; confidence:string; issues_json:string; base_revision:number; state:string }
interface EventRow { event_key:string; revision:number; event_json:string; catalog_json:string; source_batch:string; approved_by:string; approved_at:number }
export class AutomationStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    // This prototype has no production mode and cannot open the legacy reminder DB.
    if(path!==':memory:' && !path.endsWith('.automation-sandbox.sqlite')) throw new Error('Use an explicit *.automation-sandbox.sqlite database.');
    if(path!==':memory:') mkdirSync(dirname(path),{recursive:true});
    this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS automation_batches(id TEXT PRIMARY KEY,source_key TEXT NOT NULL UNIQUE,input_hash TEXT NOT NULL,source_json TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS automation_drafts(id TEXT PRIMARY KEY,batch TEXT NOT NULL,event_key TEXT NOT NULL,event_json TEXT NOT NULL,catalog_json TEXT NOT NULL,confidence TEXT NOT NULL,issues_json TEXT NOT NULL,base_revision INTEGER NOT NULL,state TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS automation_pending ON automation_drafts(event_key,state);
      CREATE TABLE IF NOT EXISTS automation_events(event_key TEXT PRIMARY KEY,revision INTEGER NOT NULL,event_json TEXT NOT NULL,catalog_json TEXT NOT NULL,source_batch TEXT NOT NULL,approved_by TEXT NOT NULL,approved_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS automation_audit(id INTEGER PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,at INTEGER NOT NULL,snapshot_json TEXT NOT NULL);`);
  }
  private transaction<T>(fn:()=>T):T { this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;} }
  private audit(actor:string,action:string,target:string,snapshot:unknown,now:number) {
    if(!actor.trim())throw new Error('Reviewer identity is required.');
    this.db.prepare('INSERT INTO automation_audit(actor,action,target,at,snapshot_json) VALUES(?,?,?,?,?)').run(actor,action,target,now,JSON.stringify(snapshot));
  }
  private active(key:string) { return this.db.prepare('SELECT * FROM automation_events WHERE event_key=?').get(key) as unknown as EventRow|undefined; }
  ingest(input: Extraction,now=Date.now()) {
    validateExtraction(input);
    return this.transaction(()=>{
      const sourceKey=digest([input.source.account,input.source.messageId,input.source.attachment,input.source.sha256]);
      const existing=this.db.prepare('SELECT id,input_hash FROM automation_batches WHERE source_key=?').get(sourceKey) as {id:string;input_hash:string}|undefined;
      if(existing) {if(existing.input_hash!==digest(input))throw new Error('This source was already parsed differently; review the existing batch instead.');return {id:existing.id,duplicate:true};}
      const batch=randomUUID();
      this.db.prepare('INSERT INTO automation_batches VALUES(?,?,?,?,?)').run(batch,sourceKey,digest(input),JSON.stringify(input.source),now);
      for(const c of input.events) {
        const key=eventKey(c.event),old=this.active(key);
        const unchanged=old && old.event_json===JSON.stringify(c.event) && old.catalog_json===JSON.stringify(input.catalog);
        this.db.prepare('INSERT INTO automation_drafts VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),batch,key,JSON.stringify(c.event),JSON.stringify(input.catalog),c.confidence,JSON.stringify(c.issues),old?.revision??0,unchanged?'unchanged':'pending');
      }
      this.audit('ingestion','import',batch,input,now);
      return {id:batch,duplicate:false};
    });
  }
  review(batch:string) {
    const source=this.db.prepare('SELECT source_json FROM automation_batches WHERE id=?').get(batch) as {source_json:string}|undefined;
    if(!source)throw new Error('Batch not found.');
    return {batch,source:JSON.parse(source.source_json),events:this.drafts(batch).map(r=>{
      const active=this.active(r.event_key);
      return {id:r.id,state:r.state,confidence:r.confidence,issues:JSON.parse(r.issues_json),baseRevision:r.base_revision,currentRevision:active?.revision??0,change:active?'update':'new',display:describeEvent(JSON.parse(r.event_json) as ScheduleEvent,JSON.parse(r.catalog_json) as Catalog),event:JSON.parse(r.event_json),catalog:JSON.parse(r.catalog_json),previous:active?JSON.parse(active.event_json):null};
    })};
  }
  private drafts(batch:string) { return this.db.prepare('SELECT * FROM automation_drafts WHERE batch=? ORDER BY rowid').all(batch) as unknown as DraftRow[]; }
  edit(batch:string,id:string,event:ScheduleEvent,issues:string[],actor:string,now=Date.now()) {
    this.transaction(()=>{
      const row=this.drafts(batch).find(x=>x.id===id && x.state==='pending');if(!row)throw new Error('Pending draft not found.');
      validateEvent(event,JSON.parse(row.catalog_json) as Catalog);
      if(eventKey(event)!==row.event_key)throw new Error('Identity changes require rejecting and importing a new candidate.');
      if(!Array.isArray(issues)||issues.some(x=>typeof x!=='string'||!x.trim()||x.length>500))throw new Error('Invalid review issues.');
      this.db.prepare('UPDATE automation_drafts SET event_json=?,issues_json=? WHERE id=?').run(JSON.stringify(event),JSON.stringify(issues),id);
      this.audit(actor,'edit',id,{before:JSON.parse(row.event_json),event,issues},now);
    });
  }
  reject(batch:string,ids:string[]|null,actor:string,incorrect=false,now=Date.now()) {
    this.transaction(()=>{
      const rows=this.drafts(batch);if(!rows.length)throw new Error('Batch not found.');
      const selected=ids===null?rows.filter(x=>x.state==='pending'):ids.map(id=>{const r=rows.find(x=>x.id===id&&x.state==='pending');if(!r)throw new Error('Pending draft not found.');return r;});
      for(const row of selected)this.db.prepare('UPDATE automation_drafts SET state=? WHERE id=?').run(incorrect?'incorrect':'rejected',row.id);
      this.audit(actor,incorrect?'incorrect-extraction':'reject',batch,selected,now);
    });
  }
  approve(batch:string,ids:string[]|null,actor:string,now=Date.now()) {
    return this.transaction(()=>{
      const rows=this.drafts(batch);if(!rows.length)throw new Error('Batch not found.');
      const selected=ids===null?rows.filter(x=>x.state==='pending'):ids.map(id=>{const r=rows.find(x=>x.id===id&&x.state==='pending');if(!r)throw new Error('Pending draft not found.');return r;});
      if(new Set(selected.map(x=>x.id)).size!==selected.length)throw new Error('Duplicate selections.');
      for(const row of selected) {
        if((JSON.parse(row.issues_json) as string[]).length)throw new Error('Resolve extraction issues explicitly before approval.');
        if((this.active(row.event_key)?.revision??0)!==row.base_revision)throw new Error('Stale approval: another review changed this event. Re-import using a new source revision.');
        validateEvent(JSON.parse(row.event_json) as ScheduleEvent,JSON.parse(row.catalog_json) as Catalog,true);
        this.db.prepare('INSERT INTO automation_events VALUES(?,?,?,?,?,?,?) ON CONFLICT(event_key) DO UPDATE SET revision=excluded.revision,event_json=excluded.event_json,catalog_json=excluded.catalog_json,source_batch=excluded.source_batch,approved_by=excluded.approved_by,approved_at=excluded.approved_at').run(row.event_key,row.base_revision+1,row.event_json,row.catalog_json,batch,actor,now);
        this.db.prepare("UPDATE automation_drafts SET state='approved' WHERE id=?").run(row.id);
      }
      this.audit(actor,'approve',batch,selected,now);return selected.length;
    });
  }
  preview(config:PreviewConfig,now=Date.now()) {
    validateConfig(config);
    const events=this.db.prepare('SELECT * FROM automation_events ORDER BY event_key').all() as unknown as EventRow[];
    return events.flatMap(row=>{
      const e=JSON.parse(row.event_json) as ScheduleEvent,catalog=JSON.parse(row.catalog_json) as Catalog;
      const pending=this.db.prepare("SELECT id FROM automation_drafts WHERE event_key=? AND state='pending' LIMIT 1").get(row.event_key);
      return config.rules.filter(r=>r.type===e.type).map(rule=>{
        const anchor=e[rule.anchor],due=anchor===null?null:anchor-rule.beforeMinutes*60000;
        let status='planned',reason:string|null=null,payload:ReturnType<typeof renderEvent>|null=null;
        if(pending){status='held';reason='A possible schedule correction awaits review.';}
        else if(due===null){status='blocked';reason=`Missing ${rule.anchor} time.`;}
        else if(anchor!<=now || due<=now){status='skipped';reason='Event or reminder time has passed; no catch-up sends.';}
        else try {payload=renderEvent(e,catalog,config,rule.template);}catch(error){status='blocked';reason=error instanceof Error?error.message:String(error);}
        return {mode:'dry-run' as const,eventKey:row.event_key,revision:row.revision,rule:rule.id,status,reason,due:due===null?null:new Date(due).toISOString(),guild:config.guild,channel:config.channel,role:config.role,payload,provenance:{batch:row.source_batch,approvedBy:row.approved_by,approvedAt:row.approved_at}};
      });
    });
  }
  close(){this.db.close();}
}
