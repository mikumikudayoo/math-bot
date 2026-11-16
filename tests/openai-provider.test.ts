import {test} from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import {Store} from '../src/service/store.js';
import {runner,type InferenceDependencies} from '../src/service/inference.js';
import type {ServiceConfig} from '../src/service/config.js';
import type {ProviderConfig} from '../src/service/providers.js';
import {UserError} from '../src/service/types.js';
import {parseModelResponse} from '../src/service/model-protocol.js';
import {parseOpenAIConfig,describeOpenAIConfig,ConfigError,DEFAULT_MODELS,LONG_CONTEXT_TOKENS,type OpenAIConfig} from '../src/service/openai-config.js';
import {parseDirective,chooseOpenAIRoute,difficultySignals} from '../src/service/openai-routing.js';
import {UsageLedger,Semaphore,BudgetError,costMicros,estimateInputTokens,formatUsageSummary} from '../src/service/openai-budget.js';
import {OpenAIRuntime,ProviderError,classifyOpenAIError,formatForDiscord,toResponsesInput,toResponsesTools,type ResponsesClient,type OpenAIRequest} from '../src/service/openai.js';

// ---- fixtures ----------------------------------------------------------------

const KEY='sk-test'+'x'.repeat(30);
const GUILD='123456789012345678',CHANNEL='223456789012345678',USER='323456789012345678';
const cfg=(env:Record<string,string>={}):OpenAIConfig=>parseOpenAIConfig({AI_PROVIDER:'openai',OPENAI_API_KEY:KEY,...env})!;
const external:ProviderConfig={backend:'https://model.example/v1',model:'external-fixture',backendKey:'external-test-key',vision:true,nativeTools:true};
const base={mode:'development',secret:'fixture-only-not-a-production-secret',port:8787,database:':memory:',concurrency:1,reserved:0,borrow:false,
  timeoutMs:10000,maxQueue:20,backend:'http://localhost:9999/v1',model:'phi-fixture',backendKey:'local-test-key',vision:false,nativeTools:false,
  python:'.venv/bin/python',searchKey:'fixture',sandbox:false,sandboxImage:'unused',external} as ServiceConfig;
const signal=()=>AbortSignal.timeout(10000);
const tick=(ms=5)=>new Promise(resolve=>setTimeout(resolve,ms));
const route=async()=>({reasoning:'fast' as const,knowledge:'internal' as const,tool:'none' as const,scores:{web:0,online:0,calculate:0}});

// Raw Responses API shapes.
const usage=(input=120,output=60,reasoning=40,cached=0)=>({input_tokens:input,input_tokens_details:{cached_tokens:cached},output_tokens:output,output_tokens_details:{reasoning_tokens:reasoning}});
const text=(t:string,u:unknown=usage())=>({status:'completed',output:[{type:'reasoning',id:'rs_final',encrypted_content:'enc-final'},{type:'message',content:[{type:'output_text',text:t}]}],...(u?{usage:u}:{})});
const fnCall=(id:string,args='{"expression":"2+3"}',name='calculate')=>({status:'completed',output:[{type:'reasoning',id:'rs_1',encrypted_content:'x'},{type:'function_call',call_id:id,name,arguments:args}],usage:usage()});

// SDK errors (real classes) whose messages deliberately contain things that must never reach users.
const H=()=>new Headers();
const err={
  rate:()=>new OpenAI.RateLimitError(429,{code:'rate_limit_exceeded',message:'Rate limit reached'},undefined,H()),
  quota:()=>new OpenAI.RateLimitError(429,{code:'insufficient_quota',message:'You exceeded your current quota'},undefined,H()),
  unavailable:()=>new OpenAI.InternalServerError(503,{message:'upstream overloaded at https://internal.example'},undefined,H()),
  auth:()=>new OpenAI.AuthenticationError(401,{code:'invalid_api_key',message:`Incorrect API key provided: ${KEY}`},undefined,H()),
  notFound:()=>new OpenAI.NotFoundError(404,{code:'model_not_found',message:`The model gpt-6-luna does not exist (key ${KEY}). See https://platform.openai.com/docs`},undefined,H()),
  unsupported:()=>new OpenAI.BadRequestError(400,{code:'unsupported_parameter',param:'reasoning.effort',message:"Unsupported parameter: 'reasoning.effort'"},undefined,H()),
  badRequest:()=>new OpenAI.BadRequestError(400,{code:'invalid_value',message:'bad input'},undefined,H()),
};

type Script=(params:any,n:number,options:{signal:AbortSignal;timeout:number})=>unknown;
function mockClient(script:Script){
  const calls:any[]=[];const options:{signal:AbortSignal;timeout:number}[]=[];
  // Snapshot params: the runtime mutates its params object between retries.
  const client:ResponsesClient={create:async(params,opts)=>{const snap=structuredClone(params);calls.push(snap);options.push(opts);return await script(snap,calls.length,opts);}};
  return {client,calls,options};
}

const request=(o:Partial<OpenAIRequest>={}):OpenAIRequest=>({messages:[{role:'system',content:'sys'},{role:'user',content:'what is 2+3'}],
  model:'gpt-6-luna',effort:'medium',tier:'light',maxOutputTokens:4000,job:{id:'job-1',user:USER},...o});

function runtimeFor(env:Record<string,string>,script:Script,now?:()=>number){
  const store=new Store(':memory:');const config=cfg(env);const mock=mockClient(script);const backoffs:number[]=[];
  const runtime=new OpenAIRuntime(config,store.db,mock.client,{backoffMs:a=>{backoffs.push(a);return 0;},...(now?{now}:{})});
  return {store,config,runtime,backoffs,...mock};
}
const usageRows=(store:Store)=>store.db.prepare('SELECT * FROM openai_usage ORDER BY id').all() as any[];
/** Mirrors the runtime's worst-case reservation for a request. */
function worstFor(c:OpenAIConfig,req:OpenAIRequest){
  const input=toResponsesInput(req.messages);const tools=toResponsesTools(req.tools);
  const chars=JSON.stringify(input).length+JSON.stringify(tools).length;
  return costMicros(c.models[req.model]!,{inputTokens:estimateInputTokens(chars,0),cachedTokens:0,outputTokens:req.maxOutputTokens,reasoningTokens:0});
}

