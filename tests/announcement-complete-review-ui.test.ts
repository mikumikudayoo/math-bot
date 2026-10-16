import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AnnouncementStore} from '../src/announcements/store.js';
import {reviewPanel,sourcePanel,sourceId,inboxPanel,jobLabel,requireJob} from '../src/announcements/review-ui.js';
import type {Extraction,ScheduleEvent} from '../src/announcements/model.js';
import {plan} from '../src/announcements/planner.js';

const guild='111111111111111111',other='444444444444444444',now=Date.parse('2030-01-01T00:00:00Z');
function fixture(message='synthetic-organizer-transport-id',offset=0):Extraction {
  const start=now+86400000+offset,end=start+7200000;
  return {source:{account:'synthetic',messageId:message,attachment:null,sha256:(offset?'b':'a').repeat(64),locator:'body.0:chunk-1'},sourceTime:now+offset,disposition:'public',correction:false,catalog:{competitions:[{id:'timo-2030',name:'TIMO',year:2030,subject:'mathematics'}],rounds:[],programs:[{id:'vtamps-v30-0',name:'VTAMPS',version:'30.0'}]},events:[{confidence:'high',issues:[],evidenceIds:['body.0:chunk-1'],event:{competitionId:null,roundId:null,programId:'vtamps-v30-0',preparesFor:['timo-2030'],yearLevel:'Senior Secondary',type:'training-session',slot:'1',start,end,deadline:end+86400000,timezone:'Asia/Manila',timezoneAssumed:false,url:'https://example.org/resources/vtamps',detailLabel:'session materials',dateHint:'January 2, 2030, exact time confirmed',status:'active',availability:{state:'available',asOf:now,expectedAt:null},temporal:{start:{precision:'exact',expression:new Date(start).toISOString(),sourceTime:now},end:{precision:'exact',expression:new Date(end).toISOString(),sourceTime:now},deadline:{precision:'exact',expression:new Date(end+86400000).toISOString(),sourceTime:now}},logistics:{venue:'Synthetic public auditorium',bring:['Pencil','Water bottle'],participant:['Parents wait in the designated waiting area.']}}}]};
}
function ingest(s:AnnouncementStore,x=fixture(),warnings:string[]=[]){
  const id=s.source(guild,x.source);s.saveEvidence(id,{evidence:[{id:'body.0:chunk-1',text:'VTAMPS V.30.0 prepares for TIMO 2030. Session 1: January 2, 2030, 8 AM to 10 AM Asia/Manila. Materials are now available. Venue: Synthetic public auditorium. Bring pencil and water bottle. Parents wait in the designated waiting area.',locations:['body.0:chunk-1']}],blocked:warnings});
  s.ingest(guild,x,now);return s.candidates(guild).find(c=>c.state==='pending')!;
}

test('moderator review shows every public projection field with distinct candidate and event lifecycle labels',()=>{
  const s=new AnnouncementStore(':memory:');try{
    const c=ingest(s),text=reviewPanel(s,guild,String(c.public_id)).text;
    for(const label of ['candidate state: pending','event lifecycle: active','training program: VTAMPS V.30.0','competition: none','round: none','prepares for: TIMO 2030','target year level: Senior Secondary','milestone type: training-session','milestone: 1','start:','end:','deadline:','timezone: Asia/Manila','timezone assumption: resolved','availability: available','public URL: https://example.org/resources/vtamps','public detail: session materials','source date hint:','temporal precision:','start: exact','source expression:','public logistics:','venue: Synthetic public auditorium','bring: Pencil; Water bottle','participant instructions: Parents wait','confidence: high','issues: none','field evidence references','privacy notice:'])assert.ok(text.includes(label),`Missing review field: ${label}`);
    assert.equal(text.includes('[object Object]'),false);assert.equal(text.includes('synthetic-organizer-transport-id'),false);assert.equal(text.includes('"competitionId"'),false);
  }finally{s.close();}
});

test('cancelled event revision remains visibly distinct from a pending candidate',()=>{
  const s=new AnnouncementStore(':memory:');try{const x=fixture();x.events[0]!.event.status='cancelled';x.events[0]!.event.start=null;x.events[0]!.event.end=null;delete x.events[0]!.event.temporal;const c=ingest(s,x),text=reviewPanel(s,guild,String(c.public_id)).text;
    assert.ok(text.includes('candidate state: pending · event lifecycle: cancelled'));assert.ok(inboxPanel(s,guild).text.includes('candidate state: pending · event lifecycle: cancelled'));
  }finally{s.close();}
});

