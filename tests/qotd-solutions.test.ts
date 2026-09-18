import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCanvas,loadImage} from '@napi-rs/canvas';
import {openPdf} from '../src/qotd/pdf.js';
import {hash,parseManual,fingerprint} from '../src/qotd/parser.js';
import {QuestionRenderer,solutionRegions} from '../src/qotd/crops.js';
import {QotdStore} from '../src/qotd/store.js';
import {Competition} from '../src/qotd/competition.js';
import {prepareSolutionCrop} from '../src/qotd/solutions.js';
import {revealAnswer,revealMessages} from '../src/qotd/posting.js';
import {dayTimes} from '../src/qotd/periods.js';
import {phimo,syntheticPdf} from './qotd-fixtures.js';

async function fixture(pages=phimo,decorations:string[]=[]) {
  const directory=mkdtempSync(join(tmpdir(),'qotd-solutions-')),path=join(directory,'source.pdf');
  const bytes=syntheticPdf(pages,decorations);writeFileSync(path,bytes);
  const pdf=await openPdf(path),parsed=parseManual(pdf.pages.map(p=>p.text));
  const renderer=new QuestionRenderer(pdf,join(directory,'crops'));
  for(const q of parsed.questions)q.crop=await renderer.question(q);
  return {directory,path,bytes,pdf,parsed,renderer,async close(){await pdf.close();rmSync(directory,{recursive:true,force:true});}};
}
const day='2026-09-17',times=dayTimes(day),guild='111111111111111111',channel='222222222222222222',message='333333333333333333',user='444444444444444444';
function session(f:Awaited<ReturnType<typeof fixture>>,number=1,old=false) {
  const store=new QotdStore(':memory:'),c=new Competition(store);
  if(old)for(const q of f.parsed.questions)delete q.solutionRange;
  store.import(hash(f.bytes),'meaningless (2).pdf',f.path,f.pdf.pages.length,f.parsed);
  const question=store.list().find(q=>q.number===number)!;
  store.review(question.id,'approved','mod',true,true);
  const selected=store.claim(guild,channel,day)!;c.create(selected.claim.id,selected.question,times.opensAt);store.finish(selected.claim.id,message);
  return {store,c,s:c.session(selected.claim.id)!};
}