async function capture<T>(fn:()=>Promise<T>){
  const logs:unknown[][]=[];const warn=console.warn,info=console.info;
  console.warn=(...a:unknown[])=>{logs.push(a);};console.info=(...a:unknown[])=>{logs.push(a);};
  try{try{return {value:await fn(),error:undefined as unknown,logs};}catch(error){return {value:undefined,error,logs};}}
  finally{console.warn=warn;console.info=info;}
}

function harness(env:Record<string,string>={},script:Script=()=>text('ok'),opts:{config?:Partial<ServiceConfig>;complete?:(url:string,init:RequestInit)=>Promise<Response>;discord?:InferenceDependencies['discord']}={}){
  const store=new Store(':memory:');
  const openaiConfig=cfg(env);
  const config={...base,...opts.config,openai:openaiConfig} as ServiceConfig;
  const mock=mockClient(script);
  const runtime=new OpenAIRuntime(openaiConfig,store.db,mock.client,{backoffMs:()=>0});
  const math={count:0,args:[] as Record<string,unknown>[]};
  const ext={count:0,urls:[] as string[],bodies:[] as any[],inits:[] as RequestInit[]};
  let seq=0;
  const run=async(prompt:string,o:{coach?:boolean;parent?:string;id?:string}={})=>{
    const job=store.admit({id:o.id??`job-${++seq}`,guild:GUILD,channel:CHANNEL,user:USER,coach:o.coach??false,kind:'ask',prompt,...(o.parent?{parent:o.parent}:{})},10);
    store.running(job.id);
    try{
      const result=await runner(config,store,{route,
        mathTool:async(_c,args)=>{math.count++;math.args.push(args);return {answer:'5'};},
        complete:async(url,init)=>{
          ext.count++;ext.urls.push(url);ext.inits.push(init);ext.bodies.push(JSON.parse(String(init.body)));
          if(!opts.complete)throw new Error('external provider must not be called');
          return opts.complete(url,init);
        },
        openai:runtime,...(opts.discord?{discord:opts.discord}:{})})(job,signal(),()=>{});
      store.complete(job.id,result);return result;
    }catch(error){store.fail(job.id,'failed');throw error;}
  };
  return {store,config,openaiConfig,runtime,math,ext,run,...mock};
}
const userTexts=(params:any)=>(params.input as any[]).filter(i=>i.role==='user').map(i=>i.content);
const isProvider=(kind:string)=>(e:unknown)=>e instanceof ProviderError&&e.kind===kind;

// ---- 1 ----------------------------------------------------------------------

test('1 model selection: routine work stays light; proof/olympiad, stacked competition signals and advanced follow-ups go advanced',async()=>{
  const c=cfg();
  for(const prompt of ['what is 2+3','solve 3x + 5 = 11 for x','hey how are you','what is 15% of 80','integrate x^2 sin(x) dx',
    'simplify (x^2+2x+1)/(x+1)','\\frac{a}{b}+\\sqrt{2} = ?','\\int_0^1 x^2\\,dx + \\sum_{k=1}^n k',
    'what is the probability of two heads','find the remainder when 2^100 is divided by 7']){
    const r=chooseOpenAIRoute(c,{prompt,coach:false});
    assert.deepEqual([r.tier,r.model,r.effort,r.maxOutputTokens],['light','gpt-6-luna','medium',4000],prompt);
  }
  for(const prompt of ['prove that sqrt(2) is irrational','show that n^3-n is divisible by 6','IMO 2019 problem 1',
    'find all functions f such that f(x+y)=f(x)+f(y)','an olympiad inequality please','USAMO 2003 P1']){
    const r=chooseOpenAIRoute(c,{prompt,coach:false});
    assert.deepEqual([r.tier,r.model,r.effort,r.maxOutputTokens],['advanced','gpt-6.1-sol','high',16000],prompt);
  }
  const stacked='how many positive integers below 1000 are divisible by 7?';
  assert.ok(difficultySignals(stacked).medium>=3);
  assert.equal(chooseOpenAIRoute(c,{prompt:stacked,coach:false}).tier,'advanced');
  // Two signals alone stay light; the router's deep reasoning is one more weak signal.
  const two='what is the probability that a random divisor of 60 is even';
  assert.equal(difficultySignals(two).medium,2);
  assert.equal(chooseOpenAIRoute(c,{prompt:two,coach:false}).tier,'light');
  assert.equal(chooseOpenAIRoute(c,{prompt:two,coach:false,routeReasoning:'deep'}).tier,'advanced');
  assert.equal(chooseOpenAIRoute(c,{prompt:'what is 2+3',coach:false,routeReasoning:'deep'}).tier,'light');
  // Follow-ups.
  assert.equal(chooseOpenAIRoute(c,{prompt:'ok and the next case?',coach:false,parentTier:'advanced'}).tier,'advanced');
  assert.equal(chooseOpenAIRoute(c,{prompt:'ok and the next case?',coach:false,parentTier:'max'}).tier,'advanced');
  assert.equal(chooseOpenAIRoute(c,{prompt:'ok and the next case?',coach:false,parentTier:'light'}).tier,'light');
  // Routing disabled.
  const off=chooseOpenAIRoute(cfg({OPENAI_ROUTING:'false'}),{prompt:'prove that sqrt(2) is irrational',coach:false});
  assert.deepEqual([off.tier,off.model,off.reason],['light','gpt-6-luna','routing disabled']);

  // End to end: the runner sends the routed model/effort, and a reply to an advanced answer stays advanced.
  const h=harness();
  try{
    await h.run('prove that sqrt 2 is irrational');
    await h.run('ok and the next case?',{parent:'job-1'});
    await h.run('what is 2+3');
    assert.deepEqual(h.calls.map(p=>[p.model,p.reasoning?.effort,p.max_output_tokens]),
      [['gpt-6.1-sol','high',16000],['gpt-6.1-sol','high',16000],['gpt-6-luna','medium',4000]]);
  }finally{h.store.close();}
});

// ---- 2 ----------------------------------------------------------------------

