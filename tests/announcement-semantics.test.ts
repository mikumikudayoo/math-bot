import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateEvent,validateExtraction,renderEvent,type Catalog,type ScheduleEvent,type Extraction} from '../src/announcements/model.js';
import {sourceTimeAnchor,classifySource,normalizeCatalogAndEvents,catalogForEvent,semanticIssues,entityEvidenceIssues,validateSemanticEvent,validateRenderedSemantics} from '../src/announcements/semantics.js';

const now=Date.parse('2030-01-01T08:00:00+08:00');
const catalog:Catalog={competitions:[{id:'contest-picked-by-model',name:'TIMO',year:2030,subject:'mathematics'}],rounds:[{id:'round-picked-by-model',competitionId:'contest-picked-by-model',name:'Heat Round'}],programs:[{id:'program-picked-by-model',name:'VTAMPS',version:'V.30.0'}]};
function event(patch:Partial<ScheduleEvent>={}):ScheduleEvent{const e:ScheduleEvent={competitionId:null,roundId:null,programId:'program-picked-by-model',preparesFor:[],yearLevel:'Senior Secondary',type:'training-session',slot:'1',start:now+86400000,end:now+86400000+7200000,deadline:null,timezone:'Asia/Manila',timezoneAssumed:false,url:null,detailLabel:null,...patch};if(patch.temporal===undefined)e.temporal=Object.fromEntries((['start','end','deadline'] as const).filter(field=>e[field]!==null).map(field=>[field,{precision:'exact',expression:new Date(e[field]!).toISOString(),sourceTime:now}]));return e;}

test('official PIMSO expanded identity is public and canonical mathematics without masking other science scope',()=>{
  const name='Philippine International Mathematics and Science Olympiad';
  const classify=(text:string)=>classifySource({evidence:[{id:'body',text}],blocked:[],sensitive:false}).disposition;
  assert.equal(classify(`${name} 2030 National Round mathematics guidelines.`),'public');
  assert.equal(classify(`${name} 2030 and HKISO 2030.`),'needs_review');
  assert.equal(classify(`${name} 2030 and VTASP guidelines.`),'needs_review');
  assert.equal(classify(`${name} 2030. Separate science program registration.`),'needs_review');
  assert.equal(classify('Generic science Olympiad guidelines.'),'ignore');
  const value:Extraction={source:{account:'synthetic',messageId:'official-pimso',attachment:null,sha256:'a'.repeat(64),locator:'body'},catalog:{competitions:[{id:'picked',name,year:2030,subject:'mathematics'}],rounds:[],programs:[]},events:[{event:event({competitionId:'picked',programId:null,type:'competition-day'}),confidence:'high',issues:[],evidenceIds:['body']}]};
  assert.doesNotThrow(()=>validateExtraction(value));
  const normalized=normalizeCatalogAndEvents(value);assert.equal(normalized.catalog.competitions[0]!.name,'PIMSO');assert.equal(normalized.events[0]!.event.competitionId,'pimso-2030');
  assert.deepEqual(entityEvidenceIssues(normalized.events[0]!.event,normalized.catalog,{evidence:[{id:'body',text:`${name} 2030 National Round mathematics.`}],evidenceIds:['body']}),[]);
  for(const subject of ['science','Mathematics']){const bad=structuredClone(value);bad.catalog.competitions[0]!.subject=subject as 'mathematics';assert.throws(()=>validateExtraction(bad));}
  for(const unsupported of ['PIMSO science competition','HKISO','VTASP','Generic science Olympiad',`${name} and another science program`]){const bad=structuredClone(value);bad.catalog.competitions[0]!.name=unsupported;assert.throws(()=>validateExtraction(bad));}
});

test('host source time accepts Gmail internalDate and explicit-offset Date headers, never an implicit timezone',()=>{
  assert.equal(sourceTimeAnchor({id:'synthetic',internalDate:String(now)}),now);
  assert.equal(sourceTimeAnchor({id:'synthetic',payload:{headers:[{name:'Date',value:'Tue, 1 Jan 2030 08:00:00 +0800'}]}}),now);
  assert.equal(sourceTimeAnchor({id:'synthetic',payload:{headers:[{name:'Date',value:'January 1, 2030 8:00 AM'}]}}),null);
  assert.equal(sourceTimeAnchor({id:'synthetic',internalDate:'not-a-time'}),null);
});

