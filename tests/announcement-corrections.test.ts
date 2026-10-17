import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AnnouncementStore,type Candidate} from '../src/announcements/store.js';
import {canonical,digest,type Extraction,type ScheduleEvent} from '../src/announcements/model.js';
import {registerEffectivePolicy} from '../src/announcements/delivery-identity.js';
import {plan} from '../src/announcements/planner.js';
import type {PolicyFile} from '../src/announcements/config.js';
import {removeAnnouncementTestDirectory} from './announcement-test-cleanup.js';

const guild='111111111111111111',channel='222222222222222222',now=Date.UTC(2030,0,1),sourceAt=now-86400000;
const sourceText='VTAMPS V.30.0 Senior Secondary Session 1: January 3, 2030, 9 AM to 11 AM Asia/Manila. Public auditorium. Public resource: https://example.org/resources/vtamps';
const policy:PolicyFile={guild,channel,role:null,staffChannel:null,templates:{session:'Session {{slot}} on {{date}} from {{timeRange}}.'},policies:[{id:'session-hour',type:'training-session',anchor:'start',beforeMinutes:60,template:'session',major:false,asset:'none'}]};
function facts(id:string,time:number|null=sourceAt,shift=0):Extraction{return {source:{account:'synthetic-corrections',messageId:id,attachment:null,sha256:digest(id),locator:'body'},sourceTime:time,catalog:{competitions:[],rounds:[],programs:[{id:'vtamps-v30-0',name:'VTAMPS',version:'30.0'}]},events:[{event:{competitionId:null,roundId:null,programId:'vtamps-v30-0',preparesFor:[],yearLevel:'Senior Secondary',type:'training-session',slot:'1',start:now+2*86400000+3600000+shift,end:now+2*86400000+10800000+shift,deadline:null,timezone:'Asia/Manila',timezoneAssumed:false,status:'active',url:'https://example.org/resources/vtamps',detailLabel:'Training schedule',logistics:{venue:'Public auditorium',bring:['Pencil']},temporal:{start:{precision:'exact',expression:'January 3, 2030, 9 AM',sourceTime:time},end:{precision:'exact',expression:'January 3, 2030, 11 AM',sourceTime:time}}},confidence:'high',issues:[],evidenceIds:['body']}]};}
function ingest(store:AnnouncementStore,input:Extraction,text=sourceText,blocked:string[]=[]){const id=store.source(guild,input.source);store.saveEvidence(id,{evidence:[{id:'body',text}],blocked});store.ingest(guild,input,now);return id;}
function pending(store:AnnouncementStore){return store.candidates(guild).filter(c=>c.state==='pending');}
function approve(store:AnnouncementStore,c:Candidate){return store.approve(guild,c.id,c.review_version,'synthetic-staff',now);}
function activate(store:AnnouncementStore){ingest(store,facts('baseline'));const candidate=pending(store)[0]!;approve(store,candidate);const snapshot=registerEffectivePolicy(store,policy,0).snapshot;plan(store,policy,now,snapshot);return {candidate,snapshot,job:store.jobs(guild)[0]!};}
function correction(id:string,time:number|null,shift:number):Extraction{const input=facts(id,time,shift);input.correction=true;input.events[0]!.correctionPatch={kind:'partial',changedFields:['start','end','temporal'],clearFields:[]};return input;}

test('a bogus same-fingerprint correction cannot release the admitted source barrier as unchanged',()=>{
  for(const field of ['availability','temporal','logistics','start']){
    const store=new AnnouncementStore(':memory:');try{
      const base=activate(store),input=correction(`bogus-${field}`,sourceAt+1000,0);
      input.events[0]!.correctionPatch={kind:'partial',changedFields:[field],clearFields:[]};
      (input.events[0]!.event as unknown as Record<string,unknown>)[field]=null;
      const source=store.source(guild,input.source);store.saveEvidence(source,{evidence:[{id:'body',text:sourceText}],blocked:[]});
      assert.throws(()=>store.ingest(guild,input,now));
      assert.equal(store.held(base.candidate.event_key),true);assert.equal(store.event(guild,base.candidate.event_key)!.revision,1);
      assert.equal(store.job(guild,base.job.id)!.state,'held');
    }finally{store.close();}
  }
});

