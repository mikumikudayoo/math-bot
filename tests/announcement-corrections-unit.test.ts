import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applyCorrectionPatch,assessCorrection,compareCorrectionSources,factFingerprint,validateCorrectionPatch} from '../src/announcements/corrections.js';
import type {Catalog,ScheduleEvent} from '../src/announcements/model.js';

const catalog:Catalog={competitions:[{id:'timo-2030',name:'TIMO',year:2030,subject:'mathematics'},{id:'pimso-2030',name:'PIMSO',year:2030,subject:'mathematics'}],rounds:[],programs:[{id:'vtamps-v26-0',name:'VTAMPS',version:'26.0'}]};
function event():ScheduleEvent{return {competitionId:null,roundId:null,programId:'vtamps-v26-0',preparesFor:['timo-2030','pimso-2030'],yearLevel:'Senior Secondary',type:'training-session',slot:'1',start:Date.UTC(2030,0,10,1),end:Date.UTC(2030,0,10,3),deadline:null,timezone:'Asia/Manila',url:'https://example.org/resources/vtamps',detailLabel:'Session schedule',status:'active',timezoneAssumed:false,logistics:{venue:'Public auditorium',bring:['Pencil','Printed admission form']},availability:{state:'expected',asOf:Date.UTC(2030,0,1),expectedAt:Date.UTC(2030,0,10)},temporal:{start:{precision:'exact',expression:'January 10 at 9 am',sourceTime:Date.UTC(2030,0,1)}}};}

test('fact fingerprint ignores catalog order, unrelated entities, association order, and evidence timing/wording',()=>{
  const base=event(),copy=structuredClone(base),reordered=structuredClone(catalog);
  reordered.competitions.reverse();reordered.competitions.push({id:'bbb-2030',name:'BBB',year:2030,subject:'mathematics'});
  copy.preparesFor.reverse();copy.availability!.asOf!+=86400000;copy.temporal!.start!.sourceTime!+=86400000;copy.temporal!.start!.expression='a forwarded quotation of the same date';
  assert.equal(factFingerprint(base,catalog),factFingerprint(copy,reordered));
  const defaults=event();delete defaults.status;delete defaults.timezoneAssumed;assert.equal(factFingerprint(base,catalog),factFingerprint(defaults,catalog));
  const rephrased=structuredClone(catalog);rephrased.competitions[0]!.name='TIMO Competition';rephrased.programs[0]!.version='v26.0';assert.equal(factFingerprint(base,catalog),factFingerprint(base,rephrased));
});

test('fact fingerprint retains material state, time, precision, URL, logistics, and scoped catalog changes',()=>{
  const base=event(),fingerprint=factFingerprint(base,catalog);
  const alternatives=[{...base,start:base.start!+60000},{...base,url:'https://example.org/resources/changed'},{...base,logistics:{...base.logistics,venue:'Another public auditorium'}},{...base,availability:{...base.availability!,state:'available' as const}},{...base,availability:{...base.availability!,expectedAt:base.availability!.expectedAt!+60000}},{...base,temporal:{start:{...base.temporal!.start!,precision:'date_only' as const}}}];
  for(const alternative of alternatives)assert.notEqual(factFingerprint(alternative,catalog),fingerprint);
  const nextYear=structuredClone(catalog);nextYear.competitions[0]!.year=2031;assert.notEqual(factFingerprint(base,nextYear),fingerprint);
});

test('explicit partial time correction retains the baseline URL, logistics, deadline, and other fields',()=>{
  const base=event(),proposal={...base,start:base.start!+3600000,end:base.end!+3600000,url:null,detailLabel:null,logistics:{venue:'Unapproved extracted venue'}};
  const result=applyCorrectionPatch(base,proposal,{kind:'partial',changedFields:['start','end'],clearFields:[]});
  assert.deepEqual(result,{...base,start:proposal.start,end:proposal.end});assert.deepEqual(base,event());
});

