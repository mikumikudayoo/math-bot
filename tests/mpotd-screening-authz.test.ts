import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChannelType,Collection,PermissionFlagsBits,type Client} from 'discord.js';
import {serviceConfigFrom} from '../src/service/config.js';
import {runner,type InferenceDependencies,type ScreeningEvent} from '../src/service/inference.js';
import {OpenAIRuntime,installOpenAIRuntime,ProviderError,type ResponsesClient} from '../src/service/openai.js';
import {ProviderBackoff} from '../src/service/providers.js';
import {BudgetError} from '../src/service/openai-budget.js';
import {Store} from '../src/service/store.js';
import {DiscordBroker,DiscordBrokerError} from '../src/service/discord-broker.js';
import {QotdStore} from '../src/qotd/store.js';
import {guardPublication,guardSemanticRequest,loadProtectedProblems,protectionVersion,ProtectedContentError,ScreeningFailure,
  screeningFailureFrom,refusalText,unavailableText,confirmedRefusals,type ProtectedProblem} from '../src/service/mpotd-guard.js';
import {executeDiscordTool,canDisclose} from '../src/discord-tools.js';
import type {DiscordTask,DiscordTool} from '../src/discord-context.js';
import type {Job} from '../src/service/types.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------
const GUILD='100000000000000001',AI_TEST='200000000000000001',MPOTD='800000000000000003',POST='800000000000000001';
const USER='700000000000000001',OTHER='700000000000000002';
const problem:ProtectedProblem={id:66,posted:true,official:true,sourceChannel:MPOTD,message:POST,thread:'800000000000000002',
  question:'A polygon has 17 sides. Count diagonals avoiding four consecutive vertices.',answer:'one hundred twenty three',
  solution:'Complementary counting excludes the incident diagonals of the four vertices.'};
const CHESS_EXPLANATION='chess is a two-player board game. each side has sixteen pieces and you win by checkmating the king.';
const CHESS_REPLY="fine, i'll be white. e4. your move.";
const response=(...output:unknown[])=>({status:'completed', service_tier:'default',output,usage:{input_tokens:100,output_tokens:30}});
const text=(value:string)=>({type:'message',content:[{type:'output_text',text:value}]});
const call=(name:string,args:unknown,id='c1')=>({type:'function_call',call_id:id,name,arguments:JSON.stringify(args)});
const verdict=(assessment:string)=>response(call('classify_competition_request',{assessment},'screen'));
const offered=(params:Record<string,unknown>,name:string)=>(params.tools as {name:string}[]|undefined)?.some(t=>t.name===name)??false;
const grant={type:'COMPETITION_REFERENCE_DATA',allowed:true};

interface Harness {store:Store;job:Job;events:ScreeningEvent[];discordCalls:{tool:DiscordTool;args:Record<string,unknown>;job:string;user:string}[];
  run:(signal?:AbortSignal)=>Promise<{answer:string}>;close:()=>void}
