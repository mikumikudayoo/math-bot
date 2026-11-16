import {test} from 'node:test';
import assert from 'node:assert/strict';
import {selectProvider,completeProvider,validateProvider,type ProviderConfig} from '../src/service/providers.js';
import {parseModelResponse,parseEnvelope,toolArguments} from '../src/service/model-protocol.js';
import {runner,system} from '../src/service/inference.js';
import {Store} from '../src/service/store.js';
import {routePrompt} from '../src/service/route-prompt.js';
import {CREATOR_ID} from '../src/discord-context.js';
import type {ServiceConfig} from '../src/service/config.js';

const external:ProviderConfig={backend:'https://model.example/v1',model:'external-fixture',backendKey:'external-test-key',vision:true,nativeTools:true};
const config:ServiceConfig={mode:'development',secret:'fixture-only-not-a-production-secret',port:8787,database:':memory:',concurrency:1,reserved:0,borrow:false,timeoutMs:10000,maxQueue:20,backend:'http://localhost:9999/v1',model:'phi-fixture',backendKey:'local-test-key',vision:false,nativeTools:false,python:'.venv/bin/python',searchKey:'fixture',sandbox:false,sandboxImage:'unused',cognitiveRouting:true,external};
const simple={reasoning:'fast',knowledge:'internal'} as const;
const options={image:false,discord:false};
const signal=()=>AbortSignal.timeout(10000);

test('conservative selection keeps only known easy tasks local and preserves disabled routing',()=>{
  for(const prompt of ['yo','who am i?','who trapped you?','2+3'])assert.equal(selectProvider(config,prompt,simple,options).model,'phi-fixture');
  for(const prompt of ['prove this theorem','explain something ambiguous','hi, also prove Fermat'])assert.equal(selectProvider(config,prompt,simple,options).model,'external-fixture');
  assert.equal(selectProvider(config,'hi',simple,{...options,image:true}),external);
  assert.equal(selectProvider({...config,cognitiveRouting:false},'prove this theorem',simple,options).model,'phi-fixture');
  assert.equal(selectProvider(config,'what did i say?',simple,{...options,discord:true}).model,'phi-fixture');
  const {external:_,...missing}=config;
  assert.throws(()=>selectProvider(missing,'prove this theorem',simple,options),/not configured/);
  assert.throws(()=>selectProvider({...config,external:{...external,vision:false}},'hi',simple,{...options,image:true}),/vision/);
});

test('external configuration rejects plaintext, embedded credentials and missing model',()=>{
  for(const backend of ['http://localhost/v1','https://user:secret@example.com/v1','https://example.com/v1?token=bad','file:///tmp/model'])assert.throws(()=>validateProvider({...external,backend},true));
  assert.throws(()=>validateProvider({...external,model:''},true));
  assert.equal(validateProvider(external,true),external);
});

test('provider retries transient failure once with isolated credentials and never downgrades',async()=>{
  let calls=0;
  const value=await completeProvider(external,{model:'untrusted',messages:[]},signal(),async(url,init)=>{
    assert.equal(url,'https://model.example/v1/chat/completions');
    assert.equal((init.headers as any).Authorization,'Bearer external-test-key');
    assert.equal(JSON.parse(String(init.body)).model,'external-fixture');
    return ++calls===1?new Response('private error',{status:503}):Response.json({ok:true});
  });
  assert.deepEqual(value,{ok:true});assert.equal(calls,2);
  calls=0;await assert.rejects(completeProvider(external,{},signal(),async()=>{calls++;return new Response('private',{status:401});}),/HTTP 401/);assert.equal(calls,1);
  calls=0;await assert.rejects(completeProvider(external,{},signal(),async()=>{calls++;throw new Error('secret address');}),/unavailable/);assert.equal(calls,2);
});

test('provider bounds responses and does not leak invalid JSON or continue after abort',async()=>{
  await assert.rejects(completeProvider(external,{},signal(),async()=>new Response('secret invalid json')),/unreadable response/);
  await assert.rejects(completeProvider(external,{},signal(),async()=>new Response('x'.repeat(1_000_001))),/size limit/);
  const controller=new AbortController();controller.abort();let calls=0;
  await assert.rejects(completeProvider(external,{},controller.signal,async()=>{calls++;return Response.json({});}));assert.equal(calls,0);
});

