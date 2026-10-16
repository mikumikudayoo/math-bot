import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasSensitivePublicContent,normalizePublicText,sanitizeOrganizerEvidence,
  validatePublicText,validatePublicUrl,validatePublicCatalog,validatePublicEvent,validatePublicDiscordPayload,
} from '../src/announcements/public-facts.js';
import {extractFacts,validateOutput} from '../src/announcements/extraction.js';
import {AnnouncementStore} from '../src/announcements/store.js';
import {documentTemplates,validateExtraction,type Extraction} from '../src/announcements/model.js';
import {plan} from '../src/announcements/planner.js';
import {deliverAnnouncements} from '../src/announcements/delivery.js';
import {sourcePanel,reviewedPayload} from '../src/announcements/review-ui.js';
import type {AutomationConfig,PolicyFile} from '../src/announcements/config.js';

// Synthetic family A/D/G evidence only. These values never came from a mailbox.
const syntheticPrivateValues=['TEST-USER-12345','TEST-PASSWORD-6789','TEST-PIN-9876','TEST-CANDIDATE-12345','Synthetic Student','Synthetic School'];
const familyA=[
  'VTAMPS V.30.0 TRAINING GUIDELINES: SENIOR SECONDARY',
  'Session 1: January 8, 2030, 1:00–3:00 PM Asia/Manila',
  'Username: TEST-USER-12345',
  'Password: TEST-PASSWORD-6789',
  'Session 2: January 15, 2030, 1:00–3:00 PM Asia/Manila',
  'Registration deadline: January 20, 2030, 5:00 PM Asia/Manila',
  'Public resource: https://example.org/resources/vtamps',
].join('\n');
const familyD=[
  'TIMO 2030 Heat Round guidelines',
  'Competition date: January 25, 2030; Exam start: 9:00 AM; Exam end: 11:00 AM Asia/Manila',
  'Mock-test window: January 22, 2030, 9:00 AM–5:00 PM Asia/Manila',
  'Candidate ID: TEST-CANDIDATE-12345; PIN: TEST-PIN-9876',
  'Student name: Synthetic Student',
  'School: Synthetic School',
  'https://example.invalid/candidate/TEST-CANDIDATE-12345',
  'Guidebook: https://example.org/resources/timo-guidebook',
].join('\n');

test('synthetic A/D public timetable survives while participant values and links are withheld',()=>{
  for(const raw of [familyA,familyD]){
    const safe=sanitizeOrganizerEvidence(raw);
    assert.equal(safe.sensitive,true);
    for(const value of syntheticPrivateValues)assert.equal(safe.text.includes(value),false);
    assert.match(safe.text,/credential content withheld/iu);
  }
  const a=sanitizeOrganizerEvidence(familyA).text;
  for(const publicFact of ['VTAMPS V.30.0','Session 1: January 8','Session 2: January 15','Registration deadline: January 20','https://example.org/resources/vtamps'])assert.ok(a.includes(publicFact));
  const d=sanitizeOrganizerEvidence(familyD).text;
  for(const publicFact of ['TIMO 2030 Heat Round','Competition date: January 25','Exam start: 9:00 AM','Exam end: 11:00 AM','Mock-test window: January 22','https://example.org/resources/timo-guidebook'])assert.ok(d.includes(publicFact));
  assert.equal(d.includes('/candidate/'),false);
});

test('same-line cells preserve public facts and remove private values without labels becoming value leaks',()=>{
  const safe=sanitizeOrganizerEvidence('TIMO 2030; Exam start: 9 AM; Candidate No.: A9C37; P.I.N.: 765432; Exam end: 11 AM\nCandidate ID | A9C38 | Exam start | 9 AM\nCandidate ID | PIN | Name\nA9C39 | 765433 | Example Person\nA9C41 | 765435 | Another Person\nRegistration deadline: January 20, 2030');
  for(const value of ['A9C37','A9C38','A9C39','A9C41','765432','765433','765435','Example Person','Another Person'])assert.equal(safe.text.includes(value),false);
  for(const publicFact of ['TIMO 2030','Exam start: 9 AM','Exam end: 11 AM','Registration deadline: January 20, 2030'])assert.ok(safe.text.includes(publicFact));
});

