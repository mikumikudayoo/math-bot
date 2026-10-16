import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { copyFileSync,mkdtempSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnnouncementStore } from '../src/announcements/store.js';
import { canonical,digest,eventKey,type Catalog,type ScheduleEvent,type Source } from '../src/announcements/model.js';
import { plan } from '../src/announcements/planner.js';
import { deliverAnnouncements } from '../src/announcements/delivery.js';
import type { AutomationConfig,PolicyFile } from '../src/announcements/config.js';
import { removeAnnouncementTestDirectory } from './announcement-test-cleanup.js';

const guild='111111111111111111',channel='222222222222222222',now=Date.parse('2030-01-01T00:00:00+08:00'),account='synthetic-legacy-rehearsal';
const schema=readFileSync(new URL('./fixtures/announcements/legacy-v1-schema.sql',import.meta.url),'utf8');
const catalog:Catalog={competitions:[],rounds:[],programs:[{id:'vtamps-v30-0',name:'VTAMPS',version:'30.0'}]};
const event=(slot:string):ScheduleEvent=>({competitionId:null,roundId:null,programId:'vtamps-v30-0',preparesFor:[],yearLevel:'Senior Secondary',type:'training-session',slot,start:now+7*86400000,end:now+7*86400000+7200000,deadline:null,timezone:'Asia/Manila',url:null,detailLabel:null});
const key=(slot:string)=>guild+':'+eventKey(event(slot));
const policy:PolicyFile={guild,channel,role:null,staffChannel:null,policies:[{id:'session-hour',type:'training-session',anchor:'start',beforeMinutes:60,template:'session',major:false,asset:'none'}],templates:{session:'Session {{slot}} on {{date}} from {{timeRange}}.'}};
const config:AutomationConfig={enabled:true,autoSend:false,database:':memory:',assets:'/tmp/synthetic-legacy-assets',policy,gmail:{account,query:'from:organizer@example.org',senders:['organizer@example.org'],clientId:'',clientSecret:'',refreshToken:''},provider:{backend:'https://example.invalid/v1',model:'synthetic',backendKey:'',nativeTools:false,vision:false},pollMs:120000};
const historyJobs=['sent','uncertain','delivering','scheduled','held','pending_approval','blocked'] as const;
const hashFile=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');

