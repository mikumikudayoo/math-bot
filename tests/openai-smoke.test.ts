import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/service/store.js';
import type {ResponsesClient} from '../src/service/openai.js';
import {smokeCli,smokeSettings} from '../src/scripts/openai-smoke.js';

function fixture(extra = '') {
  const directory = mkdtempSync(join(tmpdir(),'aleph-smoke-'));
  const path = join(directory,'shared.sqlite');
  const store = new Store(path);
  const file = join(directory,'.env.ai.development');
  const contents = 'AI_PROVIDER=legacy\nAI_SERVICE_TOKEN='+'s'.repeat(36)+'\nAI_DATABASE='+path+'\n'+extra;
  writeFileSync(file,contents);
  return {store,file,contents,load:(mode:string,key?:string)=>smokeSettings(mode,key,directory),close:()=>{store.close();rmSync(directory,{recursive:true,force:true});}};
}
const env = {OPENAI_API_KEY:'sk-fixture'+'x'.repeat(32)};
function reply(text:string,status='completed',metered=true) {
  return {status,output:[{type:'message',content:[{type:'output_text',text}]}],
    ...(metered ? {usage:{input_tokens:80,output_tokens:16,output_tokens_details:{reasoning_tokens:10}}} : {})};
}

test('smoke dry run and unknown flags do not load credentials, open a database or call a provider',async () => {
  let opened = 0; const lines:string[] = [];
  const never = () => {opened++; throw new Error('unexpected live action');};
  assert.equal(await smokeCli(['--terra'],{},s=>lines.push(s),never,{create:never}),2);
  assert.match(lines[0]!,/dry run/);
  assert.equal(await smokeCli(['--unknown','--confirm'],{},()=>{},never,{create:never}),2);
  assert.equal(opened,0);
});

test('legacy-mode staging checks all three models, verifies exact answers and persists one bounded system job in the service database',async () => {
  const f = fixture();
  const calls:Record<string,unknown>[] = [], lines:string[]=[];
  const client:ResponsesClient = {create:async params=>{calls.push(params);return reply('391');}};
  try {
    assert.equal(await smokeCli(['--confirm','--terra','--sol'],env,s=>lines.push(s),f.load,client),0);
    assert.deepEqual(calls.map(p=>p.model),['gpt-6-luna','gpt-6.1-terra','gpt-6.2-sol']);
    assert.deepEqual(calls.map(p=>p.max_output_tokens),[256,512,512]);
    assert.ok(calls.every(p=>p.store===false && (p.reasoning as {effort?:string}).effort==='low'));
    const rows = f.store.db.prepare('SELECT DISTINCT job,user,status FROM openai_usage').all();
    assert.equal(rows.length,1); assert.equal(rows[0]!.user,'system');assert.equal(rows[0]!.status,'ok');
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM jobs').get()!.n,0);
    assert.ok(!lines.join('\n').includes(env.OPENAI_API_KEY));
    assert.equal(readFileSync(f.file,'utf8'),f.contents);
  } finally {f.close();}
});

test('incorrect, truncated, unmetered, or rejected smoke attempts return failure and do not proceed to another model',async () => {
  for(const response of [reply('the answer is 391'),reply('391','incomplete'),reply('391','completed',false),null]) {
    const f = fixture();
    let sent=0;const logs:string[]=[];
    try {
      const code = await smokeCli(['--confirm','--sol'],env,s=>logs.push(s),f.load,{create:async()=>{sent++;if(!response)throw Object.assign(new Error('fixture'),{status:429});return response;}});
      assert.equal(code,1);assert.equal(sent,1);
      assert.equal(f.store.db.prepare('SELECT count(*) n FROM openai_usage').get()!.n,1);
      if(response&&!('usage' in response))assert.equal(f.store.db.prepare('SELECT status FROM openai_usage').get()!.status,'unmetered');
      assert.ok(!logs.join('\n').includes('the answer is 391'));
    } finally {f.close();}
  }
});

test('smoke respects disabled models, existing spend and lower configured system ceilings',async () => {
  for(const extra of ['OPENAI_ALLOWED_MODELS=luna\n','OPENAI_SYSTEM_REQUEST_BUDGET_USD=0\n','OPENAI_DAILY_BUDGET_USD=0\n']) {
    const f=fixture(extra);let sent=0;
    try{
      const code=await smokeCli(['--confirm','--terra'],env,()=>{},f.load,{create:async()=>{sent++;return reply('391');}});
      assert.equal(code,1);assert.equal(sent,0);
    } finally {f.close();}
  }
  const f=fixture('OPENAI_TOTAL_BUDGET_USD=0.002\n');
  try {
    const client={create:async()=>reply('391')};
    await smokeCli(['--confirm'],env,()=>{},f.load,client);
    // Existing usage belongs to a different service job; consuming the shared ceiling blocks the next preflight.
    f.store.db.prepare('UPDATE openai_usage SET cost_micros=2000').run();
    let sent=0;
    assert.equal(await smokeCli(['--confirm'],env,()=>{},f.load,{create:async()=>{sent++;return reply('391');}}),1);
    assert.equal(sent,0);
  } finally {f.close();}
});
