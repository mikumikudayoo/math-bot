import {test} from 'node:test';
import assert from 'node:assert/strict';
import {attributeFields,attributionIssues,validateFieldEvidence} from '../src/announcements/evidence.js';
import type {ScheduleEvent} from '../src/announcements/model.js';
import {AnnouncementStore} from '../src/announcements/store.js';
import type {Extraction} from '../src/announcements/model.js';

const event:ScheduleEvent={competitionId:null,roundId:null,programId:'vtamps-v30-0',preparesFor:[],yearLevel:'Senior Secondary',type:'training-session',slot:'1',start:1893456000000,end:1893463200000,deadline:null,timezone:'Asia/Manila',url:'https://example.org/resources',detailLabel:null};
test('every defined public field requires a retained evidence statement; invented references cannot count',()=>{
  const links=attributeFields(event,'source-local',['body']);
  const lookup=(source:string,id:string)=>source==='source-local'&&id==='body'?{id,text:'VTAMPS V.30.0 reviewed timetable.'}:undefined;
  assert.deepEqual(attributionIssues(event,links,lookup),[]);
  assert.ok(attributionIssues(event,links.filter(link=>link.field!=='url'),lookup).some(issue=>issue.includes('url')));
  assert.ok(attributionIssues(event,links,()=>undefined).length);
  assert.throws(()=>validateFieldEvidence([{field:'autoSend',evidenceIds:['body']}] as never));
});
test('explicit field citations cannot silently inherit the proposal-level fallback',()=>{
  const links=attributeFields(event,'source-local',['body'],[{field:'start',evidenceIds:['body:chunk-2']}]);
  assert.deepEqual(links,[{field:'start',source:'source-local',id:'body:chunk-2'}]);
  assert.ok(attributionIssues(event,links,(_source,id)=>({id,text:'Public source statement.'})).length);
});
test('partial corrections retain baseline field attribution and bind changed fields to the new email',()=>{
  const baseline=attributeFields(event,'original',['body:page-1']);
  const changed=attributeFields({...event,start:event.start!+3600000},'correction',['body'],undefined,baseline,{kind:'partial',changedFields:['start'],clearFields:[]});
  assert.deepEqual(changed.find(link=>link.field==='start'),{field:'start',source:'correction',id:'body'});
  assert.deepEqual(changed.find(link=>link.field==='url'),{field:'url',source:'original',id:'body:page-1'});
});

test('manual imports retain source-safe per-field evidence and cannot overwrite an unresolved source to dismiss it',()=>{
  const guild='111111111111111111',store=new AnnouncementStore(':memory:');try{
    const input:Extraction={source:{account:'synthetic',messageId:'manual-proof',attachment:null,sha256:'a'.repeat(64),locator:'body'},catalog:{competitions:[],rounds:[],programs:[{id:'vtamps-v30-0',name:'VTAMPS',version:'30.0'}]},evidence:[{id:'body',text:'VTAMPS V.30.0 Senior Secondary Session 1, January 1, 2030, 8 AM to 10 AM Asia/Manila.\nPIN: TEST-PIN-9876'}],events:[{event:{...event,temporal:{start:{precision:'exact',expression:'2030-01-01T00:00:00Z',sourceTime:null},end:{precision:'exact',expression:'2030-01-01T02:00:00Z',sourceTime:null}}},confidence:'high',issues:[],evidenceIds:['body']}]};
    store.ingest(guild,input);const candidate=store.candidates(guild)[0]!;store.approve(guild,candidate.id,candidate.review_version,'synthetic-staff');
    const approved=store.event(guild,candidate.event_key)! as typeof candidate&{field_evidence_json:string};
    assert.ok(JSON.parse(approved.field_evidence_json).length>=Object.keys(event).length);
    assert.equal(JSON.stringify(store.db.prepare('SELECT evidence_json FROM source_evidence').all()).includes('TEST-PIN-9876'),false);
    const malicious=structuredClone(input);malicious.disposition='private';malicious.events=[];malicious.evidence=[{id:'body',text:'Your ClassMarker is ready to take'}];
    assert.throws(()=>store.ingest(guild,malicious),/cannot be replaced/);
    const c=store.candidate(guild,candidate.id)!;store.db.prepare("UPDATE candidate_events SET state='pending',base_revision=1,field_evidence_json='[]' WHERE id=?").run(c.id);
    assert.throws(()=>store.approve(guild,c.id,c.review_version,'synthetic-staff'),/source support/);
  }finally{store.close();}
});

test('manual advisory correction=false cannot erase host erratum semantics or authorize a missing baseline',()=>{
  const guild='111111111111111111',store=new AnnouncementStore(':memory:');try{
    const input:Extraction={source:{account:'synthetic',messageId:'manual-erratum',attachment:null,sha256:'b'.repeat(64),locator:'body'},correction:false,catalog:{competitions:[],rounds:[],programs:[{id:'vtamps-v30-0',name:'VTAMPS',version:'30.0'}]},evidence:[{id:'body',text:'ERRATUM: VTAMPS V.30.0 Senior Secondary Session 1 updated schedule. January 1, 2030, 8 AM to 10 AM Asia/Manila. No other details changed.'}],events:[{event:{...event,temporal:{start:{precision:'exact',expression:'January 1, 2030, 8 AM',sourceTime:null},end:{precision:'exact',expression:'January 1, 2030, 10 AM',sourceTime:null}}},confidence:'high',issues:[],evidenceIds:['body']}]};
    store.ingest(guild,input);const candidate=store.candidates(guild)[0]!;
    assert.equal(candidate.requires_correction_resolution,1);assert.ok(JSON.parse(candidate.issues_json).some((issue:string)=>issue.includes('baseline')));
    assert.throws(()=>store.approve(guild,candidate.id,candidate.review_version,'synthetic-staff'),/Correction uncertainty/);
  }finally{store.close();}
});
