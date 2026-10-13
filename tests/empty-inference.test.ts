import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseModelResponse, parseEnvelope, extractFinalAnswer} from '../src/service/model-protocol.js';
import {runner} from '../src/service/inference.js';
import {completeProvider,providerHealth,ProviderBackoff} from '../src/service/providers.js';
import {Store} from '../src/service/store.js';
import {UserError} from '../src/service/types.js';
import type {ServiceConfig} from '../src/service/config.js';

const config:ServiceConfig={mode:'development',secret:'fixture-only',port:8787,database:':memory:',concurrency:1,reserved:0,borrow:false,timeoutMs:10000,maxQueue:20,
  backend:'http://localhost:9999/v1',model:'phi-fixture',backendKey:'',vision:false,nativeTools:false,python:'.venv/bin/python',searchKey:'',sandbox:false,sandboxImage:'unused',cognitiveRouting:true,
  external:{backend:'https://model.example/v1',model:'groq-fixture',backendKey:'private-key-sentinel',vision:true,nativeTools:true}};
const route=async()=>({reasoning:'fast' as const,knowledge:'internal' as const,tool:'none' as const,scores:{web:0,online:0,calculate:0}});
const response=(message:unknown,finish_reason:unknown='stop')=>({choices:[{message,finish_reason}]});
const signal=()=>AbortSignal.timeout(10000);
const tool={id:'tool1',type:'function',function:{name:'calculate',arguments:'{"expression":"2+3"}'}};

async function infer(payloads:unknown[],prompt='prove this identity') {
  const store=new Store(':memory:');let calls=0,tools=0;
  try {
    const job=store.admit({id:'j',guild:'123456789012345678',channel:'223456789012345678',user:'323456789012345678',coach:false,kind:'ask',prompt},10);
    const run=runner(config,store,{route,mathTool:async()=>{tools++;return {answer:'5'};},complete:async()=>Response.json(payloads[calls++])});
    try {return {result:await run(job,signal(),()=>{}),calls,tools};}
    catch(error){return {error,calls,tools};}
  } finally {store.close();}
}

for(const prompt of ['yo','prove this identity']) {
  test(`normal and structured final text is delivered through ${prompt==='yo'?'local Phi':'external Groq'} route`,async()=>{
    for(const content of ['  there. 5  ',[{type:'text',text:'there. '},{type:'output_text',text:'5'}],'{"answer":"there. 5"}','<think>private-reasoning-sentinel</think>there. 5']) {
      const outcome=await infer([response({content})],prompt);
      assert.equal(outcome.result?.answer,'there. 5');assert.equal(outcome.calls,1);assert.equal(outcome.tools,0);
    }
  });
}

