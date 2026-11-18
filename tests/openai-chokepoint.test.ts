import {test} from 'node:test';
import assert from 'node:assert/strict';
import {serviceConfigFrom} from '../src/service/config.js';
import {Store} from '../src/service/store.js';
import {runner} from '../src/service/inference.js';
import {OpenAIRuntime,installOpenAIRuntime,type ResponsesClient} from '../src/service/openai.js';
import {parseOpenAIConfig} from '../src/service/openai-config.js';

const key='sk-test'+'x'.repeat(30);
const env={AI_SERVICE_TOKEN:'x'.repeat(40),AI_PROVIDER:'openai',OPENAI_API_KEY:key,AI_DATABASE:':memory:',
  INFERENCE_BASE_URL:'http://localhost:9999/v1',INFERENCE_MODEL:'phi',EXTERNAL_INFERENCE_PROVIDER:'groq',GROQ_API_KEY:'gsk-legacy',COGNITIVE_ROUTING:'true'};
const reply=(text:string)=>({status:'completed', service_tier:'default',output:[{type:'message',content:[{type:'output_text',text}]}],usage:{input_tokens:100,output_tokens:10,output_tokens_details:{reasoning_tokens:4}}});
const route=async()=>({reasoning:'fast',knowledge:'internal',tool:'none'}) as never;
const legacy=async():Promise<Response>=>{throw new Error('legacy provider must not be called');};

test('AI_PROVIDER=openai strips legacy providers and logs only their setting names',()=>{
  const warned:unknown[]=[];
  const config=serviceConfigFrom(env,'development',{},(event,data)=>warned.push(event,data));
  assert.equal(config.kind,'openai');assert.equal(config.model,'gpt-6-luna');assert.equal(config.external,undefined);assert.equal(config.cognitiveRouting,undefined);
  assert.equal(config.visionProvider,config);assert.equal(config.backendKey,'');
  assert.ok(!JSON.stringify(warned).includes('gsk-legacy')&&!JSON.stringify(warned).includes('localhost'));
  assert.ok(JSON.stringify(warned).includes('GROQ_API_KEY'));
  assert.throws(()=>serviceConfigFrom({...env,OPENAI_EXCLUSIVE:'false'},'development'),/provider-exclusive/);
});

test('v2 config: provider and model allow-list are independent; retired routing settings fail startup',()=>{
  const c=parseOpenAIConfig({AI_PROVIDER:'openai',OPENAI_API_KEY:key,OPENAI_ALLOWED_MODELS:'luna'})!;
  assert.deepEqual(c.allowed,{luna:true,terra:false,sol:false});assert.equal(c.lunaEffort,'low');
  assert.equal(parseOpenAIConfig({AI_PROVIDER:'openai',OPENAI_API_KEY:key})!.allowed.sol,true);
  assert.throws(()=>parseOpenAIConfig({AI_PROVIDER:'openai',OPENAI_API_KEY:key,OPENAI_ALLOWED_MODELS:'terra'}),/must include luna/);
  assert.throws(()=>parseOpenAIConfig({AI_PROVIDER:'openai',OPENAI_API_KEY:key,OPENAI_LUNA_EFFORT:'none'}),/at least low/);
  assert.throws(()=>parseOpenAIConfig({AI_PROVIDER:'openai',OPENAI_API_KEY:key,OPENAI_SOL_EFFORT:'none'}));
  for(const retired of ['OPENAI_FORCE_TIER','OPENAI_ADVANCED_MODEL','OPENAI_ROUTING'])assert.throws(()=>parseOpenAIConfig({AI_PROVIDER:'openai',OPENAI_API_KEY:key,[retired]:'x'}),/no longer supported/);
  assert.throws(()=>parseOpenAIConfig({AI_PROVIDER:'openai',OPENAI_API_KEY:'sk-short'}),(e:unknown)=>e instanceof Error&&!e.message.includes('sk-short'));
  assert.equal(parseOpenAIConfig({AI_PROVIDER:'legacy'}),undefined);
});

test('every runner model call goes to gpt-6-luna at low effort through the budgeted runtime; legacy fetch is never used',async()=>{
  const config=serviceConfigFrom(env,'development',{},()=>{});
  const store=new Store(':memory:');const seen:Record<string,unknown>[]=[];
  const client:ResponsesClient={create:async params=>{seen.push(structuredClone(params));return reply('yo');}};
  const openai=new OpenAIRuntime(config.openai!,store.db,client,{backoffMs:()=>0});
  try{
    const run=runner(config,store,{openai,route,complete:legacy,protectedProblems:()=>[],random:()=>1});
    const job=store.admit({id:'100000000000000001',guild:'123456789012345678',channel:'223456789012345678',user:'323456789012345678',coach:false,kind:'ask',prompt:'yo'},10);
    const result=await run(job,AbortSignal.timeout(10000),()=>{});
    assert.equal(result.answer,'yo');assert.ok(seen.length>=1);
    for(const p of seen){assert.equal(p.model,'gpt-6-luna');assert.deepEqual(p.reasoning,{effort:'low'});assert.equal(p.store,false);assert.equal(p.temperature,undefined);assert.ok(!JSON.stringify(p).includes(key));assert.ok(!String(p.safety_identifier).includes('323456789012345678'));}
    const summary=openai.ledger.summary();
    assert.equal(summary.models[0]!.model,'gpt-6-luna');assert.equal(summary.models[0]!.reasoningTokens,4*seen.length);assert.equal(summary.requestsLast24h.ordinary,1);
  }finally{installOpenAIRuntime(undefined);store.close();}
});

