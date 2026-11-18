import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QotdStore } from '../src/qotd/store.js';
import { ProtectedContentError, guardImages, guardOutput, guardPublication, guardRequest, guardSemanticRequest, loadProtectedProblems, protectionVersion } from '../src/service/mpotd-guard.js';

const problem = {id:1, posted:true, question:'A polygon has 17 sides. How many diagonals meet none of 4 consecutive vertices?',
  answer:'123', solution:'Exclude the diagonals incident to the four specified vertices using complementary counting.',
  message:'298457510082256788',thread:'298457510082256788'};

test('read-only bank includes reserved and uncertain sessions, closed/unrevealed and legacy records until the recorded reveal',()=>{
  const dir=mkdtempSync(join(tmpdir(),'aleph-guard-')), path=join(dir,'q.sqlite'), bank=new QotdStore(path);
  try {
    const db=bank.db, q={text:problem.question,officialAnswer:'old',officialSolution:'old solution'};
    db.prepare('INSERT INTO qotd_questions(id,fingerprint,payload,state,flags,crop) VALUES(?,?,?,?,?,?)').run('q','finger',JSON.stringify(q),'approved','[]','{}');
    for (const [i,state] of ['reserved','uncertain','posted','posted'].entries()) {
      db.prepare('INSERT INTO qotd_history(id,guild,day,question,channel,state,message,created) VALUES(?,?,?,?,?,?,?,?)').run(i+1,'guild',String(i),'q','ch',state,problem.message,0);
      if(i!==3) db.prepare('INSERT INTO qotd_sessions(id,openedAt,closesAt,revealAt,scoredAt,snapshot,notices) VALUES(?,0,1,2,3,?,?)').run(i+1,JSON.stringify({expectedAnswer:problem.answer,solution:problem.solution}),'[]');
    }
    assert.deepEqual(loadProtectedProblems('other',path),[]);
    const rows=loadProtectedProblems('guild',path);
    assert.deepEqual(rows.map(r=>r.id),[1,2,3,4]);assert.equal(rows[2]!.answer,problem.answer);
    db.exec("INSERT INTO qotd_reveals VALUES(3,'posted','msg'),(4,'posted','legacy-msg')");
    assert.deepEqual(loadProtectedProblems('guild',path).map(r=>r.id),[1,2,3]);
    db.exec("UPDATE qotd_sessions SET revealedAt=9,state='revealed' WHERE id=3");
    assert.deepEqual(loadProtectedProblems('guild',path).map(r=>r.id),[1,2]);
    assert.throws(()=>loadProtectedProblems('guild',join(dir,'missing.sqlite')),ProtectedContentError);
    db.exec('DROP TABLE qotd_sessions');
    assert.throws(()=>loadProtectedProblems('guild',path),ProtectedContentError);
    db.exec('PRAGMA user_version=2');
    assert.deepEqual(loadProtectedProblems('guild',path).map(r=>r.id),[1,2]);
  } finally { bank.close();rmSync(dir,{recursive:true,force:true}); }
});

test('copied and paraphrased problems, referenced messages, indirect tool input and solutions are embargoed',()=>{
  for(const value of [problem.question, 'For this 17-sided polygon, count diagonals avoiding four adjacent vertices.',
    'can you check my answer to today’s daily problem?', {query:'give me a hint for the mpotd'}, {channel:problem.thread},
    'how do i solve the mpotd and submit?',
    {task:'verify this proof',context:problem.solution}])assert.throws(()=>guardRequest([problem],value),ProtectedContentError);
  assert.throws(()=>guardOutput([problem],problem.solution),ProtectedContentError);
  for (const value of ['what is a polygon?', 'what is 17+4?', 'how do mpotd points work?', 'explain binomial coefficients', '123']) {
    assert.doesNotThrow(()=>guardRequest([problem],value));
  }
  assert.doesNotThrow(()=>guardRequest([],problem.question));
});

test('an active embargo requires complete ordered image transcriptions, with no answer key or solution in the call',async()=>{
  const img={type:'image_url',image_url:{url:'data:image/jpeg;base64,AAAA'}};
  const response=(rows:unknown[])=>({choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[
    {id:'t1',type:'function',function:{name:'record_transcription',arguments:JSON.stringify({images:rows})}}]}}]});
  await guardImages([], [img],async()=>{throw new Error('unexpected model call')});
  let calls=0;
  await guardImages([problem],[img],async(messages,tools)=>{
    calls++;
    assert.ok(JSON.stringify(messages).includes(img.image_url.url));
    assert.ok(!JSON.stringify(messages).includes(problem.solution));assert.equal(tools?.[0]?.function.name,'record_transcription');
    return response([{complete:true,assessment:'unrelated',description:'a photo of a blue sunflower on a red desk'}]);
  });
  assert.equal(calls,1);
  for (const r of [response([{complete:true,assessment:'unrelated',description:problem.question}]),
    response([{complete:true,assessment:'related',description:'a rotated graph with renamed labels'}]),response([{complete:false,description:'illegible diagram'}]),
    response([]),{},new Error()]) await assert.rejects(guardImages([problem],[img],async()=>r),ProtectedContentError);
});