test('unreadable identical erratum remains pending and held until explicit factual resolution',()=>{
  const store=new AnnouncementStore(':memory:');try{
    const base=activate(store),input=correction('unreadable',sourceAt+1000,0);input.events[0]!.correctionPatch!.changedFields=[];
    const source=ingest(store,input,sourceText+'\nUpdated schedule is in the attached image; no other details changed.',['Scanned replacement schedule requires manual review.']);
    const c=pending(store)[0]!;assert.ok(c);assert.equal(c.requires_correction_resolution,1);assert.equal(store.job(guild,base.job.id)!.state,'held');assert.equal(store.held(c.event_key),true);
    assert.equal(store.db.prepare('SELECT state FROM sources WHERE id=?').get(source)!.state,'blocked');assert.throws(()=>approve(store,c));
    store.dismissSource(guild,source,'synthetic-staff');assert.throws(()=>approve(store,c));assert.equal(store.held(c.event_key),true);
    const resolved=store.edit(guild,c.id,c.review_version,JSON.parse(c.event_json) as ScheduleEvent,[],'synthetic-staff');approve(store,resolved);
    assert.equal(store.held(c.event_key),false);assert.equal(store.event(guild,c.event_key)!.revision,2);assert.ok(store.db.prepare("SELECT id FROM audit_log WHERE action='resolve-correction'").get());
  }finally{store.close();}
});

test('needs-review imports retain identifiable correction candidates and source holds',()=>{
  const store=new AnnouncementStore(':memory:');try{
    const base=activate(store),input=correction('needs-review',sourceAt+1000,3600000);input.disposition='needs_review';input.dispositionReason='Replacement timetable requires manual factual confirmation.';
    ingest(store,input);const c=pending(store)[0]!;assert.ok(c);assert.equal(store.job(guild,base.job.id)!.state,'held');assert.throws(()=>approve(store,c));
    const resolved=store.edit(guild,c.id,c.review_version,JSON.parse(c.event_json) as ScheduleEvent,[],'synthetic-staff');approve(store,resolved);assert.equal(store.held(c.event_key),false);
  }finally{store.close();}
});

test('a correction without an explicit patch cannot silently treat null extraction values as replacement',()=>{
  const store=new AnnouncementStore(':memory:');try{
    activate(store);const input=facts('missing-patch',sourceAt+1000);input.correction=true;input.events[0]!.event.url=null;ingest(store,input);
    const c=pending(store)[0]!;assert.equal(c.requires_correction_resolution,1);assert.throws(()=>approve(store,c));assert.ok((JSON.parse(c.issues_json) as string[]).some(issue=>/patch/i.test(issue)));
  }finally{store.close();}
});

test('a partial correction preserves baseline URL and logistics; explicit clearing is separate',()=>{
  const store=new AnnouncementStore(':memory:');try{
    const base=activate(store),input=correction('time-only',sourceAt+1000,3600000);input.events[0]!.event.url=null;input.events[0]!.event.detailLabel=null;delete input.events[0]!.event.logistics;
    ingest(store,input);const c=pending(store)[0]!,event=JSON.parse(c.event_json) as ScheduleEvent;assert.equal(event.url,'https://example.org/resources/vtamps');assert.deepEqual(event.logistics,{venue:'Public auditorium',bring:['Pencil']});approve(store,c);
    const clear=correction('clear-url',sourceAt+2000,3600000);clear.events[0]!.correctionPatch={kind:'partial',changedFields:[],clearFields:['url']};ingest(store,clear);const next=pending(store)[0]!;approve(store,next);assert.equal((JSON.parse(store.event(guild,base.candidate.event_key)!.event_json) as ScheduleEvent).url,null);
  }finally{store.close();}
});