test('2 overrides: !deep/!quick/!max directives, coach-only !max, OPENAI_FORCE_TIER and OPENAI_FORCE_EFFORT',async()=>{
  assert.deepEqual(parseDirective('!deep what is 2+3'),{prompt:'what is 2+3',directive:'deep'});
  assert.deepEqual(parseDirective('  !SOL: what is 2+3'),{prompt:'what is 2+3',directive:'deep'});
  assert.deepEqual(parseDirective('!quick prove x'),{prompt:'prove x',directive:'quick'});
  assert.deepEqual(parseDirective('!luna, hi'),{prompt:'hi',directive:'quick'});
  assert.deepEqual(parseDirective('!max prove x'),{prompt:'prove x',directive:'max'});
  assert.deepEqual(parseDirective('what is !deep'),{prompt:'what is !deep'});
  assert.deepEqual(parseDirective('!maxwell equations'),{prompt:'!maxwell equations'});

  const c=cfg();
  const deep=chooseOpenAIRoute(c,{prompt:'what is 2+3',coach:false,directive:'deep'});
  assert.deepEqual([deep.tier,deep.model,deep.effort,deep.directive],['advanced','gpt-6.1-sol','high','deep']);
  const quick=chooseOpenAIRoute(c,{prompt:'prove that sqrt 2 is irrational',coach:false,directive:'quick'});
  assert.deepEqual([quick.tier,quick.model,quick.effort],['light','gpt-6-luna','medium']);
  assert.throws(()=>chooseOpenAIRoute(c,{prompt:'x',coach:false,directive:'max'}),(e:unknown)=>e instanceof UserError&&/coaches/.test(e.message));
  const max=chooseOpenAIRoute(c,{prompt:'x',coach:true,directive:'max'});
  assert.deepEqual([max.tier,max.model,max.effort,max.maxOutputTokens],['max','gpt-6.1-sol','xhigh',32000]);

  const forcedAdvanced=cfg({OPENAI_FORCE_TIER:'advanced'});
  assert.equal(chooseOpenAIRoute(forcedAdvanced,{prompt:'what is 2+3',coach:false}).tier,'advanced');
  assert.equal(chooseOpenAIRoute(forcedAdvanced,{prompt:'what is 2+3',coach:false,directive:'quick'}).tier,'advanced');
  assert.equal(chooseOpenAIRoute(cfg({OPENAI_FORCE_TIER:'light'}),{prompt:'prove that sqrt 2 is irrational',coach:false}).model,'gpt-6-luna');
  const forcedEffort=cfg({OPENAI_FORCE_EFFORT:'low'});
  assert.equal(chooseOpenAIRoute(forcedEffort,{prompt:'what is 2+3',coach:false}).effort,'low');
  assert.equal(chooseOpenAIRoute(forcedEffort,{prompt:'prove it',coach:false}).effort,'low');
  assert.equal(chooseOpenAIRoute(forcedEffort,{prompt:'x',coach:true,directive:'max'}).effort,'xhigh');
  assert.equal(chooseOpenAIRoute(cfg({OPENAI_FORCE_TIER:'light',OPENAI_FORCE_EFFORT:'none'}),{prompt:'prove it',coach:false}).effort,'none');

  const h=harness();
  try{
    await h.run('!deep what is 2+3');
    assert.equal(h.calls[0].model,'gpt-6.1-sol');
    assert.equal(userTexts(h.calls[0]).at(-1),'what is 2+3');
    assert.ok(!JSON.stringify(h.calls[0].input).includes('!deep'));
    await h.run('!quick prove that sqrt 2 is irrational');
    assert.equal(h.calls[1].model,'gpt-6-luna');
    await assert.rejects(h.run('!max prove it',{coach:false}),(e:unknown)=>e instanceof UserError&&/coaches/.test(e.message));
    assert.equal(h.calls.length,2);
    await h.run('!max prove it',{coach:true});
    assert.deepEqual([h.calls[2].model,h.calls[2].reasoning.effort,h.calls[2].max_output_tokens],['gpt-6.1-sol','xhigh',32000]);
  }finally{h.store.close();}
});

// ---- 3 ----------------------------------------------------------------------

test('3 unsupported reasoning params: rejected at startup; runtime retries exactly once without `reasoning`; never sends temperature',async()=>{
  const check=(env:Record<string,string>,pattern:RegExp)=>assert.throws(()=>cfg(env),(e:unknown)=>e instanceof ConfigError&&pattern.test(e.message)&&!e.message.includes(KEY));
  check({OPENAI_ADVANCED_EFFORT:'none'},/not supported by gpt-6\.1-sol/);
  check({OPENAI_MAX_EFFORT:'none'},/not supported by gpt-6\.1-sol/);
  check({OPENAI_LIGHT_EFFORT:'minimal'},/not supported by gpt-6-luna/);
  check({OPENAI_FORCE_EFFORT:'none'},/not supported by gpt-6\.1-sol/);
  check({OPENAI_LIGHT_EFFORT:'turbo'},/Invalid OPENAI_LIGHT_EFFORT/);

  let t=runtimeFor({},(_p,n)=>{if(n===1)throw err.unsupported();return text('5');});
  try{
    const result=await t.runtime.complete(request(),signal());
    assert.equal(parseModelResponse(result).content,'5');
    assert.equal(t.calls.length,2);
    assert.deepEqual(t.calls[0].reasoning,{effort:'medium'});
    assert.ok(!('reasoning' in t.calls[1]));
    for(const p of t.calls){assert.ok(!('temperature' in p));assert.equal(p.model,'gpt-6-luna');assert.equal(p.max_output_tokens,4000);}
    assert.deepEqual(t.backoffs,[]);
  }finally{t.store.close();}

  t=runtimeFor({},()=>{throw err.unsupported();});
  try{
    await assert.rejects(t.runtime.complete(request(),signal()),isProvider('unsupported_parameter'));
    assert.equal(t.calls.length,2);
  }finally{t.store.close();}

  t=runtimeFor({},()=>{throw err.badRequest();});
  try{
    await assert.rejects(t.runtime.complete(request(),signal()),isProvider('bad_request'));
    assert.equal(t.calls.length,1);
  }finally{t.store.close();}

  const shaped=classifyOpenAIError({status:400,error:{param:'reasoning.effort'}});
  assert.deepEqual([shaped.kind,shaped.param],['unsupported_parameter','reasoning.effort']);
});

// ---- 4 ----------------------------------------------------------------------

