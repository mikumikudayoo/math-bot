import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runner} from '../src/service/inference.js';
import {Store} from '../src/service/store.js';
import {Scheduler} from '../src/service/scheduler.js';
import {ProviderBackoff,providerHealth} from '../src/service/providers.js';
import {aiProvider} from '../src/service/ai-routing.js';
import type {ServiceConfig} from '../src/service/config.js';
import {UNVERIFIED_REPLIES} from '../src/service/retrieval-policy.js';
const c:ServiceConfig={mode:'development',secret:'fixture',port:8787,database:':memory:',concurrency:1,reserved:0,borrow:false,timeoutMs:10000,maxQueue:20,backend:'http://127.0.0.1:8082/v1',model:'phi',backendKey:'',vision:false,nativeTools:false,python:'python3',searchKey:'fixture',sandbox:false,sandboxImage:'unused',cognitiveRouting:true,external:{backend:'https://api.groq.com/openai/v1',model:'openai/gpt-oss-120b',backendKey:'fixture',nativeTools:true,vision:false}};
function job(s:Store,prompt:string){return s.admit({id:'1',guild:'g',channel:'c',user:'u',kind:'ask',coach:false,prompt},20);}
test('greeting and thanks skip models; raw arithmetic uses the calculator directly',async()=>{
 for(const prompt of ['hello!','yo','thank you','23*19']){const s=new Store(':memory:');try{let math=0;const run=runner(c,s,{complete:async()=>{throw new Error('model must not run');},mathTool:async()=>{math++;return {answer:'437'};}});const r=await run(job(s,prompt),AbortSignal.timeout(1000),()=>{});assert.equal(r.answer,prompt==='23*19'?'437':prompt==='thank you'?'yw':'hey');assert.equal(math,prompt==='23*19'?1:0);}finally{s.close();}}
});
test('easy internal semantic routes stay local; demanding math/code override mistaken easy classification',()=>{
 const route={reasoning:'fast' as const,knowledge:'internal' as const},options={image:false,discord:false};assert.equal(aiProvider(c,'explain fractions',route,options),c);
 for(const prompt of ['prove infinitely many primes','debug async code','find positive integer pairs'])assert.equal(aiProvider(c,prompt,route,options),c.external);
 assert.equal(aiProvider(c,'discord lookup',route,{...options,discord:true}),c);
});
test('hard requests stay external and unavailable external inference never silently downgrades',async()=>{
 const s=new Store(':memory:');providerHealth.clear();try{let calls=0;const run=runner(c,s,{route:async()=>({reasoning:'deep',knowledge:'internal',tool:'none'}),complete:async(url)=>{assert.ok(url.startsWith(c.external!.backend));calls++;return new Response('',{status:503});}});await assert.rejects(()=>run(job(s,'prove this theorem'),AbortSignal.timeout(1000),()=>{}),ProviderBackoff);assert.equal(calls,1);}finally{s.close();providerHealth.clear();}
});
test('429, 503 and transport outage use local verified-source fallback; grounded output is still validated',async()=>{
 const quote='Hatsune Miku uses voice samples provided by Saki Fujita.';
 for(const failure of [429,503,0]){const s=new Store(':memory:');providerHealth.clear();try{const paths:string[]=[];const run=runner(c,s,{route:async()=>({reasoning:'standard',knowledge:'web_required',tool:'none'}),search:async()=>[{url:'https://example.org/source',title:'Hatsune Miku',description:quote}],fetchText:async()=>({url:'https://example.org/source',text:quote}),complete:async(url,init)=>{paths.push(url);if(url.startsWith(c.external!.backend)){if(!failure)throw new Error('offline');return new Response('',{status:failure});}const body=JSON.parse(String(init.body));assert.ok(body.messages.some((m:{content:unknown})=>String(m.content).includes('RETRIEVED_EVIDENCE')));return Response.json({choices:[{message:{content:JSON.stringify({claims:[{source:1,quote}]})}}]});}});
 const r=await run(job(s,"who provides Hatsune Miku's voice?"),AbortSignal.timeout(1000),()=>{});assert.ok(r.answer.includes('Saki Fujita'));assert.ok(r.answer.includes('https://example.org/source'));assert.equal(paths.length,2);assert.ok(paths[1]!.startsWith(c.backend));}finally{s.close();providerHealth.clear();}}
});
test('failed web retrieval never invokes either model to guess',async()=>{
 const s=new Store(':memory:');try{const run=runner(c,s,{route:async()=>({reasoning:'standard',knowledge:'web_required',tool:'none'}),search:async()=>{throw new Error('offline');},complete:async()=>{throw new Error('must not guess');}});assert.ok(UNVERIFIED_REPLIES.includes((await run(job(s,'what is the latest weather?'),AbortSignal.timeout(1000),()=>{})).answer));}finally{s.close();}
});
test('provider retry budget is durable and ends with a concise temporary failure',async()=>{
 const s=new Store(':memory:');const q=new Scheduler(s,{concurrency:1,reserved:0,borrow:false,timeoutMs:1000},async()=>{throw new ProviderBackoff(Date.now()+10);});try{job(s,'hard question');q.tick();await new Promise(r=>setTimeout(r,25));s.db.prepare("UPDATE jobs SET provider_attempts=2,ready_at=0").run();q.tick();await new Promise(r=>setTimeout(r,25));assert.equal(s.get('1')!.state,'failed');assert.match(s.get('1')!.answer,/temporarily unavailable/);}finally{q.stop();s.close();}
});
