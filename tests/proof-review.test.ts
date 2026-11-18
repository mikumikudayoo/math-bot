import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {proofObligation,proofRiskHints,parseReview,reviewCaveat} from '../src/service/proof-review.js';
import {grade,type Check} from '../src/scripts/math-eval-grade.js';
import {serviceConfigFrom} from '../src/service/config.js';
import {runner} from '../src/service/inference.js';
import {OpenAIRuntime,installOpenAIRuntime,type ResponsesClient} from '../src/service/openai.js';
import {Store} from '../src/service/store.js';
import {formatDiscord} from '../src/discord-format.js';

// ---------------------------------------------------------------------------
// The production regression: n² + 2ⁿ a perfect square. The reproduced draft has the right
// answer (n = 6) and the invalid "2^(a-1) > 2a + d" bound; the repaired one is complete.
// ---------------------------------------------------------------------------
const PROMPT='find all positive integers n such that n² + 2ⁿ is a perfect square. prove that your answer is complete.';
const FLAWED=[
  'let n² + 2ⁿ = m². then (m − n)(m + n) = 2ⁿ, so both factors are powers of 2:',
  '$$ m - n = 2^{a}, \\quad m + n = 2^{b} \\tag{1} $$',
  'both factors are even, so a ≥ 1, and a + b = n with a < b. subtracting, n = 2^{b-1} − 2^{a-1} = 2^{a-1}(2^{d} − 1) where d = b − a.',
  'so 2^{a-1}(2^{d} − 1) = 2a + d.',
  'for a ≥ 5 we have 2^{a-1} > 2a + d, so the left side is too big.',
  'checking a ≤ 4 leaves only a = 2, d = 2, so n = 6 is the only solution: $\\boxed{n=6}$',
].join('\n');
const REPAIRED=[
  'let n² + 2ⁿ = m². then (m − n)(m + n) = 2ⁿ, so both factors are powers of 2: m − n = 2ᵃ and m + n = 2ᵇ with a < b and a + b = n.',
  'both factors are even (they have the same parity and their product is even), so a ≥ 1.',
  'with d = b − a ≥ 1: n = 2^{a-1}(2^{d} − 1), and a + b = n gives 2^{a-1}(2^{d} − 1) = 2a + d.   (2)',
  'wait, a bound like 2^{a-1} > 2a + d ignores d, so it fails for large d. fixing it: since 2ᵈ − 1 ≥ d for d ≥ 1,',
  '2^{a-1}(2^{d} − 1) ≥ (2^{d} − 1) + (2^{a-1} − 1) ≥ d + 2^{a-1} − 1 > d + 2a when a ≥ 5, so a ≤ 4.',
  'a = 1: 2ᵈ = d + 3, no solution. a = 2: 2^{d+1} = d + 6 gives d = 2. a = 3: 2^{d+2} = d + 10, none. a = 4: 2^{d+3} = d + 16, none.',
  'so a = 2, d = 2, n = 6 (36 + 64 = 100 = 10²) is the only solution.',
  '**n = 6**',
].join('\n');
const problems=JSON.parse(readFileSync('evals/math/problems.json','utf8')) as {id:string;check:Check}[];
const rubric=problems.find(p=>p.id==='proof-n2-plus-2n-square')!.check;

test('regression rubric: n = 6 alone or with the invalid bound fails; the complete argument passes',()=>{
  const flawed=grade(rubric,FLAWED);
  assert.equal(flawed.pass,false,flawed.detail);
  assert.deepEqual(flawed.dimensions,{finalAnswer:true,completeArgument:false,validSteps:false,notation:true},flawed.detail);
  const bare=grade(rubric,'the answer is n = 6.');
  assert.equal(bare.pass,false);assert.equal(bare.dimensions?.finalAnswer,true);assert.equal(bare.dimensions?.completeArgument,false);
  // The repaired draft quotes the bad bound only to reject it; it must still pass.
  const forbiddenFree=REPAIRED.replace('wait, a bound like 2^{a-1} > 2a + d ignores d, so it fails for large d. fixing it: ','');
  const good=grade(rubric,forbiddenFree);
  assert.equal(good.pass,true,good.detail);
  const wrong=grade(rubric,forbiddenFree.replace(/n = 6/g,'n = 8').replace('**n = 6**','**n = 8**'));
  assert.equal(wrong.dimensions?.finalAnswer,false);
  // The production output after the old formatter: residue is a notation failure.
  // The exact production output ("tag{1}", "boxed{n=6}") is a notation failure even with a right answer.
  const residue=grade(rubric,forbiddenFree+'\nso tag{1} holds and boxed{n=6}.');
  assert.equal(residue.dimensions?.notation,false);assert.equal(residue.pass,false);
  assert.equal(grade(rubric,forbiddenFree+'\n$\\unknown{x}$').dimensions?.notation,true,'unknown commands render as call shapes, not residue');
});