test('solution uses its own page/bounds; original question pixels and crop bounds stay unchanged',async()=>{
  const f=await fixture();try{
    const q=f.parsed.questions[0]!,before=q.crop!;
    const result=await f.renderer.solution(q);
    assert.equal(result.status,'generated',JSON.stringify(result));assert.deepEqual(result.images.map(i=>i.page),[2]);
    const region=solutionRegions(q,f.pdf.pages)[0]!;
    const lines=f.pdf.pages[1]!.lines.filter(l=>l.top>=region.top&&l.top<region.bottom).map(l=>l.text);
    assert.ok(lines.some(l=>l.includes('Solution:')));assert.ok(!lines.some(l=>l.includes('Answer:')||l.includes('bag holds')));
    assert.notDeepEqual(result.images.map(i=>i.rect),before.images.map(i=>i.rect));
    assert.deepEqual(await f.renderer.question(q),before);
  }finally{await f.close();}
});
test('multi-page solution includes its final continuation, even with numbered proof steps',async()=>{
  const f=await fixture();try{
    const q=f.parsed.questions[1]!,crop=await f.renderer.solution(q);
    assert.equal(crop.status,'generated',JSON.stringify(crop));assert.deepEqual(crop.images.map(i=>i.page),[2,3]);
    const last=solutionRegions(q,f.pdf.pages).at(-1)!;
    assert.ok(f.pdf.pages[2]!.lines.some(l=>l.text.includes('result remains')&&l.top>=last.top&&l.bottom<last.bottom));
    assert.ok(crop.images.every(i=>readFileSync(i.path).subarray(1,4).toString()==='PNG'));
  }finally{await f.close();}
});
test('tall solution preserves bottom vector ink below the final text line',async()=>{
  const pages=[
    'ALGEBRA\n1. Find the total after the displayed calculation.\n2. Find the next integer after seven.\nVTAMPS 24 Secondary 3 Set 1',
    '1. Find the total after the displayed calculation.\nAnswer: 94\nSolution: Work through each step.\n'+Array.from({length:30},(_,i)=>`Step ${i+1}: preserve this equation.`).join('\n')+'\n\n\n\n\n2. Find the next integer after seven.\nAnswer: 8\nSolution: Add one.\nVTAMPS 24 Secondary 3 Set 1',
  ];
  // Last text baseline is 312; this red vector extends below it into the blank
  // solution area. A text-height or question-height crop would lose it.
  const f=await fixture(pages,['','1 0 0 rg 80 270 40 25 re f']);try{
    const crop=await f.renderer.solution(f.parsed.questions[0]!);assert.equal(crop.status,'generated',JSON.stringify(crop));
    const img=await loadImage(crop.images[0]!.path),canvas=createCanvas(img.width,img.height),ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);
    const pixels=ctx.getImageData(0,0,img.width,img.height).data;let red=0;
    for(let i=0;i<pixels.length;i+=4)if(pixels[i]!>200&&pixels[i+1]!<30&&pixels[i+2]!<30)red++;
    assert.ok(red>8000,'all bottom vector pixels survive');assert.ok(img.height>1000);
  }finally{await f.close();}
});
test('reveal automatically attaches source solution crop, retains normal answer/citation/closing/results',async()=>{
  const f=await fixture();const {store,c,s}=session(f);try{
    const token=c.openModal(s.id,guild,channel,message,user,times.opensAt+1000);c.submit(token,guild,channel,user,s.snapshot.expectedAnswer.trim(),times.opensAt+1000);
    const sent:any[]=[];
    await revealAnswer(store,guild,s.id,'mod',async p=>{sent.push(p);return{id:message};},times.revealAt);
    assert.match(sent[0].content,/Answer:\s+B/);assert.match(sent[0].content,/Source: PHIMO/);
    assert.match(sent[0].content,/Question: page 1/);assert.match(sent[0].content,/Solution: page 2/);
    assert.match(sent[0].content,/submissions (?:are )?closed/i);
    assert.ok(!sent[0].content.includes('The second door is green'));
    assert.equal(sent[0].files[0].name,'solution-1.png');assert.equal(sent[0].files[0].attachment.subarray(1,4).toString(),'PNG');
    assert.ok(sent[1].content.includes(`<@${user}>`));assert.ok(c.results(s.id)[0]!.points!>0);
    assert.equal(c.session(s.id)!.snapshot.solutionCrop!.images[0]!.page,2);
    assert.equal(c.session(s.id)!.snapshot.solutionSource!.sourceId,hash(f.bytes));
    assert.equal(store.get(fingerprint(f.parsed.questions[0]!))!.officialSolution,s.snapshot.solution);
    await revealAnswer(store,guild,s.id,'mod',async()=>{throw new Error('duplicate send');},times.revealAt);
  }finally{store.close();await f.close();}
});
test('old imported payloads and snapshots recover anchors without reimport or data reset',async()=>{
  const f=await fixture();const {store,c,s}=session(f,2,true);try{
    delete s.snapshot.solutionSource;
    store.db.prepare('UPDATE qotd_sessions SET snapshot=? WHERE id=?').run(JSON.stringify(s.snapshot),s.id);
    const prepared=await prepareSolutionCrop(c,s);
    assert.equal(prepared.snapshot.solutionCrop!.status,'generated');
    assert.deepEqual(prepared.snapshot.solutionCrop!.images.map(i=>i.page),[2,3]);
    assert.equal(store.list('approved')[0]!.solutionRange,undefined);
    assert.ok(c.session(s.id)!.snapshot.solutionSource!.range);
  }finally{store.close();await f.close();}
});
test('missing or changed source cannot substitute another solution and does not block scores/results',async()=>{
  const f=await fixture();const {store,c,s}=session(f);try{
    writeFileSync(f.path,'different source bytes');
    const token=c.openModal(s.id,guild,channel,message,user,times.opensAt+1000);c.submit(token,guild,channel,user,'B',times.opensAt+1000);
    const sent:any[]=[];await revealAnswer(store,guild,s.id,'mod',async p=>{sent.push(p);return{id:message};},times.revealAt);
    assert.equal(sent.length,2);assert.match(sent[0].content,/The second door is green/);assert.match(sent[0].content,/Answer:\s+B/);
    assert.ok(c.results(s.id)[0]!.points!>0);assert.ok(c.session(s.id)!.revealedAt);
  }finally{store.close();await f.close();}
});
test('unreliable boundaries fail rather than cropping a partial solution',async()=>{
  const f=await fixture();try{
    const q=f.parsed.questions[0]!;q.solutionRange!.start.line=0;
    const crop=await f.renderer.solution(q);assert.equal(crop.status,'failed');assert.equal(crop.images.length,0);
    delete q.solutionRange;assert.equal((await f.renderer.solution(q)).status,'failed');
  }finally{await f.close();}
});
test('ambiguous numbered proof steps are not accepted as next-question crop bounds',()=>{
  const parsed=parseManual(['1. What is the correct value for the first problem?\n2. What is the correct value for the second problem?',
    '1. What is the correct value for the first problem?\nAnswer: 1\nSolution: First reason.\n2. This is a proof step, not the next problem.\nMore reasoning continues.']);
  assert.equal(parsed.questions[0]!.solutionRange,undefined);
});
test('long fallback keeps answer and citation in Discord text while attaching the worked text',async()=>{
  const f=await fixture();const {store,c,s}=session(f);try{
    s.snapshot.solution='Long official reasoning. '.repeat(200);
    const payload=revealMessages(c,s)[0]!;
    assert.match(payload.content!,/Answer:\s+B/);assert.match(payload.content!,/Source: PHIMO/);
    assert.match(payload.content!,/Question: page 1.*Solution: page 2/);assert.ok(payload.files!.length);
    assert.match(payload.content!,/submissions (?:are )?closed/i);
  }finally{store.close();await f.close();}
});
test('solution next-question anchors tolerate different source line wraps',()=>{
  const parsed=parseManual(['1. Find the first answer in the sequence.\n2. Find the second answer\nin the sequence.',
    '1. Find the first answer in the sequence.\nAnswer: 1\nSolution: Count one.\n2. Find the second answer in the sequence.\nAnswer: 2\nSolution: Count two.']);
  assert.ok(parsed.questions[0]!.solutionRange?.end);
});
test('an actual raster boundary failure falls back without interrupting scoring or results',async()=>{
  const f=await fixture(phimo,['','0 0 0 rg 500 680 3 70 re f']);
  const {store,c,s}=session(f);try{
    assert.equal((await f.renderer.solution(f.parsed.questions[0]!)).status,'failed');
    const token=c.openModal(s.id,guild,channel,message,user,times.opensAt+1000);c.submit(token,guild,channel,user,'B',times.opensAt+1000);
    const sent:any[]=[];await revealAnswer(store,guild,s.id,'mod',async p=>{sent.push(p);return{id:message};},times.revealAt);
    assert.equal(sent.length,2);assert.ok(sent[0].content.includes(s.snapshot.solution));
    assert.ok(sent[1].content.includes(`<@${user}>`));assert.ok(c.results(s.id)[0]!.points!>0);assert.ok(c.session(s.id)!.revealedAt);
  }finally{store.close();await f.close();}
});
test('a vector-only continuation above the next question is retained',async()=>{
  const pages=[
    '1. Identify the final figure in the solution.\n2. Find the next integer after seven.\nVTAMPS 24 Secondary 3 Set 1',
    '1. Identify the final figure in the solution.\nAnswer: square\nSolution: The final diagram continues on the next page.\nVTAMPS 24 Secondary 3 Set 1',
    '2. Find the next integer after seven.\nAnswer: 8\nSolution: Count one more.\nVTAMPS 24 Secondary 3 Set 1',
  ];
  const f=await fixture(pages,['','','1 0 0 rg 80 778 20 8 re f']);try{
    const crop=await f.renderer.solution(f.parsed.questions[0]!);
    assert.equal(crop.status,'generated',JSON.stringify(crop));
    assert.deepEqual(crop.images.map(i=>i.page),[2,3]);
  }finally{await f.close();}
});
test('topic words and internal proof headings do not truncate the remaining solution',async()=>{
  const pages=[
    '1. Find the first answer after a lengthy explanation.\n2. Find the next integer after seven.\nVTAMPS 24 Secondary 3 Set 1',
    '1. Find the first answer after a lengthy explanation.\nAnswer: 94\nSolution: Begin here.\nALGEBRA\nAlgebraically, work through this equation.\nThe final answer is 94.\n2. Find the next integer after seven.\nAnswer: 8\nSolution: Count one more.\nVTAMPS 24 Secondary 3 Set 1',
  ];
  const f=await fixture(pages);try{
    const q=f.parsed.questions[0]!,region=solutionRegions(q,f.pdf.pages)[0]!;
    const last=f.pdf.pages[1]!.lines.find(l=>l.text.includes('final answer is 94'))!;
    assert.ok(region.bottom>last.bottom);assert.equal((await f.renderer.solution(q)).status,'generated');
  }finally{await f.close();}
});