test('multiline private labels and credential sections do not leak the next value',()=>{
  const raw='Candidate ID:\nA9C40\nPIN:\n765434\nName\nExample Person\nSchool\nExample Academy\nLogin details:\nunlabelled-account\nunlabelled-secret\nTraining schedule\nSession 1: January 8, 2030, 1 PM';
  const safe=sanitizeOrganizerEvidence(raw);
  for(const value of ['A9C40','765434','Example Person','Example Academy','unlabelled-account','unlabelled-secret'])assert.equal(safe.text.includes(value),false);
  assert.ok(safe.text.includes('Session 1: January 8, 2030, 1 PM'));
});

test('repeated sanitation preserves useful moderator evidence and its compatible credential marker',()=>{
  const first=sanitizeOrganizerEvidence(familyA);
  assert.deepEqual(sanitizeOrganizerEvidence(first.text),{text:first.text,sensitive:false});
  assert.doesNotThrow(()=>validatePublicText('credential content withheld'));
  assert.doesNotThrow(()=>validatePublicText('login details notice'));
  assert.ok(first.text.includes('Session 1: January 8'));
});

test('family G participant readiness with identity stays private at the evidence boundary',()=>{
  const safe=sanitizeOrganizerEvidence('Your ClassMarker is ready to take\nStudent name: Synthetic Student\nUser ID: TEST-USER-12345\nPIN: TEST-PIN-9876\nhttps://example.invalid/user/TEST-USER-12345');
  assert.equal(safe.sensitive,true);
  for(const value of syntheticPrivateValues)assert.equal(safe.text.includes(value),false);
  assert.ok(safe.text.includes('Your ClassMarker is ready to take'));
});

test('entity, percent, JSON escapes, Unicode width and zero-width obfuscation are inspected before redaction',()=>{
  const raws=[
    'Candidate&#32;ID&#58; TEST-CANDIDATE-12345',
    'P&#x49;N&colon; TEST-PIN-9876',
    '%50%61%73%73%77%6f%72%64%3a%20TEST-PASSWORD-6789',
    String.raw`Pass\u0077ord: TEST-PASSWORD-6789`,
    'ｐａｓｓｗｏｒｄ: TEST-PASSWORD-6789',
    'pass\u200bword: TEST-PASSWORD-6789',
    'Candidate ID%253A%2520TEST-CANDIDATE-12345',
    'Pass<b>word</b>: TEST-PASSWORD-6789',
    'PIN&#58 765432',
    'PIN&#x3a 765432',
  ];
  for(const raw of raws){const safe=sanitizeOrganizerEvidence(raw);assert.equal(safe.sensitive,true);for(const value of [...syntheticPrivateValues,'765432'])assert.equal(safe.text.includes(value),false);assert.throws(()=>validatePublicText(raw));}
  assert.equal(normalizePublicText('&amp;#80;IN&#58; 1'),'PIN: 1');
});

test('deep unresolved encodings and non-HTTPS active URL schemes are withheld',()=>{
  let encoded='Password: TEST-PASSWORD-6789';for(let n=0;n<20;n++)encoded=encodeURIComponent(encoded);
  for(const raw of [encoded,'javascript:alert(1)','data:text/plain,private','file:///tmp/private','http:example.org/private']){
    assert.throws(()=>validatePublicText(raw));const safe=sanitizeOrganizerEvidence(raw);assert.equal(safe.sensitive,true);assert.equal(safe.text.includes('TEST-PASSWORD-6789'),false);
  }
  assert.throws(()=>validatePublicText('PIN will be 765432'));
  assert.throws(()=>validatePublicText('PIN will be sent: 765432'));
  for(const raw of ['PIN765432','PIN<span>765432</span>','PIN sent to you 765432','customscheme:opaque-value','//example.org/candidate/A9C123']){
    assert.throws(()=>validatePublicText(raw));const safe=sanitizeOrganizerEvidence(raw);assert.equal(safe.sensitive,true);assert.equal(safe.text.includes('765432'),false);assert.equal(safe.text.includes('A9C123'),false);
  }
});

