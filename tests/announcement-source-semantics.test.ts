import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseMail} from '../src/announcements/parsing.js';
import {extractFacts,validateOutput,extractionSchema,validateSchema} from '../src/announcements/extraction.js';
import type {ScheduleEvent} from '../src/announcements/model.js';

const now=Date.parse('2030-01-01T00:00:00Z');
const source={account:'synthetic',messageId:'synthetic-source',attachment:null,sha256:'a'.repeat(64),locator:'body'};
const provider={backend:'https://example.invalid/v1',model:'synthetic-model',backendKey:'synthetic-key',nativeTools:false,vision:false};
function output(patch:Partial<ScheduleEvent>={}){return {disposition:'public',dispositionReason:null,correction:false,catalog:{competitions:[],rounds:[],programs:[{id:'model-choice',name:'VTAMPS',version:'30.0'}]},events:[{event:{competitionId:null,roundId:null,programId:'model-choice',preparesFor:[],yearLevel:'Senior Secondary',type:'training-session',slot:'Session 1',start:now+86400000,end:now+86400000+7200000,deadline:null,timezone:'Asia/Manila',timezoneAssumed:false,url:null,detailLabel:null,dateHint:null,status:'active',availability:null,temporal:{start:{precision:'exact',expression:'2030-01-02T00:00:00Z',sourceTime:now},end:{precision:'exact',expression:'2030-01-02T02:00:00Z',sourceTime:now},deadline:null},logistics:null,...patch},confidence:'high',issues:[],evidenceIds:['body'],correctionPatch:null,fieldEvidence:null}],issues:[]};}
const mail=(text:string)=>({evidence:[{id:'body',text}],blocked:[] as string[],sensitive:false,sourceTime:now});

test('strict extraction schema requires explicit disposition and semantic fields and rejects authority injection',()=>{
  const x=output();assert.doesNotThrow(()=>validateSchema(x,extractionSchema));
  for(const key of ['disposition','dispositionReason','correction']){const bad=structuredClone(x) as Record<string,unknown>;delete bad[key];assert.throws(()=>validateOutput(bad,mail('VTAMPS V.30.0 Session 1'),source));}
  const bad=structuredClone(x);delete (bad.events[0]!.event as Record<string,unknown>).availability;assert.throws(()=>validateOutput(bad,mail('VTAMPS V.30.0'),source));
  assert.throws(()=>validateOutput({...x,autoSend:true},mail('VTAMPS V.30.0'),source));
});

test('host identity normalization and candidate evidence IDs survive extraction validation',()=>{
  const result=validateOutput(output(),mail('VTAMPS V.30.0 Senior Secondary Session 1 on January 2, 2030, 8 AM to 10 AM Asia/Manila.'),source);
  assert.equal(result.disposition,'public');assert.equal(result.sourceTime,now);assert.equal(result.events[0]!.event.programId,'vtamps-v30-0');assert.equal(result.events[0]!.event.slot,'1');
  assert.deepEqual(result.events[0]!.evidenceIds,['body']);assert.deepEqual(result.events[0]!.issues,[]);assert.equal(result.events[0]!.event.availability,undefined);assert.equal(result.events[0]!.event.temporal!.start!.precision,'exact');
});

test('a model cannot relabel unsupported VTASP or claim supported facts from unrelated cited evidence',()=>{
  assert.throws(()=>validateOutput(output(),mail('VTASP V.9.0 guidelines'),source));
  const result=validateOutput(output(),mail('VTAMPS V.31.0 session schedule'),source);
  assert.ok(result.events[0]!.issues.some(issue=>issue.includes('version')));
  const mixed=validateOutput(output(),mail('VTAMPS V.30.0 and VTASP V.9.0 updated review schedule'),source);
  assert.equal(mixed.disposition,'needs_review');assert.equal(mixed.correction,true);
});