test('personal and unsupported messages have clean host disposition while mixed/unreadable errata remain held',()=>{
  const classify=(text:string,blocked:string[]=[])=>classifySource({evidence:[{id:'subject',text}],blocked,sensitive:false});
  assert.equal(classify('Your ClassMarker is ready to take').disposition,'private');
  assert.equal(classify('HKISO 2030 Heat Round guidelines').disposition,'ignore');
  assert.equal(classify('ERRATUM: VTASP V.9.0 review schedule').disposition,'ignore');
  assert.equal(classify('VTAMPS V.30.0 and VTASP V.9.0 revised schedule').disposition,'needs_review');
  const unreadable=classify('ERRATUM: VTAMPS V.30.0 updated review schedule',['body.1: image schedule requires review']);
  assert.equal(unreadable.disposition,'needs_review');assert.equal(unreadable.correction,true);
  assert.equal(classify('ERRATUM: VTAMPS V.30.0 updated schedule. Your ClassMarker is ready to take.',['replacement image unreadable']).disposition,'needs_review');
  assert.equal(classify('ERRATUM: VTAMPS V.30.0 updated schedule. Your ClassMarker is ready to take.').disposition,'needs_review');
  assert.equal(classify('VTAMPS V.30.0 training guidelines').disposition,'public');
});

test('canonical supported identities derive from name/year/version/round and prune unused catalog',()=>{
  const value=normalizeCatalogAndEvents({catalog,events:[{event:event({competitionId:'contest-picked-by-model',roundId:'round-picked-by-model',programId:null,type:'competition-day',slot:'exam'})}]});
  assert.equal(value.events[0]!.event.competitionId,'timo-2030');assert.equal(value.events[0]!.event.roundId,'timo-2030-heat');
  assert.deepEqual(value.catalog.programs,[]);
  const training=normalizeCatalogAndEvents({catalog,events:[{event:event()}]});
  assert.equal(training.events[0]!.event.programId,'vtamps-v30-0');assert.equal(training.catalog.programs[0]!.version,'30.0');assert.deepEqual(training.catalog.competitions,[]);
  assert.deepEqual(catalogForEvent(catalog,event()).competitions,[]);
  assert.equal(catalog.programs[0]!.id,'program-picked-by-model');
});

test('registry rejects unsupported or invented entities instead of trusting a plausible model-selected ID',()=>{
  for(const name of ['HKISO','VTASP','An invented mathematics competition']){
    const c=structuredClone(catalog);c.competitions[0]!.name=name;
    assert.throws(()=>normalizeCatalogAndEvents({catalog:c,events:[{event:event({competitionId:'contest-picked-by-model',programId:null,type:'competition-day'})}]}));
  }
  const wrong=structuredClone(catalog);wrong.programs[0]!.name='VTASP' as 'VTAMPS';assert.throws(()=>normalizeCatalogAndEvents({catalog:wrong,events:[{event:event()}]}));
});

test('each used identity must be supported by the candidate cited source pieces',()=>{
  const context={evidence:[{id:'wrong',text:'HKIMO 2030 Heat Round'},{id:'right',text:'TIMO 2030 Heat Round; VTAMPS V.30.0'}],evidenceIds:['wrong']};
  const e=event({competitionId:'contest-picked-by-model',roundId:'round-picked-by-model',programId:null,type:'competition-day'});
  assert.ok(entityEvidenceIssues(e,catalog,context).length);
  assert.deepEqual(entityEvidenceIssues(e,catalog,{...context,evidenceIds:['right']}),[]);
  assert.ok(entityEvidenceIssues(event(),catalog,{evidence:[{id:'body',text:'VTAMPS V.31.0'}]}).length);
  assert.ok(entityEvidenceIssues(e,catalog,{evidence:[]}).length);
});

test('folder existence/empty/future upload cannot establish available-now even in a draft',()=>{
  const e=event({type:'materials-release',slot:'1',availability:{state:'available',asOf:now,expectedAt:null}});
  for(const text of ['VTAMPS V.30.0 folder: https://example.org/resources/vtamps','Materials are currently empty and will be uploaded tomorrow afternoon.','Materials are not yet available.','Materials are not currently available.','Materials are available tomorrow afternoon.']){
    assert.throws(()=>validateSemanticEvent(e,{evidence:[{id:'body',text}],sourceTime:now}));
  }
  assert.throws(()=>validateSemanticEvent(e,{evidence:[],sourceTime:now}));
  assert.doesNotThrow(()=>validateSemanticEvent(e,{evidence:[{id:'body',text:'VTAMPS V.30.0 materials are now available. Timezone: Asia/Manila.'}],sourceTime:now},true));
  assert.doesNotThrow(()=>validateSemanticEvent(e,{},true));
});