test('normal schedule and check-your-email notices remain acceptable public facts',()=>{
  for(const text of ['Session 1','Session:1 at 9:00 AM','Exam start:9:00 AM; end:11:00 AM','Senior Secondary','TIMO 2030 Heat Round','registration deadline','login details','login-details notice','participants, please check your email for the login details sent to you.','Credentials were emailed to participants.','PIN will be sent by the organizer.','Exam start: 9 AM; School venue: Main Hall']){
    assert.equal(hasSensitivePublicContent(text),false);
    assert.doesNotThrow(()=>validatePublicText(text));
  }
});

test('public HTTPS resource pages and shared folder shapes remain valid',()=>{
  for(const url of ['https://example.org/resources/vtamps','https://example.org/guidebook.pdf','https://example.org/schedule#session-1','https://drive.google.com/drive/folders/public-general-materials']){
    assert.doesNotThrow(()=>validatePublicUrl(url));
    assert.ok(sanitizeOrganizerEvidence(`Resource: ${url}`).text.includes(url));
  }
});

test('personalized, auth, parameterized, encoded and nonpublic URL structures fail closed',()=>{
  const urls=[
    'http://example.org/resources','https://user:secret@example.org/resources',
    'https://example.org/candidate/A9C123','https://example.org/candidates/A9C123',
    'https://example.org/candidateID/A9C123','https://example.org/candidate;id=A9C123',
    'https://example.org/candidate%3Bid=A9C123','https://example.org/private/A9C123',
    'https://example.org/u/A9C123','https://example.org/profile/A9C123',
    'https://example.org/user/A9C123','https://example.org/student/A9C123',
    'https://example.org/account/A9C123','https://example.org/auth/start',
    'https://example.org/resources?token=A9C123','https://example.org/resources?%74oken=A9C123',
    'https://example.org/resources#token=A9C123','https://example.org/download/A9C123',
    'https://example.org/%63andidate/A9C123','https://example.org/%2563andidate/A9C123',
    'https://example.org/candidate%2FA9C123','https://example.org/session/A9C123',
    'https://example.org/resources%3Ftoken=A9C123','https://zoom.us/j/123456789',
    'https://127.0.0.1/resources','https://localhost/resources','https://files.internal/resources',
    'https://example.org:8443/resources','https://example.org/\\candidate/A9C123',
  ];
  for(const url of urls){assert.throws(()=>validatePublicUrl(url));const safe=sanitizeOrganizerEvidence(`Resource: ${url}`);assert.equal(safe.sensitive,true);assert.equal(safe.text.includes('A9C123'),false);}
});

test('every public event/catalog string receives the boundary including references and future typed fields',()=>{
  const event={competitionId:'timo-2030',roundId:'heat',programId:null,slot:'competition',dateHint:'January 25, 2030',url:'https://example.org/resources/timo',detailLabel:'general guidelines',logistics:{venue:'Main Hall'}};
  const catalog={competitions:[{id:'timo-2030',name:'TIMO'}],rounds:[{id:'heat',name:'Heat Round'}],programs:[]};
  assert.doesNotThrow(()=>validatePublicEvent(event));assert.doesNotThrow(()=>validatePublicCatalog(catalog));
  for(const field of ['competitionId','roundId','programId','slot','dateHint','detailLabel'])assert.throws(()=>validatePublicEvent({...event,[field]:'PIN: TEST-PIN-9876'}));
  for(const item of [{competitions:[{id:'timo-2030',name:'Candidate ID: A9C123'}]},{rounds:[{id:'user ID: A9C123',name:'Heat Round'}]},{programs:[{id:'vtamps',name:'VTAMPS',version:'Password: impossible-secret'}]}])assert.throws(()=>validatePublicCatalog(item));
  assert.throws(()=>validatePublicEvent({...event,logistics:{venue:'Student name: Synthetic Student'}}));
  assert.throws(()=>validatePublicEvent({...event,url:'https://example.org/candidate/A9C123'}));
});