for(const kind of ['cancellation','postponement'] as const)test(`explicit ${kind} is reviewed as event lifecycle and stops the old schedule`,()=>{
  const store=new AnnouncementStore(':memory:');try{
    const base=activate(store),input=correction(kind,sourceAt+1000,0);input.events[0]!.correctionPatch={kind,changedFields:[],clearFields:[]};ingest(store,input);const c=pending(store)[0]!;approve(store,c);plan(store,policy,now,base.snapshot);
    const event=JSON.parse(store.event(guild,c.event_key)!.event_json) as ScheduleEvent;assert.equal(event.status,kind==='cancellation'?'cancelled':'postponed');assert.equal(event.start,null);assert.equal(event.end,null);assert.equal(event.url,'https://example.org/resources/vtamps');assert.equal(store.jobs(guild).filter(j=>j.state==='scheduled').length,0);
  }finally{store.close();}
});

test('latest pending correction supersedes older proposals, invalidates buttons, and clears the active hold on approval',()=>{
  const store=new AnnouncementStore(':memory:');try{
    const base=activate(store);ingest(store,correction('first-change',sourceAt+1000,3600000));const first=pending(store)[0]!;ingest(store,correction('latest-change',sourceAt+2000,7200000));const latest=pending(store)[0]!;
    assert.equal(pending(store).length,1);assert.notEqual(latest.id,first.id);const old=store.candidate(guild,first.id)!;assert.equal(old.state,'superseded');assert.equal(old.superseded_by,latest.id);assert.ok(old.review_version>first.review_version);assert.equal(old.public_id,first.public_id);assert.throws(()=>approve(store,first));
    approve(store,latest);assert.equal(store.held(latest.event_key),false);plan(store,policy,now,base.snapshot);assert.equal(store.jobs(guild).filter(j=>j.state==='scheduled').length,1);assert.equal(store.jobs(guild).find(j=>j.state==='scheduled')!.revision,2);
  }finally{store.close();}
});

test('delayed older corrections cannot displace the latest pending or already approved source revision',()=>{
  const store=new AnnouncementStore(':memory:');try{
    activate(store);ingest(store,correction('new-correction',sourceAt+3000,7200000));const newest=pending(store)[0]!;
    ingest(store,correction('older-late',sourceAt+1000,3600000));assert.deepEqual(pending(store).map(c=>c.id),[newest.id]);approve(store,newest);
    const retry=correction('older-retry-after-approval',sourceAt+2000,3600000);ingest(store,retry);assert.equal(pending(store).length,0);assert.equal(store.held(newest.event_key),false);assert.equal((JSON.parse(store.event(guild,newest.event_key)!.event_json) as ScheduleEvent).start,now+2*86400000+3600000+7200000);assert.equal(store.candidates(guild)[0]!.state,'superseded');
  }finally{store.close();}
});

test('a newer equivalent confirmation refreshes authority and evidence without recycling candidate identity',()=>{
  const store=new AnnouncementStore(':memory:');try{
    activate(store);ingest(store,correction('equivalent-first',sourceAt+1000,3600000));const first=pending(store)[0]!;
    const confirmed=correction('equivalent-later-confirmation',sourceAt+3000,3600000),confirmedSource=ingest(store,confirmed);
    const refreshed=store.candidate(guild,first.id)!;assert.equal(pending(store).length,1);assert.equal(refreshed.public_id,first.public_id);assert.ok(refreshed.review_version>first.review_version);assert.throws(()=>approve(store,first));
    const primary=store.db.prepare('SELECT source FROM candidate_batches WHERE id=?').get(refreshed.batch)!;assert.equal(primary.source,confirmedSource);assert.ok(store.candidateEvidence(refreshed).some(link=>link.source===confirmedSource));
    ingest(store,correction('delayed-change-before-confirmation',sourceAt+2000,7200000));assert.deepEqual(pending(store).map(c=>c.id),[first.id]);assert.equal(store.candidates(guild)[0]!.state,'superseded');
    const olderEquivalent=correction('older-equivalent-retry',sourceAt+500,3600000);ingest(store,olderEquivalent);const retained=store.candidate(guild,first.id)!;assert.equal(store.db.prepare('SELECT source FROM candidate_batches WHERE id=?').get(retained.batch)!.source,confirmedSource);
    approve(store,retained);assert.equal(store.event(guild,retained.event_key)!.authoritative_source_time,sourceAt+3000);assert.ok(store.db.prepare("SELECT id FROM audit_log WHERE action='refresh-equivalent-provenance'").get());
    ingest(store,correction('delayed-change-after-confirmation-approved',sourceAt+2000,7200000));assert.equal(pending(store).length,0);
  }finally{store.close();}
});

