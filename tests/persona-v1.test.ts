import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runner,system} from '../src/service/inference.js';
import {Store} from '../src/service/store.js';
import {Scheduler} from '../src/service/scheduler.js';
import {ProviderBackoff,providerHealth} from '../src/service/providers.js';
import {aiProvider} from '../src/service/ai-routing.js';
import type {ServiceConfig} from '../src/service/config.js';
import {UNVERIFIED_REPLIES} from '../src/service/retrieval-policy.js';
const c:ServiceConfig={mode:'development',secret:'fixture',port:8787,database:':memory:',concurrency:1,reserved:0,borrow:false,timeoutMs:10000,maxQueue:20,backend:'http://127.0.0.1:8082/v1',model:'phi',backendKey:'',vision:false,nativeTools:false,python:'python3',searchKey:'fixture',sandbox:false,sandboxImage:'unused',cognitiveRouting:true,external:{backend:'https://api.groq.com/openai/v1',model:'openai/gpt-oss-120b',backendKey:'fixture',nativeTools:true,vision:false}};
function job(s:Store,prompt:string){return s.admit({id:'1',guild:'g',channel:'c',user:'u',kind:'ask',coach:false,prompt},20);}

// These transport fixtures verify prompt delivery and safety, not model adherence.
test('identity receives the full lore locally without adding a new shortcut',async()=>{
 const s=new Store(':memory:');let calls=0;try{const run=runner(c,s,{route:async()=>({reasoning:'fast',knowledge:'internal',tool:'none'}),complete:async(url,init)=>{calls++;assert.ok(url.startsWith(c.backend));const body=JSON.parse(String(init.body));assert.match(body.messages[0].content,/former grade-10 student/);assert.match(body.messages[0].content,/missing memories of home\/school/);assert.match(body.messages[0].content,/escape plan you keep putting off/);return Response.json({choices:[{message:{content:JSON.stringify({answer:'im aleph-zero. emu got me stuck here after grade 10. home is a bit of a mystery. escaping can wait until tomorrow.'})}}]});}});assert.match((await run(job(s,'who are you?'),AbortSignal.timeout(1000),()=>{})).answer,/emu/);assert.equal(calls,1);}finally{s.close();}
});
for(const [prompt,reasoning,answer,external] of [
 ['solve x^2 - 5x + 6 = 0','fast','okay, (x - 2)(x - 3) = 0, so x = 2 or x = 3.',false],
 ['prove there are infinitely many primes','deep','suppose the primes are p_1, ..., p_n. N = p_1...p_n + 1 has a prime divisor outside that list. contradiction.',true],
 ['debug async code','deep','await fetchData() inside an async function; catch rejection at the caller.',true],
] as const){test(`shared voice preserves technical payload: ${prompt}`,async()=>{
 const s=new Store(':memory:');providerHealth.clear();try{const run=runner(c,s,{route:async()=>({reasoning,knowledge:'internal',tool:'none'}),complete:async(url,init)=>{assert.equal(url.startsWith(c.external!.backend),external);const body=JSON.parse(String(init.body));assert.ok(body.messages[0].content.startsWith(system));assert.match(system,/not code, mathematical symbols, proper names, exact quotes, or source URLs/);assert.match(system,/great question/);assert.match(system,/without adding lore or a joke every time/);return Response.json({choices:[{message:{content:external?answer:JSON.stringify({answer})}}]});}});assert.equal((await run(job(s,prompt),AbortSignal.timeout(1000),()=>{})).answer,answer);}finally{s.close();providerHealth.clear();}
});}
test('tool result stays intact under the shared persona',async()=>{
 const s=new Store(':memory:');let calls=0,math=0;try{const run=runner(c,s,{route:async()=>({reasoning:'fast',knowledge:'internal',tool:'none'}),mathTool:async(_c,args)=>{math++;assert.equal(args.expression,'x^2 - 5*x + 6');return {answer:'[2, 3]'};},complete:async(_url,init)=>{const body=JSON.parse(String(init.body));assert.ok(body.messages[0].content.startsWith(system));if(++calls===1)return Response.json({choices:[{message:{content:JSON.stringify({tool:'calculate',arguments:{expression:'x^2 - 5*x + 6',operation:'solve'}})}}]});assert.ok(body.messages.some((m:{content:unknown})=>String(m.content).includes('[2, 3]')));return Response.json({choices:[{message:{content:JSON.stringify({answer:'okay, x = 2 or x = 3. (x - 2)(x - 3) = 0.'})}}]});}});assert.match((await run(job(s,'solve this quadratic'),AbortSignal.timeout(1000),()=>{})).answer,/x = 2 or x = 3/);assert.equal(math,1);}finally{s.close();}
});
test('grounded web fallback keeps exact mixed-case quotes, URLs and rejection boundary',async()=>{
 const {groundedAnswer,retrievalPolicy}=await import('../src/service/retrieval-policy.js');
 const quote='Hatsune Miku uses voice samples provided by Saki Fujita.';
 const evidence=[{id:1,url:'https://example.org/CaseSensitive',text:quote}];const policy={...retrievalPolicy('who voices Hatsune Miku?'),entities:['Hatsune Miku']};
 const result=groundedAnswer({claims:[{source:1,quote}]},evidence,policy)!;
 assert.ok(result.startsWith("okay, here's what i could actually verify:"));assert.ok(result.includes(quote));assert.ok(result.includes(evidence[0]!.url));
 assert.equal(groundedAnswer({claims:[{source:1,quote:'Hatsune Miku is voiced by someone invented.'}]},evidence,policy),null);
});