const role='333333333333333333',channel='222222222222222222';
const publicPayload=(content='Session 1 is on January 8, 2030.')=>({content,allowedMentions:{parse:[],roles:[],users:[],repliedUser:false}});
test('final payload permits only exact host role/channel metadata and Discord timestamps',()=>{
  const payload=publicPayload(`<@&${role}> Session 1 reminders are in <#${channel}> before <t:1893456000:F>.`);payload.allowedMentions.roles=[role];
  assert.doesNotThrow(()=>validatePublicDiscordPayload(payload,{role,channel}));
  assert.doesNotThrow(()=>validatePublicDiscordPayload(publicPayload()));
  for(const unsafe of [`<@&${role}> reminder`,`<#${channel}> reminder`,'<@444444444444444444> reminder','@everyone reminder','@here reminder','&lt;@444444444444444444&gt; reminder'])assert.throws(()=>validatePublicDiscordPayload(publicPayload(unsafe)));
  assert.throws(()=>validatePublicDiscordPayload({...payload,allowedMentions:{...payload.allowedMentions,roles:['444444444444444444']}},{role,channel}));
  assert.throws(()=>validatePublicDiscordPayload({...payload,allowedMentions:{...payload.allowedMentions,parse:['everyone']}},{role,channel}));
  assert.throws(()=>validatePublicDiscordPayload({...payload,allowedMentions:{...payload.allowedMentions,users:['444444444444444444']}},{role,channel}));
});

test('legacy persisted public payloads receive the same privacy checks with value-free failures',()=>{
  for(const content of [familyD,'PIN: 765432','Candidate ID: A9C123','https://example.org/candidate/A9C123','Student name: Example Person']){
    const legacy=JSON.parse(JSON.stringify(publicPayload(content))) as unknown;
    assert.throws(()=>validatePublicDiscordPayload(legacy),(error:unknown)=>error instanceof Error&&!['765432','A9C123','Example Person','TEST-'].some(value=>error.message.includes(value)));
  }
  assert.throws(()=>validatePublicDiscordPayload({...publicPayload(),embeds:[{description:'PIN: 765432'}]}));
});

const guild='111111111111111111',now=Date.parse('2030-01-01T00:00:00+08:00');
function safeExtraction():Extraction{return {
  catalog:{competitions:[],rounds:[],programs:[{id:'vtamps-v30-0',name:'VTAMPS',version:'30.0'}]},
  source:{account:'synthetic-test-account',messageId:'synthetic-source',attachment:null,sha256:'a'.repeat(64),locator:'body'},
  events:[{event:{competitionId:null,roundId:null,programId:'vtamps-v30-0',preparesFor:[],yearLevel:'Senior Secondary',type:'training-session',slot:'1',start:now+86400000,end:now+93600000,deadline:null,timezone:'Asia/Manila',url:'https://example.org/resources/vtamps',detailLabel:null,dateHint:null,status:'active',timezoneAssumed:false},confidence:'high',issues:[]}],
};}
const exactTime=(time:number|null)=>time===null?null:{precision:'exact' as const,expression:new Date(time).toISOString(),sourceTime:null};
function providerOutput(x=safeExtraction()){return {disposition:'public',dispositionReason:null,correction:false,catalog:x.catalog,events:x.events.map(c=>({...c,event:{...c.event,availability:null,temporal:{start:exactTime(c.event.start),end:exactTime(c.event.end),deadline:exactTime(c.event.deadline)},logistics:null},evidenceIds:['body']})),issues:[] as string[]};}
function ingestFixture(store:AnnouncementStore,input=safeExtraction(),at=now){
  for(const c of input.events)Object.assign(c,{evidenceIds:['body'],event:{...c.event,temporal:Object.fromEntries((['start','end','deadline'] as const).filter(field=>c.event[field]!==null).map(field=>[field,exactTime(c.event[field])!]))}});
  store.saveEvidence(store.source(guild,input.source),{evidence:[{id:'body',text:'VTAMPS V.30.0 Senior Secondary Session 1: January 2, 2030, 12:00 AM to 2:00 AM Asia/Manila. Public resources: https://example.org/resources/vtamps'}],blocked:[]});
  return store.ingest(guild,input,at);
}
const policy:PolicyFile={guild,channel,role,staffChannel:null,policies:[{id:'session-1h',type:'training-session',anchor:'start',beforeMinutes:60,template:'session',major:false,asset:'none'}],templates:documentTemplates};
const config:AutomationConfig={enabled:true,autoSend:false,database:':memory:',assets:'/tmp/announcement-synthetic-assets',policy,gmail:{account:'synthetic-test-account',query:'from:organizer@example.org',senders:['organizer@example.org'],clientId:'',clientSecret:'',refreshToken:''},provider:{backend:'https://synthetic-provider.example.org/v1',model:'synthetic-announcement-model',backendKey:'',vision:false,nativeTools:false},pollMs:120000};