test('budgets fail closed before any call: request ceiling, daily ceiling and hourly rate limit',async()=>{
  for(const [extra,pattern] of [[{OPENAI_REQUEST_BUDGET_USD:'0'},/spending limit/],[{OPENAI_DAILY_BUDGET_USD:'0'},/budget/],[{OPENAI_USER_REQUESTS_PER_HOUR:'0'},/hourly limit/]] as const){
    const config=serviceConfigFrom({...env,...extra},'development',{},()=>{});
    const store=new Store(':memory:');let calls=0;
    const openai=new OpenAIRuntime(config.openai!,store.db,{create:async()=>{calls++;return reply('x');}},{backoffMs:()=>0});
    try{
      const run=runner(config,store,{openai,route,complete:legacy,protectedProblems:()=>[],random:()=>1});
      const job=store.admit({id:'100000000000000002',guild:'123456789012345678',channel:'223456789012345678',user:'323456789012345678',coach:false,kind:'ask',prompt:'yo'},10);
      await assert.rejects(run(job,AbortSignal.timeout(10000),()=>{}),pattern);assert.equal(calls,0);
    }finally{installOpenAIRuntime(undefined);store.close();}
  }
});

test('specialist escalation: quotas are per user, consumed once per job, and raise the request class',()=>{
  const config=parseOpenAIConfig({AI_PROVIDER:'openai',OPENAI_API_KEY:key,OPENAI_USER_SOL_PER_DAY:'1'})!;
  const store=new Store(':memory:');
  try{
    const ledger=new OpenAIRuntime(config,store.db,{create:async()=>reply('x')}).ledger;
    ledger.admitJob({job:'a',guild:'g',user:'u'});ledger.admitJob({job:'b',guild:'g',user:'u'});ledger.admitJob({job:'c',guild:'g',user:'v'});
    assert.equal(ledger.requestClass('a'),'ordinary');
    assert.deepEqual(ledger.authorizeEscalation('a','u','sol'),{ok:true,class:'sol'});
    assert.deepEqual(ledger.authorizeEscalation('a','u','sol'),{ok:true,class:'sol'});
    assert.equal(ledger.authorizeEscalation('b','u','sol').ok,false);
    assert.equal(ledger.authorizeEscalation('c','v','sol').ok,true);
    assert.deepEqual(ledger.authorizeEscalation('a','u','terra'),{ok:true,class:'both'});
    assert.equal(ledger.authorizeEscalation('missing','u','sol').ok,false);
  }finally{store.close();}
});

test('streaming: deltas are surfaced, the completed response is normalized, and usage is settled',async()=>{
  const config=parseOpenAIConfig({AI_PROVIDER:'openai',OPENAI_API_KEY:key})!;
  const store=new Store(':memory:');
  try{
    const final=reply('hello there');
    const client:ResponsesClient={create:async params=>{assert.equal(params.stream,true);return (async function*(){yield {type:'response.output_text.delta',delta:'hello '};yield {type:'response.output_text.delta',delta:'there'};yield {type:'response.completed',response:final};})();}};
    const runtime=new OpenAIRuntime(config,store.db,client,{backoffMs:()=>0});runtime.ledger.admitJob({job:'j',guild:'g',user:'u'});
    const seen:string[]=[];
    const body=await runtime.complete({messages:[{role:'user',content:'hi'}],role:'luna',effort:'low',purpose:'orchestrator',job:{id:'j',user:'u'},onTextDelta:(_d,soFar)=>seen.push(soFar)},AbortSignal.timeout(5000)) as {choices:{message:{content:string}}[]};
    assert.deepEqual(seen,['hello ','hello there']);assert.equal(body.choices[0]!.message.content,'hello there');
    assert.ok(runtime.ledger.jobSpentMicros('j')>0);
    // An un-escalated (ordinary, $0.02) request cannot afford a Sol call: the reservation is refused.
    await assert.rejects(runtime.complete({messages:[{role:'user',content:'hi'}],role:'sol',effort:'medium',purpose:'consult',job:{id:'j',user:'u'}},AbortSignal.timeout(5000)),/spending limit/);
  }finally{store.close();}
});
