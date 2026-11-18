import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import { handleLunaFast } from '../src/commands/luna-fast.js';
import { LUNA_FAST_CREATOR } from '../src/luna-fast-control.js';
import { serviceConfigFrom } from '../src/service/config.js';
import { createService } from '../src/service/server.js';
import { OpenAIRuntime, type ResponsesClient } from '../src/service/openai.js';

const serviceSecret = 'fixture-service-token-'.repeat(3);
const capability = 'fixture-luna-capability-'.repeat(3);
function config(database = ':memory:') {
  return serviceConfigFrom({AI_SERVICE_TOKEN:serviceSecret,AI_LUNA_FAST_TOKEN:capability,
    AI_DATABASE:database,AI_PROVIDER:'openai',OPENAI_API_KEY:'sk-test-'+'x'.repeat(32),OPENAI_MAX_RETRIES:'1'}, 'development');
}

test('creator commands are ephemeral and neither roles nor names grant access', async () => {
  const modes:string[]=[];
  const flags:unknown[]=[];
  for (const [id,mode] of [[LUNA_FAST_CREATOR,'enable'],[LUNA_FAST_CREATOR,'status'],
    ['123456789012345678','enable'],[LUNA_FAST_CREATOR,'disable']] as const) {
    const interaction = {user:{id,username:'emu'},memberPermissions:{has:()=>true},options:{getString:()=>mode},
      reply:async (result:{flags:unknown})=>{flags.push(result.flags);},
      deferReply:async (result:{flags:unknown})=>{flags.push(result.flags);},editReply:async()=>{}} as unknown as ChatInputCommandInteraction;
    await handleLunaFast(interaction,async value=>{modes.push(value);return {enabled:value!=='disable'};});
  }
  assert.deepEqual(modes,['enable','status','disable']);
  assert.deepEqual(flags,Array(4).fill(MessageFlags.Ephemeral));
});

test('service refuses forged owner data, serializes changes and persists them across restart', async () => {
  const dir=mkdtempSync(join(tmpdir(),'aleph-luna-fast-'));
  const c=config(join(dir,'store.sqlite'));
  async function connect() {
    const app=createService(c,async()=>({answer:'fixture'}),()=>[]);
    app.server.listen(0,'127.0.0.1');
    await once(app.server,'listening');
    const address=app.server.address() as AddressInfo;
    return {app,post:(mode:string,token?:string)=>fetch('http://127.0.0.1:'+address.port+'/luna-fast',{
      method:'POST',headers:{Authorization:'Bearer '+serviceSecret,'Content-Type':'application/json',...(token?{'X-Luna-Fast-Token':token}:{})},
      body:JSON.stringify({mode,user:LUNA_FAST_CREATOR,moderator:true})})};
  }
  let server=await connect();
  try {
    assert.equal((await server.post('enable')).status,403);
    assert.equal((await server.post('enable',serviceSecret)).status,403);
    assert.deepEqual(await (await server.post('status',capability)).json(),{enabled:false});
    const toggles=await Promise.all(['enable','disable','enable','disable'].map(mode=>server.post(mode,capability)));
    assert.ok(toggles.every(r=>r.ok));
    assert.deepEqual(await (await server.post('enable',capability)).json(),{enabled:true});
    await server.app.close();
    server=await connect();
    assert.deepEqual(await (await server.post('status',capability)).json(),{enabled:true});
    assert.deepEqual(await (await server.post('disable',capability)).json(),{enabled:false});
  } finally {await server.app.close();rmSync(dir,{force:true,recursive:true});}
});

const usage={input_tokens:100,cached_tokens:0,output_tokens:10,output_tokens_details:{reasoning_tokens:5}};
const response=(tier?:string)=>({status:'completed',service_tier:tier,usage,output:[]});
test('each attempt snapshots the tier and accounting follows the actual tier', async () => {
  const db=new DatabaseSync(':memory:');
  let release!:()=>void, started!:()=>void;
  const gated=new Promise<void>(resolve=>{release=resolve;});
  const entered=new Promise<void>(resolve=>{started=resolve;});
  const seen:unknown[]=[];
  const client:ResponsesClient={create:async params=>{
    seen.push(params.service_tier);
    if(seen.length===1){started();await gated;return response('default');}
    if(seen.length===5)return response();
    return response(String(params.service_tier));
  }};
  const runtime=new OpenAIRuntime(config().openai!,db,client);
  const ask=(role:'luna'|'terra'|'sol',purpose:string)=>runtime.complete({role,effort:'low',maxOutputTokens:100,
    purpose,messages:[{role:'user',content:'fixture'}],job:{id:purpose,user:'system'}},AbortSignal.timeout(10000));
  try {
    runtime.ledger.setLunaFast(true);
    const first=ask('luna','competition-screen');
    await entered;
    runtime.ledger.setLunaFast(false);
    try {await ask('luna','proof-repair');} finally {release();}
    await first;
    runtime.ledger.setLunaFast(true);
    await ask('terra','consult-terra');await ask('sol','proof-review');await ask('luna','missing');await ask('luna','fast-known');
    assert.deepEqual(seen,['fast','default','default','default','fast','fast']);
    const row=(tier:string)=>db.prepare('SELECT cost_micros,requested_service_tier,actual_service_tier,status FROM openai_usage WHERE tier=?').get(tier);
    assert.deepEqual({...row('competition-screen')},{cost_micros:15,requested_service_tier:'fast',actual_service_tier:'default',status:'ok'});
    assert.equal(row('fast-known')?.cost_micros,30);
    assert.equal(row('missing')?.status,'unmetered');
    assert.ok(Number(row('missing')?.cost_micros)>30);
  } finally {db.close();}
});

test('rate limited attempts take a fresh tier snapshot and release their nonbilled reservation', async () => {
  const db=new DatabaseSync(':memory:');
  const requested:unknown[]=[];
  const runtime=new OpenAIRuntime(config().openai!,db,{create:async params=>{
    requested.push(params.service_tier);
    if(requested.length===1){
      runtime.ledger.setLunaFast(false);
      throw Object.assign(new Error('synthetic rate limit'),{status:429});
    }
    return response('default');
  }},{backoffMs:()=>0});
  try {
    runtime.ledger.setLunaFast(true);
    await runtime.complete({role:'luna',purpose:'retry-test',effort:'low',messages:[],
      job:{id:'retry-test',user:'system'}},AbortSignal.timeout(10000));
    assert.deepEqual(requested,['fast','default']);
    const rows=db.prepare("SELECT requested_service_tier,status,cost_micros FROM openai_usage ORDER BY id").all();
    assert.deepEqual(rows.map(r=>r.requested_service_tier),['fast','default']);
    assert.equal(rows[0]?.status,'error');
    assert.equal(rows[0]?.cost_micros,0);
    assert.equal(rows[1]?.cost_micros,15);
  } finally {db.close();}
});
