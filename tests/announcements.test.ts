import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnnouncementStore } from '../src/announcements/store.js';
import { digest,documentTemplates,type Extraction,type ScheduleEvent } from '../src/announcements/model.js';
import { plan } from '../src/announcements/planner.js';
import { deliverAnnouncements } from '../src/announcements/delivery.js';
import { validatePolicy,type AutomationConfig,type PolicyFile } from '../src/announcements/config.js';
import { parseMail,redact } from '../src/announcements/parsing.js';
import { GmailClient,GmailError,syncGmail,type GmailMessage } from '../src/announcements/gmail.js';
import { validateOutput } from '../src/announcements/extraction.js';
import { validateLockedDraft } from '../src/announcements/writing.js';
import { workerTick } from '../src/announcements/worker.js';
import { makeAnnounceCommand } from '../src/commands/announce.js';
import type { ChatInputCommandInteraction } from 'discord.js';
const guild='111111111111111111',now=Date.parse('2030-01-01T00:00:00+08:00');
const policy:PolicyFile={guild,channel:'222222222222222222',role:'333333333333333333',staffChannel:null,policies:[{id:'test-1h',type:'training-session',anchor:'start',beforeMinutes:60,template:'session',major:false,asset:'none'}],templates:documentTemplates};
const config:AutomationConfig={enabled:true,autoSend:false,database:':memory:',assets:'/tmp/announcement-test-assets',policy,gmail:{account:'test',query:'from:organizer@example.org',senders:['organizer@example.org'],clientId:'test',clientSecret:'test',refreshToken:'test'},provider:{backend:'https://api.groq.com/openai/v1',model:'openai/gpt-oss-120b',backendKey:'',nativeTools:false,vision:false},pollMs:120000};
test('Gmail account identity is verified before mailbox synchronization',async()=>{
  const s=new AnnouncementStore(':memory:');try{
    let calls=0;const client={get:async<T>(path:string)=>{calls++;assert.equal(path,'profile');return {emailAddress:'different@example.org',historyId:'1'} as T;}};
    await assert.rejects(()=>syncGmail(s,client,{...config,gmail:{...config.gmail,account:'intended@example.org'}},AbortSignal.timeout(1000)),GmailError);assert.equal(calls,1);assert.equal(s.db.prepare('SELECT count(*) n FROM sources').get()!.n,0);
  }finally{s.close();}
});
function input(message='schedule'):Extraction{
  const x=JSON.parse(readFileSync(new URL('../docs/examples/announcements/vtamps-v25-0.json',import.meta.url),'utf8')) as Extraction;
  x.source.account='test';x.source.messageId=message;x.events.forEach((c,i)=>{c.event.start=now+(i+1)*86400000;c.event.end=c.event.start+150*60000;c.event.timezoneAssumed=true;});return x;
}
function activate(s:AnnouncementStore,x=input()){s.ingest(guild,x,now);for(const c of s.candidates(guild).filter(c=>c.state==='pending'))s.approve(guild,c.id,c.review_version,'staff',now);plan(s,policy,now);}