test('4 normal response: chat-shaped body, stateless params with hashed safety_identifier, usage recorded',async()=>{
  const t=runtimeFor({},()=>text('5',usage(120,60,40,20)));
  try{
    const result=await t.runtime.complete(request(),signal());
    const choice=(result.choices as any[])[0];
    assert.equal(choice.finish_reason,'stop');
    assert.deepEqual(choice.message,{role:'assistant',content:'5'});
    assert.deepEqual(result.usage,{prompt_tokens:120,completion_tokens:60,reasoning_tokens:40,cached_tokens:20});
    assert.equal(parseModelResponse(result).content,'5');

    const p=t.calls[0];
    assert.equal(p.model,'gpt-6-luna');
    assert.equal(p.store,false);
    assert.equal(p.max_output_tokens,4000);
    assert.deepEqual(p.reasoning,{effort:'medium'});
    assert.deepEqual(p.include,['reasoning.encrypted_content']);
    assert.deepEqual(p.input,[{role:'developer',content:'sys'},{role:'user',content:'what is 2+3'}]);
    assert.ok(!('tools' in p)&&!('tool_choice' in p)&&!('temperature' in p));
    assert.match(p.safety_identifier,/^[0-9a-f]{32}$/);
    assert.ok(!p.safety_identifier.includes(USER));
    assert.ok(!JSON.stringify(p).includes(USER));
    assert.ok(!JSON.stringify(p).includes(KEY));
    assert.equal(t.options[0]!.timeout,t.config.timeoutMs);

    await t.runtime.complete(request({job:{id:'job-2',user:USER}}),signal());
    await t.runtime.complete(request({job:{id:'job-3',user:'999999999999999999'}}),signal());
    assert.equal(t.calls[1].safety_identifier,p.safety_identifier);
    assert.notEqual(t.calls[2].safety_identifier,p.safety_identifier);

    const row=usageRows(t.store)[0];
    assert.deepEqual([row.status,row.model,row.effort,row.tier,row.input_tokens,row.cached_tokens,row.output_tokens,row.reasoning_tokens],
      ['ok','gpt-6-luna','medium','light',120,20,60,40]);
    assert.equal(row.cost_micros,costMicros(DEFAULT_MODELS['gpt-6-luna']!,{inputTokens:120,cachedTokens:20,outputTokens:60,reasoningTokens:40}));
  }finally{t.store.close();}
});

// ---- 5 ----------------------------------------------------------------------

test('5 tool calls: runner executes calculate once on the host and replays reasoning + function_call + output; no Discord tools offered',async()=>{
  let discordCalls=0;
  const h=harness({},(_p,n)=>n===1?fnCall('call_1'):text('the answer is 5'),{discord:async()=>{discordCalls++;return {};}});
  try{
    const result=await h.run('what is 2+3');
    assert.equal(result.answer,'the answer is 5');
    assert.equal(h.math.count,1);
    assert.deepEqual(h.math.args[0],{expression:'2+3'});
    assert.equal(h.calls.length,2);
    assert.equal(discordCalls,0);

    const names=(h.calls[0].tools as any[]).map(t=>t.name);
    assert.ok(names.includes('calculate'));
    assert.ok(!names.some(n=>n.startsWith('discord_')),`offered: ${names}`);
    assert.equal(h.calls[0].tool_choice,'auto');
    for(const p of h.calls)assert.ok(!('temperature' in p));

    const input=h.calls[1].input as any[];
    const reasoning=input.findIndex(i=>i.type==='reasoning');
    const call=input.findIndex(i=>i.type==='function_call');
    const output=input.findIndex(i=>i.type==='function_call_output');
    assert.ok(reasoning>=0&&reasoning<call&&call<output,'reasoning, call, output in order');
    assert.deepEqual(input[reasoning],{type:'reasoning',id:'rs_1',encrypted_content:'x'});
    assert.deepEqual(input[call],{type:'function_call',call_id:'call_1',name:'calculate',arguments:'{"expression":"2+3"}'});
    assert.deepEqual(input[output],{type:'function_call_output',call_id:'call_1',output:'{"answer":"5"}'});
    assert.equal(h.ext.count,0);
  }finally{h.store.close();}
});

// ---- 6 ----------------------------------------------------------------------

test('6 missing/malformed api key: ConfigError without the key value',()=>{
  assert.equal(parseOpenAIConfig({}),undefined);
  assert.equal(parseOpenAIConfig({AI_PROVIDER:'legacy',OPENAI_API_KEY:'garbage'}),undefined);
  assert.throws(()=>parseOpenAIConfig({AI_PROVIDER:'bogus'}),ConfigError);
  for(const env of [{AI_PROVIDER:'openai'},{AI_PROVIDER:'openai',OPENAI_API_KEY:'   '}])
    assert.throws(()=>parseOpenAIConfig(env),(e:unknown)=>e instanceof ConfigError&&/requires OPENAI_API_KEY/.test(e.message));
  for(const bad of ['sk-short','sk-'+'y'.repeat(10),'pk-'+'y'.repeat(40),'sk-has spaces '+'y'.repeat(30),'Bearer sk-'+'y'.repeat(30),'sk-'+'y'.repeat(25)+'!'])
    assert.throws(()=>parseOpenAIConfig({AI_PROVIDER:'openai',OPENAI_API_KEY:bad}),
      (e:unknown)=>e instanceof ConfigError&&/malformed/.test(e.message)&&!e.message.includes(bad.trim())&&!e.message.includes('yyyyy'));
  // Inherited from the process environment; the env file wins.
  assert.equal(parseOpenAIConfig({AI_PROVIDER:'openai'},{OPENAI_API_KEY:KEY})!.apiKey,KEY);
  assert.equal(parseOpenAIConfig({AI_PROVIDER:'openai',OPENAI_API_KEY:KEY},{OPENAI_API_KEY:'sk-'+'z'.repeat(30)})!.apiKey,KEY);
  // No other configuration error echoes the key either.
  for(const env of [{OPENAI_LIGHT_MODEL:'gpt-unknown'},{OPENAI_TIMEOUT_SECONDS:'1'},{OPENAI_FALLBACK:'maybe'},{OPENAI_PRICING_JSON:'{bad'},
    {OPENAI_FORCE_TIER:'max'},{OPENAI_ROUTING:'yes'},{OPENAI_CONCURRENCY:'0'},{OPENAI_PRICING_JSON:'{"m":{"input":-1}}'}])
    assert.throws(()=>cfg(env),(e:unknown)=>e instanceof ConfigError&&!e.message.includes(KEY),JSON.stringify(env));
  // Unknown model without pricing fails closed; with pricing it is accepted.
  assert.throws(()=>cfg({OPENAI_ADVANCED_MODEL:'gpt-mystery'}),/no pricing entry/);
  const priced=cfg({OPENAI_LIGHT_MODEL:'gpt-new',OPENAI_LIGHT_EFFORT:'medium',OPENAI_PRICING_JSON:JSON.stringify({'gpt-new':{input:1,cachedInput:0.1,output:2,efforts:['medium']}})});
  assert.equal(priced.lightModel,'gpt-new');
  assert.ok(!JSON.stringify(describeOpenAIConfig(cfg())).includes(KEY));
});

