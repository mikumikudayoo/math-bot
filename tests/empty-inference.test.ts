import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseModelResponse, parseEnvelope, extractFinalAnswer} from '../src/service/model-protocol.js';
import {runner} from '../src/service/inference.js';
import {completeProvider} from '../src/service/providers.js';
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
  for(const content of ['{"answer":broken-private-sentinel}', '{"answer":null}', '{"answer":42}', '[]']) {
    const outcome=await infer([response({content})]);assert.ok(outcome.error instanceof UserError);assert.match(outcome.error.message,/unreadable answer/);
    assert.doesNotMatch(outcome.error.message,/sentinel/);assert.equal(outcome.calls,1);assert.equal(outcome.result,undefined);
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
