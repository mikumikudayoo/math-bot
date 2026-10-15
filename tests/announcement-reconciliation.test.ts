import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnnouncementStore } from '../src/announcements/store.js';
import { canonical,digest,documentTemplates,type Extraction } from '../src/announcements/model.js';
import { effectivePolicy,registerEffectivePolicy,type EffectivePolicySnapshot } from '../src/announcements/delivery-identity.js';
import { plan } from '../src/announcements/planner.js';
import type { PolicyFile } from '../src/announcements/config.js';

const guild='111111111111111111',channel='222222222222222222',now=Date.parse('2030-01-01T00:00:00+08:00');
function policy():PolicyFile{return {guild,channel,role:null,staffChannel:null,policies:[{id:'session-hour',type:'training-session',anchor:'start',beforeMinutes:60,template:'session',major:false,asset:'none'}],templates:{...documentTemplates,session:'Session {{slot}} on {{date}} from {{timeRange}}.'}};}
function facts():Extraction {
  const input=JSON.parse(readFileSync(new URL('../docs/examples/announcements/vtamps-v25-0.json',import.meta.url),'utf8')) as Extraction;
  input.source.account='synthetic';input.source.messageId='synthetic-session';input.events=[input.events[0]!];
  Object.assign(input.events[0]!.event,{start:now+7200000,end:now+10800000,timezoneAssumed:true});return input;
}
function install(store:AnnouncementStore,p:PolicyFile):EffectivePolicySnapshot {
  const result=registerEffectivePolicy(store,p,effectivePolicy(store,guild)?.revision??0);assert.equal(result.accepted,true);return result.snapshot;
}
function activate(store:AnnouncementStore,p=policy()) {
  store.ingest(guild,facts(),now);const candidate=store.candidates(guild)[0]!;store.approve(guild,candidate.id,candidate.review_version,'synthetic-staff',now);
  const snapshot=install(store,p);plan(store,p,now,snapshot);return {snapshot,job:store.jobs(guild)[0]!};
}
function active(store:AnnouncementStore){return store.jobs(guild).filter(j=>['scheduled','held','pending_approval','blocked','draft'].includes(j.state));}

test('stale A cannot supersede B and a deliberately registered A reversion creates a valid new generation',()=>{
  const store=new AnnouncementStore(':memory:');try{
    const a=policy(),first=activate(store,a),b=structuredClone(a);b.policies[0]!.beforeMinutes=30;
    const current=install(store,b);plan(store,b,now,current);const before=canonical(store.jobs(guild));
    assert.throws(()=>plan(store,a,now,first.snapshot));assert.throws(()=>plan(store,a,now));assert.equal(canonical(store.jobs(guild)),before);
    plan(store,b,now,current);assert.equal(active(store).length,1);assert.equal(active(store)[0]!.due,now+5400000);assert.equal(store.job(guild,first.job.id)!.state,'superseded');
    const reverted=install(store,a);plan(store,a,now,reverted);assert.equal(active(store).length,1);assert.equal(active(store)[0]!.due,first.job.due);assert.notEqual(active(store)[0]!.id,first.job.id);assert.equal(store.job(guild,first.job.id)!.state,'superseded');
  }finally{store.close();}
});

test('irrelevant routing retains active jobs while an unsent template change replaces only its affected projection',()=>{
  const store=new AnnouncementStore(':memory:');try{
    const a=policy(),first=activate(store,a),staff=structuredClone(a);staff.staffChannel='333333333333333333';staff.templates.unused='unused';
    const staffSnapshot=install(store,staff);plan(store,staff,now,staffSnapshot);assert.equal(active(store)[0]!.id,first.job.id);assert.equal(store.jobPolicyCurrent(first.job,staffSnapshot),true);
    const changed=structuredClone(staff);changed.templates.session='Session {{slot}} is at {{timeRange}}.';
    plan(store,changed,now,install(store,changed));assert.equal(active(store).length,1);assert.notEqual(active(store)[0]!.id,first.job.id);assert.equal(store.job(guild,first.job.id)!.state,'superseded');
  }finally{store.close();}
});