// ---- 7 ----------------------------------------------------------------------

test('7 model-not-found 404: ProviderError model_not_found, no retry, nothing sensitive in message or logs',async()=>{
  const t=runtimeFor({},()=>{throw err.notFound();});
  try{
    const {error,logs}=await capture(()=>t.runtime.complete(request(),signal()));
    assert.ok(error instanceof ProviderError);
    assert.deepEqual([error.kind,error.status,error.code,error.retryable,error.fallbackAllowed],['model_not_found',404,'model_not_found',false,false]);
    assert.equal(t.calls.length,1);
    assert.deepEqual(t.backoffs,[]);
    for(const banned of [KEY,'http','platform.openai','api.openai','gpt-6','404','does not exist'])
      assert.ok(!error.message.includes(banned),`message leaks ${banned}: ${error.message}`);
    const logged=JSON.stringify(logs);
    assert.ok(!logged.includes(KEY)&&!logged.includes('https://'),logged);
    const row=usageRows(t.store)[0];
    assert.deepEqual([row.status,row.error,row.cost_micros],['error','model_not_found',0]);
  }finally{t.store.close();}

  const h=harness({},()=>{throw err.notFound();});
  try{
    const {error}=await capture(()=>h.run('what is 2+3'));
    assert.ok(error instanceof ProviderError&&error.kind==='model_not_found');
    assert.equal(h.calls.length,1);
    assert.equal(h.ext.count,0);
  }finally{h.store.close();}
});

// ---- 8 ----------------------------------------------------------------------

test('8 rate limits & temporary failures: 429/503 retried up to maxRetries; insufficient_quota and auth are not retried',async()=>{
  const cases:[Record<string,string>,()=>unknown,string,number][]=[
    [{},err.rate,'rate_limit',3],
    [{},err.unavailable,'transient',3],
    [{},()=>({status:503}),'transient',3],
    [{OPENAI_MAX_RETRIES:'1'},err.unavailable,'transient',2],
    [{OPENAI_MAX_RETRIES:'0'},err.rate,'rate_limit',1],
    [{},err.quota,'quota',1],
    [{},err.auth,'auth',1],
  ];
  for(const [env,make,kind,attempts] of cases){
    const t=runtimeFor(env,()=>{throw make();});
    try{
      const {error,logs}=await capture(()=>t.runtime.complete(request(),signal()));
      assert.ok(error instanceof ProviderError&&error.kind===kind,`${kind}: got ${(error as ProviderError)?.kind}`);
      assert.equal(t.calls.length,attempts,kind);
      assert.deepEqual(t.backoffs,[...Array(attempts-1).keys()],kind);
      // HTTP error responses release their reservation.
      assert.ok(usageRows(t.store).every(r=>r.cost_micros===0&&r.status==='error'));
      assert.ok(!JSON.stringify(logs).includes(KEY));
      assert.ok(!error.message.includes(KEY));
      assert.equal(t.runtime.semaphore.inUse,0);
    }finally{t.store.close();}
  }
  const t=runtimeFor({},(_p,n)=>{if(n===1)throw err.unavailable();return text('5');});
  try{
    const {value}=await capture(()=>t.runtime.complete(request(),signal()));
    assert.equal(parseModelResponse(value).content,'5');
    assert.equal(t.calls.length,2);
  }finally{t.store.close();}
});

// ---- 9 ----------------------------------------------------------------------

test('9 fallback: transient OpenAI failure falls back to external; auth/quota/budget/404 do not; completed tools are replayed, not re-run',async()=>{
  const answer=(content:string)=>async()=>Response.json({choices:[{message:{role:'assistant',content}}]});
  let h=harness({OPENAI_FALLBACK:'external'},()=>{throw err.unavailable();},{complete:answer('external says 5')});
  try{
    const {value,error}=await capture(()=>h.run('what is 2+3'));
    assert.equal(error,undefined);
    assert.equal(value!.answer,'external says 5');
    assert.equal(h.calls.length,3);
    assert.equal(h.ext.count,1);
    assert.equal(h.ext.urls[0],'https://model.example/v1/chat/completions');
    assert.equal(h.ext.bodies[0].model,'external-fixture');
    assert.equal((h.ext.inits[0]!.headers as Record<string,string>).Authorization,'Bearer external-test-key');
    assert.ok(!JSON.stringify(h.ext.bodies[0]).includes(KEY));
  }finally{h.store.close();}

  // Fallback disabled: the transient error surfaces.
  h=harness({},()=>{throw err.unavailable();},{complete:answer('nope')});
  try{
    const {error}=await capture(()=>h.run('what is 2+3'));
    assert.ok(error instanceof ProviderError&&error.kind==='transient');
    assert.equal(h.ext.count,0);
  }finally{h.store.close();}

  for(const [env,make,check] of [
    [{},err.auth,isProvider('auth')],
    [{},err.quota,isProvider('quota')],
    [{},err.notFound,isProvider('model_not_found')],
    [{OPENAI_DAILY_BUDGET_USD:'0'},()=>text('unreachable'),(e:unknown)=>e instanceof BudgetError],
  ] as [Record<string,string>,()=>unknown,(e:unknown)=>boolean][]){
    const budget='OPENAI_DAILY_BUDGET_USD' in env;
    h=harness({OPENAI_FALLBACK:'external',...env},()=>{const value=make();if(budget)return value;throw value;},{complete:answer('should not be used')});
    try{
      const {error}=await capture(()=>h.run('what is 2+3'));
      assert.ok(check(error),`unexpected ${String(error)}`);
      assert.equal(h.ext.count,0);
      assert.equal(h.calls.length,budget?0:1);
    }finally{h.store.close();}
  }

  // A tool round already ran on OpenAI; fallback replays its result and never re-executes it.
  let extN=0;
  h=harness({OPENAI_FALLBACK:'external'},(_p,n)=>{if(n===1)return fnCall('call_1');throw err.unavailable();},{complete:async()=>{
    if(++extN===1)return Response.json({choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,
      tool_calls:[{id:'ext_1',type:'function',function:{name:'calculate',arguments:'{"expression":"2+3"}'}}]}}]});
    return Response.json({choices:[{message:{role:'assistant',content:'it is 5'}}]});
  }});
  try{
    const {value,error}=await capture(()=>h.run('what is 2+3'));
    assert.equal(error,undefined);
    assert.equal(value!.answer,'it is 5');
    assert.equal(h.math.count,1);
    assert.equal(h.calls.length,4);
    assert.equal(h.ext.count,2);
    const first=h.ext.bodies[0].messages as any[];
    assert.ok(first.every(m=>!('provider_items' in m)),'opaque OpenAI state is not sent to the external provider');
    assert.ok(first.some(m=>m.role==='assistant'&&m.tool_calls?.[0]?.id==='call_1'));
    assert.deepEqual(first.find(m=>m.role==='tool'),{role:'tool',tool_call_id:'call_1',content:'{"answer":"5"}'});
    const second=h.ext.bodies[1].messages as any[];
    assert.deepEqual(second.filter(m=>m.role==='tool').map(m=>[m.tool_call_id,m.content]),[['call_1','{"answer":"5"}'],['ext_1','{"answer":"5"}']]);
  }finally{h.store.close();}
});

