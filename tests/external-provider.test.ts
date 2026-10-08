import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { completeProvider,providerHealth,ProviderBackoff,selectProvider,type ProviderConfig } from '../src/service/providers.js';
import { Store } from '../src/service/store.js';
import { Scheduler } from '../src/service/scheduler.js';
import { runner } from '../src/service/inference.js';
import type { ServiceConfig } from '../src/service/config.js';
import type { Job } from '../src/service/types.js';
import { parseModelResponse,parseEnvelope,toolArguments } from '../src/service/model-protocol.js';
const remote:ProviderConfig={backend:'https://api.groq.com/openai/v1',model:'openai/gpt-oss-120b',backendKey:'offline-fixture-key',vision:false,nativeTools:true};
const cfg:ServiceConfig={mode:'development',secret:'test-only-secret-with-at-least-32-characters',port:8787,database:':memory:',concurrency:1,reserved:0,borrow:false,timeoutMs:10000,maxQueue:20,backend:'http://127.0.0.1:8080/v1',model:'local-phi',backendKey:'',vision:false,nativeTools:false,python:'python3',searchKey:'',sandbox:false,sandboxImage:'math-bot-python:local',cognitiveRouting:true,external:remote};
test('Groq 429 respects Retry-After, reports health and does not retry or switch to a paid/weaker provider',async()=>{
  providerHealth.clear();let calls=0;const before=Date.now();await assert.rejects(()=>completeProvider(remote,{},AbortSignal.timeout(1000),async()=>{calls++;return new Response('private error body must never escape',{status:429,headers:{'Retry-After':'90','x-ratelimit-remaining-requests':'0'}});}),e=>e instanceof ProviderBackoff&&e.retryAt>=before+90000);
  assert.equal(calls,1);assert.equal([...providerHealth.values()][0]!.state,'rate-limited');await assert.rejects(()=>completeProvider(remote,{},AbortSignal.timeout(1000),async()=>{calls++;return new Response('{}');}),ProviderBackoff);assert.equal(calls,1);
});
test('date-valued Retry-After and unavailable/misconfigured providers are distinct',async()=>{
  providerHealth.clear();await assert.rejects(()=>completeProvider(remote,{},AbortSignal.timeout(1000),async()=>new Response('',{status:503,headers:{'Retry-After':new Date(Date.now()+120000).toUTCString()}})),ProviderBackoff);assert.equal([...providerHealth.values()][0]!.state,'unavailable');
  providerHealth.clear();await assert.rejects(()=>completeProvider({...remote,backendKey:''},{},AbortSignal.timeout(1000),async()=>{throw new Error('should not call');}),/not configured/);assert.equal([...providerHealth.values()][0]!.state,'misconfigured');
});
test('provider transport is bounded and malformed JSON/tool output fails locally',async()=>{
  providerHealth.clear();await assert.rejects(()=>completeProvider(remote,{},AbortSignal.timeout(1000),async()=>new Response('not JSON')),/unreadable/);
  assert.throws(()=>parseModelResponse({choices:[{message:{content:[],tool_calls:[]}}]}));assert.throws(()=>parseModelResponse({choices:[{message:{content:null,tool_calls:[{function:null}]}}]}));assert.throws(()=>parseEnvelope('{broken'));assert.throws(()=>toolArguments('[]'));
});
test('easy/internal stays local, difficult work selects stronger provider, private Discord never goes remote',()=>{
  assert.equal(selectProvider(cfg,'hello',{reasoning:'fast',knowledge:'internal'},{image:false,discord:false}),cfg);
  assert.equal(selectProvider(cfg,'prove this theorem',{reasoning:'deep',knowledge:'internal'},{image:false,discord:false}),remote);
  assert.equal(selectProvider(cfg,'find a message',{reasoning:'deep',knowledge:'internal'},{image:false,discord:true}),cfg);
  assert.throws(()=>selectProvider({...cfg,external:undefined} as unknown as ServiceConfig,'prove this',{reasoning:'deep',knowledge:'internal'},{image:false,discord:false}),/stronger/);
});
test('rate-limited inference remains durably queued across restart without occupying a slot',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'provider-queue-')),path=join(dir,'test.sqlite');let store=new Store(path);
  const q=new Scheduler(store,{concurrency:1,reserved:0,borrow:false,timeoutMs:1000},async()=>{throw new ProviderBackoff(Date.now()+60000);});
  try{store.admit({id:'one',guild:'g',channel:'c',user:'u',coach:false,kind:'ask',prompt:'prove'},10);q.tick();await new Promise(r=>setTimeout(r,30));assert.equal(q.active.size,0);assert.equal(store.get('one')!.state,'queued');assert.equal(store.queued().length,0);q.stop();store.close();store=new Store(path);store.recover();assert.equal(store.get('one')!.state,'queued');assert.equal(store.queued().length,0);}finally{q.stop();store.close();rmSync(dir,{recursive:true,force:true});}
});
test('same tool harness enforces no-web and forbids remote private Discord tool requests',async()=>{
  providerHealth.clear();const store=new Store(':memory:');let sends=0;try{
    const run=runner(cfg,store,{route:async()=>({reasoning:'deep',knowledge:'internal',tool:'none'}),complete:async(_url,init)=>{
      const body=JSON.parse(String(init.body));assert.ok(body.tools.every((t:{function:{name:string}})=>!['search','fetch','discord_search','discord_member'].includes(t.function.name)));sends++;return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:'proof from approved tool policy'}}]}));
    }});
    const job:Job={id:'x',guild:'111111111111111111',channel:'222222222222222222',user:'333333333333333333',coach:false,kind:'ask',prompt:'prove that there are infinitely many primes. do not search.',state:'running',status:'',answer:'',artifact:'',created:Date.now(),message:'',delivered:0};assert.ok((await run(job,AbortSignal.timeout(1000),()=>{})).answer.includes('proof'));assert.equal(sends,1);
  }finally{store.close();}
});