test('personal readiness and unsupported programs never call the provider and yield no public facts',async()=>{
  let calls=0;const complete=async()=>{calls++;throw new Error('Provider must not be called.');};
  for(const [text,disposition] of [['Your ClassMarker is ready to take','private'],['HKISO 2030 Heat Round guidelines','ignore'],['ERRATUM: VTASP V.9.0 schedule','ignore']] as const){
    const result=await extractFacts(provider,mail(text),source,AbortSignal.timeout(1000),complete);
    assert.equal(result.disposition,disposition);assert.equal(result.events.length,0);
  }
  assert.equal(calls,0);
});

test('empty/future materials retain expected semantics and do not swallow the next session milestone',()=>{
  const x=output({type:'materials-release',slot:'Session 1',start:null,end:null,availability:{state:'expected',asOf:now,expectedAt:null},temporal:{start:{precision:'relative',expression:'tomorrow afternoon',sourceTime:now}}});
  x.events[0]!.event.temporal={start:{precision:'relative',expression:'tomorrow afternoon',sourceTime:now},end:null,deadline:null} as never;
  const session=output().events[0]!;session.event.slot='Session 2';x.events.push(session as never);
  const result=validateOutput(x,mail('VTAMPS V.30.0 Session 1 folders are currently empty. Materials will be uploaded tomorrow afternoon. Session 2 pretest reminder.'),source);
  assert.equal(result.events.length,2);assert.equal(result.events[0]!.event.availability!.state,'expected');assert.equal(result.events[1]!.event.slot,'2');assert.ok(result.events[0]!.issues.some(issue=>issue.includes('unresolved')));
  const dishonest=structuredClone(x);dishonest.events[0]!.event.availability={state:'available',asOf:now,expectedAt:null};assert.throws(()=>validateOutput(dishonest,mail('VTAMPS V.30.0 Session 1 folders are empty; materials will be uploaded tomorrow afternoon.'),source));
});

test('supported unreadable erratum is explicit needs_review even if a provider returns an old schedule',()=>{
  const m=mail('ERRATUM: VTAMPS V.30.0 updated review schedule. Replacement timetable is attached. No other details changed.');m.blocked=['body.1: image schedule requires manual factual review'];
  const result=validateOutput(output(),m,source);assert.equal(result.disposition,'needs_review');assert.equal(result.correction,true);assert.ok(result.events[0]!.issues.some(issue=>issue.includes('unreadable')));
});

test('provider correction patches retain explicit changed and cleared fields without authorizing identity mutation',()=>{
  const x=output();x.correction=true;
  Object.assign(x.events[0]!,{correctionPatch:{kind:'partial',changedFields:['start','end','temporal'],clearFields:[]}});
  const m=mail('ERRATUM: VTAMPS V.30.0 Senior Secondary Session 1 changed opening and closing times. No other details changed.');
  const result=validateOutput(x,m,source);
  assert.equal(result.correction,true);assert.equal(result.events[0]!.correctionPatch!.kind,'partial');
  Object.assign(x.events[0]!,{correctionPatch:{kind:'partial',changedFields:['programId'],clearFields:[]}});
  assert.throws(()=>validateOutput(x,m,source));
});

test('parser supplies organizer source-time anchor while retaining safely redacted schedule evidence',async()=>{
  const parsed=await parseMail({id:'synthetic-mail',internalDate:String(now),payload:{headers:[{name:'Subject',value:'VTAMPS V.30.0 guidelines'}],mimeType:'text/plain',body:{data:Buffer.from('Session 1: January 2, 2030, 8–10 AM Asia/Manila\nCandidate ID: TEST-CANDIDATE-12345\nPIN: TEST-PIN-9876').toString('base64url')}}},async()=>Buffer.alloc(0));
  assert.equal(parsed.sourceTime,now);assert.ok(parsed.evidence.some(e=>e.text.includes('Session 1:')));assert.equal(JSON.stringify(parsed).includes('TEST-CANDIDATE-12345'),false);assert.equal(JSON.stringify(parsed).includes('TEST-PIN-9876'),false);
});