// ---- 10 ---------------------------------------------------------------------

test('10 timeout & cancellation: timeouts are retryable; aborting a pending call rejects promptly without retry and keeps worst-case cost',async()=>{
  assert.equal(classifyOpenAIError(new OpenAI.APIConnectionTimeoutError()).kind,'timeout');
  assert.equal(classifyOpenAIError({name:'APIConnectionTimeoutError'}).kind,'timeout');
  assert.equal(classifyOpenAIError(new OpenAI.APIConnectionTimeoutError()).retryable,true);
  assert.equal(classifyOpenAIError(new OpenAI.APIUserAbortError()).kind,'cancelled');
  assert.equal(classifyOpenAIError({name:'APIUserAbortError'}).kind,'cancelled');

  let t=runtimeFor({},()=>{throw new OpenAI.APIConnectionTimeoutError();});
  try{
    const {error}=await capture(()=>t.runtime.complete(request(),signal()));
    assert.ok(isProvider('timeout')(error));
    assert.equal(t.calls.length,3);
    const worst=worstFor(t.config,request());
    assert.ok(worst>0);
    // A timed-out request may have been billed: keep the worst case.
    assert.ok(usageRows(t.store).every(r=>r.status==='error'&&r.error==='timeout'&&r.cost_micros===worst));
  }finally{t.store.close();}

  const controller=new AbortController();
  t=runtimeFor({},(_p,_n,options)=>new Promise((_resolve,reject)=>{
    options.signal.addEventListener('abort',()=>reject(new OpenAI.APIUserAbortError()),{once:true});
    setTimeout(()=>controller.abort(),5);
  }));
  try{
    const started=Date.now();
    const {error}=await capture(()=>t.runtime.complete(request(),controller.signal));
    assert.ok(error instanceof Error&&error.name==='AbortError',`got ${String(error)}`);
    assert.ok(Date.now()-started<1000);
    assert.equal(t.calls.length,1);
    assert.deepEqual(t.backoffs,[]);
    const rows=usageRows(t.store);
    assert.equal(rows.length,1);
    assert.deepEqual([rows[0].status,rows[0].error],['error','cancelled']);
    assert.equal(rows[0].cost_micros,worstFor(t.config,request()));
    assert.ok(rows[0].cost_micros>0);
    assert.equal(t.runtime.semaphore.inUse,0);
  }finally{t.store.close();}

  // Already aborted: nothing is reserved or sent.
  t=runtimeFor({},()=>text('5'));
  try{
    const aborted=new AbortController();aborted.abort();
    await assert.rejects(t.runtime.complete(request(),aborted.signal));
    assert.equal(t.calls.length,0);
    assert.equal(usageRows(t.store).length,0);
  }finally{t.store.close();}
});

// ---- 11 ---------------------------------------------------------------------

test('11 discord formatting: LaTeX delimiters become code, dollar amounts stay; OpenAI runner output is formatted',async()=>{
  assert.equal(formatForDiscord('so \\[x^2+1\\] done'),'so \n```\nx^2+1\n```\n done');
  assert.equal(formatForDiscord('see $$a+b$$ ok'),'see \n```\na+b\n```\n ok');
  assert.equal(formatForDiscord('let \\( x=1 \\) hold'),'let `x=1` hold');
  assert.equal(formatForDiscord('it costs $5 and $10'),'it costs $5 and $10');
  assert.ok(!/\n{3,}/.test(formatForDiscord('a\n\n\\[x\\]\n\nb')));

  const h=harness({},()=>text('so \\(x=5\\) and it costs $5 and $10\n\\[x^2\\]'));
  try{
    const result=await h.run('what is 2+3');
    assert.equal(result.answer,'so `x=5` and it costs $5 and $10\n\n```\nx^2\n```');
  }finally{h.store.close();}
});

// ---- 12 ---------------------------------------------------------------------

