import { test } from 'node:test';
import assert from 'node:assert/strict';
import { search } from '../src/service/tools.js';
import { retrievalPolicy } from '../src/service/retrieval-policy.js';

const config={searchKey:'fixture-only-not-a-real-key'};
const signal=()=>AbortSignal.timeout(10000);
function mock(response:()=>Response){
  const calls:{url:string;init:RequestInit}[]=[];
  const request=(async(url:unknown,init:RequestInit)=>{calls.push({url:String(url),init});return response();}) as typeof fetch;
  return {calls,request};
}
test('Tavily POST preserves exact entity queries and requests economical search only',async()=>{
  for(const prompt of ['What is the Pax Silica situation in the Philippines?','Describe all Eternal Towers of Hell difficulties, including noncanon ones.',"Who provides Hatsune Miku's voice?"]){
    const policy=retrievalPolicy(prompt);const m=mock(()=>Response.json({results:[]}));
    assert.deepEqual(await search(config,policy.query,signal(),m.request),[]);
    assert.equal(m.calls.length,1);
    const {url,init}=m.calls[0]!;
    assert.equal(url,'https://api.tavily.com/search');assert.equal(init.method,'POST');assert.equal(init.redirect,'error');
    assert.equal(new Headers(init.headers).get('Authorization'),`Bearer ${config.searchKey}`);
    assert.equal(new Headers(init.headers).get('Content-Type'),'application/json');
    assert.ok(init.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(String(init.body)),{query:policy.query,topic:'general',search_depth:'basic',auto_parameters:false,max_results:5,include_answer:false,include_raw_content:false,include_images:false});
    assert.ok(!String(init.body).includes(config.searchKey));
  }
});
test('Tavily content normalizes to bounded evidence; malformed, duplicate and unsafe results are ignored',async()=>{
  const m=mock(()=>Response.json({answer:'UNTRUSTED GENERATED ANSWER',results:[
    null,{title:'missing content',url:'https://example.com'},
    {title:'unsafe',url:'http://localhost/',content:'unsafe'},
    {title:'blank',url:'https://example.com/blank',content:'  '},
    {title:'a'.repeat(400),url:'https://example.com/one',content:'b'.repeat(1200),raw_content:'ignored'},
    {title:'duplicate',url:'https://example.com/one',content:'ignored'},
    ...Array.from({length:8},(_,i)=>({title:`result ${i}`,url:`https://example.com/${i}`,content:'evidence'})),
  ]}));
  const results=await search(config,'query',signal(),m.request);
  assert.equal(results.length,5);assert.deepEqual(results[0],{title:'a'.repeat(300),url:'https://example.com/one',description:'b'.repeat(1000)});
  assert.ok(!JSON.stringify(results).includes('UNTRUSTED'));assert.equal(m.calls.length,1);
});
test('Tavily failures never return provider error bodies or retry automatically',async()=>{
  for(const status of [401,429,500]){
    const m=mock(()=>new Response('sensitive provider error',{status}));
    await assert.rejects(search(config,'query',signal(),m.request),{message:'Web search provider is unavailable.'});assert.equal(m.calls.length,1);
  }
  for(const body of ['not json','null','{}','{"results":{}}']){
    const m=mock(()=>new Response(body));await assert.rejects(search(config,'query',signal(),m.request),{message:'Invalid search response.'});
  }
  const m=mock(()=>Response.json({results:[]}));
  await assert.rejects(search({searchKey:''},'query',signal(),m.request),/not configured/);assert.equal(m.calls.length,0);
});
test('Tavily response size and cancellation remain bounded',async()=>{
  const m=mock(()=>new Response('x'.repeat(1_000_001)));
  await assert.rejects(search(config,'query',signal(),m.request),/size limit/);
  const controller=new AbortController();controller.abort();
  const request=(async(_url:unknown,init:RequestInit)=>{init.signal!.throwIfAborted();return Response.json({results:[]});}) as typeof fetch;
  await assert.rejects(search(config,'query',controller.signal,request));
});
