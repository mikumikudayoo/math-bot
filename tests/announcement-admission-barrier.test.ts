import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {AnnouncementStore} from '../src/announcements/store.js';
import {digest,type Extraction} from '../src/announcements/model.js';
import {plan} from '../src/announcements/planner.js';
import type {PolicyFile} from '../src/announcements/config.js';

const guild='111111111111111111',now=Date.UTC(2029,11,30),policy:PolicyFile={guild,channel:'222222222222222222',role:null,staffChannel:null,templates:{session:'Session {{slot}} on {{date}} from {{timeRange}}.'},policies:[{id:'session',type:'training-session',anchor:'start',beforeMinutes:60,template:'session',major:false,asset:'none'}]};
function fixture():Extraction{return JSON.parse(readFileSync(new URL('../docs/examples/announcements/synthetic-reviewed-import.json',import.meta.url),'utf8')) as Extraction;}
function activate(store:AnnouncementStore){const input=fixture();store.ingest(guild,input,now);const c=store.candidates(guild)[0]!;store.approve(guild,c.id,c.review_version,'synthetic-staff',now);plan(store,policy,now);return store.jobs(guild)[0]!;}
function admit(store:AnnouncementStore,index:number){return store.source(guild,{account:'synthetic-future',messageId:`synthetic-admitted-${index}`,attachment:null,sha256:digest(index),locator:'body'});}

test('the sixth unprocessed organizer source already holds a due old reminder at admission',()=>{
  const store=new AnnouncementStore(':memory:');try{
    const job=activate(store);for(let index=0;index<6;index++){const source=admit(store,index);if(index<5)store.resolveSource(guild,source,'ignore','Synthetic unsupported source.');}
    assert.equal(store.job(guild,job.id)!.state,'held');assert.equal(store.held(job.event_key),true);assert.equal(store.claim(job.id,job.due),undefined);
    store.resolveSource(guild,admit(store,5),'private','Synthetic personal notification.');assert.equal(store.held(job.event_key),false);assert.equal(store.job(guild,job.id)!.state,'scheduled');
  }finally{store.close();}
});
test('a source admitted before any event exists also protects a later approved event',()=>{
  const store=new AnnouncementStore(':memory:');try{
    const unresolved=admit(store,0),job=activate(store);assert.equal(store.held(job.event_key),true);assert.equal(store.job(guild,job.id)!.state,'held');
    store.dismissSource(guild,unresolved,'synthetic-staff');assert.equal(store.held(job.event_key),false);plan(store,policy,now);assert.equal(store.job(guild,job.id)!.state,'scheduled');
  }finally{store.close();}
});
test('admission barrier and source row roll back atomically and cannot reappear on duplicate admission',()=>{
  const store=new AnnouncementStore(':memory:');try{
    const job=activate(store);assert.throws(()=>store.transaction(()=>{admit(store,0);throw new Error('Synthetic interruption.');}));assert.equal(store.held(job.event_key),false);assert.equal(store.job(guild,job.id)!.state,'scheduled');
    const source=admit(store,0);store.resolveSource(guild,source,'ignore','Synthetic unsupported source.');assert.equal(admit(store,0),source);assert.equal(store.held(job.event_key),false);
  }finally{store.close();}
});
test('an identified incomplete correction narrows the broad barrier to its actual event identity',()=>{
  const store=new AnnouncementStore(':memory:');try{
    const first=activate(store),second=fixture();second.source.messageId='synthetic-second-event';second.source.sha256=digest('second');second.events[0]!.event.slot='2';second.evidence![0]!.text=second.evidence![0]!.text.replace('Session 1','Session 2');store.ingest(guild,second,now);const c=store.candidates(guild).find(c=>c.state==='pending')!;store.approve(guild,c.id,c.review_version,'synthetic-staff',now);plan(store,policy,now);const other=store.jobs(guild).find(j=>j.event_key!==first.event_key)!;
    const correction=fixture();correction.source.messageId='synthetic-incomplete-correction';correction.source.sha256=digest('correction');delete correction.evidence;correction.correction=true;correction.events[0]!.correctionPatch={kind:'partial',changedFields:[],clearFields:[]};
    const source=store.source(guild,correction.source);store.saveEvidence(source,{evidence:[{id:'body',text:'ERRATUM: VTAMPS V.30.0 Senior Secondary Session 1 changed schedule. Asia/Manila.'}],blocked:['Replacement image requires manual factual review.']});assert.equal(store.held(other.event_key),true);
    store.ingest(guild,correction,now);assert.equal(store.held(first.event_key),true);assert.equal(store.held(other.event_key),false);assert.equal(store.job(guild,other.id)!.state,'scheduled');
  }finally{store.close();}
});