test('unresolved organizer sources fail closed until disposition; extraction narrows holds to affected identities',()=>{
  const s=new AnnouncementStore(':memory:');try{
    activate(s);const correction=input('unreadable-correction');correction.events=[correction.events[0]!];correction.events[0]!.event.start!+=86400000;correction.events[0]!.event.end!+=86400000;
    const source=s.source(guild,correction.source);s.holdSource(guild,source);assert.equal(s.jobs(guild).filter(j=>j.state==='held').length,5);
    const j=s.jobs(guild)[0]!;assert.equal(s.claim(j.id,j.due),undefined);
    s.ingest(guild,correction,now);assert.equal(s.jobs(guild).filter(j=>j.state==='held').length,1);assert.equal(s.jobs(guild).filter(j=>j.state==='scheduled').length,4);
    const blocked=s.source(guild,input('another-blocked-source').source);s.holdSource(guild,blocked);s.sourceState(blocked,'blocked');assert.throws(()=>s.dismissSource('444444444444444444',blocked,'staff'));
    s.dismissSource(guild,blocked,'staff');assert.equal(s.jobs(guild).filter(j=>j.state==='held').length,1);
    const candidate=s.candidates(guild).find(c=>c.state==='pending')!;s.reject(guild,candidate.id,1,'staff');assert.equal(s.jobs(guild).filter(j=>j.state==='scheduled').length,5);
  }finally{s.close();}
});
test('five training sessions have separate program identity and cannot plan before approval',()=>{
  const s=new AnnouncementStore(':memory:');try{s.ingest(guild,input(),now);assert.deepEqual(plan(s,policy,now),[]);assert.equal(s.candidates(guild).length,5);assert.equal(s.events(guild).length,0);activate(s);assert.equal(s.jobs(guild).length,5);assert.equal(s.events(guild).length,5);assert.ok(s.events(guild).every(e=>JSON.parse(e.event_json).competitionId===null));}finally{s.close();}
});
test('duplicate forwards do not create events/jobs; changed dates share stable identity and supersede unsent old revision',()=>{
  const s=new AnnouncementStore(':memory:');try{activate(s);s.ingest(guild,input('forwarded'),now);assert.equal(s.candidates(guild).filter(c=>c.state==='pending').length,0);plan(s,policy,now);assert.equal(s.jobs(guild).length,5);
    const correction=input('revision');correction.events=[correction.events[0]!];correction.events[0]!.event.start!+=86400000;correction.events[0]!.event.end!+=86400000;s.ingest(guild,correction,now);assert.equal(s.jobs(guild).filter(j=>j.state==='held').length,1);const c=s.candidates(guild).find(c=>c.state==='pending')!;s.approve(guild,c.id,c.review_version,'staff',now);plan(s,policy,now);assert.equal(s.events(guild).length,5);assert.equal(s.jobs(guild).filter(j=>j.state==='superseded').length,1);assert.equal(s.jobs(guild).filter(j=>j.state==='scheduled').length,5);assert.equal(s.event(guild,c.event_key)!.revision,2);
  }finally{s.close();}
});
test('edits require current review version and approval is scoped to server; stale competing revisions cannot overwrite',()=>{
  const s=new AnnouncementStore(':memory:');try{activate(s);const x=input('new');x.events=[x.events[0]!];x.events[0]!.event.start!+=3600000;x.events[0]!.event.end!+=3600000;s.ingest(guild,x);const c=s.candidates(guild).find(c=>c.state==='pending')!;const edited=s.edit(guild,c.id,1,x.events[0]!.event,[],'staff');assert.throws(()=>s.approve(guild,c.id,1,'staff'),/stale/);assert.throws(()=>s.approve('444444444444444444',c.id,edited.review_version,'staff'));
    const other=structuredClone(x);other.source.messageId='competing';other.events[0]!.event.start!+=3600000;other.events[0]!.event.end!+=3600000;s.ingest(guild,other);const stale=s.candidates(guild).find(r=>r.id!==c.id&&r.state==='pending')!;s.approve(guild,c.id,edited.review_version,'staff');assert.throws(()=>s.approve(guild,stale.id,1,'staff'),/Stale event/);
  }finally{s.close();}
});
test('date-only deadlines and uncertainty remain pending; staff correction required',()=>{
  const s=new AnnouncementStore(':memory:');try{
    const x=input();x.catalog.competitions=[{id:'hkimo-2030',name:'HKIMO',year:2030,subject:'mathematics'}];x.events=[x.events[0]!];x.events[0]!.event={...x.events[0]!.event,competitionId:'hkimo-2030',programId:null,type:'registration-deadline',slot:'registration',start:null,end:null,deadline:null,dateHint:'January 4, 2030'};s.ingest(guild,x);const c=s.candidates(guild)[0]!;assert.throws(()=>s.approve(guild,c.id,1,'staff'),/unresolved/);assert.equal(s.jobs(guild).length,0);
    const updated=s.edit(guild,c.id,1,{...x.events[0]!.event,deadline:now+86400000},[],'staff');s.approve(guild,c.id,updated.review_version,'staff');assert.equal(s.events(guild).length,1);
  }finally{s.close();}
});
for(const type of ['classmarker-deadline','competition-day','registration-deadline','qualification'] as const)test(`${type} remains a competition milestone independent of VTAMPS`,()=>{
  const s=new AnnouncementStore(':memory:');try{
    const x=input(type);x.catalog.competitions=[{id:'timo-2030',name:'TIMO',year:2030,subject:'mathematics'}];x.catalog.rounds=[{id:'timo-2030-heat',competitionId:'timo-2030',name:'Heat Round'}];x.events=[x.events[0]!];
    x.events[0]!.event={...x.events[0]!.event,type,competitionId:'timo-2030',roundId:'timo-2030-heat',programId:null,slot:type,preparesFor:[],start:type==='competition-day'?now+86400000:null,end:null,deadline:type.endsWith('deadline')?now+86400000:null};
    s.ingest(guild,x,now);const c=s.candidates(guild)[0]!;s.approve(guild,c.id,1,'staff',now);const e=JSON.parse(s.events(guild)[0]!.event_json) as ScheduleEvent;assert.equal(e.competitionId,'timo-2030');assert.equal(e.programId,null);assert.equal(e.roundId,'timo-2030-heat');
  }finally{s.close();}
});
for(const status of ['cancelled','postponed'] as const)test(`${status} is an approved revision with no invented replacement and no future jobs`,()=>{
  const s=new AnnouncementStore(':memory:');try{activate(s);const e=s.events(guild)[0]!;s.cancel(guild,e.event_key,status,'staff',e.revision);assert.equal(JSON.parse(s.event(guild,e.event_key)!.event_json).start,null);assert.equal(JSON.parse(s.event(guild,e.event_key)!.event_json).status,status);assert.ok(s.jobs(guild).filter(j=>j.event_key===e.event_key).every(j=>j.state==='cancelled'));assert.equal(s.db.prepare('SELECT count(*) n FROM event_revisions WHERE event_key=?').get(e.event_key)!.n,2);}finally{s.close();}
});
test('shadow mode never calls transport; approved routine reminders deliver once without model/network dependencies',async()=>{
  const s=new AnnouncementStore(':memory:');try{activate(s);const due=s.jobs(guild).map(j=>j.due).sort()[0]!;let calls=0;const send=async()=>{calls++;return {id:'sent'};};await deliverAnnouncements(s,config,send,due);assert.equal(calls,0);await deliverAnnouncements(s,{...config,autoSend:true},send,due);await deliverAnnouncements(s,{...config,autoSend:true},send,due);assert.equal(calls,1);}finally{s.close();}
});
test('ambiguous Discord failure never retries and staff reconciliation never queues a resend',async()=>{
  const s=new AnnouncementStore(':memory:');try{activate(s);const due=Math.min(...s.jobs(guild).map(j=>j.due));let calls=0;const send=async()=>{calls++;throw new Error('accepted but response lost');};await deliverAnnouncements(s,{...config,autoSend:true},send,due);await deliverAnnouncements(s,{...config,autoSend:true},send,due);assert.equal(calls,1);const j=s.jobs(guild).find(j=>j.state==='uncertain')!;s.reconcile(guild,j.id,null,'staff');assert.equal(s.job(guild,j.id)!.state,'cancelled');}finally{s.close();}
});
test('durable reservation survives restart and two schedulers cannot race a slow send',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'announcement-race-')),path=join(dir,'test.sqlite');let a=new AnnouncementStore(path);const b=new AnnouncementStore(path);let release!:()=>void;
  try{activate(a);const due=Math.min(...a.jobs(guild).map(j=>j.due));let calls=0;const wait=new Promise<void>(r=>release=r);const send=async()=>{calls++;await wait;return {id:'sent'};};const first=deliverAnnouncements(a,{...config,autoSend:true},send,due);await deliverAnnouncements(b,{...config,autoSend:true},send,due);release();await first;assert.equal(calls,1);
    const next=a.jobs(guild).filter(j=>j.state==='scheduled').sort((x,y)=>x.due-y.due)[0]!;assert.ok(a.claim(next.id,next.due));a.close();a=new AnnouncementStore(path);assert.equal(a.job(guild,next.id)!.state,'delivering');assert.equal(a.claim(next.id,next.due),undefined);
  }finally{release?.();a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});
