import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { parseManual } from '../src/qotd/parser.js';
import { openPdf } from '../src/qotd/pdf.js';
import { QuestionRenderer, cropRegions, overrideImages } from '../src/qotd/crops.js';
import { QotdStore } from '../src/qotd/store.js';
import { createReviewServer } from '../src/qotd/review-ui.js';
import { resetDevelopmentQotd } from '../src/qotd/reset.js';
import { postDaily, questionMessage, revealAnswer } from '../src/qotd/posting.js';
import { phimo, syntheticPdf } from './qotd-fixtures.js';
async function fixture(pages=phimo,decorations:string[]=[]) {
  const dir=mkdtempSync(join(tmpdir(),'qotd-crop-test-'));const file=join(dir,'source.pdf');writeFileSync(file,syntheticPdf(pages,decorations));
  const pdf=await openPdf(file);const parsed=parseManual(pdf.pages.map(p=>p.text));
  const renderer=new QuestionRenderer(pdf,join(dir,'crops'));
  for(const q of parsed.questions)q.crop=await renderer.question(q);
  return {dir,pdf,parsed,async close(){await pdf.close();rmSync(dir,{recursive:true,force:true});}};
}
test('renders original PDF crops and boundaries exclude next question, headings and answers',async()=>{
  const f=await fixture();try {
    assert.equal(f.parsed.questions.length,2);
    for(const q of f.parsed.questions) {
      assert.equal(q.crop!.status,'generated',JSON.stringify(q.crop));
      assert.ok(q.crop!.images.every(i=>i.width>0&&i.height>0));
      assert.equal(readFileSync(q.crop!.images[0]!.path).subarray(1,4).toString(),'PNG');
      for(const r of cropRegions(q,f.pdf.pages)) {
        const lines=f.pdf.pages[r.page-1]!.lines.filter(l=>l.top>=r.top&&l.top<r.bottom);
        assert.ok(lines.every(l=>!/^Answer:|^Solution[.:]/.test(l.text)));
        assert.ok(lines.every(l=>!new RegExp(`^${q.number+1}\\.`).test(l.text)));
      }
    }
  }finally{await f.close();}
});
test('original vector diagrams survive even though they are absent from extracted text',async()=>{
  const pages=['LOGICAL THINKING\n1. Identify the red square shown below.\n\n\n\n\n\n\n2. Find the next integer after 8.\nVTAMPS 24 Secondary 3 Set 1',
    '1. Identify the red square shown below.\nAnswer: square\nSolution. It has four sides.\n2. Find the next integer after 8.\nAnswer: 9\nSolution. Add one.'];
  const f=await fixture(pages,['1 0 0 rg 80 675 40 40 re f']);try{
    const q=f.parsed.questions[0]!;assert.equal(q.crop!.status,'generated');
    const img=await loadImage(q.crop!.images[0]!.path);const c=createCanvas(img.width,img.height);const ctx=c.getContext('2d');ctx.drawImage(img,0,0);const pixels=ctx.getImageData(0,0,c.width,c.height).data;
    let red=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i]!>200&&pixels[i+1]!<30&&pixels[i+2]!<30)red++;
    assert.ok(red>1000,'diagram pixels were preserved');
  }finally{await f.close();}
});
test('multi-page questions produce ordered images including continuation choices',async()=>{
  const pages=['PART 1: MULTIPLE CHOICE\n1. Select the correct source option on the next page.\nVTAMPS PHIMO FRR 26 Secondary 3 Set 1',
    'A. First choice B. Second choice\nPART 2: OPEN-ENDED\n2. What follows the integer seven?\nVTAMPS PHIMO FRR 26 Secondary 3 Set 1',
    'PART 1: MULTIPLE CHOICE\n1. Select the correct source option on the next page.\nA. First choice B. Second choice\nAnswer: A\nSolution: This is the source.\nPART 2: OPEN-ENDED\n2. What follows the integer seven?\nAnswer: 8\nSolution: Count one more.'];
  const f=await fixture(pages);try{
    const q=f.parsed.questions[0]!;assert.equal(q.crop!.status,'generated',JSON.stringify(q.crop));
    assert.deepEqual(q.crop!.images.map(i=>i.page),[1,2]);assert.deepEqual(q.choices.map(c=>c.label),['A','B']);
  }finally{await f.close();}
});
test('unconfident crop fails closed and cannot be approved',async()=>{
  const f=await fixture();const store=new QotdStore(':memory:');try{
    const q=f.parsed.questions[0]!;q.questionRange!.separateListing=false;q.crop=await new QuestionRenderer(f.pdf,join(f.dir,'failed')).question(q);
    assert.equal(q.crop.status,'failed');assert.deepEqual(q.crop.images,[]);
    store.import('source','x.pdf','source.pdf',3,f.parsed);const pending=store.list().find(x=>x.number===q.number)!;
    assert.throws(()=>store.review(pending.id,'approved','operator',true,true),/crop/);
    assert.equal(store.claim('guild','channel','2026-01-01'),null);
  }finally{store.close();await f.close();}
});
test('crop approval requires both acknowledgements and detects changed image bytes',async()=>{
  const f=await fixture();const store=new QotdStore(':memory:');try{
    store.import('source','x.pdf','source.pdf',3,f.parsed);const q=store.list()[0]!;
    assert.throws(()=>store.review(q.id,'approved','operator',true,false));
    assert.throws(()=>store.review(q.id,'approved','operator',false,true));
    store.review(q.id,'approved','operator',true,true);writeFileSync(q.crop.images[0]!.path,'tampered');
    assert.throws(()=>store.claim('guild','channel','2026-01-01'),/changed/);assert.equal(store.history('guild').length,0);
  }finally{store.close();await f.close();}
});
test('image replacement revokes approval without changing official fields or used history',async()=>{
  const f=await fixture();const store=new QotdStore(':memory:');try{
    store.import('source','x.pdf','source.pdf',3,f.parsed);const q=store.list()[0]!;store.review(q.id,'approved','operator',true,true);
    store.claim('guild','channel','2026-01-01');
    const replacement=await overrideImages([readFileSync(q.crop.images[0]!.path)],join(f.dir,'overrides'));store.replaceCrop(q.id,replacement,'operator');
    const changed=store.get(q.id)!;assert.equal(changed.state,'pending');assert.equal(changed.cropReviewed,false);assert.equal(changed.officialAnswer,q.officialAnswer);assert.equal(store.history('guild').length,1);
    store.review(q.id,'approved','operator',true,true);assert.equal(store.claim('guild','channel','2026-01-02'),null);
  }finally{store.close();await f.close();}
});
test('immediate daily posting shows crops, private button and only the configured role mention',async()=>{
  const f=await fixture();const store=new QotdStore(':memory:');try{
    store.import('source','x.pdf','source.pdf',3,f.parsed);
    for(const q of store.list())store.review(q.id,'approved','operator',true,true);
    const role='123456789012345678';const mcq=store.list('approved').find(q=>q.kind==='mcq')!;
    const payload=questionMessage(mcq,'2026-09-13',role);
    assert.ok(payload.content!.startsWith(`<@&${role}> **New Math Problem of the Day!**`));
    assert.deepEqual(payload.allowedMentions,{parse:[],roles:[role]});assert.equal(payload.poll,undefined);assert.equal(payload.components!.length,1);
    assert.equal(payload.files!.length,mcq.crop.images.length);assert.ok(!JSON.stringify(payload).includes(mcq.text));assert.ok(!JSON.stringify(payload).includes(mcq.officialSolution));
    const open=store.list('approved').find(q=>q.kind==='open')!;assert.equal(questionMessage(open).poll,undefined);
    const sent: import('discord.js').MessageCreateOptions[] = [];
    await postDaily(store,'guild','channel',async p=>{
      sent.push(p);
      return {id:`message-${sent.length}`};
    },'2026-09-13',undefined,Date.parse('2026-09-13T08:00:00+08:00'));

    assert.ok(sent[0]!.files?.length);

    assert.equal(sent.length,1);
    assert.equal(sent[0]!.poll,undefined);

    const afterFirstPost=sent.length;

    await postDaily(store,'guild','channel',async p=>{
      sent.push(p);
      return{id:'unexpected'};
    },'2026-09-13',undefined,Date.parse('2026-09-13T08:00:00+08:00'));

    assert.equal(sent.length,afterFirstPost);
  }finally{store.close();await f.close();}
});
test('local review UI displays crops and protects approval from missing acknowledgement and foreign requests',async()=>{
  const f=await fixture();const store=new QotdStore(':memory:');store.import('source','x.pdf',join(f.dir,'source.pdf'),3,f.parsed);
  const server=createReviewServer(store,f.dir,0);const base=`http://127.0.0.1:${server.port}`;
  try{
    const html=await(await fetch(base)).text();assert.match(html,/Student-facing crop preview/);assert.match(html,/sourceReviewed/);
    const token=html.match(/const reviewToken="([^"]+)"/)![1]!;
    const q=store.list()[0]!;assert.equal((await fetch(base+`/api/crop/${q.id}/0`)).status,200);
    const url=base+'/api/review/'+q.id;
    const post=(body:unknown,origin=base,auth=token)=>fetch(url,{method:'POST',headers:{'content-type':'application/json',origin,'x-review-token':auth},body:JSON.stringify(body)});
    assert.equal((await post({state:'approved'},'https://example.com')).status,403);
    assert.equal((await post({state:'approved'},base,'wrong')).status,403);
    assert.ok(!(await post({state:'approved',acknowledgeSource:true})).ok);
    assert.equal(store.get(q.id)!.state,'pending');
    assert.ok((await post({state:'approved',acknowledgeSource:true,acknowledgeCrop:true})).ok);
    assert.equal(store.get(q.id)!.state,'approved');
  }finally{server.stop(true);store.close();await f.close();}
});
test('explicit local reset discards only isolated QOTD state; refuses unrelated and production databases',()=>{
  const dir=mkdtempSync(join(tmpdir(),'qotd-reset-'));const path=join(dir,'qotd.sqlite');
  try{
    const legacy=new DatabaseSync(path);legacy.exec("CREATE TABLE qotd_questions(state TEXT);INSERT INTO qotd_questions VALUES('approved');CREATE TABLE qotd_history(id INTEGER);INSERT INTO qotd_history VALUES(1)");legacy.close();
    assert.throws(()=>new QotdStore(path),/Legacy/);
    const source=join(dir,'manual.pdf');writeFileSync(source,'source');const ai=join(dir,'development.sqlite');writeFileSync(ai,'untouched');
    assert.throws(()=>resetDevelopmentQotd(path,dir,'production',true));assert.throws(()=>resetDevelopmentQotd(path,dir,'development',false));
    assert.deepEqual(resetDevelopmentQotd(path,dir,'development',true),{reset:true,questions:1,approved:1,history:1});
    assert.ok(!existsSync(path));assert.equal(readFileSync(source,'utf8'),'source');assert.equal(readFileSync(ai,'utf8'),'untouched');
    const unrelated=new DatabaseSync(path);unrelated.exec('CREATE TABLE jobs(id INTEGER)');unrelated.close();
    assert.throws(()=>resetDevelopmentQotd(path,dir,'development',true),/not an isolated/);assert.ok(existsSync(path));
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('answer reveals wait until 22 Manila, use official fields and never send twice',async()=>{
  const f=await fixture();const store=new QotdStore(':memory:');try{
    store.import('source','x.pdf','source.pdf',3,f.parsed);for(const q of store.list())store.review(q.id,'approved','operator',true,true);
    const opened=Date.parse('2026-09-13T08:00:00+08:00');
    await postDaily(store,'guild','channel',async()=>({id:'question-message'}),'2026-09-13',undefined,opened);
    const row=store.history('guild')[0]!;const id=Number(row.id);let sent=0;
    const send=async(payload:import('discord.js').MessageCreateOptions)=>{sent++;if(sent===1)assert.ok(payload.content!.includes(store.get(String(row.question))!.officialAnswer));return{id:'answer-message'};};
    await assert.rejects(revealAnswer(store,'guild',id,'operator',send,opened),/not due/);assert.equal(sent,0);
    await revealAnswer(store,'guild',id,'operator',send,opened+14*60*60*1000);
    await revealAnswer(store,'guild',id,'operator',send,opened+15*60*60*1000);assert.equal(sent,2);
  }finally{store.close();await f.close();}
});