test('provider receives sanitized A/D evidence and personal family G bypasses the provider',async()=>{
  const familyG='Your ClassMarker is ready to take\nStudent name: Synthetic Student\nCandidate ID: TEST-CANDIDATE-12345\nPIN: TEST-PIN-9876';
  for(const raw of [familyA,familyD,familyG]){
    let captured='',calls=0;
    const complete=(async(_request:unknown,init?:RequestInit)=>{calls++;captured=String(init?.body??'');return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(providerOutput())}}]}),{status:200,headers:{'content-type':'application/json'}});}) as typeof fetch;
    const result=await extractFacts(config.provider,{evidence:[{id:'body',text:raw}],blocked:[],sensitive:false},safeExtraction().source,AbortSignal.timeout(1000),complete);
    for(const value of syntheticPrivateValues){assert.equal(captured.includes(value),false);assert.equal(JSON.stringify(result).includes(value),false);}
    if(raw===familyG){assert.equal(calls,0);assert.equal(result.disposition,'private');assert.deepEqual(result.events,[]);continue;}
    assert.equal(calls,1);
    if(raw===familyA)assert.ok(captured.includes('Session 1: January 8'));
    if(raw===familyD)assert.ok(captured.includes('Exam start: 9:00 AM'));
    assert.ok(captured.includes('credential content withheld'));
  }
});

test('sensitive structured provider output fails through the same host model boundary',()=>{
  const mail={evidence:[{id:'body',text:'Public timetable'}],blocked:[],sensitive:false};
  for(const field of ['slot','detailLabel','dateHint'] as const){
    const output=providerOutput();output.events[0]!.event[field]='Candidate ID: TEST-CANDIDATE-12345';
    assert.throws(()=>validateOutput(output,mail,safeExtraction().source));
  }
  const catalog=providerOutput();catalog.catalog.programs[0]!.version='PIN: TEST-PIN-9876';assert.throws(()=>validateOutput(catalog,mail,safeExtraction().source));
  const issues=providerOutput();issues.events[0]!.issues=['Student name: Synthetic Student'];assert.throws(()=>validateOutput(issues,mail,safeExtraction().source));
  const url=providerOutput();url.events[0]!.event.url='https://example.org/candidate/A9C123';assert.throws(()=>validateOutput(url,mail,safeExtraction().source));
});