test('correction queued holds only affected jobs; correction during delivery preserves uncertainty and surfaces staff alert',async()=>{
  const s=new AnnouncementStore(':memory:');try{activate(s);const j=s.jobs(guild).sort((a,b)=>a.due-b.due)[0]!;const x=input('correction');x.events=[x.events.find(c=>guild+':'+digest([c.event.competitionId,c.event.roundId,c.event.programId,c.event.yearLevel,c.event.type,c.event.slot])===j.event_key)!];
    const claimed=s.claim(j.id,j.due)!;assert.ok(claimed);x.events[0]!.event.start!+=86400000;x.events[0]!.event.end!+=86400000;s.ingest(guild,x);const c=s.candidates(guild).find(c=>c.state==='pending')!;s.approve(guild,c.id,1,'staff');s.finish(claimed,null);assert.equal(s.job(guild,j.id)!.state,'uncertain');assert.ok(s.db.prepare("SELECT id FROM staff_alerts WHERE kind='correction-after-send'").get());
  }finally{s.close();}
});
test('offline reminders are skipped instead of late catch-up posts',async()=>{
  const s=new AnnouncementStore(':memory:');try{activate(s);let calls=0;await deliverAnnouncements(s,{...config,autoSend:true},async()=>{calls++;return{id:'wrong'};},now+8*86400000);assert.equal(calls,0);assert.ok(s.jobs(guild).every(j=>j.state==='skipped'));}finally{s.close();}
});
test('major results/qualification require separate message and exact Canva approval',()=>{
  const s=new AnnouncementStore(':memory:');try{const x=input();x.catalog.competitions=[{id:'timo-2030',name:'TIMO',year:2030,subject:'mathematics'}];x.events=[x.events[0]!];x.events[0]!.event={...x.events[0]!.event,type:'results',competitionId:'timo-2030',programId:null,slot:'results',start:now+86400000,end:null};s.ingest(guild,x);const c=s.candidates(guild)[0]!;s.approve(guild,c.id,1,'staff',now);
    const major:PolicyFile={...policy,policies:[{id:'results',type:'results',anchor:'start',beforeMinutes:0,template:'result',major:true,asset:'required'}],templates:{result:'{{role}} results for {{competition}} {{year}} are available.'}};plan(s,major,now);const j=s.jobs(guild)[0]!;assert.equal(j.state,'pending_approval');assert.throws(()=>s.approveJob(guild,j.id,'staff',digest([j.payload_json,j.asset])),/Canva/);
    s.attach(guild,j.id,{hash:'a'.repeat(64),path:'/tmp/test.png',mime:'image/png',bytes:8},'staff');assert.throws(()=>s.approveJob(guild,j.id,'staff',digest([j.payload_json,j.asset])),/stale/);const latest=s.job(guild,j.id)!;s.approveJob(guild,j.id,'staff',digest([latest.payload_json,latest.asset]));assert.equal(s.job(guild,j.id)!.state,'scheduled');
    assert.throws(()=>validatePolicy({...major,policies:[{...major.policies[0]!,major:false}]}));
  }finally{s.close();}
});
test('rejected correction restores original blocked state rather than authorizing an empty message',()=>{
  const s=new AnnouncementStore(':memory:');try{activate(s);const p={...policy,templates:{session:'{{missing}}'}};plan(s,p,now);const x=input('bad');x.events=[x.events[0]!];x.events[0]!.event.start!+=60000;s.ingest(guild,x);const c=s.candidates(guild).find(c=>c.state==='pending')!;assert.equal(s.jobs(guild).find(j=>j.event_key===c.event_key&&j.state==='held')!.state,'held');s.reject(guild,c.id,1,'staff');assert.equal(s.jobs(guild).find(j=>j.event_key===c.event_key&&j.state==='blocked')!.state,'blocked');}finally{s.close();}
});
test('credential redaction removes values/secret links while preserving login-notice workflow',async()=>{
  const raw='BBB 2030 Heat Round credentials: username: alice password: unique-secret https://example.org/?token=individual';assert.ok(!redact(raw).text.includes('unique-secret'));assert.ok(!redact(raw).text.includes('alice'));assert.ok(redact(raw).text.includes('BBB'));
  const parsed=await parseMail({id:'x',payload:{mimeType:'text/plain',body:{data:Buffer.from(raw).toString('base64url')}}},async()=>Buffer.alloc(0));assert.equal(parsed.sensitive,true);assert.ok(!JSON.stringify(parsed).includes('individual'));
});
test('HTML tables retain row separators; image-only schedules become blocked manual review',async()=>{
  const parsed=await parseMail({id:'x',payload:{parts:[{mimeType:'text/html',body:{data:Buffer.from('<table><tr><th>Session</th><th>Date</th></tr><tr><td>Senior Secondary</td><td>Sep 20</td></tr></table>').toString('base64url')}},{mimeType:'image/png',filename:'schedule.png',body:{data:'AA=='}}]}},async()=>Buffer.alloc(0));assert.ok(parsed.evidence[0]!.text.includes('Session | Date |'));assert.ok(parsed.evidence[0]!.text.includes('Senior Secondary | Sep 20 |'));assert.ok(parsed.blocked[0]!.includes('manual factual review'));
});
test('strict schema rejects prompt-injection authority fields, wrong targets, unknown competitions and unsupported science',()=>{
  const x=input(),mail={evidence:[{id:'body',text:'Senior Secondary schedule'}],blocked:[],sensitive:false};const value={catalog:x.catalog,events:x.events.map(c=>({...c,event:{...c.event,dateHint:null,status:'active'},evidenceIds:['body']})),issues:[]};assert.equal(validateOutput(value,mail,x.source).events.length,5);
  assert.throws(()=>validateOutput({...value,approved:true},mail,x.source));
  const wrong=structuredClone(value);wrong.events[0]!.event.yearLevel='Secondary 3' as 'Senior Secondary';assert.throws(()=>validateOutput(wrong,mail,x.source));
  const unknown=structuredClone(value);unknown.events[0]!.event.competitionId='unknown';assert.throws(()=>validateOutput(unknown,mail,x.source));
  const science=structuredClone(value);science.catalog.programs[0]!.name='VTASPS' as 'VTAMPS';assert.throws(()=>validateOutput(science,mail,x.source));
  assert.throws(()=>validateOutput('{not JSON}',mail,x.source));
  const injection=structuredClone(value);Object.assign(injection.events[0]!.event,{autoSend:true,channel:guild,role:guild});assert.throws(()=>validateOutput(injection,mail,x.source));
});
test('locked drafts reject invented dates, URLs, role IDs and missing placeholders',()=>{
  validateLockedDraft('{{role}} participants, Session {{slot}} is on {{date}} from {{timeRange}}.');for(const text of ['on October 20','{{role}} on 2030-01-01','{{role}} visit https://example.org','<@&123> {{date}}','{{unknown}}'])assert.throws(()=>validateLockedDraft(text));
});
test('staff permission is checked before config/storage for every administrative command',async()=>{
  const cmd=makeAnnounceCommand(()=>{throw new Error('must not read config');});for(const action of ['inbox','status','review','preview','approve','reject','edit','attach','cancel','reconcile','import']){let replied=0;await cmd.execute({inGuild:()=>true,user:{id:'444444444444444444'},memberPermissions:{has:()=>false},options:{getSubcommand:()=>action},reply:async()=>{replied++;}} as unknown as ChatInputCommandInteraction);assert.equal(replied,1);}
});
test('Gmail expired history resync is bounded and duplicate history/messages never duplicate sources',async()=>{
  const s=new AnnouncementStore(':memory:');try{s.setState('gmail:test:cursor','expired');const paths:string[]=[];
    const client={get:async(path:string)=>{paths.push(path);if(path==='history')throw new GmailError(404);if(path==='profile')return {historyId:'new'};if(path==='messages')return {messages:[{id:'one'},{id:'one'}]};return {id:'one',payload:{headers:[{name:'From',value:'Organizer <organizer@example.org>'}],mimeType:'text/plain',body:{data:Buffer.from('VTAMPS mathematics').toString('base64url')}}};}} as Pick<GmailClient,'get'>;
    await syncGmail(s,client,config,AbortSignal.timeout(1000));assert.equal(s.state('gmail:test:cursor'),'new');assert.equal(s.db.prepare('SELECT count(*) n FROM sources').get()!.n,1);assert.ok(paths.indexOf('profile')<paths.indexOf('messages'));
  }finally{s.close();}
});
test('history arrivals outside restricted query or organizer list are never ingested',async()=>{
  const s=new AnnouncementStore(':memory:');try{s.setState('gmail:test:cursor','old');let reads=0;const client={get:async(path:string)=>{if(path==='history')return {historyId:'new',history:[{messagesAdded:[{message:{id:'private'}},{message:{id:'organizer'}}]}]};if(path==='messages')return {messages:[{id:'organizer'}]};reads++;return {id:'organizer',payload:{headers:[{name:'From',value:'not-organizer@example.org'}]}};}} as Pick<GmailClient,'get'>;await syncGmail(s,client,config,AbortSignal.timeout(1000));assert.equal(reads,1);assert.equal(s.db.prepare('SELECT count(*) n FROM sources').get()!.n,0);}finally{s.close();}
});
test('worker extraction outage becomes durable retry/blocked source without crashing delivery',async()=>{
  const s=new AnnouncementStore(':memory:');try{const x=input();s.source(guild,x.source);const gmail={get:async(path:string)=>{if(path==='profile')return{historyId:'new'};if(path==='messages')return{messages:[]};return {id:x.source.messageId,payload:{mimeType:'text/plain',body:{data:Buffer.from('VTAMPS V.25.0 schedule').toString('base64url')}}};}} as unknown as GmailClient;
    await workerTick(s,config,gmail,async()=>{throw new Error('malformed extraction');});assert.equal(s.db.prepare('SELECT state FROM sources').get()!.state,'blocked');assert.equal(s.events(guild).length,0);assert.ok(s.state('worker:last-tick'));
  }finally{s.close();}
});