test('a safe login-details label remains visible as a public milestone label during factual review',()=>{
  const s=new AnnouncementStore(':memory:');try{const c=ingest(s),event=JSON.parse(c.event_json) as ScheduleEvent;s.edit(guild,c.id,c.review_version,{...event,detailLabel:'login details'},[],'synthetic-staff');
    assert.ok(reviewPanel(s,guild,String(c.public_id)).text.includes('public detail: login details'));
  }finally{s.close();}
});

test('correction review displays the superseded approved revision and explicit before/after changed values',()=>{
  const s=new AnnouncementStore(':memory:');try{
    const original=ingest(s);s.approve(guild,original.id,original.review_version,'synthetic-staff',now);
    const next=fixture('synthetic-correction-transport-id',3600000);next.correction=true;next.events[0]!.correctionPatch={kind:'replacement',changedFields:['start','end','deadline','temporal'],clearFields:[]};
    const candidate=ingest(s,next),text=reviewPanel(s,guild,String(candidate.public_id)).text;
    assert.ok(text.includes('proposed public facts (after)'));assert.ok(text.includes('supersedes approved revision 1 · before → after'));assert.ok(text.includes('changed · start'));assert.ok(text.includes('before:'));assert.ok(text.includes('after:'));assert.ok(text.includes('changed · temporal precision'));assert.equal(text.includes('synthetic-correction-transport-id'),false);
  }finally{s.close();}
});

test('source review displays completeness warnings and retains late evidence without exposing arbitrary evidence IDs',()=>{
  const s=new AnnouncementStore(':memory:');try{
    const c=ingest(s),id=sourceId(s,guild,String(c.public_id));
    s.saveEvidence(id,{evidence:[{id:'gmail-opaque-part-id-never-display',text:'Public schedule. '.repeat(1100)+'Folders are EMPTY; upload is expected tomorrow afternoon.',locations:['body.0:chunk-1','private-attachment-id-never-display']}],blocked:['body.1: replacement image requires manual factual review'],incomplete:true});
    const text=sourcePanel(s,guild,String(c.public_id)).text;
    assert.ok(text.includes('Folders are EMPTY; upload is expected tomorrow afternoon.'));assert.ok(text.includes('body.0:chunk-1'));assert.ok(text.includes('replacement image requires manual factual review'));assert.ok(text.includes('evidence is incomplete'));
    for(const secret of ['gmail-opaque-part-id-never-display','private-attachment-id-never-display','synthetic-organizer-transport-id',id])assert.equal(text.includes(secret),false);
    assert.throws(()=>sourcePanel(s,other,String(c.public_id)));
  }finally{s.close();}
});

test('field evidence uses source ordinals and MIME/page/chunk locations while hiding internal provenance keys',()=>{
  const s=new AnnouncementStore(':memory:');try{
    const c=ingest(s),text=reviewPanel(s,guild,String(c.public_id)).text;
    // Stage 5 persists field links for every material public field. These references
    // remain useful without displaying organizer transport IDs or internal UUIDs.
    assert.ok(text.includes('source 1 · body.0:chunk-1'));assert.ok(text.includes('training program: source 1'));assert.ok(text.includes('public logistics: source 1'));
    assert.doesNotMatch(text,/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu);
  }finally{s.close();}
});

test('foreign-server field links and malformed legacy provenance remain safe and actionable in moderator review',()=>{
  const s=new AnnouncementStore(':memory:');try{
    const c=ingest(s),source=fixture('foreign-synthetic-transport-id').source,foreign=s.source(other,source);
    s.saveEvidence(foreign,{evidence:[{id:'foreign-private-locator',text:'Foreign server schedule evidence must remain private.'}]});
    s.db.prepare('UPDATE candidate_events SET field_evidence_json=? WHERE id=?').run(JSON.stringify([{field:'start',source:foreign,id:'foreign-private-locator'}]),c.id);
    const text=reviewPanel(s,guild,String(c.public_id)).text;assert.ok(text.includes('retained evidence missing or outside this server'));
    for(const privateValue of [foreign,'foreign-private-locator','Foreign server schedule evidence'])assert.equal(text.includes(privateValue),false);
    for(const invalid of ['{broken','null',JSON.stringify([null,{field:'start',source:12,id:[]},'not a link'])]){
      s.db.prepare('UPDATE candidate_events SET field_evidence_json=? WHERE id=?').run(invalid,c.id);
      assert.ok(reviewPanel(s,guild,String(c.public_id)).text.includes('malformed evidence linkage requires manual source review'));
    }
  }finally{s.close();}
});

