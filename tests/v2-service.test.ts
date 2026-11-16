import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createService } from '../src/service/server.js';
import { serviceConfigFrom } from '../src/service/config.js';
import { Store } from '../src/service/store.js';
import { search } from '../src/service/tools.js';
import { UsageLedger } from '../src/service/openai-budget.js';
import { JobEvents } from '../src/service/events.js';
import { protectionVersion, type ProtectedProblem } from '../src/service/mpotd-guard.js';

const guild = '123456789012345678', channel = '234567890123456789', user = '345678901234567890';
const id = '456789012345678901', message = '567890123456789012', part = '678901234567890123';
const config = serviceConfigFrom({AI_SERVICE_TOKEN:'t'.repeat(48),AI_DATABASE:':memory:',AI_PROVIDER:'openai',OPENAI_API_KEY:'sk-test'+'x'.repeat(32)},'development');
const problem: ProtectedProblem = {id:7,question:'A pentagon has 23 marked points and 11 blue diagonals. Count the special triangles.',
  answer:'fixture value',solution:'Count the special triangles by pairing their two adjacent vertices.',message:'',thread:''};

test('job events survive polling, publication rechecks embargo, continuations bind idempotently',async()=>{
  let finish!:()=>void;
  const wait = new Promise<void>(resolve=>{finish=resolve;});
  let active: ProtectedProblem[] = [];
  let failRead = false;
  const app = createService(config,async()=>{await wait;return {answer:'approved fixture answer'};},()=>{
    if(failRead)throw new Error('bank unavailable');
    return active;
  });
  await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+String((app.server.address() as AddressInfo).port);
  const call=(path:string,body?:unknown)=>fetch(base+path,{method:body===undefined?'GET':'POST',
    headers:{Authorization:'Bearer '+config.secret,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  try {
    assert.equal((await fetch(base+'/events?job='+id)).status,401);
    const snapshot={version:1,anchorMessageId:id,channelId:channel,chain:[],recent:[{id:'400000000000000000',
      author:{id:user,name:'fixture',relation:'requester',bot:false},timestamp:'2026-10-11T12:00:00Z',content:'context',images:[]}]};
    const submission={id,guild,user,channel,kind:'ask',prompt:'an independent math exercise',context:snapshot};
    assert.equal((await call('/jobs',{...submission,context:{...snapshot,anchorMessageId:part}})).status,400);
    assert.equal((await call('/jobs',submission)).status,200);
    assert.deepEqual(await (await call('/unbound')).json(),[]);
    app.store.db.prepare('UPDATE jobs SET created=created-20000 WHERE id=?').run(id);
    const unbound=await (await call('/unbound')).json() as {id:string}[];
    assert.deepEqual(unbound.map(job=>job.id),[id]);
    for(let i=0;i<2;i++)assert.deepEqual(await (await call('/bind',{id,message})).json(),{ok:true,message});
    assert.deepEqual(await (await call('/bind',{id,message:part})).json(),{ok:false,message});
    assert.deepEqual(await (await call('/unbound')).json(),[]);
    assert.equal(JSON.parse(app.store.get(id)!.provenance!).classification,'private-discord');
    let rows=await (await call('/pending')).json() as {state:string;progress:{phase:string};deliveryParts?:string[]}[];
    assert.equal(rows[0]?.state,'running'); assert.equal(rows[0]?.progress.phase,'started');
    app.events.emit(id,'tool_started',{label:'calculate'});
    const delta=await (await call('/events?job='+id+'&after=1')).json() as {seq:number;type:string}[];
    assert.deepEqual(delta.map(e=>e.type),['tool_started']);
    assert.equal((await call('/events?job='+id+'&after=-1')).status,400);
    finish();
    for(let i=0;i<50 && app.store.get(id)?.state==='running';i++)await new Promise(r=>setTimeout(r,5));
    rows=await (await call('/pending')).json() as typeof rows;
    assert.equal(rows[0]?.progress.phase,'completed');
    assert.deepEqual(rows[0]?.deliveryParts,[]);
    for(let i=0;i<2;i++)assert.equal((await call('/delivery-part',{id,index:1,message:part})).status,200);
    assert.equal((await call('/delivery-part',{id,index:3,message:'678901234567890126'})).status,400);
    const replacement='678901234567890125';
    assert.equal((await call('/delivery-part',{id,index:1,message:replacement,previous:part})).status,200);
    assert.equal((await call('/delivery-part',{id,index:1,message:part,previous:part})).status,400);
    assert.equal(app.store.byMessage(guild,channel,replacement)?.id,id);
    assert.equal(app.store.byMessage(guild,channel,part),undefined);
    active=[problem];
    assert.deepEqual(await (await call('/publication',{id,content:'approved fixture answer'})).json(),{allowed:false});
    app.store.markProtectionVersion(id,protectionVersion(active));
    assert.deepEqual(await (await call('/publication',{id,content:problem.question})).json(),{allowed:false});
    assert.deepEqual(await (await call('/publication',{id,content:'approved fixture answer'})).json(),{allowed:true});
    failRead=true;
    assert.deepEqual(await (await call('/publication',{id,content:'approved fixture answer'})).json(),{allowed:false});
  } finally {finish();await app.close();}
});

test('progress cursors advance on vetted stream writes and retraction; terminal events clear the preview',()=>{
  const db=new Store(':memory:'); let now=2000;
  const events=new JobEvents(db.db,()=>now,400);
  try {
    events.emit(id,'started');
    assert.equal(events.stream(id,'line one'),true);
    assert.equal(events.stream(id,'line two'),false);
    now+=500;
    assert.equal(events.stream(id,'line two'),true);
    events.retract(id);
    assert.equal(events.progress(id)?.stream,'');
    assert.deepEqual(events.since(id,1).map(e=>e.seq),[2,3,4]);
    assert.equal(JSON.stringify(events.since(id)).includes('line two'),false);
    events.emit(id,'cancelled');
    assert.equal(events.stream(id,'late write',true),false);
    assert.equal(events.emit(id,'tool_completed',{ok:true}).type,'cancelled');
  } finally {db.close();}
});

test('a search receipt records provider credits once and keeps the separate USD balance intact',async()=>{
  const store=new Store(':memory:');
  const ledger=new UsageLedger(store.db,config.openai!);
  try {
    const results=await search({searchKey:'fixture'},'test query',AbortSignal.timeout(1000),async(_url,init)=>{
      assert.equal(JSON.parse(String(init?.body)).include_usage,true);
      return Response.json({results:[],usage:{credits:1},request_id:'receipt-1'});
    },(credits,request)=>ledger.recordSearchCredits(id,request,credits));
    assert.deepEqual(results,[]);
    ledger.recordSearchCredits(id,'receipt-1',1);
    assert.equal(ledger.summary().searchCreditsToday,1);
    assert.equal(ledger.summary().todayUsd,0);
  } finally {store.close();}
});

test('startup repairs a terminal event interrupted after persisting its result',()=>{
  const store=new Store(':memory:');
  const events=new JobEvents(store.db);
  try {
    store.admit({id,user,guild,channel,kind:'ask',prompt:'test',coach:false},10);
    store.running(id);events.emit(id,'started');events.stream(id,'partial',true);
    store.complete(id,{answer:'complete'});
    events.recover();events.recover();
    assert.equal(events.progress(id)?.phase,'completed');
    assert.equal(events.progress(id)?.stream,'');
    assert.equal(events.since(id).filter(event=>event.type==='completed').length,1);
  } finally {store.close();}
});
