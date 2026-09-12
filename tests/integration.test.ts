import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createService } from '../src/service/server.js';
import { runner } from '../src/service/inference.js';
import { Store } from '../src/service/store.js';
import type { ServiceConfig } from '../src/service/config.js';
import type { Job } from '../src/service/types.js';

const config:ServiceConfig={mode:'development',secret:'test-only-secret-with-at-least-32-characters',port:8787,database:':memory:',concurrency:1,reserved:0,borrow:false,timeoutMs:10000,maxQueue:20,backend:'',model:'',backendKey:'',vision:false,python:'.venv/bin/python',searchKey:'',sandbox:false,sandboxImage:'math-bot-python:local'};
const guild='123456789012345678',channel='234567890123456789',user='345678901234567890';
test('authenticated HTTP admission, binding, delivery, and persisted disable contract',async()=>{
  const app=createService(config,async job=>({answer:`answer to ${job.prompt}`}));
  await new Promise<void>(r=>app.server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const call=(path:string,body?:unknown)=>fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${config.secret}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  try{
    assert.equal((await fetch(base+'/health')).status,401);
    assert.equal((await call('/jobs',{id:'456789012345678901',guild,channel,user,kind:'ask',prompt:'hello'})).status,200);
    await call('/bind',{id:'456789012345678901',message:'567890123456789012'});
    await call('/settings',{guild,user,moderator:true,enabled:false});
    assert.equal((await call('/jobs',{id:'678901234567890123',guild,channel,user,kind:'ask',prompt:'later'})).status,400);
    await new Promise(r=>setTimeout(r,30));
    const pending=await (await call('/pending')).json() as Job[];assert.equal(pending[0]?.answer,'answer to hello');assert.equal(pending[0]?.state,'completed');
    await call('/delivered',{id:'456789012345678901'});assert.deepEqual(await (await call('/pending')).json(),[]);
  }finally{await app.close();}
});
test('model adapter invokes allowed calculator and returns final answer from mock backend',async()=>{
  let count=0;
  const backend=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk.toString();const input=JSON.parse(body);
    count++;res.setHeader('Content-Type','application/json');
    if(count===1)res.end(JSON.stringify({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'tool1',type:'function',function:{name:'calculate',arguments:'{"expression":"2+3"}'}}]}}]}));
    else{assert.equal(JSON.parse(input.messages.at(-1).content).answer,'5');res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'2 + 3 = 5.'}}]}));}
  });
  await new Promise<void>(r=>backend.listen(0,'127.0.0.1',r));const store=new Store(':memory:');
  try{
    const job=store.admit({id:'a',guild,channel,user,coach:false,kind:'ask',prompt:'2+3'},20);
    const run=runner({...config,backend:`http://127.0.0.1:${(backend.address() as AddressInfo).port}`,model:'test-fixture-only'},store);
    const result=await run(job,AbortSignal.timeout(20000),()=>{});assert.equal(result.answer,'2 + 3 = 5.');assert.equal(count,2);
  }finally{store.close();await new Promise<void>(r=>backend.close(()=>r()));}
});
