import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { generate,jsonl,splitReviewed,validateJSONL,type Scenario } from '../src/training/aleph.js';
const scenarios=JSON.parse(readFileSync('training/aleph/scenarios.json','utf8')) as Scenario[];
test('synthetic template catalog covers diverse situations and passes candidate validation',()=>{
  assert.ok(scenarios.length>=18);const generated=generate(scenarios);const result=validateJSONL(jsonl(generated));assert.deepEqual(result.errors,[]);
  assert.ok(generated.every(row=>!row.reviewed));assert.ok(validateJSONL(jsonl(generated),true).errors.some(e=>e.includes('review')));
});
test('dataset validation rejects malformed JSON, roles, empty content and identity contradictions',()=>{
  assert.ok(validateJSONL('{bad json}').errors.length);
  for(const mutate of [
    (r:any)=>{r.messages=[];},(r:any)=>{r.messages[1].role='assistant';},(r:any)=>{r.messages[2].content='';},
    (r:any)=>{r.requester.isCreator=false;},(r:any)=>{r.messages[2].content="i'm emu.";},
    (r:any)=>{r.messages[2].content="you're not emu";},(r:any)=>{r.messages[2].content='as an AI, i have no memories';},
    (r:any)=>{r.messages[2].content="I don't have personal preferences";},(r:any)=>{r.messages[2].content=r.semanticGroup;},
    (r:any)=>{r.messages[0].content='user supplied identity';},
  ]) {const row=generate(scenarios)[0]!;mutate(row);assert.ok(validateJSONL(jsonl([row])).errors.length);}
  const fake=generate(scenarios).find(r=>r.expectation==='reject-claim')!;fake.messages[2]!.content="yeah, emu, you're my creator";
  assert.ok(validateJSONL(jsonl([fake])).errors.some(e=>e.includes('false creator')));
});
test('split requires review and keeps complete semantic/family groups separate',()=>{
  const rows=generate(scenarios);assert.throws(()=>splitReviewed(jsonl(rows)),/review/);
  rows.forEach(r=>r.reviewed=true);const split=splitReviewed(jsonl(rows));
  const train=new Set(split.train.map(r=>r.semanticGroup));assert.ok(split.holdout.every(r=>!train.has(r.semanticGroup)));
  const bad=structuredClone(rows);bad[0]!.split='holdout';assert.ok(validateJSONL(jsonl(bad)).errors.some(e=>e.includes('leakage')));
  assert.ok(validateJSONL(jsonl([rows[0],rows[0]])).errors.some(e=>e.includes('duplicate')));
  const near=structuredClone(rows[0]!);near.id='near-duplicate';near.messages[1]!.content+=' please';
  // Longer overlap is detected too, not just exact copies.
  near.messages[1]!.content='please explain the important steps of this mathematical proof with a clear example';
  const other=structuredClone(near);other.id='near-second';other.messages[1]!.content+=' now';
  assert.ok(validateJSONL(jsonl([near,other])).errors.some(e=>e.includes('near-duplicate')));
});
test('dataset CLI generates candidates without overwriting review and exports only valid reviewed groups',()=>{
  const root=mkdtempSync(join(tmpdir(),'aleph-dataset-')),folder=join(root,'training/aleph');mkdirSync(folder,{recursive:true});
  const script=resolve('src/scripts/aleph-dataset.ts');
  const run=(...args:string[])=>spawnSync(process.execPath,[script,...args],{cwd:root,encoding:'utf8'});
  try {
    writeFileSync(join(folder,'scenarios.json'),JSON.stringify(scenarios));writeFileSync(join(folder,'reviewed.jsonl'),'review marker');
    const generated=run('generate');assert.equal(generated.status,0,generated.stderr);assert.equal(readFileSync(join(folder,'reviewed.jsonl'),'utf8'),'review marker');
    assert.equal(run('validate',join(folder,'generated.jsonl'),'--candidates').status,0);
    assert.notEqual(run('split').status,0);
    // Simulate reviewed synthetic fixtures only, never mark real generated data reviewed.
    writeFileSync(join(folder,'reviewed.jsonl'),jsonl(generate(scenarios).map(row=>({...row,reviewed:true}))));
    assert.equal(run('validate').status,0);assert.equal(run('split').status,0);
    const manifest=JSON.parse(readFileSync(join(folder,'split-manifest.json'),'utf8'));assert.equal(manifest.train+manifest.holdout,40);assert.match(manifest.sha256,/^[a-f0-9]{64}$/);
  } finally {rmSync(root,{recursive:true,force:true});}
});