test('model protocol rejects malformed tool structures, duplicate IDs and nonobject arguments',()=>{
  for(const message of [{content:{}},{tool_calls:{}},{tool_calls:[null]},{tool_calls:[{id:'x',type:'function',function:{name:'calculate',arguments:42}}]}])assert.throws(()=>parseModelResponse({choices:[{message}]}));
  const call={id:'x',type:'function',function:{name:'calculate',arguments:'{}'}};
  assert.throws(()=>parseModelResponse({choices:[{message:{tool_calls:[call,call]}}]}));
  for(const raw of ['null','[]','2','"text"'])assert.throws(()=>toolArguments(raw));
  assert.deepEqual(toolArguments('{"expression":"2+3"}'),{expression:'2+3'});
  assert.throws(()=>parseEnvelope('{"tool":broken'));assert.throws(()=>parseEnvelope('[]'));
  assert.equal(parseEnvelope('yo'),undefined);assert.deepEqual(parseEnvelope('```json\n{"answer":"yo"}\n```'),{answer:'yo'});
});

test('both backends retain Aleph persona and trusted creator context through their own tool protocol',async()=>{
  for(const prompt of ['yo','prove this identity']){
    const store=new Store(':memory:');let calls=0;
    try{
      const job=store.admit({id:'j',guild:'123456789012345678',channel:'223456789012345678',user:CREATOR_ID,coach:false,kind:'ask',prompt},10);
      const result=await runner(config,store,{route:async()=>({...simple,scores:{web:0,online:0,calculate:0},tool:'none'}),mathTool:async()=>({answer:'5'}),complete:async(url,init)=>{
        const body=JSON.parse(String(init.body));const remote=prompt!=='yo';
        assert.ok(body.messages[0].content.startsWith(system));assert.ok(body.messages.some((m:any)=>String(m.content).includes('"isCreator":true')));
        assert.equal(url.startsWith('https://model.example'),remote);
        calls++;
        if(calls===1)return Response.json({choices:[{message:remote?{content:null,tool_calls:[{id:'tool1',type:'function',function:{name:'calculate',arguments:'{"expression":"2+3"}'}}]}:{content:'{"tool":"calculate","arguments":{"expression":"2+3"}}'}}]});
        assert.equal(body.messages.at(-1).role,remote?'tool':'user');
        return Response.json({choices:[{message:{content:'{"answer":"there. 5"}'}}]});
      }})(job,signal(),()=>{});
      assert.equal(result.answer,'there. 5');assert.equal(calls,2);
    }finally{store.close();}
  }
});

test('sensor outage preserves mandatory search and explicit no-web constraints',async()=>{
  const dependencies={signals:async()=>{throw new Error('offline');}};
  assert.equal((await routePrompt('latest weather in Manila',dependencies)).knowledge,'web_required');
  const offline=await routePrompt('prove this without searching',dependencies);
  assert.equal(offline.reasoning,'deep');assert.equal(offline.knowledge,'internal');
});

test('external provider cannot invoke private Discord tools',async()=>{
  const store=new Store(':memory:');let calls=0,discordCalls=0;
  try{
    const job=store.admit({id:'j',guild:'123456789012345678',channel:'223456789012345678',user:CREATOR_ID,coach:false,kind:'ask',prompt:'prove this identity'},10);
    const result=await runner(config,store,{route:async()=>({...simple,scores:{web:0,online:0,calculate:0},tool:'none'}),discord:async()=>{discordCalls++;return {};},complete:async(_url,init)=>{
      const body=JSON.parse(String(init.body));assert.ok(body.tools.every((t:any)=>!t.function.name.startsWith('discord_')));
      return Response.json({choices:[{message:++calls===1?{content:null,tool_calls:[{id:'x',type:'function',function:{name:'discord_search',arguments:'{"query":"private"}'}}]}:{content:'{"answer":"cannot retrieve that here"}'}}]});
    }})(job,signal(),()=>{});
    assert.equal(discordCalls,0);assert.equal(result.answer,'cannot retrieve that here');
  }finally{store.close();}
});
