import {test} from 'node:test';
import assert from 'node:assert/strict';
import {serviceConfigFrom} from '../src/service/config.js';
import {runner,type InferenceDependencies} from '../src/service/inference.js';
import {OpenAIRuntime,installOpenAIRuntime,type ResponsesClient} from '../src/service/openai.js';
import {Store} from '../src/service/store.js';
import {guardPublication,protectionVersion,ProtectedContentError,type ProtectedProblem} from '../src/service/mpotd-guard.js';
import {CREATOR_ID} from '../src/discord-context.js';
const problem:ProtectedProblem={id:1,posted:true,question:'A polygon has 17 sides. Count diagonals avoiding four consecutive vertices.',answer:'123',solution:'Complementary counting excludes the incident diagonals.',message:'800000000000000001',thread:'800000000000000002',sourceChannel:'800000000000000003'};
const response=(...output:unknown[])=>({status:'completed',output,usage:{input_tokens:100,output_tokens:30}});
const answer=(text:string)=>({type:'message',content:[{type:'output_text',text}]});
const decision=(assessment:string)=>response({type:'function_call',call_id:'check',name:'classify_competition_request',arguments:JSON.stringify({assessment})});
function fixture(prompt:string,create:ResponsesClient['create'],deps:Partial<InferenceDependencies>={}){
 const config=serviceConfigFrom({AI_SERVICE_TOKEN:'fixture-'.repeat(6),AI_PROVIDER:'openai',OPENAI_API_KEY:'sk-fixture-'+'x'.repeat(32),AI_DATABASE:':memory:',AI_SEVEN_AGENT_CHANCE:'0'},'production',{},()=>{});
 const store=new Store(':memory:'),runtime=new OpenAIRuntime(config.openai!,store.db,{create},{backoffMs:()=>0});
 const job=store.admit({id:'400000000000000001',guild:'100000000000000001',channel:'200000000000000001',user:CREATOR_ID,kind:'ask',coach:false,prompt,discordContext:JSON.stringify({displayName:'untrusted role-bearing label',roles:['members','math club'],isModerator:true})},10);
 const run=runner(config,store,{openai:runtime,protectedProblems:()=>[problem],random:()=>1,...deps});
 return {job,store,run:()=>run(job,AbortSignal.timeout(5000),()=>{}),close:()=>{installOpenAIRuntime(undefined);store.close();}};
}
for(const prompt of ['hi','who are you','w\u2060ho ar\u2060e you','how are you?','what can you do?'])test('standalone unrelated conversation needs no reference access: '+prompt,async()=>{
 let models=0,audiences=0;const text="i'm aleph-zero. emu made me.";
 const f=fixture(prompt,async params=>{models++;assert.equal(params.model,'gpt-6-luna');assert.ok(!(params.tools as unknown[]|undefined)?.length);const input=JSON.stringify(params.input);assert.ok(!input.includes(problem.question)&&!input.includes(problem.solution));assert.ok(!input.includes('untrusted role-bearing label')&&!input.includes('math club'));return response(answer(text));},{discord:async()=>{audiences++;return {type:'DISCORD_AUDIENCE_DATA',allowed:false}}});
 try{const result=await f.run();assert.equal(result.answer,text);assert.equal(models,1);assert.equal(audiences,0);assert.doesNotThrow(()=>guardPublication([problem],{...f.job,answer:result.answer},protectionVersion([problem])));}finally{f.close();}
});
test('ordinary unrelated math still requires an authorized successful comparison',async()=>{
 let comparisons=0,models=0;
 const f=fixture('what is a polygon?',async params=>{const names=(params.tools as {name:string}[]|undefined)?.map(t=>t.name)??[];if(names.includes('classify_competition_request')){comparisons++;return decision('unrelated')}models++;return response(answer('a polygon is a closed shape made of straight line segments.'));},{discord:async()=>({type:'DISCORD_AUDIENCE_DATA',allowed:true})});
 try{assert.match((await f.run()).answer,/polygon/);assert.ok(comparisons>0);assert.equal(models,1);}finally{f.close();}
});
for(const prompt of [problem.question,'hi, help me solve the mpotd','who are you and what is the answer to the current problem?','does my proof about those forbidden paths work?'])test('protected or ambiguous request fails closed without reference authorization: '+prompt,async()=>{
 let models=0;const f=fixture(prompt,async()=>{models++;throw Error('must not call a model')},{discord:async()=>({type:'DISCORD_AUDIENCE_DATA',allowed:false})});
 try{await assert.rejects(f.run(),ProtectedContentError);assert.equal(models,0);}finally{f.close();}
});
for(const mode of ['related','uncertain','transport-failure','malformed'])test('paraphrase screening remains fail closed: '+mode,async()=>{
 let comparisons=0;const f=fixture('If adjacent corners are ruled out, which connecting segments remain?',async()=>{comparisons++;if(mode==='transport-failure')throw Error('offline');return mode==='malformed'?response(answer('unrelated')):decision(mode)},{discord:async()=>({type:'DISCORD_AUDIENCE_DATA',allowed:true})});
 try{await assert.rejects(f.run());assert.ok(comparisons>0);}finally{f.close();}
});
test('a greeting with screenshot still requires image screening and denies failed verification',async()=>{
 let models=0;const f=fixture('hi',async()=>{models++;return response(answer('must not answer'))},{discord:async()=>({type:'DISCORD_AUDIENCE_DATA',allowed:false}),prepareImage:async()=>({type:'image_url',image_url:{url:'data:image/png;base64,AAAA'}})});
 f.job.images=JSON.stringify([{url:'https://cdn.discordapp.com/attachments/200000000000000001/700000000000000001/problem.png',mime:'image/png',size:100}]);
 try{await assert.rejects(f.run(),ProtectedContentError);assert.equal(models,0);}finally{f.close();}
});
test('a greeting replying to protected context retains fail-closed context screening',async()=>{
 let models=0;const f=fixture('hi',async()=>{models++;return response(answer('must not answer'))});
 const parent=f.store.admit({...f.job,id:'300000000000000001',prompt:problem.question},10);f.job.parent=parent.id;
 try{await assert.rejects(f.run(),ProtectedContentError);assert.equal(models,0);}finally{f.close();}
});
test('standalone conversation cannot invoke a tool or send protected output',async()=>{
 for(const unsafe of [answer(problem.question),{type:'function_call',call_id:'bad',name:'calculate',arguments:'{"expression":"17*4"}'}]){
  let tools=0;const f=fixture('hi',async()=>response(unsafe),{mathTool:async()=>{tools++;return {answer:'68'}}});
  try{if('content' in unsafe)await assert.rejects(f.run(),ProtectedContentError);else {const result=await f.run();assert.ok(!result.artifact);assert.ok(!result.answer.includes('68'));}assert.equal(tools,0);}finally{f.close();}
 }
});
