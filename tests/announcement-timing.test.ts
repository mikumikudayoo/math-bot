import {test} from 'node:test';
import assert from 'node:assert/strict';
import {canonical,digest,type Catalog,type Extraction,type ScheduleEvent} from '../src/announcements/model.js';
import {validatePolicy,type PolicyFile,type Policy} from '../src/announcements/config.js';
import {projectDelivery,registerEffectivePolicy,type DeliveryEventProjection} from '../src/announcements/delivery-identity.js';
import {AnnouncementStore} from '../src/announcements/store.js';
import {plan} from '../src/announcements/planner.js';

const guild='111111111111111111',channel='222222222222222222',now=Date.UTC(2030,0,1),minute=60000,hour=60*minute,day=24*hour;
const catalog:Catalog={competitions:[{id:'timo-2030',name:'TIMO',year:2030,subject:'mathematics'}],rounds:[],programs:[]};
function event():ScheduleEvent{return {competitionId:'timo-2030',roundId:null,programId:null,preparesFor:[],yearLevel:'Senior Secondary',type:'competition-day',slot:'heat',start:now+2*hour,end:now+4*hour,deadline:null,timezone:'Asia/Manila',timezoneAssumed:false,status:'active',url:null,detailLabel:null};}
function policy():PolicyFile{return {guild,channel,role:null,staffChannel:null,templates:{reminder:'TIMO participants: {{detailLabel}}'},policies:[{id:'competition',type:'competition-day',anchor:'start',beforeMinutes:60,template:'reminder',major:false,asset:'none'}]};}
function row(e=event()):DeliveryEventProjection{return {event_key:guild+':synthetic-timing',revision:1,approved_at:now,event_json:canonical({...e,detailLabel:'Public timetable'}),catalog_json:canonical(catalog)};}
function project(e=event(),rule:Partial<Policy>={}){const p=policy();Object.assign(p.policies[0]!,rule,{type:e.type});validatePolicy(p);return projectDelivery(row(e),p,p.policies[0]!);}

test('freshness settings accept bounded whole-minute overrides and preserve existing default policies',()=>{
  validatePolicy(policy());const p=policy();Object.assign(p.policies[0]!,{reminderGraceMinutes:60,editorialWindowMinutes:10080});validatePolicy(p);
  for(const field of ['reminderGraceMinutes','editorialWindowMinutes'] as const)for(const value of [0,-1,1.5,Infinity,NaN,field==='reminderGraceMinutes'?61:10081,'10']){
    const invalid=policy();Object.assign(invalid.policies[0]!,{[field]:value});assert.throws(()=>validatePolicy(invalid));
  }
});

test('scheduled reminder grace defaults to one minute and never stretches across a missed day',()=>{
  const result=project();assert.equal(result.due,now+hour);assert.equal(result.expires,result.due+minute);assert.ok(now+day>result.expires);assert.equal(result.blocked,false);
  const wider=project(event(),{reminderGraceMinutes:15});assert.equal(wider.expires,wider.due+15*minute);
});

test('an earlier reminder is capped at its start/deadline while zero-offset reminders get a usable interval',()=>{
  const e=event(),earlier=project(e,{beforeMinutes:10,reminderGraceMinutes:60});assert.equal(earlier.expires,e.start);
  const zero=project(e,{beforeMinutes:0});assert.equal(zero.due,e.start);assert.equal(zero.expires,zero.due+minute);assert.ok(zero.expires>zero.due);
  const deadline={...e,type:'registration-deadline' as const,start:null,end:null,deadline:now+hour};
  assert.equal(project(deadline,{anchor:'deadline',beforeMinutes:10,reminderGraceMinutes:60}).expires,deadline.deadline);
  const atDeadline=project(deadline,{anchor:'deadline',beforeMinutes:0,reminderGraceMinutes:5});assert.equal(atDeadline.expires,deadline.deadline!+5*minute);
});

test('major results use a realistic editorial window fixed to fact approval, even after the result occurrence',()=>{
  const e={...event(),type:'results' as const,start:now-day,end:null},result=project(e,{anchor:'approval',beforeMinutes:0,major:true});
  assert.equal(result.due,now);assert.equal(result.expires,now+day);assert.ok(result.expires>now+2*hour);assert.equal(result.blocked,false);
  assert.deepEqual(project(e,{anchor:'approval',beforeMinutes:0,major:true}),result);
  assert.equal(project(e,{anchor:'approval',beforeMinutes:0,major:true,editorialWindowMinutes:120}).expires,now+2*hour);
});

test('editorial publication never predates fact approval and operative announcements expire by their participation time',()=>{
  const e={...event(),start:now+30*minute,end:now+2*hour};
  const result=project(e,{anchor:'approval',beforeMinutes:60,major:true});assert.equal(result.due,now);assert.equal(result.expires,e.start);
  const atStart=project(e,{anchor:'start',beforeMinutes:0,major:true});assert.equal(atStart.due,e.start);assert.equal(atStart.expires,e.start!+minute);
  const stale=project({...e,start:now-day,end:now-day+hour},{anchor:'approval',beforeMinutes:0,major:true});assert.ok(stale.expires<now);
});