test('alternative MIME bodies share one redacted evidence item',async()=>{
 const body='BBB 2026 Heat Round username private-user password private-password';
 const mail=await parseMail({id:'mime',payload:{mimeType:'multipart/alternative',parts:[{mimeType:'text/plain',body:{data:Buffer.from(body).toString('base64url')}},{mimeType:'text/html',body:{data:Buffer.from(`<p>${body}</p>`).toString('base64url')}}]}},async()=>Buffer.alloc(0));
 assert.equal(mail.evidence.length,1);assert.equal(mail.sensitive,true);assert.ok(!mail.evidence[0]!.text.includes('private-password'));
});
test('duplicate login notices merge by round while conflicts and unreadable attachments require review',()=>{
 const x=input('duplicate-login');x.catalog.competitions=[{id:'bbb-2030',name:'BBB',year:2030,subject:'mathematics'}];x.catalog.rounds=[{id:'bbb-2030-heat',competitionId:'bbb-2030',name:'Heat Round'}];
 const event={...x.events[0]!.event,type:'login-details' as const,competitionId:'bbb-2030',roundId:'bbb-2030-heat',programId:null,slot:'login-1',start:null,end:null,deadline:null,dateHint:null,status:'active' as const};
 const value={catalog:x.catalog,events:[{event,confidence:'high',issues:[],evidenceIds:['body']},{event:{...event,slot:'login-2'},confidence:'medium',issues:[],evidenceIds:['body']}],issues:[]};
 const mail={evidence:[{id:'body',text:'BBB login notice'}],sensitive:true,blocked:['image requires manual review']};
 const merged=validateOutput(value,mail,x.source);assert.equal(merged.events.length,1);assert.equal(merged.events[0]!.event.slot,'login-details');assert.equal(merged.events[0]!.confidence,'medium');assert.ok(merged.events[0]!.issues.includes('image requires manual review'));
 value.events[1]!.event.timezoneAssumed=false;assert.ok(validateOutput(value,mail,x.source).events[0]!.issues.some(i=>i.includes('Conflicting facts')));
});