test('proof obligation is deterministic and conservative',()=>{
  for(const p of [PROMPT,'prove that √2 is irrational','show that n³ − n is divisible by 6','give me a rigorous proof of the AM-GM inequality',
    'determine all functions f: ℝ → ℝ with f(x + y) = f(x) + f(y)','find all pairs of primes p, q with p + q = 2026','write a proof that there are infinitely many primes'])
    assert.equal(proofObligation(p),true,p);
  for(const p of ['what is 2 + 2','solve x² − 5x + 6 = 0','look at this proof','can you check my proof?','find all x such that x² = 4',
    'give me a hint for proving that √2 is irrational','explain chess','find all the files in my folder'])
    assert.equal(proofObligation(p),false,p);
});

test('risk hints flag the incident bound and numerical evidence, and stay quiet on a clean argument',()=>{
  assert.ok(proofRiskHints('for a ≥ 5, clearly 2^(a-1) > 2a + d for all d.').includes('unsupported_inequality'));
  // The incident's exact shape: a bound conditioned on a while d stays free.
  assert.ok(proofRiskHints('for a ≥ 5 we have 2^{a-1} > 2a + d, so the left side is too big.').includes('unsupported_inequality'));
  assert.deepEqual(proofRiskHints('for a ≥ 5 we have 2^{a-1} > 2a, and d ≥ 1 is handled separately.'),[]);
  assert.ok(proofRiskHints('we checked n up to 1000, so there are no other solutions.').includes('numerical_evidence_as_proof'));
  assert.ok(proofRiskHints('by induction the claim holds.').includes('induction_misuse'));
  assert.deepEqual(proofRiskHints('since 2ᵈ − 1 ≥ d by the binomial theorem, the left side exceeds 2a + d.'),[]);
});

test('review parsing is strict: malformed or contradictory output is never a pass',()=>{
  const reply=(args:unknown,name='record_proof_review')=>({choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'r',type:'function',function:{name,arguments:JSON.stringify(args)}}]}}]});
  assert.deepEqual(parseReview(reply({verdict:'valid',answerCorrect:'yes',issues:[]})),{verdict:'valid',answerCorrect:'yes'});
  assert.equal(parseReview(reply({verdict:'valid',answerCorrect:'no',issues:[]}))?.verdict,'gaps');
  assert.equal(parseReview(reply({verdict:'valid',answerCorrect:'yes',issues:[{category:'algebra_error',step:'x',explanation:'y'}]}))?.verdict,'gaps');
  for(const bad of [reply({verdict:'fine',answerCorrect:'yes',issues:[]}),reply({verdict:'valid'},'other'),{choices:[{message:{role:'assistant',content:'looks valid'}}]},{}])
    assert.equal(parseReview(bad),undefined);
  assert.match(reviewCaveat('unresolved',['unsupported_inequality']),/unsupported inequality/);
});

// ---------------------------------------------------------------------------
// Orchestrator integration with a mocked provider.
// ---------------------------------------------------------------------------
const response=(...output:unknown[])=>({status:'completed',output,usage:{input_tokens:200,output_tokens:60}});
const text=(value:string)=>({type:'message',content:[{type:'output_text',text:value}]});
const call=(name:string,args:unknown)=>({type:'function_call',call_id:'c-'+name,name,arguments:JSON.stringify(args)});
const offered=(params:Record<string,unknown>,name:string)=>(params.tools as {name:string}[]|undefined)?.some(t=>t.name===name)??false;
const verdict=(v:string,issues:unknown[]=[])=>response(call('record_proof_review',{verdict:v,answerCorrect:'yes',issues}));
function fixture(prompt:string,create:ResponsesClient['create'],env:Record<string,string>={}){
  const config=serviceConfigFrom({AI_SERVICE_TOKEN:'fixture-'.repeat(6),AI_PROVIDER:'openai',OPENAI_API_KEY:'sk-fixture-'+'x'.repeat(32),AI_DATABASE:':memory:',AI_SEVEN_AGENT_CHANCE:'0',...env},'production',{},()=>{});
  const store=new Store(':memory:');
  const job=store.admit({id:'400000000000000001',guild:'100000000000000001',channel:'200000000000000001',user:'700000000000000001',coach:false,kind:'ask',prompt,discordContext:'{}'},10);
  const run=runner(config,store,{openai:new OpenAIRuntime(config.openai!,store.db,{create},{backoffMs:()=>0}),protectedProblems:()=>[],random:()=>1});
  return {store,run:()=>run(job,AbortSignal.timeout(5000),()=>{}),close:()=>{installOpenAIRuntime(undefined);store.close();},ledger:()=>store.db};
}

