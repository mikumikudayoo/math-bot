import {test} from 'node:test';
import assert from 'node:assert/strict';
import {serviceConfigFrom} from '../src/service/config.js';
import {JobEvents} from '../src/service/events.js';
import {runner, type InferenceDependencies} from '../src/service/inference.js';
import {OpenAIRuntime, installOpenAIRuntime, type ResponsesClient} from '../src/service/openai.js';
import {Store} from '../src/service/store.js';
import type {ProtectedProblem} from '../src/service/mpotd-guard.js';

const ids = {id:'100000000000000001', guild:'200000000000000002',channel:'300000000000000003',user:'400000000000000004'};
function call(tool: string, args: Record<string,unknown>) {
  return {status:'completed', output:[{type:'function_call',call_id:'c1',name:tool,arguments:JSON.stringify(args)}],
    usage:{input_tokens:110,output_tokens:20}};
}
function exercise(prompt: string, dependencies: Partial<InferenceDependencies>, create: ResponsesClient['create']) {
  const config = serviceConfigFrom({AI_PROVIDER:'openai',OPENAI_API_KEY:'sk-fixture'+'x'.repeat(30),
    AI_SERVICE_TOKEN:'synthetic-service-token-'.repeat(2),AI_SEVEN_AGENT_CHANCE:'0',AI_STREAMING:'false'},'development');
  const store = new Store(':memory:');
  const job = store.admit({...ids,kind:'ask',coach:false,prompt},1);
  const events = new JobEvents(store.db);
  const runtime = new OpenAIRuntime(config.openai!,store.db,{create});
  const run = runner(config,store,{protectedProblems:()=>[],...dependencies,events,openai:runtime});
  return {execute:()=>run(job,AbortSignal.timeout(5000),()=>{}),events,close:()=>{installOpenAIRuntime(undefined);store.close();}};
}

test('revocation after retrieval withholds the club note from the next model attempt',async () => {
  const note = 'the origami club meets on the third saturday';
  let checks = 0;
  const modelInputs: string[] = [];
  const f = exercise('find a message about the club schedule',{
    discord:async (_job,tool) => {
      if(tool === 'discord_audience') {checks++; return {type:'DISCORD_AUDIENCE_DATA',allowed:false};}
      return {type:'DISCORD_SEARCH_DATA', results:[{id:'600000000000000006', channelId:ids.channel,author:{id:ids.user},content:note}]};
    },
  },async p => {
    modelInputs.push(JSON.stringify(p.input));
    return call('discord_search',{query:'origami'});
  });
  try {
    await assert.rejects(f.execute());
    assert.ok(checks>0);
    assert.equal(modelInputs.length,1);
    assert.ok(!modelInputs[0]!.includes(note));
    assert.ok(!f.events.progress(ids.id)?.stream);
  } finally { f.close(); }
});

test('an embargo introduced during a model call stops the next computation',async () => {
  let bank: ProtectedProblem[] = [];
  let mathCalls = 0, modelCalls = 0;
  const f = exercise('please check my class exercise',{
    protectedProblems:()=>bank,
    mathTool:async () => { mathCalls++; return {answer:'10'}; },
  },async () => {
    modelCalls++;
    bank = [{id:1,question:'How many paper cranes are in two groups of five?',
      answer:'10',solution:'count the cranes in both groups',message:'',thread:'',posted:true}];
    return call('calculate',{expression:'2*5'});
  });
  try {
    await assert.rejects(f.execute());
    assert.equal(modelCalls,1);
    assert.equal(mathCalls,0);
    assert.ok(!f.events.progress(ids.id)?.stream);
  } finally { f.close(); }
});
