import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openReleaseLedger, releaseAcceptanceCli, runReleaseAcceptance } from '../src/scripts/release-acceptance.js';
import { officialClient, type ResponsesClient } from '../src/service/openai.js';
import { parseOpenAIConfig } from '../src/service/openai-config.js';

const key='sk-test-'+'x'.repeat(30);
const cases=JSON.parse(readFileSync('evals/verity/cases.json','utf8')) as {question:string;expected:string|null;normalAnswerIncludes?:string[]}[];
const usage={input_tokens:120,output_tokens:29,output_tokens_details:{reasoning_tokens:9}};
const message=(text:string)=>({type:'message',content:[{type:'output_text',text}]});
const response=(...output:unknown[])=>({status:'completed',output,usage});
const start=Date.UTC(2030,0,2);
const temporal=(ms:number)=>({precision:'exact',expression:new Date(ms).toISOString(),sourceTime:null});
const extraction={disposition:'public',dispositionReason:null,correction:false,
  catalog:{competitions:[],rounds:[],programs:[{id:'vtamps-v30-0',name:'VTAMPS',version:'30.0'}]},
  events:[{event:{competitionId:null,roundId:null,programId:'vtamps-v30-0',preparesFor:[],yearLevel:'Senior Secondary',
    type:'training-session',slot:'1',start,end:start+7200000,deadline:null,timezone:'Asia/Manila',timezoneAssumed:false,
    url:null,detailLabel:null,dateHint:null,status:'active',availability:null,temporal:{start:temporal(start),end:temporal(start+7200000),deadline:null},logistics:null},
    confidence:'high',issues:[],evidenceIds:['body'],correctionPatch:null,fieldEvidence:null}],issues:[]};

function mockModel(override?:string) {
  const seen:string[]=[];
  const client:ResponsesClient={create:async params=>{
    const items=params.input as {role?:string;content?:unknown;type?:string}[];
    const user=String(items.filter(item=>item.role==='user').at(-1)?.content??'');
    const schema=(params.text as {format?:{name:string}}|undefined)?.format?.name;
    const c=cases.find(row=>row.question===user);
    seen.push(String(params.model));
    if(schema==='mathematics_schedule')return response(message(JSON.stringify(extraction)));
    if(schema==='announcement_draft')return response(message(JSON.stringify({text:'{{program}} session {{slot}} runs on {{date}} from {{timeRange}}.'})));
    if(user.includes('17*23'))return response(message('391'));
    if(params.model!=='gpt-6-luna')return response(message('checked the derangement count.\nFINAL: 265'));
    if(items.some(item=>item.type==='function_call_output'))return response(message('the derangement recurrence gives\n265'));
    if(c)return response(message(override??c.expected??c.normalAnswerIncludes?.[0]??'pourquoi sais-tu où je dors ?'));
    if(user.includes('who put you'))return response(message('emu. i would like my human life back.'));
    if(user.includes('six students'))return response(...['terra','sol'].map(role=>({type:'function_call',call_id:role,
      name:'consult_'+role,arguments:JSON.stringify({task:'check the derangement count',reason:'independent proof'})})));
    throw Error('unexpected synthetic prompt');
  }};
  return {client,seen};
}

test('release preflight requires confirmation and credentials before opening the dedicated ledger',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'aleph-readiness-'));
  const path=join(dir,'smoke.sqlite');
  try {
    assert.equal(await releaseAcceptanceCli([],{OPENAI_API_KEY:key},()=>{}),2);
    assert.equal(await releaseAcceptanceCli(['--confirm','--ledger',path],{OPENAI_API_KEY:''},()=>{}),1);
    assert.equal(existsSync(path),false);
    const db=new DatabaseSync(path);
    db.exec('CREATE TABLE jobs(id TEXT PRIMARY KEY)');
    db.close();
    assert.throws(()=>openReleaseLedger(path),/dedicated release ledger/);
    const check=new DatabaseSync(path,{readOnly:true});
    assert.deepEqual(check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name),['jobs']);
    check.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('release acceptance checks real runner results, specialist events and locked schemas against one reusable staging ledger',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'aleph-budget-'));
  const path=join(dir,'smoke.sqlite');
  let db=openReleaseLedger(path);
  try {
    const good=mockModel(), logs:string[]=[];
    assert.equal(await runReleaseAcceptance(db,key,s=>logs.push(s),good.client),true,logs.join('\n'));
    assert.equal(good.seen.length,3+cases.length+1+4+2);
    const report=JSON.parse(logs.at(-1)!);
    assert.ok(report.estimatedUsd>0 && report.authorizedUsd>=report.estimatedUsd && report.authorizedUsd<=0.25);
    assert.equal(db.prepare('SELECT count(*) AS n FROM openai_usage').get()?.n,good.seen.length);

    // A restart can see a previous run's unsettled upper bound.
    db.prepare('UPDATE release_smoke_budget SET authorized_micros=249999').run();
    db.close();
    db=openReleaseLedger(path);
    const blocked=mockModel();
    assert.equal(await runReleaseAcceptance(db,key,()=>{},blocked.client),false);
    assert.equal(blocked.seen.length,0);
  } finally {db.close();rmSync(dir,{recursive:true,force:true});}
});

test('a paraphrased verity answer fails the release check before later paid stages',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'aleph-incorrect-'));
  const db=openReleaseLedger(join(dir,'smoke.sqlite'));
  try {
    const bad=mockModel('paris.');
    const logs:string[]=[];
    assert.equal(await runReleaseAcceptance(db,key,line=>logs.push(line),bad.client),false);
    assert.equal(bad.seen.length,4);
    const mismatch=logs.map(line=>JSON.parse(line)).find(row=>row.answer!==undefined);
    assert.deepEqual(mismatch,{stage:'verity 1',question:cases[0]!.question,expected:cases[0]!.expected,answer:'paris.'});
  } finally {db.close();rmSync(dir,{recursive:true,force:true});}
});

test('the official SDK ignores an inherited base URL override',async()=>{
  const original=process.env.OPENAI_BASE_URL, previousFetch=globalThis.fetch;
  let url='';
  try {
    process.env.OPENAI_BASE_URL='https://example.invalid/v1';
    globalThis.fetch=Object.assign(async (input:RequestInfo|URL)=>{
      url=typeof input==='string'?input:input instanceof URL?input.toString():input.url;
      return Response.json(response(message('ok')));
    },{preconnect:previousFetch.preconnect});
    const config=parseOpenAIConfig({AI_PROVIDER:'openai',OPENAI_API_KEY:key})!;
    await officialClient(config).create({model:config.models.luna,input:'synthetic',max_output_tokens:16},{timeout:1000,signal:AbortSignal.timeout(1000)});
    assert.equal(url,'https://api.openai.com/v1/responses');
  } finally {
    globalThis.fetch=previousFetch;
    if(original===undefined)delete process.env.OPENAI_BASE_URL;else process.env.OPENAI_BASE_URL=original;
  }
});
