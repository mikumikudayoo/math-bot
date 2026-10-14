import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DiscordBroker} from '../src/service/discord-broker.js';
import type {DiscordTool} from '../src/discord-context.js';
import type {Job} from '../src/service/types.js';

const privateValues=['private-query-marker','private-requester-marker','private-guild-marker','private-channel-marker','private-author-marker','private-source-marker','private-job-marker','private-result-marker','private-error-marker','private-type-marker'];
const job:Job={id:privateValues[6]!,guild:privateValues[2]!,channel:privateValues[3]!,user:privateValues[1]!,sourceMessageId:privateValues[5]!,kind:'ask',coach:false,prompt:'unused',state:'running',status:'thinking',answer:'',artifact:'',created:0,message:'',delivered:0};
const args={query:privateValues[0],authorId:privateValues[4],channelId:privateValues[3]};
function fixture(){
  const logs:Record<string,unknown>[]=[];
  const broker=new DiscordBroker(event=>logs.push({...event}));
  const verify=()=>{
    const logged=JSON.stringify(logs);
    // Never print an offending marker through an assertion's diagnostic values.
    for(const value of privateValues)assert.ok(!logged.includes(value),'sensitive payload must be absent from telemetry');
    for(const event of logs){
      assert.match(String(event.requestId),/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      assert.ok(Object.keys(event).every(key=>['requestId','tool','state','latencyMs'].includes(key)));
      if(event.state!=='requested')assert.ok(typeof event.latencyMs==='number'&&Number.isFinite(event.latencyMs)&&event.latencyMs>=0&&event.latencyMs<=30000);
    }
  };
  return {broker,logs,verify};
}

test('broker logs correlated success without requester, query, identifiers, or result payload',async()=>{
  const {broker,logs,verify}=fixture();
  try{
    const result={type:'DISCORD_SEARCH_DATA',results:[{content:privateValues[7],author:{id:job.user}}]};
    const promise=broker.request(job,'discord_search',args,new AbortController().signal);
    const task=broker.take()[0]!;
    assert.equal(broker.finish(task.id,result),true);assert.equal(await promise,result);
    assert.equal(broker.finish(task.id,result),false);
    assert.deepEqual(logs.map(log=>log.state),['requested','completed']);
    assert.equal(logs[0]!.requestId,logs[1]!.requestId);assert.equal(logs[0]!.tool,'discord_search');verify();
  }finally{broker.close();}
});

test('broker classifies untrusted result types and errors without logging their values',async()=>{
  const {broker,logs,verify}=fixture();
  try{
    for(const value of [{type:privateValues[9],content:privateValues[7]},{error:privateValues[8],type:privateValues[9]},null]){
      const promise=broker.request(job,'discord_member',args,new AbortController().signal);const task=broker.take()[0]!;
      assert.equal(broker.finish(task.id,value),true);assert.equal(await promise,value);
    }
    assert.deepEqual(logs.filter(log=>log.state!=='requested').map(log=>log.state),['invalid_result','unavailable','invalid_result']);verify();
  }finally{broker.close();}
});

test('broker cancellation and close use fixed outcomes and retain stale-result rejection',async()=>{
  const {broker,logs,verify}=fixture();
  try{
    const controller=new AbortController();const cancelled=broker.request(job,'discord_search',args,controller.signal);
    const task=broker.take()[0]!;controller.abort(privateValues[8]);await assert.rejects(cancelled,/unavailable or cancelled/);
    assert.equal(broker.finish(task.id,{type:privateValues[9]}),false);
    const closed=broker.request(job,'discord_member',args,new AbortController().signal);broker.close();await assert.rejects(closed,/unavailable/);
    assert.deepEqual(logs.map(log=>log.state),['requested','cancelled','requested','closed']);verify();
  }finally{broker.close();}
});

test('broker telemetry allowlists tools rather than echoing unexpected names',async()=>{
  const {broker,logs,verify}=fixture();
  try{
    const pending=broker.request(job,privateValues[0] as DiscordTool,args,new AbortController().signal);const task=broker.take()[0]!;
    broker.finish(task.id,{error:privateValues[8]});await pending;
    assert.ok(logs.every(log=>log.tool==='unsupported'));verify();
  }finally{broker.close();}
});
