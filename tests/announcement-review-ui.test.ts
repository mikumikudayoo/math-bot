import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageFlags,type ChatInputCommandInteraction,type ButtonInteraction,type AutocompleteInteraction } from 'discord.js';
import { AnnouncementStore } from '../src/announcements/store.js';
import { documentTemplates,type Extraction } from '../src/announcements/model.js';
import type { AutomationConfig } from '../src/announcements/config.js';
import { makeAnnounceCommand,makeAnnounceButtonHandler } from '../src/commands/announce.js';
import { inboxPanel,reviewPanel,sourcePanel,sourceId,requireJob,jobCandidate } from '../src/announcements/review-ui.js';
import { plan } from '../src/announcements/planner.js';
import { deliverAnnouncements } from '../src/announcements/delivery.js';
import { removeAnnouncementTestDirectory } from './announcement-test-cleanup.js';
const guild='111111111111111111',other='444444444444444444',now=Date.parse('2030-01-01T00:00:00+08:00');
const config:AutomationConfig={enabled:true,autoSend:false,database:':memory:',assets:'/tmp/announcement-review-test',policy:{guild,channel:'222222222222222222',role:'333333333333333333',staffChannel:null,policies:[{id:'test-1h',type:'training-session',anchor:'start',beforeMinutes:60,template:'session',major:false,asset:'none'}],templates:documentTemplates},gmail:{account:'test',query:'from:organizer@example.org',senders:['organizer@example.org'],clientId:'private-client',clientSecret:'private-secret',refreshToken:'private-refresh'},provider:{backend:'https://api.groq.com/openai/v1',model:'openai/gpt-oss-120b',backendKey:'private-key',nativeTools:false,vision:false},pollMs:120000};
function input(message='schedule',offset=0):Extraction{
  const x=JSON.parse(readFileSync(new URL('../docs/examples/announcements/vtamps-v25-0.json',import.meta.url),'utf8')) as Extraction;
  x.source.account='test';x.source.messageId=message;
  x.events.forEach((c,i)=>{c.event.start=now+(i+1+offset)*86400000;c.event.end=c.event.start+150*60000;c.event.timezoneAssumed=false;});return x;
}
function ingestFixture(s:AnnouncementStore,x:Extraction,at=now){
  const exact=(time:number|null)=>time===null?null:{precision:'exact' as const,expression:new Date(time).toISOString(),sourceTime:null};
  for(const c of x.events)Object.assign(c,{evidenceIds:['body'],event:{...c.event,temporal:Object.fromEntries((['start','end','deadline'] as const).filter(field=>c.event[field]!==null).map(field=>[field,exact(c.event[field])!]))}});
  const text=[...x.catalog.programs.map(p=>`${p.name} V.${p.version}`),...x.events.map(({event:e})=>`${e.yearLevel} Session ${e.slot}: ${new Date(e.start!).toISOString()} to ${new Date(e.end!).toISOString()} ${e.timezone}`)].join('\n');
  s.saveEvidence(s.source(guild,x.source),{evidence:[{id:'body',text}],blocked:[]});
  return s.ingest(guild,x,at);
}
function interaction(action:string,values:Record<string,unknown>={},authorized=true,server=guild){
  const replies:any[]=[],defers:any[]=[],choices:any[]=[];
  const i={guildId:server,user:{id:'555555555555555555'},member:null,memberPermissions:{has:()=>authorized},inGuild:()=>true,options:{getSubcommand:()=>action,getString:(name:string)=>values[name]??null,getInteger:(name:string)=>values[name]??null,getBoolean:(name:string)=>values[name]??null,getAttachment:(name:string)=>values[name]??null,getFocused:()=>values.query??''},reply:async(v:unknown)=>{replies.push(v);},deferReply:async(v:unknown)=>{defers.push(v);},editReply:async(v:unknown)=>{replies.push(v);},followUp:async(v:unknown)=>{replies.push(v);},respond:async(v:unknown)=>{choices.push(v);}};
  return {i:i as unknown as ChatInputCommandInteraction,replies,defers,choices};
}
const text=(reply:any)=>reply.files?.[0]?.attachment?.toString()??reply.content;
const ids=(panel:{components:any[]})=>panel.components.flatMap(r=>r.toJSON().components.map((c:any)=>c.custom_id));
const uuid=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