for(const time of [sourceAt+1000,null])test(`competing correction order ${time===null?'without timestamps':'at equal timestamps'} blocks approval until explicit rejection`,()=>{
  const store=new AnnouncementStore(':memory:');try{
    activate(store);ingest(store,correction('competing-one',time,3600000));const first=pending(store)[0]!;ingest(store,correction('competing-two',time,7200000));assert.equal(pending(store).length,2);assert.throws(()=>approve(store,first));
    for(const c of pending(store))assert.throws(()=>approve(store,c));
    const second=pending(store).find(c=>c.id!==first.id)!;store.reject(guild,second.id,second.review_version,'synthetic-staff');approve(store,store.candidate(guild,first.id)!);assert.equal(store.held(first.event_key),false);
  }finally{store.close();}
});

test('equivalent rejected facts stay rejected; materially new evidence permits only explicit audited reconsideration',()=>{
  const store=new AnnouncementStore(':memory:');try{
    ingest(store,facts('rejected-original'));const original=pending(store)[0]!;store.reject(guild,original.id,original.review_version,'synthetic-staff');const rejected=store.candidate(guild,original.id)!;
    ingest(store,facts('rejected-forward',sourceAt+1000));assert.equal(pending(store).length,0);assert.equal(store.candidates(guild).length,1);assert.equal(store.candidate(guild,original.id)!.state,'rejected');assert.throws(()=>store.reconsider(guild,rejected.id,rejected.review_version,'synthetic-staff','A forwarding wrapper alone is not new evidence.',now));
    ingest(store,facts('new-supporting-evidence',sourceAt+2000),sourceText+'\nOrganizer explicitly confirms that the public session remains scheduled.');assert.equal(pending(store).length,0);
    const reopened=store.reconsider(guild,rejected.id,rejected.review_version,'synthetic-staff','New organizer confirmation resolves the reason for the prior rejection.',now);assert.notEqual(reopened.public_id,rejected.public_id);assert.equal(reopened.reconsideration_of,rejected.id);assert.equal(store.candidate(guild,rejected.id)!.state,'rejected');assert.ok(store.db.prepare("SELECT id FROM audit_log WHERE action='reconsider-rejected'").get());
    store.reject(guild,reopened.id,reopened.review_version,'synthetic-staff');const rejectedAgain=store.candidate(guild,reopened.id)!;assert.throws(()=>store.reconsider(guild,rejectedAgain.id,rejectedAgain.review_version,'synthetic-staff','The same evidence must not qualify again.',now+1));
  }finally{store.close();}
});

test('materially changed facts after rejection produce a linked proposal while preserving rejected history',()=>{
  const store=new AnnouncementStore(':memory:');try{
    ingest(store,facts('rejected-invitation'));const c=pending(store)[0]!;store.reject(guild,c.id,c.review_version,'synthetic-staff');ingest(store,facts('changed-invitation',sourceAt+1000,3600000));const changed=pending(store)[0]!;assert.equal(changed.reconsideration_of,c.id);assert.equal(store.candidate(guild,c.id)!.state,'rejected');assert.ok(store.db.prepare("SELECT id FROM audit_log WHERE action='propose-materially-changed-reconsideration'").get());approve(store,changed);
  }finally{store.close();}
});