test('exact delivery references remain separate from the originating candidate number in moderator labels',()=>{
  const s=new AnnouncementStore(':memory:');try{
    const c=ingest(s);s.approve(guild,c.id,c.review_version,'synthetic-staff',now);
    plan(s,{guild,channel:'222222222222222222',role:null,staffChannel:null,policies:[{id:'session-1h',type:'training-session',anchor:'start',beforeMinutes:60,template:'session',major:false,asset:'none'}],templates:{session:'Session {{slot}} is on {{date}} from {{timeRange}}.'}},now);
    const j=s.jobs(guild)[0]!;const label=jobLabel(s,guild,j);assert.match(label,/D#\d+ · candidate #\d+/u);assert.equal(label.includes(j.id),false);
  }finally{s.close();}
});

test('D references select one of several jobs for attachment and reconciliation and retain number tombstones',()=>{
  const s=new AnnouncementStore(':memory:');try{
    const c=ingest(s);s.approve(guild,c.id,c.review_version,'synthetic-staff',now);
    const rule={type:'training-session' as const,anchor:'start' as const,beforeMinutes:60,template:'session',major:true,asset:'optional' as const};
    plan(s,{guild,channel:'222222222222222222',role:null,staffChannel:null,policies:[{...rule,id:'first'},{...rule,id:'second'}],templates:{session:'Session {{slot}} on {{date}} from {{timeRange}}.'}},now);
    const first=requireJob(s,guild,'D#1'),second=requireJob(s,guild,'D#2');assert.notEqual(first.id,second.id);assert.throws(()=>requireJob(s,guild,String(c.public_id)),/multiple deliveries/);assert.throws(()=>requireJob(s,other,'D#1'));
    s.attach(guild,second.id,{hash:'a'.repeat(64),path:'synthetic-reviewed.png',mime:'image/png',bytes:8},'synthetic-staff');assert.ok(s.job(guild,second.id)!.asset);assert.equal(s.job(guild,first.id)!.asset,null);
    s.db.prepare("UPDATE announcement_jobs SET state='uncertain'").run();s.reconcile(guild,requireJob(s,guild,'D#2').id,null,'synthetic-staff');assert.equal(s.job(guild,first.id)!.state,'uncertain');assert.equal(s.job(guild,second.id)!.state,'cancelled');
    const deleted=s.addJob({...first,policy:'synthetic-unconsumed-copy',state:'pending_approval'});const number=Number(s.db.prepare('SELECT public_id FROM announcement_job_public_ids WHERE job=?').get(deleted.id)!.public_id);
    s.db.prepare('DELETE FROM announcement_jobs WHERE id=?').run(deleted.id);const next=s.addJob({...first,policy:'synthetic-unconsumed-next',state:'pending_approval'});
    assert.ok(Number(s.db.prepare('SELECT public_id FROM announcement_job_public_ids WHERE job=?').get(next.id)!.public_id)>number);assert.throws(()=>requireJob(s,guild,`D#${number}`));assert.equal(s.resolveCandidate(guild,String(c.public_id))!.id,c.id);
  }finally{s.close();}
});

test('approved field evidence cannot be replaced behind the reviewed immutable revision',()=>{
  const s=new AnnouncementStore(':memory:');try{
    const c=ingest(s);s.approve(guild,c.id,c.review_version,'synthetic-staff',now);const source=sourceId(s,guild,String(c.public_id));
    const before=s.db.prepare('SELECT evidence_json FROM source_evidence WHERE source=?').get(source)!.evidence_json;
    assert.throws(()=>s.saveEvidence(source,{evidence:[{id:'body.0:chunk-1',text:'A different organizer statement.'}]}),/immutable/);
    assert.equal(s.db.prepare('SELECT evidence_json FROM source_evidence WHERE source=?').get(source)!.evidence_json,before);
  }finally{s.close();}
});