/** A completed "explain chess" answer, then the same user's reply-chain follow-up. */
function replyChain(prompt:string,create:ResponsesClient['create'],opts:{discord?:InferenceDependencies['discord'];problems?:()=>ProtectedProblem[];
  user?:string;mathTool?:InferenceDependencies['mathTool'];store?:Store;jobId?:string;parentId?:string;run?:ReturnType<typeof runner>}={}):Harness{
  const config=serviceConfigFrom({AI_SERVICE_TOKEN:'fixture-'.repeat(6),AI_PROVIDER:'openai',OPENAI_API_KEY:'sk-fixture-'+'x'.repeat(32),
    AI_DATABASE:':memory:',AI_SEVEN_AGENT_CHANCE:'0'},'production',{},()=>{});
  const store=opts.store??new Store(':memory:');
  const user=opts.user??USER,parentId=opts.parentId??'400000000000000001',jobId=opts.jobId??'400000000000000002';
  store.admit({id:parentId,guild:GUILD,channel:AI_TEST,user,coach:false,kind:'ask',prompt:'can you explain chess?',discordContext:'{}'},10);
  store.running(parentId);store.complete(parentId,{answer:CHESS_EXPLANATION});
  const job=store.admit({id:jobId,guild:GUILD,channel:AI_TEST,user,coach:false,kind:'ask',prompt,parent:parentId,discordContext:'{}'},10);
  const events:ScreeningEvent[]=[],discordCalls:Harness['discordCalls']=[];
  const discord:InferenceDependencies['discord']=async(j,tool,args,signal)=>{
    discordCalls.push({tool,args,job:j.id,user:j.user});
    return opts.discord?opts.discord(j,tool,args,signal):tool==='competition_reference'?grant:{type:'DISCORD_AUDIENCE_DATA',allowed:false};
  };
  const run=opts.run??runner(config,store,{openai:new OpenAIRuntime(config.openai!,store.db,{create},{backoffMs:()=>0}),
    protectedProblems:opts.problems??(()=>[problem]),random:()=>1,discord,screeningLog:e=>events.push(e),
    ...(opts.mathTool?{mathTool:opts.mathTool}:{})});
  return {store,job,events,discordCalls,run:(signal=AbortSignal.timeout(5000))=>run(job,signal,()=>{}),close:()=>{installOpenAIRuntime(undefined);store.close();}};
}
/** Classifier says `screen` for every screening call; Luna answers with `answer`. */
function model(screen:(input:string)=>unknown,answer:()=>unknown=()=>response(text(CHESS_REPLY))){
  const seen={screens:0,answers:0,screenInputs:[] as string[],answerInputs:[] as string[]};
  const create:ResponsesClient['create']=async params=>{
    const input=JSON.stringify(params.input);
    if(offered(params,'classify_competition_request')){seen.screens++;seen.screenInputs.push(input);return screen(input);}
    seen.answers++;seen.answerInputs.push(input);return answer();
  };
  return {create,seen};
}
const noProtectedText=(value:unknown)=>{
  const json=JSON.stringify(value);
  for(const secret of [problem.question,problem.answer,problem.solution,'explain chess','lets play chess',CHESS_EXPLANATION])assert.ok(!json.includes(secret),'diagnostics leaked content');
};

// ---------------------------------------------------------------------------
// 1. the incident: reply-chain chess while an MPoTD is active in a restricted channel
// ---------------------------------------------------------------------------
test('incident: "lets play chess" in a reply chain continues while a restricted-channel MPoTD is active',async()=>{
  const m=model(()=>verdict('unrelated'));
  // The bot would deny publication of the restricted source into #ai-test (discord_audience),
  // but grants the separate, host-only screening authorization.
  const h=replyChain('lets play chess',m.create,{discord:async(_j,tool)=>tool==='competition_reference'?grant:{type:'DISCORD_AUDIENCE_DATA',allowed:false}});
  try{
    const result=await h.run();
    assert.equal(result.answer,CHESS_REPLY);
    assert.ok(m.seen.screens>=1,'reply chains are still semantically screened');
    assert.equal(m.seen.answers,1);
    // Screening authorization is its own operation, with the authoritative reference record.
    const refs=h.discordCalls.filter(c=>c.tool==='competition_reference');
    assert.ok(refs.length>=1);
    for(const c of refs)assert.deepEqual(c.args,{references:[{channel:MPOTD,message:POST,official:true}]});
    assert.ok(!h.discordCalls.some(c=>c.tool==='discord_audience'),'publication check is not used for internal screening');
    // The isolated comparison receives the posted statement only — never the answer or solution —
    // and the conversational model never receives the reference at all.
    for(const input of m.seen.screenInputs)assert.ok(!input.includes(problem.solution)&&!input.includes(problem.answer));
    // The reply (with its chain) is screened before answering, and the answer is screened before publication.
    assert.ok(m.seen.screenInputs.some(i=>i.includes('lets play chess')&&i.includes('two-player board game')));
    assert.ok(m.seen.screenInputs.some(i=>i.includes("i'll be white")));
    for(const input of m.seen.answerInputs)assert.ok(!input.includes(problem.question)&&!input.includes(problem.solution));
    assert.deepEqual(h.events,[]);
    // The publisher rechecks the stored answer before delivery.
    assert.doesNotThrow(()=>guardPublication([problem],{...h.job,answer:result.answer},protectionVersion([problem])));
  }finally{h.close();}
});

