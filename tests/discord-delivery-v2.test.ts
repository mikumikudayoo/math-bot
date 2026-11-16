import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Client, MessageEditOptions } from 'discord.js';
import { DeliveryManager, bindPrimary, deliveryChunks, discordPublisher, progressContent, queuedPayload, recoverPrimary, studyContent, type DeliveryJob } from '../src/delivery.js';
import { formatDiscord, splitDiscordMessage } from '../src/discord-format.js';
import { refusalText } from '../src/service/mpotd-guard.js';

const gid = '111111111111111111', uid = '222222222222222222', channelId = '333333333333333333', main = '444444444444444444';
function job(update: Partial<DeliveryJob> = {}): DeliveryJob {
  return { id:'555555555555555555', guild:gid, user:uid, channel:channelId, state:'running', message:main,
    kind:'ask', coach:false, created:0, delivered:0, status:'thinking', prompt:'math', answer:'', artifact:'', ...update };
}
function progress(stream: string, seq = 1): NonNullable<DeliveryJob['progress']> {
  return {job:'555555555555555555',seq,updated:seq,phase:'output_delta',label:'',recent:[],stream};
}
function fixture() {
  const calls: string[] = [], contents = new Map<string,MessageEditOptions>(), ids: string[] = [], nonces = new Set<string>();
  let next = 0;
  function message(id: string) {
    return {id,async edit(payload: MessageEditOptions) { calls.push('edit/'+id); contents.set(id,payload); }};
  }
  const channel = {
    guildId:gid, isTextBased:() => true, isSendable:() => true,
    messages:{
      async fetch(id: string) { if (!contents.has(id)) throw Object.assign(new Error(),{code:10008}); return message(id); },
      async edit(id: string, payload: MessageEditOptions) { if (!contents.has(id)) throw Object.assign(new Error(),{code:10008}); return message(id).edit(payload); },
    },
    async send(payload: {content:string;nonce:string;enforceNonce:boolean}) {
      assert.ok(payload.enforceNonce); assert.ok(!nonces.has(payload.nonce)); nonces.add(payload.nonce);
      const id = String(600000000000000000n + BigInt(++next)); contents.set(id,{content:payload.content}); calls.push('create/'+id);
      return message(id);
    },
  };
  const client = {channels:{fetch:async() => channel}} as unknown as Client;
  const control = {deny:-1,checks:0,failAck:false,ack:false};
  const request = async <T>(path: string, body?: unknown): Promise<T> => {
    const b = body as {id:string;index:number;message:string;previous?:string;content:string};
    calls.push(path);
    if (path === '/publication') { control.checks++; return {allowed:control.checks !== control.deny} as T; }
    if (path === '/delivery-part') {
      assert.ok(contents.has(b.message)); assert.equal(contents.get(b.message)?.content,'preparing the next part…');
      if (b.previous) assert.equal(b.previous,ids[b.index-1]);
      ids[b.index-1] = b.message;
    }
    if (path === '/delivered') { if (control.failAck) throw new Error('offline'); control.ack = true; }
    return {} as T;
  };
  contents.set(main,{content:'queued'});
  return {client,request,calls,contents,ids,control};
}

