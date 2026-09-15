import {createCanvas} from '@napi-rs/canvas';
import {hash} from '../src/qotd/parser.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseManual, fingerprint } from '../src/qotd/parser.js';
import { QotdStore } from '../src/qotd/store.js';
import { postDaily, questionMessage } from '../src/qotd/posting.js';
import { importFolder } from '../src/qotd/importer.js';
import { phimo, vtamps, syntheticPdf } from './qotd-fixtures.js';

const imageDirectory=mkdtempSync(join(tmpdir(),'qotd-test-crops-'));
const imagePath=join(imageDirectory,'question.png');const imageBytes=createCanvas(100,50).toBuffer('image/png');writeFileSync(imagePath,imageBytes);
after(()=>rmSync(imageDirectory,{recursive:true,force:true}));
function seed(store: QotdStore) {
  const parsed=parseManual(phimo);
  for(const q of parsed.questions)q.crop={status:'generated',images:[{path:imagePath,sha256:hash(imageBytes),page:1,rect:[0,0,100,50],width:100,height:50}],flags:[]};
  return store.import('source-a','generic.pdf','source.pdf',phimo.length,parsed);
}
function approveAll(store: QotdStore) { for (const q of store.list()) store.review(q.id,'approved','test-moderator',true,true); }

test('PHIMO content metadata, mixed kinds, exact official text and multi-page solutions', () => {
  const result = parseManual(phimo);
  assert.equal(result.metadata.competition,'PHIMO'); assert.equal(result.metadata.year,2026); assert.equal(result.metadata.set,'7');
  assert.equal(result.questions.length,2);
  const [mcq,open] = result.questions;
  assert.equal(mcq!.kind,'mcq'); assert.deepEqual(mcq!.choices.map(c=>c.label),['A','B','C']);
  assert.equal(open!.kind,'open'); assert.deepEqual(open!.choices,[]);
  assert.equal(open!.officialAnswer,'  10  ');
  assert.equal(open!.officialSolution,'  Subtract the two removed cubes.\n1. First count all cubes.\n2. Then remove two cubes.\nThe result remains 10.');
  assert.equal(open!.questionPage,1); assert.equal(open!.solutionPage,2); assert.equal(open!.solutionEndPage,3);
});
test('VTAMPS 2024 and v25.0 preserve topic-based open questions and inconsistent official answers', () => {
  for (const edition of ['24','v25.0']) {
    const result = parseManual(vtamps(edition));
    assert.equal(result.questions.length,2); assert.equal(result.questions[1]!.section,'ALGEBRA');
    assert.ok(result.questions.every(q=>q.kind==='open' && !q.choices.length));
    assert.equal(result.questions[1]!.officialAnswer,' 99');
    assert.match(result.questions[1]!.officialSolution,/deliberately inconsistent/);
    assert.equal(result.metadata.edition,edition.replace('v',''));
  }
});
test('choices span pages; letter at end of prose is not a choice; no options invented', () => {
  const pages = ['PART 1: MULTIPLE CHOICE\n1. Choose a letter other than E.\nA. Alpha\nB. Beta','C. Gamma\n2. An image contains choices that could not be read.'];
  const result = parseManual(pages);
  assert.equal(result.questions[0]!.choices.length,3);
  assert.equal(result.questions[0]!.questionEndPage,2);
  assert.deepEqual(result.questions[1]!.choices,[]);
  assert.ok(result.questions[1]!.flags.includes('choices-unreadable'));
});
test('normalized content deduplicates independent of source metadata; SQL uniqueness and immutable answers', () => {
  const store = new QotdStore(':memory:');
  try {
    assert.equal(seed(store).added,2);
    const parsed = parseManual(phimo); parsed.questions[0]!.text = '  '+parsed.questions[0]!.text.replaceAll(' ','  ')+'\n';
    parsed.questions[0]!.officialAnswer='NEW OFFICIAL VARIANT';
    const result = store.import('source-b','renamed.pdf','b.pdf',3,parsed);
    assert.equal(result.added,0); assert.equal(result.duplicates,2); assert.equal(result.conflicts,1);
    const id = fingerprint(parsed.questions[0]!);
    assert.equal(store.get(id)!.officialAnswer,' B'); assert.equal(store.occurrences(id).length,2);
    assert.throws(()=>store.db.prepare('INSERT INTO qotd_questions SELECT * FROM qotd_questions LIMIT 1').run());
    assert.equal(seed(store).added,0); assert.equal(store.list().length,2);
  } finally { store.close(); }
});
test('near duplicates and changed manual number are flagged, never automatically approved', () => {
  const store = new QotdStore(':memory:');
  try {
    seed(store); const changed = parseManual(phimo); changed.questions[1]!.text=changed.questions[1]!.text.replace('12','13');
    const result=store.import('different','other.pdf','other.pdf',3,changed);
    assert.ok(result.near>=1); const q=store.get(fingerprint(changed.questions[1]!))!;
    assert.equal(q.state,'pending'); assert.ok(q.flags.some(f=>f.startsWith('near-duplicate:')));
    assert.ok(q.flags.includes('same-manual-number-different-content'));
  } finally { store.close(); }
});
test('pending questions cannot post and approval requires an explicit source review', () => {
  const store = new QotdStore(':memory:');
  try { seed(store); assert.equal(store.claim('g','c','2026-01-01'),null); assert.throws(()=>store.review(store.list()[0]!.id,'approved','mod',false)); }
  finally { store.close(); }
});
test('no-repeat survives reopening, re-import and competing database connections; reset audited', () => {
  const dir=mkdtempSync(join(tmpdir(),'qotd-history-')); const path=join(dir,'q.sqlite');
  let store=new QotdStore(path);
  try {
    seed(store); approveAll(store); const first=store.claim('g','c','2026-01-01')!; assert.ok(first);
    store.close(); store=new QotdStore(path); seed(store);
    const competing=new QotdStore(path);
    try { assert.equal(competing.claim('g','c','2026-01-01'),null); } finally { competing.close(); }
    const second=store.claim('g','c','2026-01-02')!; assert.notEqual(first.question.id,second.question.id);
    assert.equal(store.claim('g','c','2026-01-03'),null);
    store.reset('g',first.question.id,'moderator');
    assert.equal(store.claim('g','c','2026-01-01'),null); // reset does not erase daily history
    assert.equal(store.claim('g','c','2026-01-03')!.question.id,first.question.id);
    assert.equal(store.history('g').length,3);
    assert.match(String(store.db.prepare('SELECT action FROM qotd_audit ORDER BY id DESC LIMIT 1').get()!.action),/explicit no-repeat reset/);
  } finally { store.close(); rmSync(dir,{recursive:true,force:true}); }
});
test('failed sends consume a reservation and are never retried automatically', async () => {
  const store = new QotdStore(':memory:');
  try {
    seed(store); approveAll(store); let calls=0;
    await assert.rejects(postDaily(store,'g','c',async()=>{calls++;throw new Error('timeout after delivery');},'2026-01-01',undefined,Date.parse('2026-01-01T08:00:00+08:00')),/remains consumed/);
    await postDaily(store,'g','c',async()=>{calls++;return {id:'unexpected'};},'2026-01-01',undefined,Date.parse('2026-01-01T08:00:00+08:00'));
    assert.equal(calls,1); assert.equal(store.history('g')[0]!.state,'uncertain');
  } finally { store.close(); }
});
test('all question types use private answer buttons; public payload never contains official solution', async () => {
  const store=new QotdStore(':memory:');
  try {
    seed(store); approveAll(store); const qs=store.list('approved');
    const mcq=questionMessage(qs.find(q=>q.kind==='mcq')!); const open=questionMessage(qs.find(q=>q.kind==='open')!);
    assert.equal(mcq.poll,undefined); assert.equal(mcq.components!.length,1); assert.equal(open.poll,undefined);
    assert.ok(!JSON.stringify(mcq).includes('The second door is green'));
    const long={...qs.find(q=>q.kind==='mcq')!,text:'a'.repeat(2500),choices:[{label:'A',text:'x'.repeat(100)},{label:'B',text:'y'}]};
    assert.equal(questionMessage(long).poll,undefined);
    approveAll(store); await postDaily(store,'g','c',async()=>({id:'message-1'}),'2026-01-01',undefined,Date.parse('2026-01-01T08:00:00+08:00'));
    assert.equal(store.history('g')[0]!.state,'posted'); assert.equal(store.history('g')[0]!.message,'message-1');
  } finally { store.close(); }
});
test('recursive PDF importer is idempotent with renamed identical PDFs and synthetic real PDF extraction', async () => {
  const dir=mkdtempSync(join(tmpdir(),'qotd-pdfs-')); const store=new QotdStore(join(dir,'q.sqlite'));
  try {
    const root=join(dir,'manuals'); mkdirSync(join(root,'nested'),{recursive:true});
    const pdf=syntheticPdf(phimo); writeFileSync(join(root,'arbitrary.pdf'),pdf); writeFileSync(join(root,'nested','duplicate.PDF'),pdf);
    const first=await importFolder(store,root,join(dir,'assets'),()=>{});
    assert.equal(first.failed,0); assert.equal(first.added,2); assert.equal(first.skippedFiles,1);
    approveAll(store); const selected=store.claim('g','c','2026-01-01')!;
    const second=await importFolder(store,root,join(dir,'assets'),()=>{});
    assert.equal(second.added,0); assert.equal(second.skippedFiles,2);
    assert.equal(store.get(selected.question.id)!.state,'approved'); assert.equal(store.history('g').length,1);
    assert.equal(store.db.prepare('SELECT count(*) n FROM qotd_files').get()!.n,2);
  } finally { store.close(); rmSync(dir,{recursive:true,force:true}); }
});
test('scanned/unsupported PDFs remain recorded for manual extraction with no eligible questions', () => {
  const result=parseManual(['']); assert.equal(result.questions.length,0); assert.ok(result.warnings.length>0);
});

test('retained assets resolve release symlinks to the persistent shared directory', async () => {
  const dir=mkdtempSync(join(tmpdir(),'qotd-shared-')); const store=new QotdStore(':memory:');
  try {
    const persistent=join(dir,'shared'); const release=join(dir,'release-data'); const manuals=join(dir,'manuals');
    mkdirSync(persistent); mkdirSync(manuals); symlinkSync(persistent,release,'junction');
    writeFileSync(join(manuals,'manual.pdf'),syntheticPdf(phimo));
    const result=await importFolder(store,manuals,release,()=>{});
    assert.equal(result.added,2);
    const source=store.occurrences(store.list()[0]!.id)[0]!;
    assert.ok(String(source.asset).startsWith(realpathSync(persistent)));
    assert.ok(!String(source.asset).includes('release-data'));
  } finally { store.close(); rmSync(dir,{recursive:true,force:true}); }
});