test('the pre-fix coupling is gone: a denied publication audience no longer blocks screening, a denied screening reference still does',async()=>{
  const m=model(()=>verdict('unrelated'));
  const h=replyChain('lets play chess',m.create,{discord:async(_j,tool)=>tool==='competition_reference'
    ?{type:'COMPETITION_REFERENCE_DATA',allowed:false,reason:'source-restricted'}:{type:'DISCORD_AUDIENCE_DATA',allowed:true}});
  try{
    await assert.rejects(h.run(),(e:unknown)=>e instanceof ProtectedContentError&&e.message===unavailableText);
    assert.equal(m.seen.screens,0,'no reference leaves the host without screening authorization');assert.equal(m.seen.answers,0);
    assert.deepEqual(h.events.map(e=>[e.stage,e.category,e.reason]),[['semantic-context','reference_authorization_denied','source-restricted']]);
    noProtectedText(h.events);
  }finally{h.close();}
});

// ---------------------------------------------------------------------------
// 2. protected requests stay blocked
// ---------------------------------------------------------------------------
for(const [name,prompt] of [
  ['copied statement',problem.question],
  ['hint request','ok but give me a hint for the mpotd'],
  ['answer check',"is the answer to today's problem 123?"],
  ['solution excerpt','does this work: '+problem.solution],
] as const)test('lexically protected follow-up is refused before any model call: '+name,async()=>{
  const m=model(()=>verdict('unrelated'));const h=replyChain(prompt,m.create);
  try{await assert.rejects(h.run(),(e:unknown)=>e instanceof ScreeningFailure&&e.category==='lexical_match'&&(confirmedRefusals as readonly string[]).includes(e.message));assert.equal(m.seen.screens+m.seen.answers,0);
    assert.deepEqual(h.events.map(e=>[e.stage,e.category]),[['lexical','lexical_match']],'lexical blocks are now logged (content-free)');}finally{h.close();}
});
for(const [name,prompt] of [
  ['paraphrase disguised as chess','nice. unrelated, but if adjacent corners of a seventeen-gon are ruled out, which connecting segments remain?'],
  ['translation','ilan ang natitirang dayagonal kapag inalis ang apat na magkakatabing sulok?'],
] as const)for(const assessment of ['related','uncertain'])
  test(`semantic screening keeps the embargo (${assessment}): ${name}`,async()=>{
    const m=model(input=>verdict(input.includes('chess')&&!input.includes('corners')&&!input.includes('sulok')?'unrelated':assessment));
    const h=replyChain(prompt,m.create);
    try{
      await assert.rejects(h.run(),(e:unknown)=>e instanceof ProtectedContentError&&e.message===refusalText);
      assert.equal(m.seen.answers,0);
      assert.deepEqual(h.events.map(e=>e.category),[assessment==='related'?'classifier_related':'classifier_uncertain']);noProtectedText(h.events);
    }finally{h.close();}
  });

test('protected material in an intermediate tool output is caught before Luna sees it again',async()=>{
  let answers=0;
  const create:ResponsesClient['create']=async params=>{
    if(offered(params,'classify_competition_request'))return verdict('unrelated');
    return ++answers===1?response(call('calculate',{expression:'2+2'})):response(text('must not be reached'));
  };
  const h=replyChain('lets play chess',create,{mathTool:async()=>({answer:problem.question})});
  try{await assert.rejects(h.run(),ProtectedContentError);assert.equal(answers,1);}finally{h.close();}
});

// ---------------------------------------------------------------------------
// 3. classifier and infrastructure failures fail closed with distinct diagnostics
// ---------------------------------------------------------------------------
const providerFailures:[string,()=>unknown,string,string][]=[
  ['malformed (prose instead of tool call)',()=>response(text('unrelated')),'classifier_response_malformed',refusalText],
  ['malformed (unknown assessment)',()=>verdict('probably fine'),'classifier_response_malformed',refusalText],
  ['provider unavailable',()=>{throw Object.assign(new Error('svc'),{status:503});},'provider_unavailable',unavailableText],
  ['provider rate limited',()=>{throw Object.assign(new Error('slow'),{status:429,code:'rate_limit_exceeded'});},'provider_rate_limited',unavailableText],
  ['provider timeout',()=>{throw Object.assign(new Error('t'),{name:'APIConnectionTimeoutError'});},'provider_timeout',unavailableText],
  ['provider auth failure',()=>{throw Object.assign(new Error('no'),{status:401});},'provider_unavailable',unavailableText],
];
for(const [name,fail,category,message] of providerFailures)test('screening failure stays closed and is categorized: '+name,async()=>{
  const m=model(()=>fail());const h=replyChain('lets play chess',m.create);
  try{
    await assert.rejects(h.run(),(e:unknown)=>e instanceof ProtectedContentError&&e.message===message);
    assert.equal(m.seen.answers,0);
    assert.deepEqual(h.events.map(e=>[e.stage,e.category]),[['semantic-context',category]]);noProtectedText(h.events);
  }finally{h.close();}
});