test('unresolved material availability and relative tomorrow afternoon block approval without inventing a time',()=>{
  const e=event({type:'materials-release',slot:'1',start:null,end:null,availability:{state:'expected',asOf:now,expectedAt:null},temporal:{start:{precision:'relative',expression:'tomorrow afternoon',sourceTime:now}}});
  assert.doesNotThrow(()=>validateSemanticEvent(e,{sourceTime:now}));
  assert.ok(semanticIssues(e,{sourceTime:now}).some(issue=>issue.includes('unresolved')));
  assert.throws(()=>validateSemanticEvent(e,{sourceTime:now},true));
  assert.throws(()=>validateEvent(e,catalog,true));
  assert.equal(e.start,null);assert.equal(e.availability!.expectedAt,null);
  const forged=event({temporal:{start:{precision:'exact',expression:'tomorrow afternoon',sourceTime:now-1}}});
  assert.ok(semanticIssues(forged,{sourceTime:now}).some(issue=>issue.includes('source-time')));
});

test('timezone assumptions require host confirmation and date-only facts stay unresolved',()=>{
  const e=event({timezoneAssumed:true});assert.throws(()=>validateEvent(e,catalog,true));
  assert.doesNotThrow(()=>validateEvent(e,catalog,true,{timezoneConfirmed:true}));
  e.timezoneAssumed=false;e.temporal={start:{precision:'date_only',expression:'January 2, 2030',sourceTime:now}};
  assert.throws(()=>validateEvent(e,catalog,true));
});

test('typed check-in and mock-test window remain distinct from the exam and reject incomplete windows',()=>{
  const checkIn=event({competitionId:'contest-picked-by-model',programId:null,type:'check-in',slot:'onsite-check-in',start:now+3600000,end:null,logistics:{venue:'Synthetic public auditorium',bring:['Pencil','Water bottle'],participant:['Parents wait in the designated waiting area.']}});
  assert.doesNotThrow(()=>validateEvent(checkIn,catalog,true));
  const window=event({...checkIn,type:'mock-test-window',slot:'mock-test',end:now+7200000,temporal:{start:{precision:'window',expression:'9:00 AM to 10:00 AM',sourceTime:now},end:{precision:'window',expression:'9:00 AM to 10:00 AM',sourceTime:now}}});
  assert.doesNotThrow(()=>validateEvent(window,catalog,true));
  assert.throws(()=>validateEvent({...window,end:null},catalog,true));
  assert.throws(()=>validateEvent({...checkIn,logistics:{venue:'Student name: Synthetic Student'}},catalog));
});

test('structured semantics cannot bypass public-fact validation or disguise unexpected fields',()=>{
  assert.throws(()=>validateEvent(event({availability:{state:'available',asOf:now,expectedAt:null,token:'private'} as never}),catalog));
  assert.throws(()=>validateEvent(event({temporal:{start:{precision:'exact',expression:'PIN: TEST-PIN-9876',sourceTime:now}}}),catalog));
  assert.throws(()=>validateEvent(event({logistics:{bring:['Candidate ID: TEST-CANDIDATE-12345']}}),catalog));
});

test('rendered text cannot promote expected/unavailable material into current availability',()=>{
  const e=event({type:'materials-release',availability:{state:'expected',asOf:now,expectedAt:now+86400000}});
  assert.throws(()=>validateRenderedSemantics(e,'The materials are now available.'));
  assert.doesNotThrow(()=>validateRenderedSemantics(e,'Materials are expected tomorrow.'));
  assert.throws(()=>renderEvent(e,catalog,{guild:'111111111111111111',channel:'222222222222222222',role:null,rules:[],templates:{release:'Materials are now available.'}},'release'));
});

test('zero-event manual extraction requires an explicit non-public disposition',()=>{
  const source={account:'synthetic',messageId:'synthetic-source',attachment:null,sha256:'a'.repeat(64),locator:'subject'};
  const x:Extraction={catalog:{competitions:[],rounds:[],programs:[]},source,events:[]};assert.throws(()=>validateExtraction(x));
  for(const disposition of ['private','ignore','needs_review'] as const)assert.doesNotThrow(()=>validateExtraction({...x,disposition,dispositionReason:'Synthetic disposition.'}));
  assert.throws(()=>validateExtraction({...x,disposition:'public'}));
});
