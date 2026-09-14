import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/service/store.js';
import { Scheduler } from '../src/service/scheduler.js';
import { publicAddress,publicURL } from '../src/service/network.js';
import { matchesTerm } from '../src/moderation.js';
import type { Submission,Result } from '../src/service/types.js';

let counter=0;
function input(user='u',coach=false):Submission{return {id:String(++counter),guild:'g',channel:'c',user,coach,kind:'ask',prompt:'hello'};}
const turn=()=>new Promise(r=>setTimeout(r,10));
test('disable persists and accepted work survives restart; new work rejected',()=>{
  const dir=mkdtempSync(join(tmpdir(),'math-bot-'));const path=join(dir,'state.sqlite');let store=new Store(path);
  try{const j=store.admit(input(),20);store.running(j.id);store.setEnabled('g',false,'moderator');store.close();store=new Store(path);store.recover();assert.equal(store.enabled('g'),false);assert.equal(store.get(j.id)?.state,'queued');assert.throws(()=>store.admit(input('b'),20),/disabled/);}
  finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('coach gets next slot without preemption; accepted queue drains while disabled',async()=>{
  const store=new Store(':memory:');const started:string[]=[];const finish=new Map<string,(v:Result)=>void>();
  const queue=new Scheduler(store,{concurrency:1,reserved:0,borrow:false,timeoutMs:5000},async job=>{started.push(job.id);return new Promise(r=>finish.set(job.id,r));});
  const a=store.admit(input('a'),20);queue.tick();await turn();const b=store.admit(input('b'),20);const c=store.admit(input('coach',true),20);store.setEnabled('g',false,'mod');queue.tick();assert.deepEqual(started,[a.id]);
  finish.get(a.id)!({answer:'a'});await turn();assert.deepEqual(started,[a.id,c.id]);finish.get(c.id)!({answer:'c'});await turn();assert.deepEqual(started,[a.id,c.id,b.id]);finish.get(b.id)!({answer:'b'});await turn();queue.stop();store.close();
});
test('reserved capacity excludes ordinary requests unless borrowing is enabled',async()=>{
  for(const borrow of [false,true]){
    const store=new Store(':memory:');const finish:Array<(v:Result)=>void>=[];
    const q=new Scheduler(store,{concurrency:2,reserved:1,borrow,timeoutMs:5000},async()=>new Promise(r=>finish.push(r)));
    store.admit(input('a'),20);store.admit(input('b'),20);q.tick();await turn();assert.equal(q.active.size,borrow?2:1);
    q.stop();finish.forEach(r=>r({answer:'ok'}));await turn();store.close();
  }
});
test('idempotent admission and conversation isolation',()=>{
  const store=new Store(':memory:');const j=input('a');store.admit(j,20);store.admit(j,20);assert.equal(store.queued().length,1);
  store.running(j.id);store.complete(j.id,{answer:'ok'});assert.throws(()=>store.admit({...input('b'),parent:j.id},20),/own completed/);
  store.admit({...input('a'),parent:j.id},20);store.close();
});
test('public network checks reject SSRF and protocol tricks',()=>{
  for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','192.168.0.1','::1','::ffff:127.0.0.1','fc00::1','0.0.0.0','224.0.0.1'])assert.equal(publicAddress(ip),false,ip);
  assert.ok(publicAddress('1.1.1.1'));assert.throws(()=>publicURL('file:///etc/passwd'));assert.throws(()=>publicURL('https://user:pass@example.com'));assert.throws(()=>publicURL('https://example.com:444'));
});
test('filter whole-word matching does not censor analysis or class',()=>{
  assert.equal(matchesTerm('analysis','anal'),false);assert.equal(matchesTerm('class','ass'),false);assert.equal(matchesTerm('a BAD phrase!','bad phrase'),true);assert.equal(matchesTerm('a.b','a.b'),true);assert.equal(matchesTerm('axb','a.b'),false);
});