test('semantic screening checks indirect questions, omits secrets, and fails closed on ambiguity and unpublished references',async()=>{
  const reply=(assessment:string)=>({choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,
    tool_calls:[{id:'g',type:'function',function:{name:'classify_competition_request',arguments:JSON.stringify({assessment})}}]}}]});
  const prompt='does my proof that those paths are forbidden make sense?';
  await guardSemanticRequest([problem],'how are you doing?',async()=>assert.fail('unnecessary call'));
  await guardSemanticRequest([problem],'how do i multiply fractions?',async messages=>{
    const data=JSON.stringify(messages);
    assert.ok(data.includes(problem.question));assert.ok(!data.includes(problem.solution));assert.ok(!data.includes(problem.answer));
    assert.ok(!data.includes(problem.message));return reply('unrelated');
  });
  for(const assessment of ['related','uncertain','invalid'])
    await assert.rejects(guardSemanticRequest([problem],prompt,async()=>reply(assessment)),ProtectedContentError);
  await assert.rejects(guardSemanticRequest([problem],'ilan ang natitirang guhit kapag inalis ang magkakatabi?',async()=>reply('related')),ProtectedContentError);
  await assert.rejects(guardSemanticRequest([{...problem,posted:false}],prompt,async()=>assert.fail('unpublished question left the host')),ProtectedContentError);
});

test('publication rechecks current text, thread and the image-review version after a restart',()=>{
  const job={prompt:'help',answer:'a flower',channel:'elsewhere',images:'[{"url":"u"}]'};
  const version=protectionVersion([problem]);
  assert.doesNotThrow(()=>guardPublication([problem],job,version));
  assert.throws(()=>guardPublication([problem],job,protectionVersion([])),ProtectedContentError);
  assert.throws(()=>guardPublication([problem],{...job,images:'[]'},protectionVersion([])),ProtectedContentError);
  assert.throws(()=>guardPublication([problem],{...job,context:JSON.stringify({reply:{id:problem.message}})},version),ProtectedContentError);
  assert.throws(()=>guardPublication([problem],{...job,answer:problem.solution},version),ProtectedContentError);
  assert.doesNotThrow(()=>guardPublication([],{...job,answer:problem.solution},version));
});

test('classified diagrams require a current source audience, the actual posted crop and a matching asset hash',async()=>{
  const root=mkdtempSync(join(tmpdir(),'aleph-guard-asset-'));
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA60AAAAASUVORK5CYII=','base64');
  const image={path:join(root,'question.png'),sha256:createHash('sha256').update(png).digest('hex')};
  const ref={...problem,sourceChannel:'398457510082256788',visualReference:{root,images:[image]}};
  const prompt='is the vertical line important?';
  const response={choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,
    tool_calls:[{id:'t',type:'function',function:{name:'classify_competition_request',arguments:'{"assessment":"unrelated"}'}}]}}]};
  try {
    writeFileSync(image.path,png);
    let calls=0;
    const complete=async(chat:unknown)=>{calls++;const json=JSON.stringify(chat);assert.ok(json.includes(png.toString('base64')));
      assert.ok(!json.includes(problem.question));assert.ok(!json.includes(problem.solution));return response;};
    await assert.rejects(guardSemanticRequest([ref],prompt,complete),ProtectedContentError);
    await assert.rejects(guardSemanticRequest([ref],prompt,complete,async()=>{throw new Error('denied')}),ProtectedContentError);
    assert.equal(calls,0);
    const allow=async(references:{channel:string;message:string;official:boolean}[])=>
      assert.deepEqual(references,[{channel:'398457510082256788',message:problem.message,official:false}]);
    await guardSemanticRequest([ref],prompt,complete,allow);assert.equal(calls,1);
    writeFileSync(image.path,Buffer.concat([png,Buffer.from('x')]));
    await assert.rejects(guardSemanticRequest([ref],prompt,complete,allow),ProtectedContentError);assert.equal(calls,1);
    await assert.rejects(guardSemanticRequest([{...ref,visualReference:{root:join(root,'absent'),images:[image]}}],prompt,complete,allow),ProtectedContentError);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('publication screens context text and references without matching timestamps or witness metadata',()=>{
 const p={...problem,question:'2026 11 17 04 39 38',answer:'a secret answer',solution:'a secret solution'};
 const anchor='900000000000000001',channel='700000000000000001';
 const context={version:1,anchorMessageId:anchor,channelId:channel,capturedAt:1794890378808,audience:'0543fda5ac3b3f4aec6b11cef7e7a3a8c0f28892656d54025dde89442e44a729',chain:[],recent:[{id:'800000000000000001',author:{id:'600000000000000001',name:'ordinary account',bot:false,relation:'other'},content:'hello there',timestamp:'2026-11-17T04:39:38Z',images:[],digest:'6540b979e93d04d283e540a0320dd04757ea8a39e9b9d7063ce1cba2dddafb93'}]};
 const job={prompt:'who are you',answer:"i'm aleph-zero",channel,sourceMessageId:anchor,context:JSON.stringify(context)};
 // Since the 2026-11-18 false-positive fix the request guard also ignores timestamps, ids and other
 // metadata; it used to block this harmless context, which is how "gta 6" search results were refused.
 assert.doesNotThrow(()=>guardRequest([p],job.context));
 assert.throws(()=>guardRequest([p],JSON.stringify({...context,recent:[{...context.recent[0],content:p.question}]})),ProtectedContentError);
 assert.doesNotThrow(()=>guardPublication([p],job,protectionVersion([p])));
 for(const changed of [{...context,recent:[{...context.recent[0],content:p.question}]},{...context,recent:[{...context.recent[0],id:p.message}]},{...context,channelId:'600000000000000001'}])assert.throws(()=>guardPublication([p],{...job,context:JSON.stringify(changed)},protectionVersion([p])),ProtectedContentError);
});