test('friendly IDs are unique, stable, guild scoped; legacy UUIDs remain internal',()=>{
  const s=new AnnouncementStore(':memory:');try{ingestFixture(s,input(),now);const candidates=s.candidates(guild);assert.equal(new Set(candidates.map(c=>c.public_id)).size,5);
    for(const c of candidates){assert.equal(s.resolveCandidate(guild,`#${c.public_id}`)?.id,c.id);assert.equal(s.candidate(guild,c.id)?.public_id,c.public_id);assert.equal(s.resolveCandidate(other,String(c.public_id)),undefined);}
    ingestFixture(s,input('forward'),now);assert.equal(s.candidates(guild).length,5);assert.deepEqual(s.candidates(guild).map(c=>c.public_id),candidates.map(c=>c.public_id));
    assert.equal(s.resolveCandidate(guild,'0'),undefined);assert.equal(s.resolveCandidate(guild,'999999999999999999999'),undefined);
  }finally{s.close();}
});
test('additive migration backfills an old database and retains all historical state',()=>{
  const dir=mkdtempSync(join(tmpdir(),'review-migration-')),path=join(dir,'db.sqlite');let s=new AnnouncementStore(path);
  try{ingestFixture(s,input(),now);s.approve(guild,s.resolveCandidate(guild,'1')!.id,1,'staff',now);plan(s,config.policy,now);const before=s.candidates(guild).map(c=>({id:c.id,event:c.event_json}));s.setState('gmail:test:cursor','preserve-cursor');
    const tables=['sources','source_evidence','candidate_batches','candidate_events','candidate_sources','events','event_revisions','announcement_jobs','gmail_state','audit_log'];
    const snapshot=tables.map(table=>s.db.prepare(`SELECT * FROM ${table}`).all());
    s.db.exec('DROP TRIGGER candidate_public_id_insert; DROP TABLE candidate_public_ids; DELETE FROM schema_version WHERE version=2;');s.close();s=new AnnouncementStore(path);
    assert.deepEqual(s.candidates(guild).map(c=>({id:c.id,event:c.event_json})),before);assert.deepEqual(tables.map(table=>s.db.prepare(`SELECT * FROM ${table}`).all()),snapshot);assert.equal(s.state('gmail:test:cursor'),'preserve-cursor');
    const numbered=s.candidates(guild).map(c=>({id:c.id,number:c.public_id}));s.close();s=new AnnouncementStore(path);assert.deepEqual(s.candidates(guild).map(c=>({id:c.id,number:c.public_id})),numbered);
  }finally{s.close();removeAnnouncementTestDirectory(dir);}
});
test('deleting or rejecting candidates never reuses moderator numbers',()=>{
  const s=new AnnouncementStore(':memory:');try{ingestFixture(s,input(),now);const top=s.candidates(guild)[0]!;s.reject(guild,top.id,1,'staff');assert.equal(s.candidate(guild,top.id)?.public_id,top.public_id);
    s.db.prepare('DELETE FROM candidate_sources WHERE candidate=?').run(top.id);s.db.prepare('DELETE FROM candidate_events WHERE id=?').run(top.id);
    ingestFixture(s,input('later',10),now);assert.ok(s.candidates(guild).filter(c=>c.batch!==top.batch).every(c=>c.public_id>top.public_id));assert.equal(s.resolveCandidate(guild,String(top.public_id)),undefined);
  }finally{s.close();}
});
test('two store connections allocate distinct IDs and preserve rollback semantics',()=>{
  const dir=mkdtempSync(join(tmpdir(),'review-concurrent-')),path=join(dir,'db.sqlite'),a=new AnnouncementStore(path),b=new AnnouncementStore(path);
  try{ingestFixture(a,input(),now);ingestFixture(b,input('second',20),now);assert.equal(new Set(a.candidates(guild).map(c=>c.public_id)).size,10);
    const count=a.candidates(guild).length;assert.throws(()=>a.transaction(()=>{ingestFixture(a,input('nested',30),now);}));assert.equal(a.candidates(guild).length,count);
  }finally{a.close();b.close();removeAnnouncementTestDirectory(dir);}
});
test('readable inbox groups a source, has bounded pages, and never dumps UUID JSON',()=>{
  const s=new AnnouncementStore(':memory:');try{ingestFixture(s,input(),now);ingestFixture(s,input('second',20),now);
    const first=inboxPanel(s,guild),second=inboxPanel(s,guild,1);assert.match(first.text,/page 1\/2/);assert.match(second.text,/page 2\/2/);assert.match(first.text,/5 candidates/);assert.doesNotMatch(first.text,uuid);assert.ok(!first.text.trim().startsWith('{'));
    assert.ok(ids(first).includes('announce:page:candidates:1'));assert.ok(ids(second).includes('announce:page:candidates:0'));assert.equal(ids(first).filter((id:string)=>id.startsWith('announce:review:')).length,5);
    assert.equal(s.candidatePage(guild,999).page,1);assert.match(reviewPanel(s,guild,'1').text,/5 candidates from this email: #1, #2, #3, #4, #5/);
  }finally{s.close();}
});
test('review/view, inbox and nonexistent numbers return useful private responses',async()=>{
  const s=new AnnouncementStore(':memory:');try{ingestFixture(s,input(),now);const cmd=makeAnnounceCommand(()=>config,()=>s);
    for(const action of ['inbox','review','view','status']){const m=interaction(action,{id:'1'});await cmd.execute(m.i);assert.equal(m.defers[0].flags,MessageFlags.Ephemeral);assert.doesNotMatch(text(m.replies[0]),uuid);assert.deepEqual(m.replies[0].allowedMentions,{parse:[]});}
    const missing=interaction('view',{id:'999'});await cmd.execute(missing.i);assert.match(text(missing.replies[0]),/candidate not found.*inbox/);
  }finally{s.close();}
});
test('friendly approve/reject perform individual actions and preserve numeric IDs',async()=>{
  const s=new AnnouncementStore(':memory:');try{ingestFixture(s,input(),now);const cmd=makeAnnounceCommand(()=>config,()=>s);
    for(const [action,id] of [['approve','1'],['reject','2']]){const m=interaction(action!,{id,version:1});await cmd.execute(m.i);assert.doesNotMatch(text(m.replies[0]),/blocked/);}
    assert.equal(s.resolveCandidate(guild,'1')?.state,'approved');assert.equal(s.resolveCandidate(guild,'2')?.state,'rejected');assert.equal(s.candidates(guild).filter(c=>c.state==='pending').length,3);assert.equal(s.events(guild).length,1);assert.equal(s.jobs(guild).length,1);assert.equal(config.autoSend,false);
  }finally{s.close();}
});
test('edit increments review version; old command and button approvals remain blocked',async()=>{
  const s=new AnnouncementStore(':memory:');try{ingestFixture(s,input(),now);const cmd=makeAnnounceCommand(()=>config,()=>s),edit=interaction('edit',{id:'1',version:1,start:'2030-01-02 01:00'});await cmd.execute(edit.i);assert.equal(s.resolveCandidate(guild,'1')?.review_version,2);
    const approve=interaction('approve',{id:'1',version:1});await cmd.execute(approve.i);assert.match(text(approve.replies[0]),/stale/);
    const b=interaction('button');Object.assign(b.i,{customId:'announce:facts:1:1'});await makeAnnounceButtonHandler(()=>config,()=>s)(b.i as unknown as ButtonInteraction);assert.match(text(b.replies[0]),/stale/);assert.equal(s.events(guild).length,0);
  }finally{s.close();}
});
test('buttons navigate private reviews and approve only the reviewed version',async()=>{
  const s=new AnnouncementStore(':memory:');try{ingestFixture(s,input(),now);const handler=makeAnnounceButtonHandler(()=>config,()=>s);
    for(const id of ['announce:page:candidates:0','announce:review:1:0','announce:source:1:0','announce:facts:1:1']){const m=interaction('button');Object.assign(m.i,{customId:id});await handler(m.i as unknown as ButtonInteraction);assert.equal(m.defers[0].flags,MessageFlags.Ephemeral);assert.doesNotMatch(text(m.replies[0]),uuid);}
    assert.equal(s.resolveCandidate(guild,'1')?.state,'approved');assert.equal(s.events(guild).length,1);
  }finally{s.close();}
});
test('autocomplete uses readable labels and numeric values, including delivery references',async()=>{
  const s=new AnnouncementStore(':memory:');try{ingestFixture(s,input(),now);const cmd=makeAnnounceCommand(()=>config,()=>s),m=interaction('review',{query:'VTAMPS'});await cmd.autocomplete!(m.i as unknown as AutocompleteInteraction);
    assert.equal(m.choices[0].length,5);assert.match(m.choices[0][0].name,/#\d+.*VTAMPS.*training-session/);assert.match(m.choices[0][0].value,/^\d+$/);
    s.approve(guild,s.resolveCandidate(guild,'1')!.id,1,'staff',now);plan(s,config.policy,now);const j=interaction('preview');await cmd.autocomplete!(j.i as unknown as AutocompleteInteraction);assert.equal(j.choices[0][0].value,'1');assert.equal(requireJob(s,guild,'1').id,s.jobs(guild)[0]!.id);
  }finally{s.close();}
});
test('authorization precedes all config/storage reads for commands, buttons, autocomplete',async()=>{
  const cmd=makeAnnounceCommand(()=>{throw new Error('must not read');}),handler=makeAnnounceButtonHandler(()=>{throw new Error('must not read');});
  for(const action of ['inbox','view','review','source','dismiss-source','status','approve','reject','edit','preview','attach','cancel','reconcile','import']){const m=interaction(action,{},false);await cmd.execute(m.i);assert.match(text(m.replies[0]),/staff permission/);assert.equal(m.replies[0].flags,MessageFlags.Ephemeral);}
  const a=interaction('review',{},false);await cmd.autocomplete!(a.i as unknown as AutocompleteInteraction);assert.deepEqual(a.choices,[[]]);
  const b=interaction('button',{},false);Object.assign(b.i,{customId:'announce:source:1:0'});await handler(b.i as unknown as ButtonInteraction);assert.match(text(b.replies[0]),/staff permission/);
});
test('wrong guild and maintenance cannot retrieve evidence or autocomplete',async()=>{
  const s=new AnnouncementStore(':memory:');try{ingestFixture(s,input(),now);const cmd=makeAnnounceCommand(()=>config,()=>s);
    const wrong=interaction('source',{id:'1'},true,other);await cmd.execute(wrong.i);assert.match(text(wrong.replies[0]),/blocked/);
    const auto=interaction('review',{},true,other);await cmd.autocomplete!(auto.i as unknown as AutocompleteInteraction);assert.deepEqual(auto.choices,[[]]);
    s.setState('maintenance:reset','true');const m=interaction('review',{id:'1'});await cmd.execute(m.i);assert.match(text(m.replies[0]),/blocked/);
  }finally{s.close();}
});
test('source evidence is private, credential redacted, and excludes Gmail IDs/metadata',async()=>{
  const s=new AnnouncementStore(':memory:');try{ingestFixture(s,input('private-gmail-id'),now);const id=sourceId(s,guild,'1');s.saveEvidence(id,{evidence:[{id:'gmail-private-part-id',text:'session 1 begins at 9am'},{id:'login',text:'TIMO username private-user password private-password'}],blocked:[],sensitive:true});
    const m=interaction('source',{id:'1'});await makeAnnounceCommand(()=>config,()=>s).execute(m.i);assert.equal(m.defers[0].flags,MessageFlags.Ephemeral);const output=text(m.replies[0]);assert.match(output,/session 1 begins/);assert.match(output,/credential content withheld/);
    for(const secret of ['private-gmail-id','gmail-private-part-id','private-user','private-password',id,config.gmail.clientSecret,config.gmail.refreshToken,config.provider.backendKey])assert.ok(!output.includes(secret));assert.doesNotMatch(output,uuid);
  }finally{s.close();}
});
test('source inbox reaches blocked sources without manual IDs; dismissal retains holds',async()=>{
  const s=new AnnouncementStore(':memory:');try{ingestFixture(s,input(),now);const id=s.source(guild,input('blocked').source);s.sourceState(id,'blocked');
    const panel=inboxPanel(s,guild,0,'sources');assert.match(panel.text,/organizer email 1.*blocked/);assert.ok(ids(panel).includes(`announce:source:${id}:0`));assert.ok(!panel.text.includes(id));
    const m=interaction('button');Object.assign(m.i,{customId:`announce:dismiss:${id}:0`});await makeAnnounceButtonHandler(()=>config,()=>s)(m.i as unknown as ButtonInteraction);assert.equal(s.db.prepare('SELECT state FROM sources WHERE id=?').get(id)!.state,'dismissed');assert.equal(s.candidates(guild).filter(c=>c.state==='pending').length,5);
  }finally{s.close();}
});
test('forwarded candidate provenance remains privately reviewable without exposing source IDs',async()=>{
  const s=new AnnouncementStore(':memory:');try{ingestFixture(s,input('original'),now);ingestFixture(s,input('forwarded'),now);
    const original=sourceId(s,guild,'1'),forwarded=String(s.db.prepare('SELECT id FROM sources WHERE message_id=?').get('forwarded')!.id);
    s.saveEvidence(original,{evidence:[{text:'original organizer schedule'}]});s.saveEvidence(forwarded,{evidence:[{text:'forwarded organizer clarification'}]});
    const first=sourcePanel(s,guild,'1'),second=sourcePanel(s,guild,'1',1);assert.match(first.text,/source 1\/2/);assert.ok(ids(first).includes('announce:source:1:1'));assert.match(second.text,/forwarded organizer clarification/);assert.ok(!second.text.includes(forwarded));
    const m=interaction('button');Object.assign(m.i,{customId:'announce:source:1:1'});await makeAnnounceButtonHandler(()=>config,()=>s)(m.i as unknown as ButtonInteraction);assert.match(text(m.replies[0]),/forwarded organizer clarification/);assert.equal(m.defers[0].flags,MessageFlags.Ephemeral);
  }finally{s.close();}
});
test('preview and reconcile friendly delivery references preserve uncertainty safety',async()=>{
  const s=new AnnouncementStore(':memory:');try{ingestFixture(s,input(),now);s.approve(guild,s.resolveCandidate(guild,'1')!.id,1,'staff',now);plan(s,config.policy,now);const job=s.jobs(guild)[0]!,cmd=makeAnnounceCommand(()=>config,()=>s);
    const p=interaction('preview',{id:'1'});await cmd.execute(p.i);assert.match(text(p.replies[0]),/public auto-send: OFF/);assert.ok(!text(p.replies[0]).includes(job.id));
    const failed=interaction('reconcile',{id:'1'});await cmd.execute(failed.i);assert.match(text(failed.replies[0]),/blocked/);
    s.db.prepare("UPDATE announcement_jobs SET state='uncertain' WHERE id=?").run(job.id);const m=interaction('reconcile',{id:'1',message:'666666666666666666'});await cmd.execute(m.i);assert.equal(s.job(guild,job.id)?.state,'sent');assert.equal(s.job(guild,job.id)?.message,'666666666666666666');assert.ok(!text(m.replies[0]).includes('666666666666666666'));
  }finally{s.close();}
});
test('cancel resolves friendly event references and enforces current revision',async()=>{
  const s=new AnnouncementStore(':memory:');try{ingestFixture(s,input(),now);s.approve(guild,s.resolveCandidate(guild,'1')!.id,1,'staff',now);plan(s,config.policy,now);const cmd=makeAnnounceCommand(()=>config,()=>s);
    const stale=interaction('cancel',{id:'1',revision:99});await cmd.execute(stale.i);assert.match(text(stale.replies[0]),/stale/);
    const m=interaction('cancel',{id:'1',revision:1});await cmd.execute(m.i);assert.match(text(m.replies[0]),/cancelled; revision 2/);assert.equal(s.jobs(guild)[0]!.state,'cancelled');
  }finally{s.close();}
});
test('manual import produces numbered proposals, retains upload safety and no auto approval',async()=>{
  const s=new AnnouncementStore(':memory:');try{let downloads=0;const cmd=makeAnnounceCommand(()=>config,()=>s,async()=>{downloads++;return{body:Buffer.from(JSON.stringify(input())),type:'application/json',url:'https://cdn.discordapp.com/test.json'};});
    const m=interaction('import',{facts:{size:1000,url:'https://cdn.discordapp.com/test.json'}});await cmd.execute(m.i);assert.match(text(m.replies[0]),/facts proposed: #/);assert.doesNotMatch(text(m.replies[0]),uuid);assert.equal(s.events(guild).length,0);assert.equal(downloads,1);
    for(const facts of [{size:100001,url:'https://cdn.discordapp.com/test.json'},{size:1,url:'https://evil.example/test.json'}]){const bad=interaction('import',{facts});await cmd.execute(bad.i);assert.match(text(bad.replies[0]),/blocked/);}assert.equal(downloads,1);
  }finally{s.close();}
});
test('major asset attachment and hash-locked approval work through friendly references',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'review-assets-')),s=new AnnouncementStore(':memory:');try{ingestFixture(s,input(),now);s.approve(guild,s.resolveCandidate(guild,'1')!.id,1,'staff',now);const cfg={...config,assets:dir,policy:{...config.policy,policies:[{...config.policy.policies[0]!,major:true,asset:'required' as const}]}};plan(s,cfg.policy,now);const job=s.jobs(guild)[0]!;
    const cmd=makeAnnounceCommand(()=>cfg,()=>s,async()=>({body:Buffer.from([137,80,78,71,13,10,26,10,1]),type:'image/png',url:'https://cdn.discordapp.com/test.png'}));
    const attach=interaction('attach',{id:'1',image:{size:9,url:'https://cdn.discordapp.com/test.png'}});await cmd.execute(attach.i);assert.ok(s.job(guild,job.id)!.asset);
    const preview=interaction('preview',{id:'1'});await cmd.execute(preview.i);const customId=preview.replies[0].components[0].toJSON().components[0].custom_id;
    const handler=makeAnnounceButtonHandler(()=>cfg,()=>s),b=interaction('button');Object.assign(b.i,{customId});await handler(b.i as unknown as ButtonInteraction);assert.equal(s.job(guild,job.id)?.state,'scheduled');
    const again=interaction('button');Object.assign(again.i,{customId});await handler(again.i as unknown as ButtonInteraction);assert.match(text(again.replies[0]),/stale/);
  }finally{s.close();removeAnnouncementTestDirectory(dir);}
});
test('auto-send remains off even after moderator approval and planned due jobs',async()=>{
  const s=new AnnouncementStore(':memory:');try{ingestFixture(s,input(),now);s.approve(guild,s.resolveCandidate(guild,'1')!.id,1,'staff',now);plan(s,config.policy,now);const job=s.jobs(guild)[0]!;let sends=0;
    await deliverAnnouncements(s,config,async()=>{sends++;return{id:'666666666666666666'};},job.due);assert.equal(sends,0);assert.equal(s.job(guild,job.id)?.state,'scheduled');assert.equal(jobCandidate(s,guild,job)?.public_id,1);
  }finally{s.close();}
});
test('delivery inbox pagination reaches records beyond the legacy 100-job list',()=>{
  const s=new AnnouncementStore(':memory:');try{ingestFixture(s,input(),now);s.approve(guild,s.resolveCandidate(guild,'1')!.id,1,'staff',now);plan(s,config.policy,now);const job=s.jobs(guild)[0]!;
    for(let n=1;n<105;n++)s.addJob({...job,policy:`fixture-policy-${n}`,due:job.due+n});
    const last=inboxPanel(s,guild,20,'deliveries');assert.match(last.text,/page 21\/21/);assert.equal(ids(last).filter((v:string)=>v.startsWith('announce:preview:')).length,5);assert.doesNotMatch(last.text,/[0-9a-f]{64}/i);
  }finally{s.close();}
});