test('12 token accounting: reasoning counted once, cached rate, long-context multipliers; ledger summary without prompt text',async()=>{
  const luna=DEFAULT_MODELS['gpt-6-luna']!,sol=DEFAULT_MODELS['gpt-6.1-sol']!;
  const near=(actual:number,expected:number)=>assert.ok(Math.abs(actual-expected)<=1,`${actual} vs ${expected}`);
  // Reasoning tokens are a subset of output tokens.
  const withReasoning=costMicros(luna,{inputTokens:1000,cachedTokens:0,outputTokens:2000,reasoningTokens:1500});
  assert.equal(withReasoning,costMicros(luna,{inputTokens:1000,cachedTokens:0,outputTokens:2000,reasoningTokens:0}));
  near(withReasoning,1100);
  // Cached tokens are priced at the cached rate and never exceed input.
  near(costMicros(sol,{inputTokens:100_000,cachedTokens:40_000,outputTokens:0,reasoningTokens:0}),124_000);
  near(costMicros(sol,{inputTokens:100_000,cachedTokens:200_000,outputTokens:0,reasoningTokens:0}),10_000);
  // Long context: 2x input and cache, 1.5x output, strictly above the threshold.
  near(costMicros(sol,{inputTokens:LONG_CONTEXT_TOKENS,cachedTokens:0,outputTokens:0,reasoningTokens:0}),544_000);
  near(costMicros(sol,{inputTokens:LONG_CONTEXT_TOKENS+1,cachedTokens:0,outputTokens:0,reasoningTokens:0}),1_088_004);
  near(costMicros(sol,{inputTokens:300_000,cachedTokens:100_000,outputTokens:10_000,reasoningTokens:9_000}),970_000);

  const secret='SECRET_PROMPT_TEXT_42';
  const t=runtimeFor({},(p)=>p.model==='gpt-6-luna'?text('SECRET_ANSWER',usage(1000,3000,2500,200)):text('SECRET_ANSWER',usage(500,800,700,0)));
  try{
    const messages=[{role:'user',content:secret}];
    await t.runtime.complete(request({messages}),signal());
    await t.runtime.complete(request({messages,model:'gpt-6.1-sol',effort:'high',tier:'advanced',maxOutputTokens:16000}),signal());
    const s=t.runtime.ledger.summary();
    const luna1=s.models.find(m=>m.model==='gpt-6-luna')!,sol1=s.models.find(m=>m.model==='gpt-6.1-sol')!;
    assert.deepEqual([luna1.calls,luna1.inputTokens,luna1.cachedTokens,luna1.outputTokens,luna1.reasoningTokens,luna1.uncertain],[1,1000,200,3000,2500,0]);
    assert.deepEqual([sol1.calls,sol1.reasoningTokens,sol1.outputTokens],[1,700,800]);
    assert.equal(s.estimated,true);
    near(s.todayUsd*1e6,costMicros(luna,{inputTokens:1000,cachedTokens:200,outputTokens:3000,reasoningTokens:2500})+costMicros(sol,{inputTokens:500,cachedTokens:0,outputTokens:800,reasoningTokens:700}));
    assert.match(formatUsageSummary(s),/reasoning 2500/);

    const columns=(table:string)=>(t.store.db.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).map(c=>c.name);
    assert.deepEqual(columns('openai_usage'),['id','job','user','day','created','model','effort','tier','status','input_tokens','cached_tokens',
      'output_tokens','reasoning_tokens','cost_micros','latency_ms','error']);
    assert.deepEqual(columns('openai_jobs'),['job','guild','user','tier','requested','created']);
    const dump=JSON.stringify([usageRows(t.store),t.store.db.prepare('SELECT * FROM openai_jobs').all(),s]);
    assert.ok(!dump.includes(secret)&&!dump.includes('SECRET_ANSWER'));
  }finally{t.store.close();}
});

// ---- 13 ---------------------------------------------------------------------