test('manual imports and moderator edits cannot bypass public fact validation',()=>{
  const store=new AnnouncementStore(':memory:');try{
    for(const field of ['slot','detailLabel','dateHint'] as const){
      const unsafe=safeExtraction();unsafe.events[0]!.event[field]='PIN: TEST-PIN-9876';
      assert.throws(()=>validateExtraction(unsafe));assert.throws(()=>ingestFixture(store,unsafe,now));
    }
    const unsafeCatalog=safeExtraction();unsafeCatalog.catalog.programs[0]!.version='Student name: Synthetic Student';assert.throws(()=>ingestFixture(store,unsafeCatalog,now));
    const unsafeUrl=safeExtraction();unsafeUrl.events[0]!.event.url='https://example.org/candidate/A9C123';assert.throws(()=>ingestFixture(store,unsafeUrl,now));
    assert.equal(store.candidates(guild).length,0);
    const safe=safeExtraction();ingestFixture(store,safe,now);const candidate=store.candidates(guild)[0]!;
    assert.throws(()=>store.edit(guild,candidate.id,candidate.review_version,{...safe.events[0]!.event,detailLabel:'PIN: TEST-PIN-9876'},[],'synthetic-staff'));
    assert.throws(()=>store.edit(guild,candidate.id,candidate.review_version,safe.events[0]!.event,['Student name: Synthetic Student'],'synthetic-staff'));
    assert.equal(store.candidate(guild,candidate.id)!.event_json,candidate.event_json);
    assert.equal(store.candidate(guild,candidate.id)!.review_version,candidate.review_version);
  }finally{store.close();}
});

test('moderator source evidence remains useful and credential-safe even through direct persistence',()=>{
  const store=new AnnouncementStore(':memory:');try{
    const safe=safeExtraction();ingestFixture(store,safe,now);const source=store.source(guild,safe.source);
    store.saveEvidence(source,{evidence:[{id:'body',text:familyA+'\n'+familyD}],blocked:[],sensitive:true});
    const panel=sourcePanel(store,guild,String(store.candidates(guild)[0]!.public_id)).text;
    for(const value of syntheticPrivateValues)assert.equal(panel.includes(value),false);
    assert.ok(panel.includes('Session 1: January 8'));assert.ok(panel.includes('Exam start: 9:00 AM'));assert.match(panel,/credential content withheld/iu);
  }finally{store.close();}
});

test('approval revalidates persisted candidate content rather than trusting its safety marker',()=>{
  const store=new AnnouncementStore(':memory:');try{
    ingestFixture(store,safeExtraction(),now);const candidate=store.candidates(guild)[0]!;
    store.db.prepare('UPDATE candidate_events SET event_json=? WHERE id=?').run(JSON.stringify({...safeExtraction().events[0]!.event,detailLabel:'PIN: TEST-PIN-9876'}),candidate.id);
    assert.throws(()=>store.approve(guild,candidate.id,candidate.review_version,'synthetic-staff',now));assert.equal(store.events(guild).length,0);
  }finally{store.close();}
});

test('unsafe legacy persisted payload is withheld in preview and blocked before a transport callback',async()=>{
  const store=new AnnouncementStore(':memory:');try{
    ingestFixture(store,safeExtraction(),now);const candidate=store.candidates(guild)[0]!;store.approve(guild,candidate.id,candidate.review_version,'synthetic-staff',now);plan(store,policy,now);
    const job=store.jobs(guild)[0]!;
    // Synthetic corruption models a legacy row or a stale unsafe persistence path.
    store.db.prepare('UPDATE announcement_jobs SET payload_json=? WHERE id=?').run(JSON.stringify(publicPayload('PIN: TEST-PIN-9876')),job.id);
    assert.equal(reviewedPayload(store.job(guild,job.id)!).includes('TEST-PIN-9876'),false);
    let calls=0;
    // This isolated transport-mechanics unit never changes configured auto-send.
    await deliverAnnouncements(store,{...config,autoSend:true},async()=>{calls++;return{id:'synthetic-message'};},job.due);
    assert.equal(calls,0);assert.equal(store.job(guild,job.id)!.state,'blocked');
    assert.ok(store.db.prepare("SELECT id FROM staff_alerts WHERE guild=? AND kind='public-safety-review' AND target=?").get(guild,job.id));
    assert.equal(store.db.prepare('SELECT count(*) n FROM delivery_attempts').get()!.n,0);
  }finally{store.close();}
});
