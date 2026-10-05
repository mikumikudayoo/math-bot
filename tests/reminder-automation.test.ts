import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutomationStore } from '../src/reminders/automation/store.js';
import { documentTemplates,eventKey,validateExtraction,type Extraction,type PreviewConfig } from '../src/reminders/automation/model.js';
const fixture=()=>JSON.parse(readFileSync(new URL('../docs/examples/reminder-automation/vtamps-v25-0.json',import.meta.url),'utf8')) as Extraction;
const config:PreviewConfig={guild:'111111111111111111',channel:'222222222222222222',role:'333333333333333333',rules:[{id:'24h',type:'training-session',anchor:'start',beforeMinutes:1440,template:'session'}],templates:documentTemplates};
const before=Date.parse('2026-08-01T00:00:00+08:00');

test('image fixture is five Senior Secondary sessions in Manila, with no invented competition association',()=>{
  const input=fixture();validateExtraction(input);assert.equal(input.events.length,5);
  assert.deepEqual(input.catalog.competitions,[]);
  assert.deepEqual(input.events.map(x=>new Date(x.event.start!).toISOString()),['2026-08-30T09:00:00.000Z','2026-09-12T09:00:00.000Z','2026-09-13T09:00:00.000Z','2026-09-20T09:00:00.000Z','2026-09-27T09:00:00.000Z']);
  for(const {event:e} of input.events){assert.equal(e.end!-e.start!,150*60000);assert.equal(e.competitionId,null);assert.equal(e.yearLevel,'Senior Secondary');}
});
test('pending extraction cannot generate reminders; duplicate emails are idempotent and approval survives reopening',()=>{
  const dir=mkdtempSync(join(tmpdir(),'automation-')),path=join(dir,'test.automation-sandbox.sqlite');let s=new AutomationStore(path);
  try{
    const batch=s.ingest(fixture(),before);assert.equal(s.ingest(fixture()).id,batch.id);assert.equal(s.ingest(fixture()).duplicate,true);
    assert.deepEqual(s.preview(config,before),[]);assert.equal(s.approve(batch.id,null,'staff',before),5);s.close();s=new AutomationStore(path);
    const previews=s.preview(config,before);assert.equal(previews.length,5);assert.ok(previews.every(x=>x.status==='planned'&&x.mode==='dry-run'));
    const first=previews.find(x=>x.due==='2026-08-29T09:00:00.000Z')!;assert.ok(first.payload!.content.includes('Session 1'));assert.ok(first.payload!.content.includes('Sunday'));assert.ok(first.payload!.content.includes('5:00'));assert.ok(first.payload!.content.includes('7:30'));
    assert.deepEqual(first.payload!.allowedMentions,{parse:[],roles:[config.role],users:[],repliedUser:false});
    assert.equal(s.ingest({...fixture(),source:{...fixture().source,messageId:'forwarded'}}).duplicate,false);
    assert.ok(s.preview(config,before).every(x=>x.status==='planned')); // Identical forwarding does not hold approved events.
  }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
test('corrections keep stable identity, hold previews, invalidate stale reviews and update without duplicate events',()=>{
  const s=new AutomationStore(':memory:');try{
    const base=fixture();const batch=s.ingest(base);s.approve(batch.id,null,'staff');
    const update=fixture();update.source.messageId='correction';update.events=[update.events[3]!];const e=update.events[0]!.event;
    const oldKey=eventKey(e);e.start!+=86400000;e.end!+=86400000;assert.equal(eventKey(e),oldKey);
    const pending=s.ingest(update);assert.equal(s.preview(config,before).filter(x=>x.status==='held').length,1);
    const competing=structuredClone(update);competing.source.messageId='competing';competing.events[0]!.event.start!+=86400000;competing.events[0]!.event.end!+=86400000;
    const stale=s.ingest(competing);s.approve(pending.id,null,'reviewer');assert.throws(()=>s.approve(stale.id,null,'reviewer'),/Stale/);
    assert.equal(s.preview(config,before).length,5);s.reject(stale.id,null,'reviewer');
    const previews=s.preview(config,before);assert.ok(previews.every(x=>x.status==='planned'));assert.equal(previews.find(x=>x.eventKey===oldKey)!.revision,2);
  }finally{s.close();}
});
test('uncertainty blocks approve-all atomically and a staff edit or rejection resolves it',()=>{
  const s=new AutomationStore(':memory:');try{
    const input=fixture();input.events[1]!.issues=['OCR date ambiguous'];input.events[1]!.confidence='low';const b=s.ingest(input);
    assert.throws(()=>s.approve(b.id,null,'staff'),/Resolve/);assert.deepEqual(s.preview(config,before),[]);
    const row=s.review(b.id).events[1]!;s.edit(b.id,row.id,input.events[1]!.event,[],'reviewer');assert.equal(s.approve(b.id,null,'reviewer'),5);
    const correction=fixture();correction.source.messageId='bad-ocr';correction.events=[correction.events[0]!];correction.events[0]!.event.start!+=60000;const c=s.ingest(correction);s.reject(c.id,null,'reviewer',true);assert.ok(s.review(c.id).events.every(x=>x.state==='incorrect'));assert.ok(s.preview(config,before).every(x=>x.status==='planned'));
  }finally{s.close();}
});
test('past times never catch up; missing placeholders and invalid destination/config block rendering',()=>{
  const s=new AutomationStore(':memory:');try{
    const b=s.ingest(fixture());s.approve(b.id,null,'staff');assert.ok(s.preview(config,Date.parse('2026-10-03T00:00:00+08:00')).every(x=>x.status==='skipped'&&x.payload===null));
    assert.ok(s.preview({...config,role:null},before).every(x=>x.status==='blocked'));
    assert.ok(s.preview({...config,templates:{session:'{{url}}'}},before).every(x=>x.status==='blocked'));
    assert.throws(()=>s.preview({...config,role:config.guild},before));assert.throws(()=>s.preview({...config,rules:[config.rules[0]!,config.rules[0]!]},before));
  }finally{s.close();}
});
test('actual mathematics competitions and rounds stay separate from linked VTAMPS preparation',()=>{
  const input=fixture();input.catalog.competitions=[{id:'timo-2026',name:'TIMO',year:2026,subject:'mathematics'}];input.catalog.rounds=[{id:'timo-2026-heat',competitionId:'timo-2026',name:'Heat Round'}];
  input.events[0]!.event.preparesFor=['timo-2026'];validateExtraction(input);
  const competition=structuredClone(input.events[0]!);competition.event={...competition.event,competitionId:'timo-2026',roundId:'timo-2026-heat',programId:null,preparesFor:[],type:'competition-day',slot:'competition-day'};input.events.push(competition);validateExtraction(input);
  assert.notEqual(eventKey(input.events[0]!.event),eventKey(competition.event));
  input.catalog.competitions[0]!.name='HKISO';assert.throws(()=>validateExtraction(input),/mathematics/);
});
test('rejects invalid sources, unrelated levels, impossible intervals and a legacy DB path',()=>{
  const input=fixture();input.events[0]!.event.end=input.events[0]!.event.start;assert.throws(()=>validateExtraction(input));
  assert.throws(()=>new AutomationStore('data/reminders.production.sqlite'),/sandbox/);
  const wrong=fixture();(wrong.events[0]!.event as {yearLevel:string}).yearLevel='Secondary 3';assert.throws(()=>validateExtraction(wrong));
  const duplicate=fixture();duplicate.events.push(duplicate.events[0]!);assert.throws(()=>validateExtraction(duplicate),/Duplicate/);
  const sensitive=fixture();Object.assign(sensitive.source,{body:'credentials must not be copied'});assert.throws(()=>validateExtraction(sensitive),/Unexpected/);
});

test('date-only deadlines remain reviewable but cannot activate until a human resolves the time',()=>{
  const s=new AutomationStore(':memory:');try{
    const input=fixture();input.catalog.competitions=[{id:'bbb-2026',name:'BBB',year:2026,subject:'mathematics'}];input.catalog.rounds=[{id:'bbb-heat',competitionId:'bbb-2026',name:'Heat Round'}];
    input.events=[input.events[0]!];input.events[0]!.event={...input.events[0]!.event,type:'registration-deadline',competitionId:'bbb-2026',roundId:'bbb-heat',programId:null,slot:'registration',start:null,end:null,deadline:null,dateHint:'November 3, 2026'};
    input.events[0]!.issues=['Source says November 3, 2026 but gives no cutoff time'];const b=s.ingest(input);assert.equal(s.review(b.id).events[0]!.display.deadline,null);
    assert.throws(()=>s.approve(b.id,null,'staff'),/Resolve/);const draft=s.review(b.id).events[0]!;s.edit(b.id,draft.id,input.events[0]!.event,[],'staff');assert.throws(()=>s.approve(b.id,null,'staff'),/unresolved/);
    // Synthetic reviewer-confirmed time for testing, not a claim about BBB's cutoff.
    const confirmed={...input.events[0]!.event,deadline:Date.parse('2026-11-03T17:00:00+08:00')};s.edit(b.id,draft.id,confirmed,[],'staff');assert.equal(s.approve(b.id,null,'staff'),1);
  }finally{s.close();}
});