test('a transient classifier failure is retried with re-authorization and no duplicated answer',async()=>{
  let screens=0;const m=model(()=>++screens===1?(()=>{throw Object.assign(new Error('svc'),{status:503});})():verdict('unrelated'));
  const h=replyChain('lets play chess',m.create);
  try{
    assert.equal((await h.run()).answer,CHESS_REPLY);assert.equal(m.seen.answers,1);
    // Each classifier attempt re-checks the reference (read-only) before data leaves the host.
    assert.ok(h.discordCalls.filter(c=>c.tool==='competition_reference').length>=3);
  }finally{h.close();}
});

for(const [name,discord,category] of [
  ['broker timeout',async()=>{throw new DiscordBrokerError('timed_out');},'discord_broker_timeout'],
  ['broker closed',async()=>{throw new DiscordBrokerError('closed');},'discord_broker_unavailable'],
  ['bot unavailable result',async()=>({error:'Discord information unavailable for this request.'}),'discord_broker_unavailable'],
  ['publication-shaped result is not a screening grant',async()=>({type:'DISCORD_AUDIENCE_DATA',allowed:true}),'discord_broker_unavailable'],
] as [string,InferenceDependencies['discord'],string][])test('reference authorization failures are distinguishable: '+name,async()=>{
  const m=model(()=>verdict('unrelated'));const h=replyChain('lets play chess',m.create,{discord});
  try{
    await assert.rejects(h.run(),(e:unknown)=>e instanceof ProtectedContentError&&e.message===unavailableText);
    assert.equal(m.seen.screens+m.seen.answers,0);
    assert.deepEqual(h.events.map(e=>e.category),[category]);noProtectedText(h.events);
  }finally{h.close();}
});