test('material publication retains its editorial window after expected availability has arrived',()=>{
  const e={...event(),type:'materials-release' as const,start:now-hour,end:null,availability:{state:'available' as const,asOf:now-hour,expectedAt:null}};
  const result=project(e,{anchor:'approval',beforeMinutes:0,major:true});assert.equal(result.due,now);assert.equal(result.expires,now+day);assert.equal(result.blocked,false);
});

test('freshness edits affect only the unsent projection and do not invent a new logical obligation',()=>{
  const routine=project(),changed=project(event(),{reminderGraceMinutes:10});assert.equal(routine.logical_delivery_id,changed.logical_delivery_id);assert.notEqual(routine.plan_hash,changed.plan_hash);
  const e={...event(),type:'results' as const,start:null,end:null},major=project(e,{major:true,anchor:'approval',beforeMinutes:0}),revised=project(e,{major:true,anchor:'approval',beforeMinutes:0,editorialWindowMinutes:120});assert.equal(major.logical_delivery_id,revised.logical_delivery_id);assert.notEqual(major.plan_hash,revised.plan_hash);
});

function activated(type:'competition-day'|'results',rule:Partial<Policy>={}){
  const store=new AnnouncementStore(':memory:'),e={...event(),type,detailLabel:'Public timetable'},input:Extraction={source:{account:'synthetic-timing',messageId:'synthetic-public-timing',attachment:null,sha256:digest('synthetic-timing'),locator:'body'},sourceTime:now-minute,catalog,events:[{event:e,confidence:'high',issues:[],evidenceIds:['body']}]};
  input.events[0]!.event.temporal={start:{precision:'exact',expression:new Date(e.start!).toISOString(),sourceTime:now-minute},end:{precision:'exact',expression:new Date(e.end!).toISOString(),sourceTime:now-minute}};
  store.saveEvidence(store.source(guild,input.source),{evidence:[{id:'body',text:'TIMO 2030 Senior Secondary competition day: January 1, 2030, 10 AM to noon Asia/Manila. Public timetable.'}],blocked:[]});store.ingest(guild,input,now);const c=store.candidates(guild)[0]!;store.approve(guild,c.id,c.review_version,'synthetic-staff',now);
  const p=policy();Object.assign(p.policies[0]!,rule,{type});const snapshot=registerEffectivePolicy(store,p,0).snapshot;return {store,p,snapshot};
}

test('editorial review two hours after fact approval can reserve a major message without any transport',()=>{
  const {store,p,snapshot}=activated('results',{major:true,anchor:'approval',beforeMinutes:0});try{
    plan(store,p,now+2*hour,snapshot);const job=store.jobs(guild)[0]!;assert.equal(job.state,'pending_approval');assert.equal(job.expires,now+day);store.approveJob(guild,job.id,'synthetic-staff',digest([job.payload_json,job.asset]));
    const reserved=store.claim(job.id,now+2*hour,snapshot);assert.ok(reserved);assert.equal(store.validateDelivery(job.id,snapshot,now+2*hour).id,job.id);
  }finally{store.close();}
});

test('offline missed reminders are skipped and irrelevant policy reloads never renew their freshness',()=>{
  const {store,p,snapshot}=activated('competition-day');try{
    plan(store,p,now,snapshot);const original=store.jobs(guild)[0]!;const changed={...p,staffChannel:'333333333333333333'},current=registerEffectivePolicy(store,changed,snapshot.revision).snapshot;
    plan(store,changed,now+30*minute,current);assert.equal(store.jobs(guild)[0]!.id,original.id);assert.equal(store.jobs(guild)[0]!.expires,original.expires);
    plan(store,changed,now+day,current);assert.equal(store.job(guild,original.id)!.state,'skipped');assert.equal(store.claim(original.id,now+day,current),undefined);plan(store,changed,now+2*day,current);assert.equal(store.jobs(guild).length,1);assert.ok(store.db.prepare("SELECT id FROM staff_alerts WHERE kind='missed-reminder'").get());
  }finally{store.close();}
});

test('major publications first planned after editorial expiry skip instead of creating late catch-up approval jobs',()=>{
  const {store,p,snapshot}=activated('results',{major:true,anchor:'approval',beforeMinutes:0});try{
    plan(store,p,now+2*day,snapshot);const job=store.jobs(guild)[0]!;assert.equal(job.state,'skipped');assert.equal(job.expires,now+day);assert.throws(()=>store.approveJob(guild,job.id,'synthetic-staff',digest([job.payload_json,job.asset])));assert.equal(store.claim(job.id,now+2*day,snapshot),undefined);
  }finally{store.close();}
});

test('existing unapproved major jobs expire and cannot be revived by a later wider policy window',()=>{
  const {store,p,snapshot}=activated('results',{major:true,anchor:'approval',beforeMinutes:0});try{
    plan(store,p,now,snapshot);const job=store.jobs(guild)[0]!;assert.equal(job.state,'pending_approval');
    plan(store,p,now+2*day,snapshot);assert.equal(store.job(guild,job.id)!.state,'skipped');
    const changed=structuredClone(p);changed.policies[0]!.editorialWindowMinutes=10080;const current=registerEffectivePolicy(store,changed,snapshot.revision).snapshot;
    plan(store,changed,now+2*day,current);assert.equal(store.jobs(guild).length,1);assert.equal(store.job(guild,job.id)!.state,'skipped');assert.equal(store.claim(job.id,now+2*day,current),undefined);
  }finally{store.close();}
});