test('nulls in a partial patch preserve baseline facts; erasure requires an explicit supported clear list',()=>{
  const base=event(),proposal={...base,url:null,detailLabel:null};
  assert.deepEqual(applyCorrectionPatch(base,proposal,{kind:'partial',changedFields:['url','detailLabel'],clearFields:[]}),base);
  const result=applyCorrectionPatch(base,proposal,{kind:'partial',changedFields:[],clearFields:['url','logistics']});
  assert.equal(result.url,null);assert.equal(result.detailLabel,base.detailLabel);assert.equal(result.logistics,undefined);assert.deepEqual(base,event());
});

test('partial structured-block correction retains unmentioned logistics and availability members',()=>{
  const base=event(),proposal={...base,logistics:{venue:'New public auditorium'},availability:{state:'available' as const,asOf:base.availability!.asOf,expectedAt:null}};
  const result=applyCorrectionPatch(base,proposal,{kind:'partial',changedFields:['logistics','availability'],clearFields:[]});
  assert.deepEqual(result.logistics,{venue:'New public auditorium',bring:base.logistics!.bring});assert.equal(result.availability!.state,'available');
});

test('patches cannot mutate identity or contain ambiguous unsupported mutation lists',()=>{
  const base=event();
  for(const changedFields of [['slot'],['competitionId'],['type'],['unknown'],['start','start']])assert.throws(()=>applyCorrectionPatch(base,base,{kind:'partial',changedFields,clearFields:[]}));
  assert.throws(()=>applyCorrectionPatch(base,{...base,slot:'2'},{kind:'partial',changedFields:['start'],clearFields:[]}));
  assert.throws(()=>validateCorrectionPatch({kind:'partial',changedFields:['url'],clearFields:['url']}));
  for(const clearFields of [['timezone'],['status'],['preparesFor']])assert.throws(()=>validateCorrectionPatch({kind:'partial',changedFields:[],clearFields}));
});

test('explicit replacement replaces the public projection and cancellation/postponement remove operative times',()=>{
  const base=event(),proposal={...base,url:null,detailLabel:null};
  assert.deepEqual(applyCorrectionPatch(base,proposal,{kind:'replacement',changedFields:[],clearFields:[]}),proposal);
  for(const kind of ['cancellation','postponement'] as const){
    const result=applyCorrectionPatch(base,proposal,{kind,changedFields:[],clearFields:[]});
    assert.equal(result.status,kind==='cancellation'?'cancelled':'postponed');assert.equal(result.start,null);assert.equal(result.end,null);assert.equal(result.deadline,null);assert.equal(result.temporal,undefined);assert.equal(result.url,base.url);assert.deepEqual(result.logistics,base.logistics);
  }
});

test('an unreadable erratum repeating approved facts cannot release unchanged delivery',()=>{
  const decision=assessCorrection({correction:true,unresolvedEvidence:true,baselineExists:true,sameFacts:true});
  assert.equal(decision.allowUnchanged,false);assert.ok(decision.issues.length);
  assert.equal(assessCorrection({correction:false,unresolvedEvidence:false,baselineExists:true,sameFacts:true}).allowUnchanged,true);
});

test('a correction without a retained baseline explicitly requires review without historical replay',()=>{
  const decision=assessCorrection({correction:true,unresolvedEvidence:false,baselineExists:false,sameFacts:false});
  assert.equal(decision.allowUnchanged,false);assert.ok(decision.issues.some(issue=>/baseline/i.test(issue)));
});

test('source ordering distinguishes delayed retries from newer corrections and blocks uncertain competing order',()=>{
  const a={sourceTime:1000,sourceHash:'source-a'},b={sourceTime:2000,sourceHash:'source-b'};
  assert.equal(compareCorrectionSources(b,a),'newer');assert.equal(compareCorrectionSources(a,b),'older');
  assert.equal(compareCorrectionSources({...a,sourceTime:9000},a),'same');
  for(const other of [{sourceTime:1000,sourceHash:'source-c'},{sourceTime:null,sourceHash:'source-c'},{sourceTime:NaN,sourceHash:'source-c'}])assert.equal(compareCorrectionSources(other,a),'ambiguous');
  assert.equal(compareCorrectionSources(a,{sourceTime:null,sourceHash:'source-b'}),'ambiguous');
});