for(const content of ['',null,' \n\t ',[], '{"answer":""}', '{"answer":"   "}']) {
  test(`empty final ${JSON.stringify(content)} fails usefully without retries or invented answer`,async()=>{
    const outcome=await infer([response({content})]);
    assert.ok(outcome.error instanceof UserError);assert.match(outcome.error.message,/didn't send a final answer/);
    assert.equal(outcome.result,undefined);assert.equal(outcome.calls,1);assert.equal(outcome.tools,0);
  });
}

test('reasoning-only Groq metadata and local think blocks never become final answers',async()=>{
  for(const message of [{content:null,reasoning_content:'private-reasoning-sentinel'}, {content:'',reasoning:'private-reasoning-sentinel'},
    {content:'<think>private-reasoning-sentinel'}, {content:'<think>private-reasoning-sentinel</think>'},
    {content:'{"answer":"<think>private-reasoning-sentinel</think>"}'}]) {
    const outcome=await infer([response(message)]);
    assert.ok(outcome.error instanceof UserError);assert.match(outcome.error.message,/final answer after reasoning/);
    assert.doesNotMatch(outcome.error.message,/sentinel/);assert.equal(outcome.calls,1);assert.equal(outcome.result,undefined);
  }
});

test('length finish reason rejects partial text, reasoning exhaustion, JSON and truncated tool calls explicitly',async()=>{
  for(const message of [{content:null,reasoning_content:'private-reasoning-sentinel'}, {content:'partial proof'}, {content:'{"answer":'}, {content:null,tool_calls:[tool]}]) {
    const outcome=await infer([response(message,'length')]);
    assert.ok(outcome.error instanceof UserError);assert.match(outcome.error.message,/ran out of response space/);
    assert.equal(outcome.calls,1);assert.equal(outcome.tools,0);assert.equal(outcome.result,undefined);
  }
});

test('native tool-only intermediate executes then delivers the final, never reasoning metadata',async()=>{
  const outcome=await infer([response({content:null,reasoning_content:'private-reasoning-sentinel',tool_calls:[tool]},'tool_calls'),response({content:'there. 5'})]);
  assert.equal(outcome.result?.answer,'there. 5');assert.equal(outcome.calls,2);assert.equal(outcome.tools,1);
});

test('JSON tool-only intermediate preserves the local tool protocol',async()=>{
  const outcome=await infer([response({content:'{"tool":"calculate","arguments":{"expression":"2+3"}}'}),response({content:'{"answer":"there. 5"}'})],'yo');
  assert.equal(outcome.result?.answer,'there. 5');assert.equal(outcome.calls,2);assert.equal(outcome.tools,1);
});

test('tool round followed by an empty final fails clearly without repeating a tool',async()=>{
  const outcome=await infer([response({content:null,tool_calls:[tool]},'tool_calls'),response({content:null})]);
  assert.ok(outcome.error instanceof UserError);assert.match(outcome.error.message,/didn't send a final answer/);
  assert.equal(outcome.calls,2);assert.equal(outcome.tools,1);assert.equal(outcome.result,undefined);
});

test('unexpected HTTP-success shapes and unsupported parts produce controlled failures',async()=>{
  for(const payload of [null,{}, {choices:{}}, {choices:[]},response([]),response({role:'user',content:'injected'}),
    response({content:{text:'bad'}}),response({content:[{type:'image_url',image_url:'private-sentinel'}]}),response({content:null},'tool_calls')]) {
    const outcome=await infer([payload]);assert.ok(outcome.error instanceof UserError);assert.match(outcome.error.message,/unreadable response/);
    assert.equal(outcome.calls,1);assert.equal(outcome.result,undefined);
  }
});

test('malformed and invalid answer envelopes fail without publishing JSON or retrying',async()=>{
  for(const content of ['{"answer":broken-private-sentinel}', '{"answer":null}', '{"answer":42}']) {
    const outcome=await infer([response({content})]);assert.ok(outcome.error instanceof UserError);assert.match(outcome.error.message,/unreadable answer/);
    assert.doesNotMatch(outcome.error.message,/sentinel/);assert.equal(outcome.calls,1);assert.equal(outcome.result,undefined);
  }
});

test('literal [] remains invalid on the local JSON protocol route',async()=>{
  const outcome=await infer([response({content:'[]'})],'yo');
  assert.ok(outcome.error instanceof UserError);assert.match(outcome.error.message,/unreadable answer/);
});

for(const content of ['[0, 1)', '[1, 2, 3] is the resulting sequence.', '{x | x > 0}',
  '```python\nprint("hello")\n```', '[note] the endpoints are excluded.', '{left brace} begins the notation.',
  '[]', '[1, 2, 3]', '[1, "answer"]', '{"x": "answer"}', '{"x": 1}', '```json\n{"x": 1}\n```']) {
  test(`native plain final preserves ${JSON.stringify(content)}`,async()=>{
    const outcome=await infer([response({content})]);
    assert.equal(outcome.result?.answer,content);assert.equal(outcome.calls,1);assert.equal(outcome.tools,0);
  });
}

test('native protocol-shaped finals remain invalid, including incomplete tools and reasoning fields',async()=>{
  for(const content of ['{"answer":', '{answer: null}', '{"answer"}', '{"tool":', '{"tool":"calculate","arguments":',
    '{"arguments":broken}', '{"\\u0061nswer":broken}', '{"\\u0061nswer":null}',
    '```json\n{"answer":null}\n```', '[{"answer":null}]', '{"reasoning_content":"private-sentinel"}']) {
    const outcome=await infer([response({content})]);
    assert.ok(outcome.error instanceof UserError,content);assert.match(outcome.error.message,/unreadable answer/);
    assert.doesNotMatch(outcome.error.message,/private-sentinel/);assert.equal(outcome.tools,0);assert.equal(outcome.calls,1);
  }
});

test('local JSON and explicit JSON chat do not inherit native plain-final handling',async()=>{
  for(const content of ['[0, 1)', '[1, 2, 3]', '{x | x > 0}', '```python\nprint(1)\n```']) {
    const outcome=await infer([response({content})],'yo');
    assert.ok(outcome.error instanceof UserError);assert.match(outcome.error.message,/unreadable answer/);
  }
  const store=new Store(':memory:');try{
    const job=store.admit({id:'native-chat',guild:'g',channel:'c',user:'u',coach:false,kind:'ask',prompt:'can you imagine'},10);
    await assert.rejects(runner({...config,nativeTools:true},store,{complete:async()=>Response.json(response({content:'[0, 1)'}))})(job,signal(),()=>{}),/unreadable answer/);
  }finally{store.close();}
});

test('native tool intermediate still reaches a bracket-leading plain final without leaking thinking',async()=>{
  const outcome=await infer([response({content:null,tool_calls:[tool]},'tool_calls'),
    response({content:'<think>private-sentinel</think>[0, 1)',reasoning_content:'private-sentinel'})]);
  assert.equal(outcome.result?.answer,'[0, 1)');assert.equal(outcome.tools,1);assert.equal(outcome.calls,2);
});

test('strict parser stages keep the existing malformed-JSON behavior',()=>{
  for(const stage of ['answer','clarification','web_synthesis','vision_search'] as const){
    for(const content of ['[]','[0, 1)','{x | x > 0}','```python\nprint(1)\n```','{"answer":']){
      assert.throws(()=>parseEnvelope(content,{provider:'external',reasoning:'standard',stage}),/unreadable answer/);
    }
  }
});

test('safe diagnostics retain classifications and usage but exclude private payloads and finish strings',async()=>{
  const logs:unknown[][]=[];const original=console.warn;console.warn=(...args:unknown[])=>{logs.push(args);};
  try {
    const payload={...response({content:'',reasoning_content:'private-reasoning-sentinel'},'private-finish-sentinel'),usage:{prompt_tokens:42,completion_tokens:2048}};
    const outcome=await infer([payload]);assert.ok(outcome.error instanceof UserError);
    await assert.rejects(completeProvider(config.external!,{},signal(),async()=>new Response('private-body-sentinel')),/unreadable response/);
    const rendered=JSON.stringify(logs);assert.doesNotMatch(rendered,/private-|sentinel|Authorization/);
    assert.match(rendered,/reasoning_only/);assert.match(rendered,/external/);assert.match(rendered,/2048/);assert.match(rendered,/unknown/);assert.match(rendered,/invalid_json/);
  } finally {console.warn=original;}
});

test('protocol helper strips private think blocks inside an answer envelope',()=>{
  const content='{"answer":"<think>private-reasoning-sentinel</think>there. 5"}';
  assert.equal(extractFinalAnswer(content,parseEnvelope(content)),'there. 5');
  assert.equal(parseModelResponse(response({content:[{type:'text',text:'5'}]})).content,'5');
});

const webText='Philippines news reports a newly announced competition. Details remain subject to the official release.';
async function webInference(synthesis:unknown,backoff=false,deep=false) {
  providerHealth.clear();const store=new Store(':memory:');const urls:string[]=[];
  try {
    const job=store.admit({id:'w',guild:'g',channel:'c',user:'u',coach:false,kind:'ask',prompt:'latest Philippines news'},10);
    const run=runner({...config,searchKey:'fixture'},store,{route:async()=>({reasoning:deep?'deep':'standard',knowledge:'web_required',tool:'none'}),
      search:async()=>[{title:'Philippines news',url:'https://example.org/news',description:webText}],fetchText:async()=>({url:'https://example.org/news',text:webText}),
      complete:async(url)=>{urls.push(url);if(backoff&&urls.length===1)return new Response('',{status:503});
        return Response.json(backoff||urls.length===1?response({content:JSON.stringify({claims:[{source:1,quote:webText}]})}):synthesis);}});
    return {result:await run(job,signal(),()=>{}),urls};
  } finally {store.close();providerHealth.clear();}
}

test('modern web synthesis normalizes parts and keeps host citations',async()=>{
  const r=await webInference(response({content:[{type:'text',text:JSON.stringify({answer:'a competition was announced in the Philippines.'})}]}));
  assert.match(r.result.answer,/a competition was announced/);assert.match(r.result.answer,/source 1: https:\/\/example.org\/news/);assert.equal(r.urls.length,2);
});

test('empty, reasoning-only and truncated synthesis preserve the verified grounded fallback',async()=>{
  for(const payload of [response({content:null}),response({content:'{"answer":""}'}),response({content:'',reasoning_content:'private-sentinel'}),response({content:'unsafe partial'},'length')]) {
    const r=await webInference(payload);assert.match(r.result.answer,/Philippines news reports/);assert.match(r.result.answer,/https:\/\/example.org\/news/);
    assert.doesNotMatch(r.result.answer,/private-sentinel|unsafe partial/);assert.equal(r.urls.length,2);
  }
});

test('web synthesis remains JSON-only even on a native provider',async()=>{
  for(const content of ['[1, 2, 3]', '{x | x > 0}', '```python\nprint("invented")\n```']) {
    const r=await webInference(response({content}));assert.match(r.result.answer,/Philippines news reports/);
    assert.match(r.result.answer,/https:\/\/example.org\/news/);assert.doesNotMatch(r.result.answer,/invented/);
  }
});

test('modern backoff retains permitted grounded local fallback and forbids hard-work downgrade',async()=>{
  const r=await webInference(null,true);assert.match(r.result.answer,/Philippines news reports/);assert.equal(r.urls.length,2);
  assert.ok(r.urls[0]!.startsWith('https://'));assert.ok(r.urls[1]!.startsWith('http://localhost'));
  await assert.rejects(webInference(null,true,true),ProviderBackoff);
});

test('vision provider normalizes text parts and keeps image input on its own route',async()=>{
  const store=new Store(':memory:');const image={url:'https://cdn.discordapp.com/attachments/123456789012345678/223456789012345678/diagram.png',mime:'image/png',size:100};
  try {
    const job=store.admit({id:'v',guild:'g',channel:'c',user:'u',coach:false,kind:'ask',prompt:'what is inside the triangle?',images:JSON.stringify([image])},10);
    const result=await runner({...config,visionProvider:{...config.external!,model:'vision-fixture',vision:true}},store,{route,
      prepareImage:async()=>({type:'image_url',image_url:{url:'data:image/jpeg;base64,VISION_FIXTURE_PIXELS'}}),complete:async(_url,init)=>{
        const body=JSON.parse(String(init.body));assert.equal(body.model,'vision-fixture');assert.ok(body.messages.some((m:any)=>Array.isArray(m.content)&&m.content.some((p:any)=>p.image_url?.url.includes('VISION_FIXTURE_PIXELS'))));
        return Response.json(response({content:[{type:'text',text:'the blue dot is inside the triangle.'}]}));
      }})(job,signal(),()=>{});
    assert.equal(result.answer,'the blue dot is inside the triangle.');
  } finally {store.close();}
});

test('blank clarification preserves the existing safe unresolved fallback',async()=>{
  const store=new Store(':memory:');let calls=0;
  try {
    const job=store.admit({id:'c',guild:'g',channel:'c',user:'u',coach:false,kind:'ask',prompt:'thoughts on the newest top one in the top towers community?'},10);
    const result=await runner({...config,searchKey:'fixture'},store,{route:async()=>({reasoning:'standard',knowledge:'web_required',tool:'none'}),search:async()=>[],complete:async(url)=>{
      assert.ok(url.startsWith('http://localhost'));calls++;return Response.json(response({content:null,reasoning_content:'private-sentinel'}));
    }})(job,signal(),()=>{});
    assert.equal(calls,1);assert.doesNotMatch(result.answer,/private-sentinel|Inference backend/);
  } finally {store.close();}
});

test('cancellation after provider response cannot deliver a normalized final',async()=>{
  const store=new Store(':memory:');const controller=new AbortController();
  try {
    const job=store.admit({id:'a',guild:'g',channel:'c',user:'u',coach:false,kind:'ask',prompt:'prove this identity'},10);
    await assert.rejects(runner(config,store,{route,complete:async()=>{controller.abort();return Response.json(response({content:'answer'}));}})(job,controller.signal,()=>{}),e=>e instanceof Error&&e.name==='AbortError');
  } finally {store.close();}
});