for(const terminal of ['sent','delivering','uncertain'] as const)test(`${terminal} obligations remain consumed across staff, template, role and timing changes`,()=>{
  const store=new AnnouncementStore(':memory:');try{
    const a=policy(),first=activate(store,a),claimed=store.claim(first.job.id,first.job.due,first.snapshot)!;assert.ok(claimed);
    if(terminal!=='delivering')store.finish(claimed,terminal==='sent'?'synthetic-discord-message':null);
    const attemptBefore=canonical(store.db.prepare('SELECT * FROM delivery_attempts').all()),b=structuredClone(a);
    b.staffChannel='333333333333333333';b.role='444444444444444444';b.templates.session='{{role}} Session {{slot}} is at {{timeRange}}.';b.policies[0]!.beforeMinutes=30;
    plan(store,b,now,install(store,b));assert.equal(store.jobs(guild).length,1);assert.equal(store.job(guild,first.job.id)!.state,terminal);assert.equal(canonical(store.db.prepare('SELECT * FROM delivery_attempts').all()),attemptBefore);
    const anchored=structuredClone(b);anchored.policies[0]!.anchor='approval';anchored.policies[0]!.beforeMinutes=0;
    plan(store,anchored,now,install(store,anchored));assert.equal(store.jobs(guild).length,1);assert.equal(store.job(guild,first.job.id)!.state,terminal);assert.equal(canonical(store.db.prepare('SELECT * FROM delivery_attempts').all()),attemptBefore);
    assert.equal(store.db.prepare('SELECT count(*) n FROM logical_delivery_reservations').get()!.n,1);
    const destination={...b,channel:'555555555555555555'};plan(store,destination,now,install(store,destination));assert.equal(active(store).length,1);assert.equal(active(store)[0]!.channel,destination.channel);assert.notEqual(active(store)[0]!.logical_delivery_id,first.job.logical_delivery_id);assert.equal(store.job(guild,first.job.id)!.state,terminal);
  }finally{store.close();}
});