test('13 spending ceilings & quotas: budgets refuse before any call; hourly/advanced/max quotas; idempotent admission; unknown usage keeps worst case',async()=>{
  // Daily budget already zero: refused before client.create.
  let t=runtimeFor({OPENAI_DAILY_BUDGET_USD:'0'},()=>text('5'));
  try{
    await assert.rejects(t.runtime.complete(request(),signal()),(e:unknown)=>e instanceof BudgetError&&/today's ai budget/.test(e.message));
    assert.equal(t.calls.length,0);
    assert.equal(t.runtime.semaphore.inUse,0);
  }finally{t.store.close();}

  // Daily budget exhausted by earlier spend.
  t=runtimeFor({OPENAI_DAILY_BUDGET_USD:'0.01'},()=>text('5',usage(100,19_500,0)));
  try{
    await t.runtime.complete(request(),signal());
    await assert.rejects(t.runtime.complete(request(),signal()),BudgetError);
    assert.equal(t.calls.length,1);
  }finally{t.store.close();}

  // Total budget persists across days.
  let now=Date.UTC(2026,10,16,12);
  t=runtimeFor({OPENAI_DAILY_BUDGET_USD:'10',OPENAI_TOTAL_BUDGET_USD:'0.01'},()=>text('5',usage(100,19_500,0)),()=>now);
  try{
    await t.runtime.complete(request(),signal());
    now+=2*86_400_000;
    await assert.rejects(t.runtime.complete(request(),signal()),(e:unknown)=>e instanceof BudgetError&&/moderator needs to raise/.test(e.message));
    assert.equal(t.calls.length,1);
  }finally{t.store.close();}

  const store=new Store(':memory:');
  try{
    now=Date.UTC(2026,10,16,12);
    const ledger=new UsageLedger(store.db,cfg({OPENAI_USER_REQUESTS_PER_HOUR:'2',OPENAI_USER_ADVANCED_PER_DAY:'1'}),()=>now);
    const admit=(job:string,tier:'light'|'advanced'|'max',explicit=false,user=USER)=>ledger.admitJob({job,guild:GUILD,user,tier,explicit});
    // Hourly limit.
    assert.deepEqual(admit('h1','light'),{tier:'light',downgraded:false});
    assert.deepEqual(admit('h1','light'),{tier:'light',downgraded:false},'same job id is idempotent');
    assert.deepEqual(admit('h2','advanced'),{tier:'advanced',downgraded:false});
    assert.deepEqual(admit('h2','light'),{tier:'advanced',downgraded:false},'resumed job keeps its tier');
    assert.throws(()=>admit('h3','light'),(e:unknown)=>e instanceof BudgetError&&/hourly/.test(e.message));
    assert.equal(ledger.tierForJob('h3'),undefined);
    assert.deepEqual(admit('other','light',false,'999999999999999999'),{tier:'light',downgraded:false});
    // Advanced quota (1/day, already used by h2): automatic work is downgraded, explicit work is refused.
    now+=3_600_001;
    assert.deepEqual(admit('a1','advanced'),{tier:'light',downgraded:true});
    assert.equal(ledger.tierForJob('a1'),'light');
    assert.throws(()=>admit('a2','advanced',true),(e:unknown)=>e instanceof BudgetError&&/deep-reasoning quota/.test(e.message));
    assert.equal((store.db.prepare("SELECT count(*) AS n FROM openai_jobs WHERE job='h1'").get() as {n:number}).n,1);
    // !max: one per day.
    const user2='888888888888888888';
    const maxLedger=new UsageLedger(store.db,cfg(),()=>now);
    assert.deepEqual(maxLedger.admitJob({job:'m1',guild:GUILD,user:user2,tier:'max',explicit:true}),{tier:'max',downgraded:false});
    assert.throws(()=>maxLedger.admitJob({job:'m2',guild:GUILD,user:user2,tier:'max',explicit:true}),/!max/);

    // Settlement without usage: worst case stays unless the response was an unbilled HTTP error.
    const r1=ledger.reserve({job:'s',user:USER,model:'gpt-6-luna',effort:'medium',tier:'light',inputTokens:100,maxOutputTokens:4000});
    const r2=ledger.reserve({job:'s',user:USER,model:'gpt-6-luna',effort:'medium',tier:'light',inputTokens:100,maxOutputTokens:4000});
    ledger.settle(r1.id,{status:'error',latencyMs:1});
    ledger.settle(r2.id,{status:'error',latencyMs:1,billed:false});
    const cost=(id:number)=>(store.db.prepare('SELECT cost_micros AS c FROM openai_usage WHERE id=?').get(id) as {c:number}).c;
    assert.ok(r1.worst>0);
    assert.equal(cost(r1.id),r1.worst);
    assert.equal(cost(r2.id),0);
  }finally{store.close();}

  // A response with no usage keeps the reserved worst case and is flagged as uncertain.
  t=runtimeFor({},()=>text('5',null));
  try{
    await t.runtime.complete(request(),signal());
    const row=usageRows(t.store)[0];
    assert.equal(row.status,'unmetered');
    assert.equal(row.cost_micros,worstFor(t.config,request()));
    assert.ok(row.cost_micros>0);
    assert.equal(t.runtime.ledger.summary().models[0]!.uncertain,1);
  }finally{t.store.close();}

  // Runner: automatic advanced work over quota is downgraded with a note; explicit !deep is refused before any call.
  const h=harness({OPENAI_USER_ADVANCED_PER_DAY:'0'});
  try{
    const result=await h.run('prove that sqrt 2 is irrational');
    assert.equal(h.calls[0].model,'gpt-6-luna');
    assert.match(result.answer,/deep-reasoning quota for today is used up\.$/);
    await assert.rejects(h.run('!deep prove that sqrt 2 is irrational'),BudgetError);
    assert.equal(h.calls.length,1);
  }finally{h.store.close();}
  const broke=harness({OPENAI_DAILY_BUDGET_USD:'0'});
  try{
    await assert.rejects(broke.run('what is 2+3'),BudgetError);
    assert.equal(broke.calls.length,0);
  }finally{broke.store.close();}
});

// ---- 14 ---------------------------------------------------------------------

test('14 concurrency: second call waits for the first; an aborted waiter is removed from the queue',async()=>{
  const sem=new Semaphore(1);
  await sem.acquire(signal());
  const waiter=new AbortController();
  const pending=sem.acquire(waiter.signal);
  waiter.abort();
  await assert.rejects(pending);
  sem.release();
  assert.equal(sem.inUse,0,'aborted waiter must not be woken');
  await sem.acquire(signal());
  assert.equal(sem.inUse,1);
  sem.release();

  const gates:(()=>void)[]=[];
  const t=runtimeFor({OPENAI_CONCURRENCY:'1'},(p)=>new Promise(resolve=>{gates.push(()=>resolve(text(`done ${userTexts(p).at(-1)}`)));}));
  try{
    const msg=(content:string)=>request({messages:[{role:'user',content}]});
    const a=t.runtime.complete(msg('a'),signal());
    const b=t.runtime.complete(msg('b'),signal());
    await tick();
    assert.equal(t.calls.length,1);
    assert.equal(t.runtime.semaphore.inUse,1);
    gates[0]!();
    assert.equal(parseModelResponse(await a).content,'done a');
    await tick();
    assert.equal(t.calls.length,2);
    gates[1]!();
    assert.equal(parseModelResponse(await b).content,'done b');
    assert.equal(t.runtime.semaphore.inUse,0);

    const c=t.runtime.complete(msg('c'),signal());
    const abortD=new AbortController();
    const d=t.runtime.complete(msg('d'),abortD.signal);
    const e=t.runtime.complete(msg('e'),signal());
    await tick();
    abortD.abort();
    await assert.rejects(d);
    gates[2]!();await c;
    await tick();
    assert.deepEqual(t.calls.map(p=>userTexts(p).at(-1)),['a','b','c','e']);
    gates[3]!();await e;
    assert.equal(t.runtime.semaphore.inUse,0);
  }finally{t.store.close();}
});

// ---- 15 ---------------------------------------------------------------------

test('15 duplicate tool prevention: repeated call id or identical arguments run calculate only once',async()=>{
  const h=harness({},(_p,n)=>n===1?fnCall('call_1'):n===2?fnCall('call_1'):n===3?fnCall('call_2'):text('still 5'));
  try{
    const result=await h.run('what is 2+3');
    assert.equal(result.answer,'still 5');
    assert.equal(h.math.count,1);
    assert.equal(h.calls.length,4);
    const outputs=(h.calls[3].input as any[]).filter(i=>i.type==='function_call_output').map(i=>[i.call_id,i.output]);
    assert.deepEqual(outputs,[['call_1','{"answer":"5"}'],['call_1','{"answer":"5"}'],['call_2','{"answer":"5"}']]);
  }finally{h.store.close();}
});

// ---- 16 ---------------------------------------------------------------------

test('16 groq/legacy preservation: without config.openai the runner posts to /chat/completions and leaves directives alone',async()=>{
  const mock=mockClient(()=>text('should not be called'));
  for(const [config,prompt,expectedURL] of [
    [base,'!deep what is 2+3','http://localhost:9999/v1/chat/completions'],
    [{...base,cognitiveRouting:true},'prove this identity','https://model.example/v1/chat/completions'],
  ] as [ServiceConfig,string,string][]){
    const store=new Store(':memory:');
    try{
      const runtime=new OpenAIRuntime(cfg(),store.db,mock.client,{backoffMs:()=>0});
      const job=store.admit({id:'j',guild:GUILD,channel:CHANNEL,user:USER,coach:false,kind:'ask',prompt},10);
      const urls:string[]=[];const bodies:any[]=[];
      const result=await runner(config,store,{route,mathTool:async()=>({answer:'5'}),openai:runtime,complete:async(url,init)=>{
        urls.push(url);bodies.push(JSON.parse(String(init.body)));
        return Response.json({choices:[{message:{content:JSON.stringify({answer:'\\(x\\) costs $5'})}}]});
      }})(job,signal(),()=>{});
      assert.deepEqual(urls,[expectedURL]);
      assert.equal(bodies[0].messages.at(-1).content,prompt,'prompt passed unchanged');
      assert.equal(bodies[0].temperature,0.2);
      assert.ok(!('reasoning' in bodies[0])&&!('store' in bodies[0]));
      assert.equal(result.answer,'\\(x\\) costs $5','legacy answers are not reformatted');
      assert.equal(mock.calls.length,0);
    }finally{store.close();}
  }
});