test('an erratum referring to a pre-bootstrap event requires explicit resolution without creating mailbox replay state',()=>{
  const store=new AnnouncementStore(':memory:');try{
    store.setState('gmail:synthetic:cursor','future-boundary');ingest(store,correction('missing-historical-baseline',sourceAt,3600000));const c=pending(store)[0]!;assert.equal(c.requires_correction_resolution,1);assert.ok((JSON.parse(c.issues_json) as string[]).some(issue=>/baseline/i.test(issue)));assert.throws(()=>approve(store,c));assert.equal(store.state('gmail:synthetic:cursor'),'future-boundary');
    const resolved=store.edit(guild,c.id,c.review_version,JSON.parse(c.event_json) as ScheduleEvent,[],'synthetic-staff');approve(store,resolved);assert.equal(store.events(guild).length,1);
  }finally{store.close();}
});

for(const terminal of ['sent','delivering','uncertain'] as const)test(`a correction preserves ${terminal} delivery reservation and attempt history`,()=>{
  const store=new AnnouncementStore(':memory:');try{
    const base=activate(store),claimed=store.claim(base.job.id,base.job.due,base.snapshot)!;assert.ok(claimed);if(terminal!=='delivering')store.finish(claimed,terminal==='sent'?'synthetic-discord-message':null);
    const attempts=canonical(store.db.prepare('SELECT * FROM delivery_attempts').all()),reservations=canonical(store.db.prepare('SELECT * FROM logical_delivery_reservations').all());ingest(store,correction('change-after-reservation',sourceAt+1000,3600000));approve(store,pending(store)[0]!);
    assert.equal(store.job(guild,claimed.id)!.state,terminal);assert.equal(canonical(store.db.prepare('SELECT * FROM delivery_attempts').all()),attempts);assert.equal(canonical(store.db.prepare('SELECT * FROM logical_delivery_reservations').all()),reservations);assert.ok(store.db.prepare("SELECT id FROM staff_alerts WHERE kind='correction-after-send'").get());
    if(terminal==='delivering'){store.finish(claimed,null);assert.equal(store.job(guild,claimed.id)!.state,'uncertain');}
  }finally{store.close();}
});

test('correction migration is idempotent and preserves future cursor, IDs, rejected history, revisions, and consumed delivery ledger',()=>{
  const dir=mkdtempSync(join(tmpdir(),'announcement-correction-migration-')),path=join(dir,'synthetic.sqlite');let store=new AnnouncementStore(path);
  try{
    const base=activate(store),claimed=store.claim(base.job.id,base.job.due,base.snapshot)!;store.finish(claimed,null);store.setState('gmail:synthetic:cursor','future-only-boundary');const rejected=facts('historical-rejection',sourceAt+1000,3600000);ingest(store,rejected);const c=pending(store)[0]!;store.reject(guild,c.id,c.review_version,'synthetic-staff');
    const ids=canonical(store.db.prepare('SELECT * FROM candidate_public_ids').all()),revisions=canonical(store.db.prepare('SELECT * FROM event_revisions').all()),attempts=canonical(store.db.prepare('SELECT * FROM delivery_attempts').all());
    store.db.exec('DELETE FROM schema_version WHERE version=6; DELETE FROM rejected_facts; UPDATE candidate_events SET fact_fingerprint=NULL;');store.close();store=new AnnouncementStore(path);store.close();store=new AnnouncementStore(path);
    assert.equal(store.state('gmail:synthetic:cursor'),'future-only-boundary');assert.equal(canonical(store.db.prepare('SELECT * FROM candidate_public_ids').all()),ids);assert.equal(canonical(store.db.prepare('SELECT * FROM event_revisions').all()),revisions);assert.equal(canonical(store.db.prepare('SELECT * FROM delivery_attempts').all()),attempts);assert.equal(store.job(guild,claimed.id)!.state,'uncertain');assert.equal(store.candidate(guild,c.id)!.state,'rejected');assert.ok(store.candidate(guild,c.id)!.fact_fingerprint);ingest(store,{...rejected,source:{...rejected.source,messageId:'post-migration-rejected-forward',sha256:digest('post-migration-rejected-forward')}});assert.equal(pending(store).length,0);
  }finally{store.close();removeAnnouncementTestDirectory(dir);}
});
