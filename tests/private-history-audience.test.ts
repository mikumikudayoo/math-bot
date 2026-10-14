import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/service/store.js';
import {runner} from '../src/service/inference.js';
import {UserError} from '../src/service/types.js';
import type {ServiceConfig} from '../src/service/config.js';
import type {InferenceDependencies} from '../src/service/inference.js';
const cfg:ServiceConfig={mode:'development',secret:'fixture',port:8787,database:':memory:',concurrency:1,reserved:0,borrow:false,timeoutMs:10000,maxQueue:20,backend:'http://localhost:9999/v1',model:'p3-history',backendKey:'',vision:false,nativeTools:false,python:'unused',searchKey:'',sandbox:false,sandboxImage:'unused',cognitiveRouting:true,external:{backend:'https://external.example/v1',model:'p3-strong',backendKey:'',vision:false,nativeTools:true}};
const scope={guild:'123456789012345678',channel:'223456789012345678',user:'323456789012345678',coach:false,kind:'ask' as const};
const privateChannel='423456789012345678',sentinel='PRIVATE_AUDIENCE_SENTINEL';
const fast=async()=>({reasoning:'fast' as const,knowledge:'internal' as const,tool:'none' as const,scores:{web:0,online:0,calculate:0}});
function parent(s:Store,sources=[{guildId:scope.guild,channelId:privateChannel}],unknown=false){
 const j=s.admit({...scope,id:'parent',prompt:'a prior authorized lookup'},10);s.running(j.id);s.complete(j.id,{answer:sentinel,provenance:{version:1,classification:'private-discord',discordSources:sources,audienceUnknown:unknown}});return j.id;
}
for(const outcome of ['denied','unavailable','throws'] as const)test(`P3 inherited private history fails before model reuse when audience ${outcome}`,async()=>{
 const s=new Store(':memory:');let generated=0;
 try{const j=s.admit({...scope,id:'next',parent:parent(s),prompt:'hi'},10);
 const discord:InferenceDependencies['discord']=async(_j,tool,args)=>{assert.equal(tool,'discord_audience');assert.deepEqual(args,{sourceChannels:[privateChannel]});if(outcome==='throws')throw new Error(sentinel);return outcome==='denied'?{type:'DISCORD_AUDIENCE_DATA',allowed:false}:{error:sentinel};};
 await assert.rejects(()=>runner(cfg,s,{discord,complete:async()=>{generated++;throw new Error('must not generate');}})(j,AbortSignal.timeout(10000),()=>{}),error=>error instanceof UserError&&!error.message.includes(sentinel));assert.equal(generated,0);
 }finally{s.close();}
});
test('P3 authorized private-derived history is reused without provenance IDs in the model payload',async()=>{
 const s=new Store(':memory:');let checked=0;
 try{const j=s.admit({...scope,id:'next',parent:parent(s),prompt:'hi'},10);const r=await runner(cfg,s,{discord:async()=>{checked++;return {type:'DISCORD_AUDIENCE_DATA',allowed:true};},complete:async(_u,init)=>{const body=String(init.body);assert.ok(body.includes(sentinel));assert.ok(!body.includes(privateChannel));assert.ok(!body.includes('discordSources'));return Response.json({choices:[{message:{content:'{"answer":"hi"}'},finish_reason:'stop'}]});}})(j,AbortSignal.timeout(10000),()=>{});assert.equal(checked,1);assert.equal(r.provenance?.classification,'private-discord');
 }finally{s.close();}
});
test('P3 unknown or foreign private audiences fail closed without requesting a guessed scope',async()=>{
 for(const sources of [[],[{guildId:'523456789012345678',channelId:privateChannel}]]){const s=new Store(':memory:');let calls=0;try{const j=s.admit({...scope,id:'next',parent:parent(s,sources),prompt:'hi'},10);await assert.rejects(()=>runner(cfg,s,{discord:async()=>{calls++;return {type:'DISCORD_AUDIENCE_DATA',allowed:true};},complete:async()=>{calls++;throw new Error('unexpected');}})(j,AbortSignal.timeout(10000),()=>{}),UserError);assert.equal(calls,0);}finally{s.close();}}
});
test('P3 strong public work filters private history without unnecessary private audience access',async()=>{
 const s=new Store(':memory:');let audience=0;
 try{const j=s.admit({...scope,id:'next',parent:parent(s),prompt:'prove there are infinitely many primes'},10);const r=await runner(cfg,s,{route:async()=>({...await fast(),reasoning:'deep'}),discord:async()=>{audience++;throw new Error('no private context needed');},complete:async(url,init)=>{assert.ok(url.startsWith('https://external'));assert.ok(!String(init.body).includes(sentinel));return Response.json({choices:[{message:{content:'a product plus one has a new prime divisor.'},finish_reason:'stop'}]});}})(j,AbortSignal.timeout(10000),()=>{});assert.equal(audience,0);assert.equal(r.provenance?.classification,'public');
 }finally{s.close();}
});
test('P3 a persisted retry reauthorizes its private provenance even without parent history',async()=>{
 const s=new Store(':memory:');let generated=0;
 try{const j=s.admit({...scope,id:'retry',prompt:'hi'},10);s.markProvenance(j.id,{version:1,classification:'private-discord',discordSources:[{guildId:scope.guild,channelId:privateChannel}],audienceUnknown:false});await assert.rejects(()=>runner(cfg,s,{discord:async()=>({type:'DISCORD_AUDIENCE_DATA',allowed:false}),complete:async()=>{generated++;throw new Error('unexpected');}})(j,AbortSignal.timeout(10000),()=>{}),UserError);assert.equal(generated,0);
 }finally{s.close();}
});
