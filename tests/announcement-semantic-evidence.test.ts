import {test} from 'node:test';
import assert from 'node:assert/strict';
import {semanticIssues,validateSemanticEvent} from '../src/announcements/semantics.js';
import type {ScheduleEvent} from '../src/announcements/model.js';

const now=Date.parse('2030-01-01T00:00:00Z');
const exact=(expression:string)=>({precision:'exact' as const,expression,sourceTime:now});
function event(patch:Partial<ScheduleEvent>={}):ScheduleEvent{return {competitionId:null,roundId:null,programId:'vtamps-v30-0',preparesFor:[],yearLevel:'Senior Secondary',type:'training-session',slot:'1',start:now+86400000,end:now+86400000+7200000,deadline:null,timezone:'Asia/Manila',timezoneAssumed:false,url:null,detailLabel:null,temporal:{start:exact('January 2, 2030, 8 AM Asia/Manila'),end:exact('January 2, 2030, 10 AM Asia/Manila')},...patch};}

test('citing an early chunk cannot hide a later empty/future material qualifier',()=>{
  const e=event({type:'materials-release',availability:{state:'available',asOf:now,expectedAt:null}});
  const context={evidence:[{id:'body:chunk-1',text:'VTAMPS V.30.0 materials are now available.'},{id:'body:chunk-2',text:'Correction: the folders are empty; materials will be uploaded tomorrow afternoon.'}],evidenceIds:['body:chunk-1'],sourceTime:now};
  assert.throws(()=>validateSemanticEvent(e,context));
  assert.doesNotThrow(()=>validateSemanticEvent(e,{...context,evidence:context.evidence.slice(0,1)}));
});

test('affirmative current availability still has to exist in the pieces cited by that proposal',()=>{
  const e=event({type:'materials-release',availability:{state:'available',asOf:now,expectedAt:null}});
  assert.throws(()=>validateSemanticEvent(e,{evidence:[{id:'uncited',text:'Materials are now available.'},{id:'cited',text:'A folder link exists.'}],evidenceIds:['cited'],sourceTime:now}));
});

test('later available confirmation supersedes historical future wording without discarding baseline field proof',()=>{
  const e=event({type:'materials-release',availability:{state:'available',asOf:now,expectedAt:null}});
  const old={id:'baseline/body',text:'VTAMPS V.30.0 materials are empty and will be uploaded tomorrow afternoon.'},current={id:'body',text:'VTAMPS V.30.0 materials are now available. Timezone: Asia/Manila.'};
  const context={evidence:[old,current],sourceEvidence:[current],evidenceIds:['body'],sourceTime:now};
  assert.doesNotThrow(()=>validateSemanticEvent(e,context,true));
  const future={id:'body',text:'Correction: materials are empty and will be uploaded tomorrow afternoon.'};
  assert.throws(()=>validateSemanticEvent(e,{evidence:[{id:'baseline/body',text:'Materials are now available.'},future],sourceEvidence:[future],evidenceIds:['baseline/body'],sourceTime:now}));
});

test('source-backed operative times require explicit temporal precision, while uncertain drafts remain retainable',()=>{
  const e=event();delete e.temporal;
  const context={evidence:[{id:'body',text:'VTAMPS V.30.0 Session 1 schedule'}],evidenceIds:['body']};
  assert.ok(semanticIssues(e,context).some(issue=>issue.startsWith('start temporal precision')));assert.ok(semanticIssues(e,context).some(issue=>issue.startsWith('end temporal precision')));
  assert.doesNotThrow(()=>validateSemanticEvent(e,context));assert.throws(()=>validateSemanticEvent(e,context,true));assert.doesNotThrow(()=>validateSemanticEvent(e,{},true));
});

test('a provider cannot erase a relative source clock ambiguity by labeling its invented timestamp exact',()=>{
  const e=event({type:'materials-release',slot:'Session 1',availability:{state:'expected',asOf:now,expectedAt:now+86400000}});
  const context={evidence:[{id:'body',text:'VTAMPS V.30.0 Session 1 materials will be uploaded tomorrow afternoon.'}],evidenceIds:['body'],sourceTime:now};
  assert.ok(semanticIssues(e,context).some(issue=>issue.includes('provider exact precision')));
  assert.throws(()=>validateSemanticEvent(e,context,true));
  assert.doesNotThrow(()=>validateSemanticEvent(e,{...context,timezoneConfirmed:true},true));
});

test('Session 1 material-relative wording does not contaminate an independently exact Session 2 training milestone',()=>{
  const e=event({slot:'2'}),context={evidence:[{id:'body',text:'VTAMPS V.30.0 Session 1 materials will be uploaded tomorrow afternoon. Session 2: January 2, 2030, 8 AM to 10 AM Asia/Manila.'}],evidenceIds:['body'],sourceTime:now};
  assert.deepEqual(semanticIssues(e,context),[]);assert.doesNotThrow(()=>validateSemanticEvent(e,context,true));
  assert.ok(semanticIssues({...e,slot:'1'},{...context,evidence:[{id:'body',text:'VTAMPS V.30.0 Session 1 is tomorrow afternoon.'}]}).some(issue=>issue.includes('provider exact precision')));
});

test('provider timezoneAssumed false cannot substitute for cited explicit timezone proof or trusted staff confirmation',()=>{
  const e=event(),context={evidence:[{id:'body',text:'VTAMPS V.30.0 Session 1: January 2, 2030, 9 AM to 11 AM.'}],evidenceIds:['body'],sourceTime:now,timezoneConfirmed:false};
  assert.ok(semanticIssues(e,context).some(issue=>issue.startsWith('Source timezone is unconfirmed')));assert.throws(()=>validateSemanticEvent(e,context,true));
  assert.doesNotThrow(()=>validateSemanticEvent(e,{...context,timezoneConfirmed:true},true));assert.doesNotThrow(()=>validateSemanticEvent(e,{},true));
  for(const timezone of ['Asia/Manila','PHT','Philippine Standard Time','UTC+8','GMT+08:00','2030-01-02T09:00:00+08:00','2030-01-02T01:00:00Z'])assert.doesNotThrow(()=>validateSemanticEvent(e,{...context,evidence:[{id:'body',text:context.evidence[0]!.text+' '+timezone}]},true));
  for(const timezone of ['Asia/Manilaville','UTC+8:30','UTC+8bogus','GMT+9','2030-01-02T09:00:00+99:99'])assert.ok(semanticIssues(e,{...context,evidence:[{id:'body',text:context.evidence[0]!.text+' '+timezone}]}).some(issue=>issue.startsWith('Source timezone is unconfirmed')));
});

test('inherited cited timezone proof is usable but uncited timezone statements are insufficient',()=>{
  const e=event(),old={id:'baseline/body',text:'VTAMPS V.30.0 Session 1 schedule uses Asia/Manila.'},current={id:'body',text:'Session 1 moves to January 3, 2030, 9 AM to 11 AM.'};
  const context={evidence:[current,old],sourceEvidence:[current],evidenceIds:['body','baseline/body'],sourceTime:now};
  assert.doesNotThrow(()=>validateSemanticEvent(e,context,true));
  assert.throws(()=>validateSemanticEvent(e,{...context,evidenceIds:['body']},true));
});