test('worker distinguishes Groq outages from Gmail source failures and preserves safe failure audit',async()=>{
  const {ProviderBackoff}=await import('../src/service/providers.js');
  for(const failure of [new ProviderBackoff(Date.now()+60000,'http-429'),new GmailError(503,Date.now()+60000)]){
    const s=new AnnouncementStore(':memory:');try{
      const x=input();s.source(guild,x.source);s.setState('gmail:retry-at',String(Date.now()+60000));
      const gmail={get:async()=>({id:x.source.messageId,payload:{mimeType:'text/plain',body:{data:Buffer.from('VTAMPS schedule').toString('base64url')}}})} as unknown as GmailClient;
      await workerTick(s,config,gmail,async()=>{throw failure;});
      assert.equal(s.db.prepare('SELECT state FROM sources').get()!.state,'retry');
      assert.equal(s.db.prepare('SELECT provider FROM source_failures').get()!.provider,failure instanceof ProviderBackoff?'groq':'gmail');
      assert.equal(s.db.prepare("SELECT COUNT(*) n FROM staff_alerts WHERE kind='provider-outage'").get()!.n,failure instanceof ProviderBackoff?1:0);
      assert.equal(s.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='source-failure'").get()!.n,1);
    }finally{s.close();}
  }
});

test('factual review alert names the training program and session while full identities stay in the database',async()=>{
 const {staffAlertContent}=await import('../src/announcements/alerts.js');const s=new AnnouncementStore(':memory:');try{
 s.ingest(guild,input());const alert=s.db.prepare("SELECT id,kind,target FROM staff_alerts WHERE kind='factual-review' LIMIT 1").get() as {id:string;kind:string;target:string};
 const content=staffAlertContent(s,guild,alert);assert.ok(content.includes('VTAMPS'));assert.ok(content.includes('25.0'));assert.ok(content.includes('training-session'));assert.ok(!content.includes(alert.target));assert.ok(content.includes('/announce inbox'));assert.ok(s.candidates(guild).some(c=>c.event_key===alert.target));
 }finally{s.close();}
});
