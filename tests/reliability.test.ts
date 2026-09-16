import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runner,system,type InferenceDependencies } from '../src/service/inference.js';
import { retrievalPolicy,groundedAnswer,UNVERIFIED } from '../src/service/retrieval-policy.js';
import { maximumDifferentPairs,pairingCertificate,verifyPairingCertificate } from '../src/service/pairing.js';
import { Store } from '../src/service/store.js';
import { statusText } from '../src/status.js';
import type { ServiceConfig } from '../src/service/config.js';
import { routePrompt } from '../src/service/route-prompt.js';

const config:ServiceConfig={mode:'development',secret:'fixture-only-not-a-production-secret',port:8787,database:':memory:',concurrency:1,reserved:0,borrow:false,timeoutMs:10000,maxQueue:20,backend:'http://localhost:9999/v1',model:'fixture-only',backendKey:'',vision:false,nativeTools:false,python:'.venv/bin/python',searchKey:'fixture',sandbox:false,sandboxImage:'unused'};
const pax='What is the Pax Silica situation in the Philippines?';
const towers='Describe all Eternal Towers of Hell difficulties, including noncanon ones.';
const miku="Who provides Hatsune Miku's voice?";
const toys='There are 2025 Blossom, 2026 Bubbles, and 2027 Buttercup stuffed toys mixed together. If you want to get 3 pairs of stuffed toys, with each pair consisting of two different characters, at least how many stuffed toys must be taken?';
function fixture(prompt:string,answers:unknown[],options:{evidence?:string;searchFail?:boolean;empty?:boolean;native?:boolean}={}){
  const store=new Store(':memory:');const calls:{search:string[];requests:Record<string,unknown>[];statuses:string[];math:number}={search:[],requests:[],statuses:[],math:0};
  const text=options.evidence??'Pax Silica discussions concern the Philippines. This is a synthetic test source, not live reporting.';
  const io:InferenceDependencies={
    // Exercise the real router with fixture sensor signals; no local sensor daemon is needed.
    route:(prompt)=>routePrompt(prompt,{signals:async clauses=>clauses.map(clause=>{
      const fact=/Pax Silica|Eternal Towers of Hell|Hatsune Miku/.test(clause);
      const uncertain=/flibber/.test(clause);
      return {reasoning:0,freshness:0,externalKnowledge:fact?1:uncertain?0.6:0,verificationNeed:fact?1:uncertain?0.6:0,ambiguity:0,calculation:0};
    })}),
    search:async(_c,query)=>{calls.search.push(query);if(options.searchFail)throw new Error('offline');return options.empty?[]:[{title:'Test source',url:'https://example.com/source',description:text}];},
    fetchText:async()=>({url:'https://example.com/source',text}),
    mathTool:async()=>{calls.math++;return {answer:'5'};},
    complete:async(_url,init)=>{calls.requests.push(JSON.parse(String(init.body)));const answer=answers.shift()??'unsupported factual answer';return Response.json({choices:[{message:{role:'assistant',content:typeof answer==='string'?answer:JSON.stringify(answer)}}]});},
  };
  const job=store.admit({id:'1',guild:'g',channel:'c',user:'u',coach:false,kind:'ask',prompt},20);
  return {calls,store,run:()=>runner({...config,nativeTools:options.native??false},store,io)(job,AbortSignal.timeout(10000),s=>calls.statuses.push(s))};
}
test('routing requires exact Pax Silica, niche exhaustive towers, and voice-provider verification',()=>{
  for(const prompt of [pax,towers,miku,'What is the latest weather in Manila?','List every winner of this obscure award.'])assert.ok(retrievalPolicy(prompt).required,prompt);
  assert.ok(retrievalPolicy(pax).query.includes('"Pax Silica"'));assert.ok(!retrievalPolicy(pax).query.includes('Paxil'));
  assert.ok(retrievalPolicy(towers).entities.includes('Eternal Towers of Hell'));assert.ok(retrievalPolicy(towers).exhaustive);
  assert.ok(retrievalPolicy(miku).entities.includes('Hatsune Miku'));
});
test('Pax cannot become Paxil/paroxetine; required search executes before a model final is possible',async()=>{
  const f=fixture(pax,['Paxil is paroxetine.','Paxil is paroxetine.']);
  try{assert.equal((await f.run()).answer,UNVERIFIED);assert.equal(f.calls.search.length,1);assert.ok(f.calls.search[0]!.includes('"Pax Silica"'));assert.equal(f.calls.requests.length,2);assert.equal(f.calls.statuses[0],'searching');}
  finally{f.store.close();}
});
test('required retrieval failure, empty results and entity mismatch refuse without invoking the model',async()=>{
  for(const options of [{searchFail:true},{empty:true},{evidence:'Paxil is a medicine also called paroxetine, available in many countries.'}]){
    const f=fixture(pax,['Fabricated answer'],options);try{assert.equal((await f.run()).answer,UNVERIFIED);assert.equal(f.calls.requests.length,0);}finally{f.store.close();}
  }
});
test('a failed voluntary search cannot fall back to a guessed final answer',async()=>{
  const f=fixture('does flibber exist?',[{tool:'search',arguments:{query:'flibber'}},{answer:'invented fact'}],{searchFail:true});
  try{assert.equal((await f.run()).answer,UNVERIFIED);assert.ok(f.calls.search.length<=2);}finally{f.store.close();}
});
test('math vocabulary cannot exempt current factual questions from retrieval',()=>{
  assert.ok(retrievalPolicy('Calculate the current price of gold in Manila.').required);
});
test('niche exhaustive request cannot invent game lore when search is unavailable',async()=>{
  const f=fixture(towers,['Eternal Tower Legends has invented difficulties.'],{searchFail:true});
  try{assert.equal((await f.run()).answer,UNVERIFIED);assert.equal(f.calls.requests.length,0);assert.ok(f.calls.search[0]!.includes('"Eternal Towers of Hell"'));}finally{f.store.close();}
});
test('grounded response uses exact source text and host URLs, never unsupported model prose',async()=>{
  const quote="Hatsune Miku's voice provider is Saki Fujita. This is a synthetic test excerpt.";
  const f=fixture(miku,[{claims:[{source:1,quote}],answer:'Invented unsupported provider',insufficient:false}],{evidence:quote});
  try{const result=await f.run();assert.ok(result.answer.includes(quote));assert.ok(!result.answer.includes('Invented'));assert.ok(result.answer.includes('https://example.com/source'));assert.equal(f.calls.search.length,1);}finally{f.store.close();}
});
test('fabricated quotations and citations fail validation; insufficient evidence is explicit',()=>{
  const policy=retrievalPolicy(pax),evidence=[{id:1,url:'https://example.com/source',text:'Pax Silica concerns the Philippines in this synthetic example.'}];
  assert.equal(groundedAnswer({claims:[{source:7,quote:evidence[0]!.text}]},evidence,policy),null);
  assert.equal(groundedAnswer({claims:[{source:1,quote:'Pax Silica signed a fabricated agreement with the Philippines.'}]},evidence,policy),null);
  assert.equal(groundedAnswer({insufficient:true},evidence,policy),UNVERIFIED);
});
test('verified exhaustive lists are explicitly limited and cannot claim completeness',async()=>{
  const quote='Eternal Towers of Hell difficulties are discussed here; unofficial lists may differ.';
  const f=fixture(towers,[{claims:[{source:1,quote}]}],{evidence:quote});
  try{assert.match((await f.run()).answer,/not a guaranteed complete list/);}finally{f.store.close();}
});
test('timeless prompts and ordinary conversation make zero search calls',async()=>{
  for(const prompt of ['hello','Explain photosynthesis','What is a prime number?','Why is the sky blue?','Solve all integer solutions of x + 2 = 3.']){
    assert.equal(retrievalPolicy(prompt).required,false,prompt);
    const f=fixture(prompt,[{answer:'A concise educational response.'}]);try{await f.run();assert.equal(f.calls.search.length,0);assert.equal(f.calls.requests[0]!.tools,undefined);assert.equal(f.calls.requests[0]!.tool_choice,undefined);}finally{f.store.close();}
  }
});
test('uncertain draft is discarded and verification is host-enforced',async()=>{
  const f=fixture('does flibber exist?',[{answer:'I think it is an ancient kingdom.'}],{searchFail:true});
  try{assert.equal((await f.run()).answer,UNVERIFIED);assert.equal(f.calls.search.length,1);assert.equal(f.calls.requests.length,1);}finally{f.store.close();}
});
test('JSON tool protocol works without native tools; action status reflects actual tool',async()=>{
  const f=fixture('Calculate 2+3.',[{tool:'calculate',arguments:{expression:'2+3'}},{answer:'2 + 3 = 5.'}]);
  try{assert.equal((await f.run()).answer,'2 + 3 = 5.');assert.equal(f.calls.math,1);assert.ok(f.calls.statuses.includes('calculating'));assert.equal(f.calls.requests[0]!.tools,undefined);assert.equal(f.calls.statuses.at(-1),'preparing answer');}finally{f.store.close();}
});
test('unknown tools and repeating tools cannot escape the existing loop budget',async()=>{
  const f=fixture('hello',Array.from({length:10},()=>({tool:'shell',arguments:{command:'anything'}})));
  try{await assert.rejects(f.run(),/Tool-step limit/);assert.equal(f.calls.requests.length,6);assert.equal(f.calls.math,0);}finally{f.store.close();}
});
test('persona is preserved and unconfigured cutoff/company identity claims are blocked',async()=>{
  assert.match(system,/Aleph-Zero/);assert.match(system,/emu/);assert.match(system,/become human/);
  for(const answer of ['I was developed by Microsoft.','My knowledge cutoff is January 2025.']){
    const f=fixture('Who are you?',[{answer}]);try{const result=await f.run();assert.match(result.answer,/Aleph-Zero/);assert.match(result.answer,/emu/);assert.ok(!result.answer.includes('2025'));assert.equal(f.calls.search.length,0);}finally{f.store.close();}
  }
});
test('stuffed-toy proof verifies the bad selection and sufficient matching bound, not just 2030',async()=>{
  const stock=[2025,2026,2027],proof=pairingCertificate(stock,3);
  assert.equal(proof.threshold,2030);assert.deepEqual(proof.bad,[0,2,2027]);assert.equal(maximumDifferentPairs(proof.bad),2);assert.ok(verifyPairingCertificate(stock,proof));
  assert.equal(verifyPairingCertificate(stock,{...proof,bad:[2025,4,0]}),false); // Same count, already permits at least three pairs.
  assert.equal(verifyPairingCertificate(stock,{...proof,threshold:2030,minimumOther:2}),false);
  assert.ok(proof.minimumLargest>=3);assert.equal(proof.minimumOther,3);
  const f=fixture(toys,['2030 because you exhaust all categories.']);
  try{const result=await f.run();assert.match(result.answer,/2029 can fail/);assert.match(result.answer,/2027 Buttercup/);assert.match(result.answer,/only 2 disjoint/);assert.match(result.answer,/at least 3 outside/);assert.equal(f.calls.requests.length,0);assert.equal(f.calls.search.length,0);}finally{f.store.close();}
});
test('pairing formula agrees with exhaustive small inventories and adversarial selections',()=>{
  for(let a=1;a<=5;a++)for(let b=1;b<=5;b++)for(let c=1;c<=5;c++)for(let k=1;k<=3;k++){
    const stock=[a,b,c];if(maximumDifferentPairs(stock)<k)continue;const proof=pairingCertificate(stock,k);assert.ok(verifyPairingCertificate(stock,proof));
    for(let x=0;x<=a;x++)for(let y=0;y<=b;y++)for(let z=0;z<=c;z++)if(x+y+z===proof.threshold)assert.ok(maximumDifferentPairs([x,y,z])>=k);
  }
});
test('status labels use actual actions and safely map old persisted statuses',()=>{
  for(const [status,emoji] of [['thinking','💭'],['searching','🔎'],['calculating','🧮'],['plotting','📊'],['examining image','👁️'],['preparing answer','✍️']])assert.ok(statusText(status!,'running').startsWith(emoji!));
  assert.equal(statusText('reasoning','running'),'💭 thinking...');assert.match(statusText('queued · priority position 2','queued'),/⏳ queued/);
});