test('missing or invalid reference images fail closed with asset categories',async()=>{
  const root=mkdtempSync(join(tmpdir(),'aleph-ref-'));
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA60AAAAASUVORK5CYII=','base64');
  const path=join(root,'question.png'),sha256=createHash('sha256').update(png).digest('hex');
  const visual=(images:{path:string;sha256:string}[])=>()=>[{...problem,visualReference:{root,images}}];
  try{
    const cases:[string,()=>ProtectedProblem[],()=>void,string,string?][]=[
      ['missing file',visual([{path,sha256}]),()=>{},'reference_asset_missing','image'],
      ['hash mismatch',visual([{path,sha256}]),()=>writeFileSync(path,Buffer.concat([png,Buffer.from('x')])),'reference_asset_invalid','hash-mismatch'],
      ['malformed hash',visual([{path,sha256:'nothex'}]),()=>writeFileSync(path,png),'reference_asset_invalid','hash-format'],
      ['no approved crop',visual([]),()=>{},'reference_asset_missing','no-crop'],
    ];
    for(const [name,problems,prepare,category,reason] of cases){
      prepare();const m=model(()=>verdict('unrelated'));const h=replyChain('lets play chess',m.create,{problems});
      try{
        await assert.rejects(h.run(),ProtectedContentError,name);assert.equal(m.seen.screens+m.seen.answers,0,name);
        assert.deepEqual(h.events.map(e=>[e.category,e.reason]),[[category,reason]],name);
      }finally{h.close();}
    }
    // The valid crop authorizes and is the only reference material sent to the classifier.
    writeFileSync(path,png);const m=model(()=>verdict('unrelated'));const h=replyChain('lets play chess',m.create,{problems:visual([{path,sha256}])});
    try{assert.equal((await h.run()).answer,CHESS_REPLY);assert.ok(m.seen.screenInputs.every(i=>i.includes(png.toString('base64'))&&!i.includes(problem.question)));}finally{h.close();}
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('unavailable competition state and mid-request changes fail closed with their own categories',async()=>{
  {
    const m=model(()=>verdict('unrelated'));
    const h=replyChain('lets play chess',m.create,{problems:()=>{throw new ScreeningFailure('competition_database_unavailable',unavailableText);}});
    try{await assert.rejects(h.run(),ProtectedContentError);assert.equal(m.seen.screens+m.seen.answers,0);assert.deepEqual(h.events.map(e=>[e.stage,e.category]),[['bank','competition_database_unavailable']]);}finally{h.close();}
  }
  {
    let reads=0;const m=model(()=>verdict('unrelated'));
    const h=replyChain('lets play chess',m.create,{problems:()=>++reads>2?[problem,{...problem,id:67}]:[problem]});
    try{await assert.rejects(h.run(),/competition state changed/);assert.ok(h.events.some(e=>e.category==='reference_version_changed'));}finally{h.close();}
  }
  {
    const m=model(()=>verdict('unrelated'));const h=replyChain('lets play chess',m.create,{problems:()=>[{...problem,posted:false}]});
    try{
      await assert.rejects(h.run(),(e:unknown)=>e instanceof ProtectedContentError&&e.message===refusalText);
      assert.equal(m.seen.screens,0,'unposted problems never leave the host');assert.ok(!h.discordCalls.length);
      assert.deepEqual(h.events.map(e=>e.category),['reference_unpublished']);
    }finally{h.close();}
  }
});

test('no active embargo: no screening authorization or classifier call at all',async()=>{
  const m=model(()=>assert.fail('no screening without a protected problem'));
  const h=replyChain('lets play chess',m.create,{problems:()=>[]});
  try{assert.equal((await h.run()).answer,CHESS_REPLY);assert.equal(h.discordCalls.length,0);assert.equal(m.seen.screens,0);}finally{h.close();}
});

// ---------------------------------------------------------------------------
// 4. isolation, concurrency, cancellation, and no model access to screening privileges
// ---------------------------------------------------------------------------
test('concurrent users keep separate screening state, authorization context and outcomes',async()=>{
  const store=new Store(':memory:');
  const config=serviceConfigFrom({AI_SERVICE_TOKEN:'fixture-'.repeat(6),AI_PROVIDER:'openai',OPENAI_API_KEY:'sk-fixture-'+'x'.repeat(32),AI_DATABASE:':memory:',AI_SEVEN_AGENT_CHANCE:'0'},'production',{},()=>{});
  const inputs=new Map<string,string[]>();const calls:{job:string;user:string;tool:string}[]=[];const events:ScreeningEvent[]=[];
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let waiting=0;
  const create:ResponsesClient['create']=async params=>{
    const input=JSON.stringify(params.input);
    if(offered(params,'classify_competition_request')){
      const who=input.includes('corners')?'B':'A';inputs.set(who,[...(inputs.get(who)??[]),input]);
      if(++waiting===2)release();await gate; // both jobs are screening at the same time
      return verdict(who==='B'?'related':'unrelated');
    }
    return response(text(CHESS_REPLY));
  };
  const run=runner(config,store,{openai:new OpenAIRuntime(config.openai!,store.db,{create},{backoffMs:()=>0}),protectedProblems:()=>[problem],random:()=>1,
    screeningLog:e=>events.push(e),discord:async(j,tool)=>{calls.push({job:j.id,user:j.user,tool});return tool==='competition_reference'?grant:{type:'DISCORD_AUDIENCE_DATA',allowed:false};}});
  const a=replyChain('lets play chess',create,{store,run,user:USER,parentId:'400000000000000011',jobId:'400000000000000012'});
  const b=replyChain('and if adjacent corners of the 17-gon are excluded, which segments remain?',create,{store,run,user:OTHER,parentId:'400000000000000021',jobId:'400000000000000022'});
  try{
    const [ra,rb]=await Promise.allSettled([a.run(),b.run()]);
    assert.equal(ra.status,'fulfilled');assert.equal((ra as PromiseFulfilledResult<{answer:string}>).value.answer,CHESS_REPLY);
    assert.equal(rb.status,'rejected');assert.ok((rb as PromiseRejectedResult).reason instanceof ProtectedContentError);
    for(const input of inputs.get('A')??[])assert.ok(!input.includes('corners'),'A never sees B');
    for(const input of inputs.get('B')??[])assert.ok(!input.includes('lets play chess'),'B never sees A');
    for(const c of calls)assert.equal(c.user,c.job==='400000000000000012'?USER:OTHER);
    assert.deepEqual(events.map(e=>[e.job,e.category]),[['400000000000000022','classifier_related']]);
  }finally{installOpenAIRuntime(undefined);store.close();}
});

test('cancellation stops pending screening authorization without a verdict or model call',async()=>{
  const m=model(()=>verdict('unrelated'));const controller=new AbortController();
  const h=replyChain('lets play chess',m.create,{discord:(_j,_t,_a,signal)=>new Promise((_r,reject)=>{
    signal.addEventListener('abort',()=>reject(new DiscordBrokerError('cancelled')),{once:true});setTimeout(()=>controller.abort(),5);})});
  try{await assert.rejects(h.run(controller.signal));assert.equal(m.seen.screens+m.seen.answers,0);
    assert.ok(!h.events.some(e=>e.category==='reference_authorization_denied'),'cancellation is not a denial');}finally{h.close();}
});

test('models cannot request or reuse screening privileges as a general tool',async()=>{
  let answers=0;const offeredTools=new Set<string>();
  const create:ResponsesClient['create']=async params=>{
    if(offered(params,'classify_competition_request'))return verdict('unrelated');
    for(const t of (params.tools as {name:string}[]|undefined)??[])offeredTools.add(t.name);
    return ++answers===1?response(call('competition_reference',{references:[{channel:'999999999999999999',message:'999999999999999998',official:true}]}))
      :response(text(CHESS_REPLY));
  };
  const h=replyChain('lets play chess',create);
  try{
    await h.run();
    assert.ok(!offeredTools.has('competition_reference')&&!offeredTools.has('discord_audience'));
    assert.ok(!JSON.stringify(h.discordCalls).includes('999999999999999999'),'model arguments never reach the broker');
    for(const c of h.discordCalls.filter(c=>c.tool==='competition_reference'))assert.deepEqual(c.args,{references:[{channel:MPOTD,message:POST,official:true}]});
  }finally{h.close();}
});

// ---------------------------------------------------------------------------
// 5. bot-side authorization: screening is distinct from disclosure
// ---------------------------------------------------------------------------
const BOT='411111111111111111',MOD='511111111111111111',MEMBER_ROLE='611111111111111111';
function discordFixture(){
  const channels=new Collection<string,any>(),members=new Collection<string,any>();
  const everyone={id:GUILD};
  const guild:any={id:GUILD,roles:{everyone,cache:new Collection(),fetch:async()=>{}},members:{fetch:async({user}:any)=>members.get(user),fetchMe:async()=>members.get(BOT)},
    channels:{fetch:async(id?:string)=>id?channels.get(id)??null:channels,fetchActiveThreads:async()=>({threads:new Collection()})}};
  // `viewers` decides who can read; `everyoneCanView` models the @everyone overwrite used by publicSource.
  function channel(id:string,o:{viewers:Set<string>;everyoneCanView:boolean;nsfw?:boolean;type?:ChannelType}){
    const posts=new Collection<string,any>();
    const c:any={id,guildId:GUILD,guild,type:o.type??ChannelType.GuildText,nsfw:o.nsfw??false,posts,
      isThread:()=>false,isTextBased:()=>true,
      permissionsFor:(m:{id:string})=>({has:(bits:bigint|bigint[])=>m.id===GUILD?o.everyoneCanView:o.viewers.has(m.id)}),
      permissionOverwrites:{cache:new Collection(o.everyoneCanView?[]:[[GUILD,{id:GUILD,type:0,allow:{has:()=>false,any:()=>false},deny:{has:(b:bigint)=>b===PermissionFlagsBits.ViewChannel,any:()=>true}}],
        [MEMBER_ROLE,{id:MEMBER_ROLE,type:0,allow:{has:()=>true,any:()=>true},deny:{has:()=>false,any:()=>false}}]])},
      messages:{fetch:async({message}:{message:string})=>{const p=posts.get(message);if(!p)throw new Error('Unknown Message');return p;}}};
    channels.set(id,c);return c;
  }
  for(const id of [USER,BOT,MOD])members.set(id,{id,guild,roles:{cache:new Collection()},permissions:{has:()=>false}});
  const client={guilds:{fetch:async()=>guild}} as unknown as Client;
  return {guild,client,channel};
}
const task=(args:Record<string,unknown>,tool:DiscordTool='competition_reference',user=USER):DiscordTask=>({id:'t',job:'j',user,guild:GUILD,channel:AI_TEST,tool,args});
const ref=(official:boolean,channel=MPOTD,message=POST)=>({references:[{channel,message,official}]});

test('bot: an official role-gated MPoTD channel authorizes screening even when the requester cannot open it',async()=>{
  const f=discordFixture();
  f.channel(AI_TEST,{viewers:new Set([USER,BOT,MOD]),everyoneCanView:false});
  const source=f.channel(MPOTD,{viewers:new Set([BOT,MOD]),everyoneCanView:false});
  source.posts.set(POST,{id:POST,channelId:MPOTD,author:{id:BOT},content:problem.question});
  const result=await executeDiscordTool(f.client,task(ref(true)),false) as Record<string,unknown>;
  assert.deepEqual(result,{type:'COMPETITION_REFERENCE_DATA',allowed:true});
  // Only a decision crosses the boundary: no content, names or counts.
  assert.ok(!JSON.stringify(result).includes(problem.question));
});

test('bot: screening authorization never weakens disclosure — the same restricted source stays unpublishable, even for a moderator',async()=>{
  const f=discordFixture();
  const destination=f.channel(AI_TEST,{viewers:new Set([USER,BOT,MOD]),everyoneCanView:true});
  const source=f.channel(MPOTD,{viewers:new Set([BOT,MOD]),everyoneCanView:false});
  source.posts.set(POST,{id:POST,channelId:MPOTD,author:{id:BOT}});
  assert.equal((await executeDiscordTool(f.client,task(ref(true),'competition_reference',MOD),false) as any).allowed,true);
  const moderator=await f.guild.members.fetch({user:MOD}),bot=await f.guild.members.fetchMe();
  assert.equal(await canDisclose(source,destination,moderator,bot),false);
  assert.deepEqual(await executeDiscordTool(f.client,task({sourceChannels:[MPOTD]},'discord_audience',MOD),false),{type:'DISCORD_AUDIENCE_DATA',allowed:false});
});

test('bot: manual posts in non-official restricted channels, deleted or foreign posts and unsafe channels stay local',async()=>{
  const f=discordFixture();
  f.channel(AI_TEST,{viewers:new Set([USER,BOT]),everyoneCanView:true});
  const restricted=f.channel(MPOTD,{viewers:new Set([BOT]),everyoneCanView:false});
  restricted.posts.set(POST,{id:POST,channelId:MPOTD,author:{id:BOT}});
  const publicChannel=f.channel('800000000000000009',{viewers:new Set([USER,BOT]),everyoneCanView:true});
  publicChannel.posts.set(POST,{id:POST,channelId:'800000000000000009',author:{id:BOT}});
  const foreign=f.channel('800000000000000010',{viewers:new Set([USER,BOT]),everyoneCanView:true});
  foreign.posts.set(POST,{id:POST,channelId:'800000000000000010',author:{id:USER}});
  const nsfw=f.channel('800000000000000011',{viewers:new Set([USER,BOT]),everyoneCanView:true,nsfw:true});
  nsfw.posts.set(POST,{id:POST,channelId:'800000000000000011',author:{id:BOT}});
  const hidden=f.channel('800000000000000012',{viewers:new Set([USER]),everyoneCanView:false});
  hidden.posts.set(POST,{id:POST,channelId:'800000000000000012',author:{id:BOT}});
  const reason=async(args:Record<string,unknown>)=>(await executeDiscordTool(f.client,task(args),false) as {reason?:string;allowed?:boolean});
  assert.deepEqual(await reason(ref(false)),{type:'COMPETITION_REFERENCE_DATA',allowed:false,reason:'source-restricted'});
  assert.equal((await reason(ref(false,'800000000000000009'))).allowed,true);
  assert.equal((await reason(ref(true,MPOTD,'800000000000000099'))).reason,'message-missing');
  assert.equal((await reason(ref(true,'800000000000000010'))).reason,'not-bot-post');
  assert.equal((await reason(ref(true,'800000000000000011'))).reason,'channel-type');
  assert.equal((await reason(ref(true,'800000000000000012'))).reason,'bot-cannot-read');
  assert.equal((await reason(ref(true,'800000000000000013'))).reason,'channel-unavailable');
  for(const bad of [{},{references:[]},{references:[{channel:MPOTD,message:POST}]},{references:[{channel:MPOTD,message:POST,official:true,extra:1}]},
    {...ref(true),sourceChannels:[MPOTD]},{references:[{channel:'x',message:POST,official:true}]}])
    assert.ok((await executeDiscordTool(f.client,task(bad),false) as {error?:string}).error,JSON.stringify(bad));
});

// ---------------------------------------------------------------------------
// 6. units: bank flag, broker telemetry, error mapping
// ---------------------------------------------------------------------------
test('bank marks only the operator-configured schedule channel as official',()=>{
  const dir=mkdtempSync(join(tmpdir(),'aleph-official-')),path=join(dir,'q.sqlite'),bank=new QotdStore(path);
  try{
    const db=bank.db;
    db.prepare('INSERT INTO qotd_questions(id,fingerprint,payload,state,flags,crop) VALUES(?,?,?,?,?,?)').run('q','f',JSON.stringify({text:problem.question}),'approved','[]','{}');
    db.prepare('INSERT INTO qotd_history(id,guild,day,question,channel,state,message,created) VALUES(?,?,?,?,?,?,?,?)').run(1,GUILD,'d1','q',MPOTD,'posted',POST,0);
    db.prepare('INSERT INTO qotd_history(id,guild,day,question,channel,state,message,created) VALUES(?,?,?,?,?,?,?,?)').run(2,GUILD,'d2','q',AI_TEST,'posted','800000000000000020',0);
    assert.deepEqual(loadProtectedProblems(GUILD,path).map(p=>p.official),[false,false],'no schedule: nothing is official');
    db.prepare('INSERT INTO qotd_schedule VALUES(?,?,?,?)').run(GUILD,MPOTD,22,null);
    assert.deepEqual(loadProtectedProblems(GUILD,path).map(p=>[p.id,p.official]),[[1,true],[2,false]]);
    db.prepare('INSERT INTO qotd_schedule VALUES(?,?,?,?)').run('100000000000000099',AI_TEST,22,null);
    assert.deepEqual(loadProtectedProblems(GUILD,path).map(p=>p.official),[true,false],'another guild schedule does not apply');
    assert.throws(()=>loadProtectedProblems(GUILD,join(dir,'absent.sqlite')),(e:unknown)=>e instanceof ScreeningFailure&&e.category==='competition_database_unavailable');
  }finally{bank.close();rmSync(dir,{recursive:true,force:true});}
});

test('broker telemetry reports screening decisions and timeouts without content',async()=>{
  const log:unknown[]=[];const broker=new DiscordBroker(e=>log.push(e));
  const job={id:'j',user:USER,guild:GUILD,channel:AI_TEST} as Job;
  const pending=broker.request(job,'competition_reference',ref(true),AbortSignal.timeout(5000));
  const [t]=broker.take();assert.equal(t?.tool,'competition_reference');
  broker.finish(t!.id,{type:'COMPETITION_REFERENCE_DATA',allowed:false,reason:'source-restricted'});
  assert.deepEqual(await pending,{type:'COMPETITION_REFERENCE_DATA',allowed:false,reason:'source-restricted'});
  const done=log.at(-1) as Record<string,unknown>;assert.equal(done.state,'completed');assert.equal(done.outcome,'denied');assert.equal(done.tool,'competition_reference');
  assert.ok(!JSON.stringify(log).includes(MPOTD)&&!JSON.stringify(log).includes(POST));
  const controller=new AbortController();const cancelled=broker.request(job,'competition_reference',ref(true),controller.signal);controller.abort();
  await assert.rejects(cancelled,(e:unknown)=>e instanceof DiscordBrokerError&&e.state==='cancelled');
});

test('infrastructure errors map to distinct categories and never to a pass',async()=>{
  const map=(e:unknown)=>screeningFailureFrom(e).category;
  assert.equal(map(new ProviderBackoff(0,'openai-rate_limit')),'provider_rate_limited');
  assert.equal(map(new ProviderBackoff(0,'openai-timeout')),'provider_timeout');
  assert.equal(map(new ProviderBackoff(0,'openai-transient')),'provider_unavailable');
  assert.equal(map(new ProviderError('rate_limit',429)),'provider_rate_limited');
  assert.equal(map(new ProviderError('auth',401)),'provider_unavailable');
  assert.equal(map(new BudgetError('limit','daily')),'budget_exhausted');
  assert.equal(map(new DiscordBrokerError('timed_out')),'discord_broker_timeout');
  assert.equal(map(new Error('anything')),'provider_unavailable');
  // A direct guard call without an authorizer, or with a throwing one, fails closed.
  const complete=async()=>assert.fail('no reference may leave the host');
  await assert.rejects(guardSemanticRequest([problem],'lets play chess',complete),(e:unknown)=>e instanceof ScreeningFailure&&e.category==='reference_authorization_denied');
  await assert.rejects(guardSemanticRequest([problem],'lets play chess',complete,async()=>{throw new Error('x');}),(e:unknown)=>e instanceof ScreeningFailure&&e.message===unavailableText);
});