test('format tables and math, preserve program indentation and neutralize mass mentions',() => {
  const source = ['# data','| x | y |',
    '| --- | --- |','| 1 | 4 |', '', '\\[','\\frac{1}{\\sqrt{4}} \\leq \\pi','\\]',
    '<b>proof</b> @everyone','```python','if True:','    print("$x$")','```'].join('\n');
  const out = formatDiscord(studyContent(job({state:'completed',answer:source})));
  assert.ok(out.includes('- **x** 1 · **y** 4'));
  assert.ok(out.includes('(1)/(√(4)) ≤ π')); assert.ok(out.includes('proof @\u200beveryone'));
  assert.ok(out.includes('    print("$x$")')); assert.ok(!out.includes('<b>'));
  assert.equal(formatDiscord('one costs $5 and another costs $8'), 'one costs $5 and another costs $8');
  assert.equal(studyContent(job({state:'completed',answer:'-4\n- explain\n    a = 3'})), '-4\n- explain\n    a = 3');
});
test('splitters keep lines, complete equations, unicode, links and code fence language',() => {
  const equation = 'y = x² + 2x − 1', link = '[the source](https://example.org/a)';
  const text = ['a'.repeat(58),equation,'```ts', 'function run() {', '  '+ '🙂'.repeat(120), '}', '```', link].join('\n');
  const parts = splitDiscordMessage(text,80);
  assert.ok(parts.length >= 4);
  for (const part of parts) {
    assert.ok(part.length <= 80); assert.equal((part.match(/^\s*```/gm)?.length ?? 0) % 2,0);
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(part));
  }
  assert.ok(parts.some(s => s.includes(equation))); assert.ok(parts.some(s => s.includes(link)));
  assert.ok(parts.filter(s=>s.includes('```ts')).length >= 2);
  assert.equal(parts.join('').match(/🙂/gu)?.length,120);
});
test('private sources suppress streamed words; labels cannot echo an injected status',() => {
  const row = job({progress:progress('public draft')});
  assert.equal(progressContent(row).content,'public draft');
  row.provenance = JSON.stringify({version:1,classification:'private-discord',discordSources:[],audienceUnknown:true});
  row.progress = {...row.progress!,phase:'tool_started',label:'injected private guild name',stream:'private draft'};
  assert.deepEqual(progressContent(row),{checked:false,content:'working through a tool call.'});
});
test('formatting cannot create a private outbound target or join an ID that was previously separated',() => {
  const privateJob = job({provenance:JSON.stringify({classification:'private-discord',discordSources:[{guildId:gid,channelId}],audienceUnknown:false})});
  const raw = 'see https://example.org/ok and private<b></b>.ph or 123456789<b></b>123456789';
  const answer = deliveryChunks(privateJob,raw).join('');
  assert.ok(answer.includes('https://example.org/ok')); assert.ok(!answer.includes('private.ph'));
  assert.ok(!answer.includes('123456789123456789'));
  assert.ok(!deliveryChunks(job(),'ht<b></b>tps://new.example/a').join('').includes('https://new.example'));
});
test('coalesces intermediate edits, accepts terminal ahead of cosmetic delays and ignores stale rows',async () => {
  let now = 0;
  const texts: string[] = [];
  const manager = new DeliveryManager(async j => { texts.push(terminalText(j)); }, () => now);
  const run = (text:string,seq:number) => job({progress:progress(text,seq)});
  await manager.update([run('a',1)]); now=500; await manager.update([run('ab',2)]);
  now=1400; await manager.update([run('abc',3)]); now=1500; await manager.update([run('stale',2)]);
  now=1501; await manager.update([job({state:'completed',answer:'final'})]);
  now=3000; await manager.update([run('after',5)]); assert.deepEqual(texts,['a','abc','final']);
});
function terminalText(j: DeliveryJob) { return j.state === 'running' ? progressContent(j).content : j.answer; }
test('an in-flight slow progress edit cannot land after cancellation',async () => {
  let resume!: () => void;
  const wait = new Promise<void>(resolve => {resume = resolve;});
  const writes: string[] = [];
  const manager = new DeliveryManager(async (j,current) => {
    if (j.state === 'running') await wait;
    if (current()) writes.push(j.state);
  });
  const running = manager.update([job({progress:progress('old')})]);
  const cancel = job({state:'cancelled',answer:'cancelled'}); await manager.update([cancel]);
  resume(); await running; await manager.update([cancel]); assert.deepEqual(writes,['cancelled']);
});
test('honors retry-after on 429 with terminal superseding pending progress',async () => {
  let now = 0, attempts = 0;
  const writes: string[] = [];
  const manager = new DeliveryManager(async j => {
    if (!attempts++) throw {status:429,rawError:{retry_after:3}};
    writes.push(j.state);
  },()=>now);
  await manager.update([job()]); const done = job({state:'completed'});
  now=2999; await manager.update([done]); assert.deepEqual(writes,[]);
  now=3000; await manager.update([done]); assert.deepEqual(writes,['completed']);
});
test('full publication persists each safe placeholder before text; restart after lost ack reuses all IDs and puts artifact last',async () => {
  const f=fixture(); const j=job({state:'completed',answer:['a'.repeat(1700),'b'.repeat(1700),'c'.repeat(1700)].join('\n'),artifact:'aQ=='});
  f.control.failAck=true;
  await assert.rejects(discordPublisher(f.client,f.request)(j,()=>true));
  assert.equal(f.ids.length,2); assert.equal(f.control.checks,3);
  assert.equal(f.contents.get(main)?.content,'a'.repeat(1700));
  assert.equal(f.contents.get(main)?.files?.length,0); assert.equal(f.contents.get(f.ids[0]!)?.files?.length,0);
  assert.equal(f.contents.get(f.ids[1]!)?.files?.length,1);
  f.control.failAck=false;
  await discordPublisher(f.client,f.request)({...j,deliveryParts:[...f.ids]},()=>true);
  assert.equal(f.ids.length,2); assert.ok(f.control.ack); assert.equal(f.calls.filter(x=>x.startsWith('create/')).length,2);
});
test('a newly imposed embargo mid-publication scrubs every known part and artifact',async () => {
  const f=fixture(); const j=job({state:'completed',answer:'one'.repeat(500)+'\n'+'two'.repeat(500),artifact:'aQ=='});
  f.control.deny=2; await discordPublisher(f.client,f.request)(j,()=>true);
  assert.ok(f.control.ack); assert.equal(f.ids.length,1);
  for (const p of f.contents.values()) { assert.ok(!p.content?.includes('oneone')); assert.ok(!p.content?.includes('twotwo')); assert.deepEqual(p.attachments,[]); assert.deepEqual(p.files,[]); }
});
test('a running stream identifies its exact approved snapshot and withdraws it if the service has moved on',async () => {
  const f=fixture(), j=job({progress:progress('draft text',7)});
  let sent:unknown;
  const request=async<T>(path:string,body?:unknown):Promise<T>=>{
    assert.equal(path,'/publication'); sent=body; return {allowed:false} as T;
  };
  await discordPublisher(f.client,request)(j,()=>true);
  assert.deepEqual(sent,{id:j.id,content:'draft text',streamSeq:7,streamUpdated:7});
  assert.ok(!f.contents.get(main)?.content?.includes('draft text'));
});
test('a single oversized mathematical expression is preserved whole in a checked text attachment',async () => {
  const f=fixture(), answer='y = '+Array(1100).fill('x').join(' + ');
  await discordPublisher(f.client,f.request)(job({state:'completed',answer}),()=>true);
  assert.equal(f.ids.length,0); assert.equal(f.control.checks,1);
  const p=f.contents.get(main)!;
  assert.match(String(p.content),/text attachment/);
  const file=p.files?.[0] as {name:string;attachment:Buffer};
  assert.equal(file.name,'answer.txt'); assert.equal(file.attachment.toString(),answer);
});
test('Discord permission refusal reaches the primary without content, files or additional model text',async () => {
  const f=fixture(); const j=job({state:'completed',answer:'private sentinel',artifact:'aQ==',
    provenance:JSON.stringify({classification:'private-discord',audienceUnknown:true,discordSources:[]})});
  await discordPublisher(f.client,f.request)(j,()=>true);
  assert.ok(f.control.ack); assert.equal(f.control.checks,0); assert.match(String(f.contents.get(main)?.content),/can't safely share/);
  assert.deepEqual(f.contents.get(main)?.attachments,[]);
});
test('missing known continuation is replaced using compare-and-swap on the durable ID',async () => {
  const f=fixture(); const j=job({state:'completed',answer:'a'.repeat(1800)+'\n'+'b'.repeat(1800)});
  await discordPublisher(f.client,f.request)(j,()=>true);
  const old=f.ids[0]!; f.contents.delete(old);
  await discordPublisher(f.client,f.request)({...j,deliveryParts:[old]},()=>true);
  assert.notEqual(f.ids[0],old); assert.equal(f.ids.length,1);
});
test('the host embargo refusal and ordinary failure text go through publication unchanged',async () => {
  for (const answer of [refusalText,'the calculation timed out.']) {
    const f=fixture();
    await discordPublisher(f.client,f.request)(job({state:'failed',answer}),()=>true);
    assert.equal(f.contents.get(main)?.content,answer); assert.equal(f.control.checks,1);
  }
});
test('unbound recovery deduplicates a reply after a persisted bind acknowledgement is lost',async () => {
  const row=job({message:'',sourceMessageId:'666666666666666666'}), nonce=queuedPayload(row.id).nonce;
  let attempts=0,created=0;
  const replies=new Map<string,{id:string;delete:()=>Promise<void>}>();
  const destination={guildId:gid,isSendable:()=>true,async send(payload: ReturnType<typeof queuedPayload> & {reply?:{messageReference:string}}) {
    assert.equal(payload.nonce,nonce); assert.equal(payload.enforceNonce,true); assert.equal(payload.reply?.messageReference,row.sourceMessageId);
    assert.ok(!payload.content.includes(row.answer || 'secret'));
    if (!replies.has(nonce)) { created++; replies.set(nonce,{id:main,delete:async()=>{assert.fail('must retain the canonical reply');}}); }
    return replies.get(nonce);
  }};
  const client={channels:{fetch:async()=>destination}} as unknown as Client;
  const request=async<T>(path:string,body?:unknown):Promise<T>=>{
    assert.equal(path,'/bind'); assert.deepEqual(body,{id:row.id,message:main});
    if (!attempts++) throw new Error('lost response after first bind');
    return {ok:true,message:main} as T;
  };
  await assert.rejects(recoverPrimary(client,request,row)); await recoverPrimary(client,request,row);
  assert.equal(created,1); assert.equal(attempts,2);
});
test('slash recovery creates a standalone placeholder; conflicting late primary is removed only after service confirmation',async () => {
  const row=job({message:''}); let deleted=false;
  const duplicate={id:'777777777777777777',delete:async()=>{deleted=true;}};
  const destination={guildId:gid,isSendable:()=>true,send:async(payload:ReturnType<typeof queuedPayload>)=>{
    assert.ok(!Object.hasOwn(payload,'reply')); assert.ok(payload.enforceNonce); return duplicate;
  }};
  const request=async<T>()=>({ok:false,message:main}) as T;
  await recoverPrimary({channels:{fetch:async()=>destination}} as unknown as Client,request,row);
  assert.equal(deleted,true); deleted=false;
  await assert.rejects(bindPrimary(async()=>{throw new Error('service offline');},row.id,duplicate as never));
  assert.equal(deleted,false);
});