test('independent schedulers and duplicate generations reserve one logical delivery, including after restart',()=>{
  const dir=mkdtempSync(join(tmpdir(),'announcement-ledger-')),path=join(dir,'announcements.sqlite');let a=new AnnouncementStore(path);const b=new AnnouncementStore(path);
  try{
    const p=policy(),first=activate(a,p);plan(b,p,now,first.snapshot);assert.equal(b.jobs(guild).length,1);
    const duplicate=b.addJob({...first.job,policy:'synthetic-duplicate-generation'});assert.notEqual(duplicate.id,first.job.id);
    const claimed=a.claim(first.job.id,first.job.due,first.snapshot)!;assert.ok(claimed);assert.equal(b.claim(duplicate.id,duplicate.due,first.snapshot),undefined);
    assert.equal(a.db.prepare('SELECT count(*) n FROM delivery_attempts').get()!.n,1);assert.equal(a.db.prepare('SELECT count(*) n FROM logical_delivery_reservations').get()!.n,1);
    a.close();a=new AnnouncementStore(path);plan(a,p,now,first.snapshot);assert.equal(a.job(guild,claimed.id)!.state,'delivering');assert.equal(a.claim(claimed.id,claimed.due,first.snapshot),undefined);assert.equal(active(a).length,0);
  }finally{a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});

test('stale claim tokens leave a valid current plan intact',()=>{
  const store=new AnnouncementStore(':memory:');try{
    const p=policy(),first=activate(store,p),next={...p,staffChannel:'333333333333333333'},snapshot=install(store,next);plan(store,next,now,snapshot);
    assert.equal(store.claim(first.job.id,first.job.due,first.snapshot),undefined);assert.equal(store.job(guild,first.job.id)!.state,'scheduled');assert.ok(store.claim(first.job.id,first.job.due,snapshot));
  }finally{store.close();}
});

test('moderator reconciliation consumes the obligation and a late completion cannot overwrite the decision or attempt history',()=>{
  const store=new AnnouncementStore(':memory:');try{
    const p=policy(),first=activate(store,p),claimed=store.claim(first.job.id,first.job.due,first.snapshot)!;
    const attemptBefore=canonical(store.db.prepare('SELECT * FROM delivery_attempts').all());store.reconcile(guild,claimed.id,null,'synthetic-staff');store.finish(claimed,'late-synthetic-message');
    assert.equal(store.job(guild,claimed.id)!.state,'cancelled');assert.equal(store.job(guild,claimed.id)!.message,null);assert.equal(canonical(store.db.prepare('SELECT * FROM delivery_attempts').all()),attemptBefore);
    const next={...p,templates:{...p.templates,session:'Session {{slot}} at {{timeRange}}.'}};plan(store,next,now,install(store,next));assert.equal(store.jobs(guild).length,1);assert.equal(active(store).length,0);
    assert.ok(store.db.prepare("SELECT id FROM staff_alerts WHERE kind='delivery-reconciled-during-send'").get());
  }finally{store.close();}
});

test('major message approval survives irrelevant policy edits and is invalidated by replacement text',()=>{
  const store=new AnnouncementStore(':memory:');try{
    const p=policy();p.policies[0]!.major=true;const first=activate(store,p);store.approveJob(guild,first.job.id,'synthetic-staff',digest([first.job.payload_json,first.job.asset]));
    const harmless={...p,staffChannel:'333333333333333333'};plan(store,harmless,now,install(store,harmless));assert.equal(store.job(guild,first.job.id)!.state,'scheduled');assert.equal(store.job(guild,first.job.id)!.approved_by,'synthetic-staff');
    const changed={...harmless,templates:{...p.templates,session:'Session {{slot}} at {{timeRange}}.'}};plan(store,changed,now,install(store,changed));assert.equal(store.job(guild,first.job.id)!.state,'superseded');const latest=active(store)[0]!;assert.equal(latest.state,'pending_approval');assert.equal(latest.approved_by,null);assert.equal(latest.approved_payload_hash,null);
  }finally{store.close();}
});

test('final persisted-delivery validation rejects policy, hold, lifecycle, expiry and exact payload changes',()=>{
  const store=new AnnouncementStore(':memory:');try{
    const p=policy(),first=activate(store,p),claimed=store.claim(first.job.id,first.job.due,first.snapshot)!,payload=JSON.parse(claimed.payload_json);
    assert.equal(store.validateDelivery(claimed.id,first.snapshot,claimed.due,payload).id,claimed.id);
    assert.throws(()=>store.validateDelivery(claimed.id,first.snapshot,claimed.expires+1,payload));assert.throws(()=>store.validateDelivery(claimed.id,first.snapshot,claimed.due,{...payload,content:'different safe text'}));
    const next={...p,channel:'333333333333333333'};install(store,next);assert.throws(()=>store.validateDelivery(claimed.id,first.snapshot,claimed.due,payload));
    const fresh=install(store,p);const source=store.source(guild,{...facts().source,messageId:'synthetic-unresolved-correction'});store.holdSource(guild,source);assert.throws(()=>store.validateDelivery(claimed.id,fresh,claimed.due,payload));store.dismissSource(guild,source,'synthetic-staff');
    assert.equal(store.validateDelivery(claimed.id,fresh,claimed.due,payload).id,claimed.id);store.cancel(guild,claimed.event_key,'cancelled','synthetic-staff',claimed.revision);assert.throws(()=>store.validateDelivery(claimed.id,fresh,claimed.due,payload));
  }finally{store.close();}
});

test('legacy migration is idempotent and preserves cursors, public IDs, revisions and sent/uncertain/delivering attempt history',()=>{
  const dir=mkdtempSync(join(tmpdir(),'announcement-legacy-ledger-')),path=join(dir,'legacy.sqlite');let store=new AnnouncementStore(path);
  try{
    const p=policy(),first=activate(store,p),base=first.job;
    // Model pre-identity rows in an isolated synthetic database, retaining the
    // original policy/attempt fields that the migration must not rewrite.
    for(const state of ['sent','uncertain','delivering','scheduled','superseded']){
      const job=store.addJob({...base,policy:`legacy-${state}`,state});
      store.db.prepare('UPDATE announcement_jobs SET logical_delivery_id=NULL,rule_id=NULL,policy_revision=NULL,plan_hash=NULL WHERE id=?').run(job.id);
      if(['sent','uncertain','delivering'].includes(state))store.db.prepare('INSERT INTO delivery_attempts VALUES(?,?,?,?)').run(job.id,state==='delivering'?'reserved':state,state==='sent'?'synthetic-historical-message':null,now);
    }
    store.db.prepare('DELETE FROM announcement_jobs WHERE id=?').run(base.id);
    store.db.exec('DROP INDEX announcement_logical_jobs; DROP TABLE logical_delivery_reservations; DROP TABLE legacy_delivery_guards;');
    for(const column of ['logical_delivery_id','rule_id','policy_revision','plan_hash','approved_payload_hash'])store.db.exec(`ALTER TABLE announcement_jobs DROP COLUMN ${column}`);
    store.db.prepare('DELETE FROM schema_version WHERE version=4').run();
    store.setState('gmail:synthetic:cursor','future-only-boundary');store.setState('gmail:synthetic:bootstrap-history-id','future-only-boundary');
    const attempts=canonical(store.db.prepare('SELECT * FROM delivery_attempts ORDER BY job').all()),publicIds=canonical(store.db.prepare('SELECT * FROM candidate_public_ids').all()),revisions=canonical(store.db.prepare('SELECT * FROM event_revisions').all());
    store.close();store=new AnnouncementStore(path);
    assert.equal(canonical(store.db.prepare('SELECT * FROM delivery_attempts ORDER BY job').all()),attempts);assert.equal(canonical(store.db.prepare('SELECT * FROM candidate_public_ids').all()),publicIds);assert.equal(canonical(store.db.prepare('SELECT * FROM event_revisions').all()),revisions);
    for(const state of ['sent','uncertain','delivering','superseded'])assert.equal(store.db.prepare('SELECT state FROM announcement_jobs WHERE policy=?').get(`legacy-${state}`)!.state,state);
    assert.equal(store.db.prepare("SELECT state FROM announcement_jobs WHERE policy='legacy-scheduled'").get()!.state,'blocked');assert.equal(store.db.prepare('SELECT count(*) n FROM legacy_delivery_guards').get()!.n,5);
    plan(store,p,now,effectivePolicy(store,guild)!);assert.equal(active(store).filter(j=>j.state==='scheduled').length,0);assert.equal(store.jobs(guild).length,5);
    store.close();store=new AnnouncementStore(path);assert.equal(store.db.prepare('SELECT count(*) n FROM legacy_delivery_guards').get()!.n,5);assert.equal(canonical(store.db.prepare('SELECT * FROM delivery_attempts ORDER BY job').all()),attempts);assert.equal(store.state('gmail:synthetic:cursor'),'future-only-boundary');assert.equal(store.state('gmail:synthetic:bootstrap-history-id'),'future-only-boundary');
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
