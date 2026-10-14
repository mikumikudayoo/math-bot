import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/service/store.js';
import {runner} from '../src/service/inference.js';
import type {ServiceConfig} from '../src/service/config.js';
const sentinel='PRIVATE_DERIVED_HISTORY_SENTINEL';
const config:ServiceConfig={mode:'development',secret:'fixture',port:8787,database:':memory:',concurrency:1,reserved:0,borrow:false,timeoutMs:10000,maxQueue:20,backend:'http://localhost:9999/v1',model:'phi-fixture',backendKey:'',vision:false,nativeTools:false,python:'unused',searchKey:'',sandbox:false,sandboxImage:'unused',cognitiveRouting:true,external:{backend:'https://external.example/v1',model:'strong-fixture',backendKey:'',vision:false,nativeTools:true}};
const input={guild:'123456789012345678',channel:'223456789012345678',user:'323456789012345678',coach:false,kind:'ask' as const};
const fast=async()=>({reasoning:'fast' as const,knowledge:'internal' as const,tool:'none' as const,scores:{web:0,online:0,calculate:0}});
const reply=(answer:string)=>Response.json({choices:[{message:{content:JSON.stringify({answer})},finish_reason:'stop'}]});
async function chain(s:Store){
 const first=s.admit({...input,id:'first',prompt:'what did machica say about calculus?'},10);s.running(first.id);
 const result=await runner(config,s,{discord:async()=>({type:'DISCORD_SEARCH_DATA',results:[{id:'423456789012345678',channelId:input.channel,author:{id:input.user},content:sentinel}]}),complete:async()=>Response.json({choices:[{message:{content:'{"message":1,"passage":1}'},finish_reason:'stop'}]})})(first,AbortSignal.timeout(10000),()=>{});s.complete(first.id,result);
 const second=s.admit({...input,id:'derived',parent:first.id,prompt:'summarize briefly'},10);s.running(second.id);
 const summary=await runner(config,s,{route:fast,discord:async()=>({type:'DISCORD_AUDIENCE_DATA',allowed:true}),complete:async()=>reply(sentinel)})(second,AbortSignal.timeout(10000),()=>{});s.complete(second.id,summary);return summary;
}
test('P1 private retrieval then derived answer persists explicit provenance',async()=>{
 const s=new Store(':memory:');try{const result=await chain(s);assert.equal((result as any).provenance?.classification,'private-discord');assert.equal(JSON.parse((s.get('derived') as any).provenance).classification,'private-discord');}finally{s.close();}
});
test('P1 derived private history cannot enter external hard-work payload',async()=>{
 const s=new Store(':memory:');let external=0;try{await chain(s);const job=s.admit({...input,id:'hard',parent:'derived',prompt:'prove Euclid prime theorem'},10);
 await runner(config,s,{route:async()=>({...await fast(),reasoning:'deep'}),complete:async(url,init)=>{assert.ok(url.startsWith('https://external'));external++;assert.ok(!String(init.body).includes(sentinel));return reply('a larger integer supplies another prime divisor.');}})(job,AbortSignal.timeout(10000),()=>{});assert.equal(external,1);
 }finally{s.close();}
});