/** Original columns only: additive migrations may append columns but cannot alter this history. */
function historicalRows(db:DatabaseSync){return {
  sources:db.prepare('SELECT id,guild,account,message_id,hash,metadata,state,attempts,retry_at FROM sources ORDER BY id').all(),
  evidence:db.prepare('SELECT * FROM source_evidence ORDER BY source').all(),
  batches:db.prepare('SELECT * FROM candidate_batches ORDER BY id').all(),
  candidates:db.prepare('SELECT id,guild,batch,event_key,event_json,catalog_json,issues_json,confidence,base_revision,review_version,state FROM candidate_events ORDER BY id').all(),
  provenance:db.prepare('SELECT * FROM candidate_sources ORDER BY candidate,source').all(),
  events:db.prepare('SELECT event_key,guild,revision,event_json,catalog_json,approved_by,approved_at FROM events ORDER BY event_key').all(),
  revisions:db.prepare('SELECT event_key,revision,event_json,catalog_json,actor,at FROM event_revisions ORDER BY event_key,revision').all(),
  attempts:db.prepare('SELECT * FROM delivery_attempts ORDER BY job').all(),
  audit:db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
  draft:db.prepare('SELECT * FROM announcement_drafts ORDER BY job').all(),
  incidents:db.prepare('SELECT * FROM operational_incidents ORDER BY guild,provider').all(),
  failures:db.prepare('SELECT * FROM source_failures ORDER BY source').all(),
  jobs:db.prepare('SELECT id,guild,event_key,revision,policy,channel,role,due,expires,major,asset_policy,asset,payload_json,message FROM announcement_jobs ORDER BY id').all(),
  terminal:db.prepare("SELECT id,state,message,approved_by FROM announcement_jobs WHERE state IN ('sent','uncertain','delivering') ORDER BY id").all(),
  legacyAlerts:db.prepare("SELECT id,guild,kind,target,state,message,at FROM staff_alerts WHERE id LIKE 'synthetic-legacy-alert-%' ORDER BY id").all(),
};}
function completeRows(db:DatabaseSync){
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  return canonical(Object.fromEntries(tables.map(row=>{const name=String(row.name),quoted='"'+name.replaceAll('"','""')+'"';return [name,db.prepare(`SELECT * FROM ${quoted}`).all().map(canonical).sort()];})));
}
function seedLegacy(path:string,numericIds:boolean){
  const db=new DatabaseSync(path);try{db.exec(schema);
  const source:Source={account,messageId:'synthetic-legacy-message',attachment:null,sha256:digest('synthetic-legacy-content'),locator:'synthetic source; no Gmail replay'};
  const sourceId=digest([account,source.messageId]);
  db.prepare('INSERT INTO sources(id,guild,account,message_id,hash,metadata,state,attempts,retry_at) VALUES(?,?,?,?,?,?,?,?,?)').run(sourceId,guild,account,source.messageId,source.sha256,canonical(source),'extracted',3,0);
  db.prepare('INSERT INTO source_evidence VALUES(?,?)').run(sourceId,canonical({evidence:[{id:'body',text:'VTAMPS V.30.0 Senior Secondary synthetic historical timetable, January 8, 2030, Asia/Manila.'}],blocked:[]}));
  db.prepare('INSERT INTO candidate_batches VALUES(?,?,?)').run('synthetic-legacy-batch',sourceId,digest('synthetic-legacy-batch'));
  for(const [index,state] of ['approved','pending','rejected'].entries()){
    const slot=String(index+1),id=`synthetic-legacy-${state}`;
    db.prepare('INSERT INTO candidate_events VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,guild,'synthetic-legacy-batch',key(slot),canonical(event(slot)),canonical(catalog),canonical(state==='pending'?['Legacy timetable needs fresh factual review.']:[]),'high',state==='approved'?1:0,state==='pending'?4:2,state);
    db.prepare('INSERT INTO candidate_sources VALUES(?,?)').run(id,sourceId);
  }
  db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)').run(key('1'),guild,2,canonical(event('1')),canonical(catalog),'synthetic-original-staff',now);
  for(const revision of [1,2])db.prepare('INSERT INTO event_revisions VALUES(?,?,?,?,?,?)').run(key('1'),revision,canonical({...event('1'),start:event('1').start!-(2-revision)*86400000,end:event('1').end!-(2-revision)*86400000}),canonical(catalog),'synthetic-original-staff',now-(2-revision)*1000);
  for(const state of historyJobs){
    const id=`synthetic-legacy-job-${state}`,message=state==='sent'?'synthetic-discord-receipt':null;
    const payload=canonical({content:'Synthetic historical Session 1 reminder.',allowedMentions:{parse:[],roles:[],users:[],repliedUser:false}});
    db.prepare('INSERT INTO announcement_jobs(id,guild,event_key,revision,policy,channel,role,due,expires,major,asset_policy,asset,payload_json,state,message,approved_by,held_from) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,guild,key('1'),2,`synthetic-legacy-policy-${state}`,channel,null,now+86400000,now+86460000,state==='pending_approval'?1:0,'none',null,payload,state,message,state==='scheduled'||state==='pending_approval'?'synthetic-original-staff':null,state==='held'?'scheduled':null);
    if(['sent','uncertain','delivering'].includes(state))db.prepare('INSERT INTO delivery_attempts VALUES(?,?,?,?)').run(id,state==='delivering'?'reserved':state,message,now-1000);
  }
  db.prepare('INSERT INTO announcement_drafts VALUES(?,?,?,?)').run('synthetic-legacy-job-pending_approval','retry',2,now+60000);
  for(const [id,state] of [['synthetic-legacy-alert-pending','pending'],['synthetic-legacy-alert-sent','sent']])db.prepare('INSERT INTO staff_alerts VALUES(?,?,?,?,?,?,?)').run(id,guild,'factual-review',state==='sent'?'synthetic-historical-alert-target':'synthetic-legacy-batch',state,state==='sent'?'synthetic-staff-receipt':null,now-1000);
  for(const [index,action] of ['approve-facts','reject','delivery-attempt'].entries())db.prepare('INSERT INTO audit_log VALUES(?,?,?,?,?,?,?)').run(index+1,guild,'synthetic-original-staff',action,'synthetic-legacy-batch',canonical({synthetic:true,revision:2}),now-1000+index);
  db.prepare('INSERT INTO operational_incidents VALUES(?,?,?,?,?,?,?)').run(guild,'groq','synthetic-old-incident',1,now-1000,3,'Synthetic provider unavailable.');
  db.prepare('INSERT INTO source_failures VALUES(?,?,?,?)').run(sourceId,'groq','Synthetic historical provider failure.',now-1000);
  for(const [state,value] of [['cursor','150'],['bootstrap-history-id','100'],['bootstrap-mode','future-only'],['bootstrap-at',String(now-86400000)],['health','healthy']])db.prepare('INSERT INTO gmail_state VALUES(?,?)').run(`gmail:${account}:${state}`,value);
  if(numericIds){
    db.exec(`CREATE TABLE candidate_public_ids(public_id INTEGER PRIMARY KEY AUTOINCREMENT,candidate TEXT NOT NULL UNIQUE);
      CREATE TRIGGER candidate_public_id_insert AFTER INSERT ON candidate_events BEGIN INSERT INTO candidate_public_ids(candidate) VALUES(NEW.id); END;
      INSERT INTO schema_version VALUES(2);`);
    for(const [number,candidate] of [[41,'synthetic-legacy-approved'],[52,'synthetic-legacy-pending'],[63,'synthetic-legacy-rejected'],[90,'synthetic-deleted-candidate-tombstone']])db.prepare('INSERT INTO candidate_public_ids VALUES(?,?)').run(number,candidate);
  }
  const historical=historicalRows(db),numbers=numericIds?canonical(db.prepare('SELECT * FROM candidate_public_ids ORDER BY public_id').all()):undefined;
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');return {historical,numbers};
  }finally{db.close();}
}

for(const numericIds of [false,true])test(`isolated checkpoint schema ${numericIds?'v2 with numeric tombstones':'v1 without public IDs'} migrates conservatively and survives two further constructor reopens`,async()=>{
  const dir=mkdtempSync(join(tmpdir(),'announcement-full-migration-')),original=join(dir,'synthetic-original.sqlite'),copy=join(dir,'synthetic-rehearsal.sqlite');
  let store:AnnouncementStore|undefined;
  try{
    const baseline=seedLegacy(original,numericIds),originalHash=hashFile(original);copyFileSync(original,copy);
    store=new AnnouncementStore(copy);assert.deepEqual(historicalRows(store.db),baseline.historical);
    assert.equal(store.state(`gmail:${account}:cursor`),'150');assert.equal(store.state(`gmail:${account}:bootstrap-history-id`),'100');assert.equal(store.state(`gmail:${account}:bootstrap-mode`),'future-only');
    const versions=store.db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(row=>Number(row.version));for(const version of [1,2,3,4,5,6,7,8,9])assert.ok(versions.includes(version));
    assert.equal(store.db.prepare('SELECT count(*) n FROM announcement_job_public_ids').get()!.n,historyJobs.length);
    const numbers=canonical(store.db.prepare('SELECT * FROM candidate_public_ids ORDER BY public_id').all());
    if(numericIds)assert.equal(numbers,baseline.numbers);else assert.deepEqual(store.db.prepare('SELECT public_id FROM candidate_public_ids ORDER BY public_id').all().map(row=>Number(row.public_id)),[1,2,3]);
    const pending=store.candidate(guild,'synthetic-legacy-pending')!;assert.equal(pending.state,'pending');assert.equal(pending.review_version,4);assert.equal(pending.public_safety_version,0);assert.equal(pending.fact_semantics_version,0);assert.throws(()=>store!.approve(guild,pending.id,pending.review_version,'synthetic-new-staff',now));
    assert.equal(store.candidate(guild,'synthetic-legacy-rejected')!.state,'rejected');assert.ok(store.db.prepare("SELECT candidate FROM rejected_facts WHERE candidate='synthetic-legacy-rejected'").get());
    const approved=store.event(guild,key('1'))!;assert.equal(approved.revision,2);assert.equal(approved.public_safety_version,0);assert.equal(approved.fact_semantics_version,0);assert.deepEqual(JSON.parse(String(store.db.prepare('SELECT field_evidence_json FROM events WHERE event_key=?').get(key('1'))!.field_evidence_json)),[]);
    for(const state of ['sent','uncertain','delivering'])assert.equal(store.job(guild,`synthetic-legacy-job-${state}`)!.state,state);
    for(const state of ['scheduled','held','pending_approval','blocked']){const job=store.job(guild,`synthetic-legacy-job-${state}`)!;assert.equal(job.state,'blocked');assert.equal(job.public_safety_version,0);assert.equal(job.approved_by,null);}
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM legacy_delivery_guards').get()!.n,historyJobs.length);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM delivery_attempts').get()!.n,3);
    plan(store,policy,now);assert.equal(store.jobs(guild).length,historyJobs.length);assert.equal(store.jobs(guild).filter(job=>job.state==='scheduled').length,0);
    let sends=0;await deliverAnnouncements(store,config,async()=>{sends++;return {id:'synthetic-never-sent'};},now+86400000);assert.equal(sends,0);assert.equal(config.autoSend,false);
    // A tombstone remains consumed even after an otherwise disposable candidate is deleted.
    const previous=Number(store.db.prepare('SELECT MAX(public_id) n FROM candidate_public_ids').get()!.n);
    store.db.prepare('INSERT INTO candidate_events(id,guild,batch,event_key,event_json,catalog_json,issues_json,confidence,base_revision,state) VALUES(?,?,?,?,?,?,?,?,?,?)').run('synthetic-disposable-candidate',guild,'synthetic-legacy-batch',key('4'),canonical(event('4')),canonical(catalog),'[]','high',0,'pending');
    const next=Number(store.db.prepare("SELECT public_id FROM candidate_public_ids WHERE candidate='synthetic-disposable-candidate'").get()!.public_id);assert.ok(next>previous);store.db.prepare("DELETE FROM candidate_events WHERE id='synthetic-disposable-candidate'").run();
    const stable=completeRows(store.db);store.close();store=new AnnouncementStore(copy);assert.equal(completeRows(store.db),stable);store.close();store=new AnnouncementStore(copy);assert.equal(completeRows(store.db),stable);
    assert.deepEqual(historicalRows(store.db),baseline.historical);assert.equal(store.state(`gmail:${account}:cursor`),'150');assert.equal(store.db.prepare("SELECT public_id FROM candidate_public_ids WHERE candidate='synthetic-disposable-candidate'").get()!.public_id,next);assert.equal(hashFile(original),originalHash);
    assert.equal(store.db.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{store?.close();removeAnnouncementTestDirectory(dir);}
});
