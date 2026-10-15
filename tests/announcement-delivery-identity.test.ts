import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { effectivePolicy,isEffectivePolicy,logicalDeliveryId,registerEffectivePolicy,type PolicySnapshotStore,type LogicalDeliveryIdentity } from '../src/announcements/delivery-identity.js';
import { documentTemplates } from '../src/announcements/model.js';
import type { PolicyFile } from '../src/announcements/config.js';

const guild='111111111111111111',channel='222222222222222222';
function policy():PolicyFile{return {guild,channel,role:null,staffChannel:null,policies:[{id:'session-hour',type:'training-session',anchor:'start',beforeMinutes:60,template:'session',major:false,asset:'none'}],templates:{...documentTemplates}};}

class StateStore implements PolicySnapshotStore {
  readonly db:DatabaseSync;
  constructor(path=':memory:'){this.db=new DatabaseSync(path);this.db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS gmail_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);');}
  state(key:string){return this.db.prepare('SELECT value FROM gmail_state WHERE key=?').get(key)?.value as string|undefined;}
  setState(key:string,value:string){this.db.prepare('INSERT INTO gmail_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value);}
  transaction<T>(fn:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  close(){this.db.close();}
}

test('authoritative policy CAS rejects stale A after B; deliberate fresh reversion advances the generation',()=>{
  const store=new StateStore();try{
    const a=policy(),b={...a,staffChannel:'333333333333333333'};
    assert.equal(effectivePolicy(store,guild),undefined);
    const first=registerEffectivePolicy(store,a,0);assert.equal(first.accepted,true);assert.equal(first.snapshot.revision,1);
    const second=registerEffectivePolicy(store,b,1);assert.equal(second.accepted,true);assert.equal(second.snapshot.revision,2);
    const stale=registerEffectivePolicy(store,a,1);assert.equal(stale.accepted,false);assert.deepEqual(stale.snapshot,second.snapshot);
    assert.equal(isEffectivePolicy(store,first.snapshot),false);assert.equal(isEffectivePolicy(store,second.snapshot),true);
    const same=registerEffectivePolicy(store,b,1);assert.equal(same.accepted,true);assert.deepEqual(same.snapshot,second.snapshot);
    const reverted=registerEffectivePolicy(store,a,2);assert.equal(reverted.accepted,true);assert.equal(reverted.snapshot.revision,3);assert.equal(reverted.snapshot.fingerprint,first.snapshot.fingerprint);
  }finally{store.close();}
});

test('two policy store connections agree on registration, reject stale publication, and retain the snapshot across restart',()=>{
  const dir=mkdtempSync(join(tmpdir(),'announcement-policy-cas-')),path=join(dir,'state.sqlite');
  const first=new StateStore(path),second=new StateStore(path);let reopened:StateStore|undefined;
  try{
    first.setState('gmail:synthetic:cursor','future-boundary');first.setState(`policy:${guild}`,'legacy-fingerprint');
    const a=policy(),installed=registerEffectivePolicy(first,a,0);
    assert.deepEqual(registerEffectivePolicy(second,a,0).snapshot,installed.snapshot);
    const b={...a,templates:{...a.templates,session:'{{role}} session {{slot}} is at {{timeRange}}.'}};
    const changed=registerEffectivePolicy(second,b,1);assert.equal(changed.snapshot.revision,2);
    assert.equal(registerEffectivePolicy(first,a,1).accepted,false);
    reopened=new StateStore(path);assert.deepEqual(effectivePolicy(reopened,guild),changed.snapshot);
    assert.equal(reopened.state('gmail:synthetic:cursor'),'future-boundary');assert.equal(reopened.state(`policy:${guild}`),'legacy-fingerprint');
  }finally{reopened?.close();first.close();second.close();rmSync(dir,{recursive:true,force:true});}
});

test('registered policy is detached from caller mutations and canonical property ordering is idempotent',()=>{
  const store=new StateStore();try{
    const a=policy(),installed=registerEffectivePolicy(store,a,0);
    a.templates.session='changed caller text';assert.notEqual(effectivePolicy(store,guild)!.policy.templates.session,a.templates.session);
    installed.snapshot.policy.templates.session='mutated snapshot';assert.equal(isEffectivePolicy(store,installed.snapshot),false);
    const current=effectivePolicy(store,guild)!;
    const reordered={templates:current.policy.templates,policies:current.policy.policies,staffChannel:current.policy.staffChannel,role:current.policy.role,channel:current.policy.channel,guild:current.policy.guild};
    assert.equal(registerEffectivePolicy(store,reordered,0).snapshot.revision,1);
  }finally{store.close();}
});

test('corrupt or cross-guild durable policy state fails closed without replacement',()=>{
  const store=new StateStore();try{
    const installed=registerEffectivePolicy(store,policy(),0),key=`policy:${guild}:effective`;
    for(const value of ['{invalid',JSON.stringify({...installed.snapshot,revision:0}),JSON.stringify({...installed.snapshot,fingerprint:'wrong'}),JSON.stringify({...installed.snapshot,guild:'444444444444444444'})]){
      store.setState(key,value);assert.throws(()=>effectivePolicy(store,guild));assert.throws(()=>registerEffectivePolicy(store,policy(),0));assert.equal(store.state(key),value);
    }
  }finally{store.close();}
});

function identity(p=policy()):LogicalDeliveryIdentity {const rule=p.policies[0]!;return {guild:p.guild,eventKey:`${p.guild}:synthetic-session`,revision:1,ruleId:rule.id,anchor:rule.anchor,channel:rule.channel??p.channel};}

test('logical delivery survives staff routing, template, role and timing anchor/offset edits',()=>{
  const a=policy(),b=structuredClone(a),original=logicalDeliveryId(identity(a));
  b.staffChannel='333333333333333333';b.role='444444444444444444';b.templates.session='{{role}} session {{slot}} is at {{timeRange}}.';b.templates.unused='new private configuration';b.policies[0]!.beforeMinutes=30;
  assert.equal(logicalDeliveryId(identity(b)),original);
  assert.equal(logicalDeliveryId({...identity(b),anchor:'approval'}),original);
  assert.equal(logicalDeliveryId({...identity(a),occurrence:'original'}),original);
});

test('logical deliveries distinguish event revisions, stable rules, destinations and explicit occurrences',()=>{
  const base=identity(),original=logicalDeliveryId(base);
  for(const change of [{eventKey:`${guild}:another-session`},{revision:2},{ruleId:'session-day'},{channel:'333333333333333333'},{occurrence:'staff-reissue-synthetic-1'}])assert.notEqual(logicalDeliveryId({...base,...change}),original);
});

test('logical delivery rejects malformed or cross-guild identity instead of collapsing obligations',()=>{
  const base=identity();
  for(const change of [{guild:'invalid'},{eventKey:'444444444444444444:another-guild'},{eventKey:`${guild}:`},{revision:0},{revision:1.5},{ruleId:''},{channel:'invalid'},{anchor:'unknown'},{occurrence:' '}])assert.throws(()=>logicalDeliveryId({...base,...change} as LogicalDeliveryIdentity));
});