import {publicProvenance,readProvenance} from '../src/service/provenance.js';
import {TurnWebBoundary} from '../src/service/turn-web-boundary.js';
test('P1 public history remains eligible and no-parent conversation is independent',async()=>{
 const s=new Store(':memory:');try{const p=s.admit({...input,id:'public',prompt:'hello'},10);s.running(p.id);s.complete(p.id,{answer:'PUBLIC_HISTORY',provenance:publicProvenance()});const j=s.admit({...input,id:'next',parent:p.id,prompt:'prove Euclid prime theorem'},10);let saw=false;
 const r=await runner(config,s,{route:async()=>({...await fast(),reasoning:'deep'}),complete:async(_u,init)=>{saw=String(init.body).includes('PUBLIC_HISTORY');return reply('a proof.');}})(j,AbortSignal.timeout(10000),()=>{});assert.ok(saw);assert.equal(r.provenance?.classification,'public');
 s.running(j.id);s.complete(j.id,r);await chain(s);const unrelated=s.admit({...input,id:'unrelated',prompt:'hi'},10);const fresh=await runner(config,s,{complete:async()=>reply('hi')})(unrelated,AbortSignal.timeout(10000),()=>{});assert.equal(fresh.provenance?.classification,'public');
 }finally{s.close();}
});
test('P1 mixed consumed history is private and cannot reset inside turn or complete',async()=>{
 const s=new Store(':memory:');try{await chain(s);const j=s.admit({...input,id:'mixed',parent:'derived',prompt:'summarize briefly'},10);s.running(j.id);
 const r=await runner(config,s,{route:fast,discord:async()=>({type:'DISCORD_AUDIENCE_DATA',allowed:true}),complete:async(_u,init)=>{assert.ok(String(init.body).includes(sentinel));assert.ok(!String(init.body).includes('discordSources'));return reply('a mixed summary');}})(j,AbortSignal.timeout(10000),()=>{});assert.equal(r.provenance?.classification,'private-discord');
 s.complete(j.id,{answer:'safe-looking text',provenance:publicProvenance()});assert.equal(readProvenance(s.get(j.id)!.provenance).classification,'private-discord');
 const b=new TurnWebBoundary('hi');b.observeProvenance(r.provenance!);b.observeProvenance(publicProvenance());b.observeDiscord({type:'DISCORD_SEARCH_DATA',results:[]});assert.ok(b.private);
 }finally{s.close();}
});
test('P1 retry/restart preserves taint before a final answer exists',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'private-retry-'));const path=join(dir,'ai.sqlite');let s=new Store(path);
 try{const j=s.admit({...input,id:'retry',prompt:'what did machica say about calculus?'},10);s.running(j.id);
 await assert.rejects(()=>runner({...config,model:'phi-retry-fixture'},s,{discord:async()=>({type:'DISCORD_SEARCH_DATA',results:[{id:'423456789012345678',channelId:input.channel,author:{id:input.user},content:sentinel}]}),complete:async()=>{throw new Error('synthetic interruption');}})(j,AbortSignal.timeout(10000),()=>{}));
 assert.equal(readProvenance(s.get(j.id)!.provenance).classification,'private-discord');s.defer(j.id,Date.now());s.close();s=new Store(path);assert.equal(s.get(j.id)!.state,'queued');assert.equal(readProvenance(s.get(j.id)!.provenance).classification,'private-discord');
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
test('P1 migration labels legacy descendants past eight history rows, without relabelling explicit public results',()=>{
 const dir=mkdtempSync(join(tmpdir(),'private-legacy-'));const path=join(dir,'ai.sqlite');let s=new Store(path);
 try{let parent:string|undefined;
 for(let i=0;i<11;i++){const j=s.admit({...input,id:'legacy-'+i,prompt:i?'derived text':'old lookup',...(parent?{parent}:{})},10);s.running(j.id);s.complete(j.id,{answer:sentinel,...(!i?{retrievalContext:JSON.stringify({kind:'discord',refs:[{channelId:input.channel}]})}:{})});s.db.prepare("UPDATE jobs SET provenance='{}' WHERE id=?").run(j.id);parent=j.id;}
 const clean=s.admit({...input,id:'explicit-public',parent:parent!,prompt:'standalone public proof'},10);s.running(clean.id);s.complete(clean.id,{answer:'public proof',provenance:publicProvenance()});s.close();s=new Store(path);
 assert.equal(readProvenance(s.get(parent!)!.provenance).classification,'private-discord');assert.equal(s.history(s.get(parent!)!).length,8);assert.ok(s.history(s.get(parent!)!).every(r=>readProvenance(r.provenance).classification==='private-discord'));
 assert.equal(readProvenance(s.get(clean.id)!.provenance).classification,'public');const before=s.get(parent!)!.provenance;s.close();s=new Store(path);assert.equal(s.get(parent!)!.provenance,before);
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