test('a flawed proof draft is reviewed by gpt-6.2-sol, repaired by Luna and only the repaired version is published',async()=>{
  const seen:{model:string;purpose:string;effort?:string|undefined;input:string}[]=[];let lunaTurns=0;
  const create:ResponsesClient['create']=async params=>{
    const input=JSON.stringify(params.input);
    if(offered(params,'record_proof_review')){
      seen.push({model:String(params.model),purpose:'review',effort:(params.reasoning as {effort?:string}).effort,input});
      // A draft without a bound that accounts for d is flagged; the repaired draft has one.
      return !input.includes('2ᵈ − 1 ≥ d')
        ?verdict('gaps',[{category:'unsupported_inequality',step:'2^{a-1} > 2a + d for a ≥ 5',explanation:'fails for large d'}])
        :verdict('valid');
    }
    lunaTurns++;seen.push({model:String(params.model),purpose:'luna',input});
    return response(text(lunaTurns===1?FLAWED:REPAIRED));
  };
  const f=fixture(PROMPT,create);
  try{
    const result=await f.run();
    assert.equal(result.answer,REPAIRED);
    const reviews=seen.filter(s=>s.purpose==='review');
    assert.deepEqual(reviews.map(r=>[r.model,r.effort]),[['gpt-6.2-sol','medium'],['gpt-6.2-sol','medium']]);
    // The reviewer sees only the task and the draft: no persona, history or tools.
    for(const r of reviews){assert.ok(!r.input.includes('Aleph-Zero'));assert.ok(r.input.includes('PROOF_REVIEW_INPUT'));}
    assert.ok(reviews[0]!.input.includes('unsupported_inequality'),'deterministic focus hint reaches the reviewer');
    // Luna's repair turn receives the categorized, untrusted finding.
    assert.ok(seen.filter(s=>s.purpose==='luna')[1]!.input.includes('PROOF_REVIEW'));
    assert.equal(lunaTurns,2);
    const usage=f.ledger().prepare("SELECT model,tier FROM openai_usage ORDER BY id").all() as {model:string;tier:string}[];
    assert.ok(usage.some(u=>u.model==='gpt-6.2-sol'&&u.tier==='proof-review'));
    assert.ok(!usage.some(u=>u.model==='gpt-6.1-sol'),'no inference path selects 6.1 sol by default');
    assert.doesNotMatch(formatDiscord(result.answer),/\\[a-zA-Z]|\b(?:tag|boxed)\{/);
  }finally{f.close();}
});

test('routine requests never pay for a proof review',async()=>{
  let reviews=0;const f=fixture('solve x² − 5x + 6 = 0',async params=>{if(offered(params,'record_proof_review'))reviews++;return response(text('x = 2 or x = 3'));});
  try{assert.equal((await f.run()).answer,'x = 2 or x = 3');assert.equal(reviews,0);}finally{f.close();}
});

test('without Sol quota the review falls back to Luna at high effort, without raising the request class',async()=>{
  const models:string[]=[];
  const f=fixture(PROMPT,async params=>{
    if(offered(params,'record_proof_review')){models.push(params.model+'/'+(params.reasoning as {effort:string}).effort);return verdict('valid');}
    return response(text(REPAIRED));
  },{OPENAI_USER_SOL_PER_DAY:'0'});
  try{assert.equal((await f.run()).answer,REPAIRED);assert.deepEqual(models,['gpt-6-luna/high']);}finally{f.close();}
});

test('a proof that keeps failing review is published with an honest caveat after the bounded cycles',async()=>{
  let reviews=0,luna=0;
  const f=fixture(PROMPT,async params=>{
    if(offered(params,'record_proof_review')){reviews++;return verdict('invalid',[{category:'incomplete_cases',step:'a ≤ 4',explanation:'case a = 3 skipped'}]);}
    luna++;return response(text(FLAWED));
  });
  try{
    const answer=(await f.run()).answer;
    assert.equal(reviews,2);assert.equal(luna,2);
    assert.ok(answer.startsWith(FLAWED));assert.match(answer,/treat that step as unproven/);assert.match(answer,/incomplete cases/);
  }finally{f.close();}
});

test('a reviewer outage does not block the answer and does not pretend it was checked',async()=>{
  const f=fixture(PROMPT,async params=>{
    if(offered(params,'record_proof_review'))throw Object.assign(new Error('down'),{status:401});
    return response(text(REPAIRED));
  });
  try{const answer=(await f.run()).answer;assert.ok(answer.startsWith(REPAIRED));assert.match(answer,/couldn't get an independent check/);}finally{f.close();}
});

test('OPENAI_PROOF_REVIEW=off disables the review; invalid settings fail startup',async()=>{
  let reviews=0;const f=fixture(PROMPT,async params=>{if(offered(params,'record_proof_review'))reviews++;return response(text(FLAWED));},{OPENAI_PROOF_REVIEW:'off'});
  try{assert.equal((await f.run()).answer,FLAWED);assert.equal(reviews,0);}finally{f.close();}
  assert.throws(()=>serviceConfigFrom({AI_SERVICE_TOKEN:'fixture-'.repeat(6),AI_PROVIDER:'openai',OPENAI_API_KEY:'sk-fixture-'+'x'.repeat(32),OPENAI_PROOF_REVIEW:'always'},'production',{},()=>{}),/OPENAI_PROOF_REVIEW/);
  assert.throws(()=>serviceConfigFrom({AI_SERVICE_TOKEN:'fixture-'.repeat(6),AI_PROVIDER:'openai',OPENAI_API_KEY:'sk-fixture-'+'x'.repeat(32),OPENAI_PROOF_REVIEW_EFFORT:'none'},'production',{},()=>{}));
});
