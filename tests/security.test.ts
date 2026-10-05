import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defaultSecurityConfig, emptyExemptions, type SecurityConfig, type ModerationInput, type Rule } from '../src/security/types.js';
import { normalizeText } from '../src/security/normalization.js';
import { compileSafeRegex, validateSecurityConfig } from '../src/security/config.js';
import { compileDetectors, decide } from '../src/security/detectors.js';
import { SecurityStore } from '../src/security/store.js';
import { executeCase, type ActionAdapter } from '../src/security/actions.js';
import { authorizeConfigChange, canConfigureSecurity } from '../src/security/authorization.js';
import { diagnostics } from '../src/security/diagnostic.js';
import { parseConfig } from '../src/config.js';
import { commandJSON } from '../src/commands/index.js';
import { correlateAudit } from '../src/security/attribution.js';
import { protectedDatabaseRegistry } from '../src/admin/sql.js';

const guild='111111111111111111',user='222222222222222222',owner='333333333333333333',role='444444444444444444',channel='555555555555555555';
const rule=(overrides:Partial<Rule>={}):Rule=>({id:'test-rule',enabled:true,type:'keyword',patterns:['scam'],policy:'medium',severity:'medium',source:'message',minConfidence:1,obfuscation:true,exemptions:emptyExemptions(),notes:'Synthetic test rule',...overrides});
function config(overrides:Partial<SecurityConfig>={}):SecurityConfig{return validateSecurityConfig({...defaultSecurityConfig(),mode:'enforce',rules:[rule()],...overrides});}
const input=(overrides:Partial<ModerationInput>={}):ModerationInput=>({guild,eventId:'message-1',source:'message',content:'this is a scam',author:{id:user,bot:false,staff:false},roles:[],channel:{id:channel,parent:null,category:null},timestamp:10000,...overrides});
function fixture(overrides:Partial<SecurityConfig>={}){let now=10000;const store=new SecurityStore(':memory:',()=>now);store.saveConfig(guild,config(overrides),owner,0);return {store,tick:(ms:number)=>{now+=ms;},process:(id='message-1',overrides:Partial<ModerationInput>={})=>store.process(input({eventId:id,...overrides}),owner)!};}
function adapter(overrides:Partial<ActionAdapter>={}){const calls:string[]=[];const io:ActionAdapter={authorize:async()=>true,deleteMessage:async()=>{calls.push('delete');},timeout:async()=>{calls.push('timeout');},notify:async()=>{calls.push('dm');},log:async()=>{calls.push('log');},...overrides};return {io,calls};}

test('normalization preserves original multilingual text and strips obfuscation only for detection',()=>{
  const text='Filipino: kumusta · 日本語 · 한국어 · café · s\u200bcam';
  const normalized=normalizeText(text);assert.equal(normalized.original,text);assert.ok(normalized.clean.includes('scam'));assert.ok(normalized.clean.includes('日本語'));assert.ok(normalized.clean.includes('한국어'));assert.ok(normalized.clean.includes('café'));
  assert.equal(compileDetectors(config())(input({content:'kumusta 日本語 한국어 café mañana'})).length,0);
});
test('whole-word keywords resist false positives, case and compatibility obfuscation',()=>{
  const detect=compileDetectors(config());
  for(const text of ['ＳＣＡＭ','sc\u200bam','a scam!'])assert.equal(detect(input({content:text}))[0]?.confidence,1,text);
  for(const text of ['scampi','notascam','scam_thing'])assert.equal(detect(input({content:text})).length,0,text);
});
test('spacing and confusable lookalikes yield review-only findings',()=>{
  const cfg=config(),detect=compileDetectors(cfg);
  for(const text of ['s.c.a.m','s c a m','scаm']){
    const findings=detect(input({content:text}));assert.equal(findings.length,1,text);assert.equal(findings[0]!.confidence,0.85);
    assert.equal(decide(cfg,findings,()=>5,'message').action,'review');assert.equal(decide(cfg,findings,()=>5,'message').delete,false);
  }
});
test('domain matching checks exact hosts and subdomains, never URL substrings',()=>{
  const detect=compileDetectors(config({rules:[rule({type:'domain',patterns:['evil.example']})]}));
  for(const text of ['https://evil.example/path','https://sub.evil.example/x','evil.example'])assert.equal(detect(input({content:text})).length,1,text);
  for(const text of ['https://not-evil.example','https://evil.example.safe.example','https://safe.example/evil.example','https://evil.example@safe.example'])assert.equal(detect(input({content:text})).length,0,text);
});
test('Unicode IDN domains can be explicit rules without banning scripts',()=>{
  const detect=compileDetectors(config({rules:[rule({type:'domain',patterns:['例え.テスト']})]}));
  assert.equal(detect(input({content:'https://例え.テスト/page'})).length,1);
  assert.equal(detect(input({content:'https://安全.テスト/page'})).length,0);
});
test('bounded regex accepts useful patterns and rejects backtracking constructs',()=>{
  assert.ok(compileSafeRegex('\\bscam\\b').test('SCAM'));
  assert.ok(compileSafeRegex('[0-9]{4}').test('1234'));
  for(const pattern of ['(a+)+$','a*','a|b','(a)\\1','a{1,100}','a{1,}','a?a?a?','a{2}{2}'])assert.throws(()=>compileSafeRegex(pattern),pattern);
  assert.throws(()=>config({rules:[rule({type:'keyword',patterns:['\u200b']})]}));
});
test('configuration refuses unknown fields, unsupported punishments, duplicate IDs and bad durations',()=>{
  assert.throws(()=>validateSecurityConfig({...config(),unknown:true}));
  assert.throws(()=>config({rules:[rule(),rule()]}));
  assert.throws(()=>config({rules:[rule({policy:'missing'})]}));
  assert.throws(()=>config({policies:[{...config().policies[0]!,steps:[{count:1,action:'ban' as any,durationMs:0}]}]}));
  assert.throws(()=>config({policies:[{...config().policies[0]!,steps:[{count:1,action:'timeout',durationMs:29*86400000}]}]}));
});
test('user, role, channel, thread parent, category, staff and bot exemptions apply before policy',()=>{
  for(const [key,id,overrides] of [
    ['users',user,{}],['roles',role,{roles:[role]}],['channels',channel,{}],['channels',channel,{channel:{id:'thread',parent:channel,category:null}}],['categories',channel,{channel:{id:'other',parent:null,category:channel}}]
  ] as const){const exemptions={...emptyExemptions(),[key]:[id]};assert.equal(compileDetectors(config({exemptions}))(input(overrides)).length,0,key);}
  for(const author of [{id:user,bot:true,staff:false},{id:user,bot:false,staff:true}])assert.equal(compileDetectors(config())(input({author})).length,0);
  assert.equal(compileDetectors(config({rules:[rule({exemptions:{...emptyExemptions(),users:[user]}})]}))(input()).length,0);
});
test('profile detection stays separate and ambiguous profiles never auto-punish',()=>{
  const cfg=config({rules:[rule({source:'profile'})]}),findings=compileDetectors(cfg)(input({source:'profile'}));
  assert.equal(findings.length,1);assert.equal(compileDetectors(cfg)(input()).length,0);
  assert.deepEqual({...decide(cfg,findings,()=>9,'profile'),findings:[]},{findings:[],action:'review',delete:false,durationMs:0,policy:null,count:false,windowMs:0,warningExpiryMs:0});
});
test('rules and punishment policies are independent and use configurable steps',()=>{
  const cfg=config(),findings=compileDetectors(cfg)(input());assert.equal(decide(cfg,findings,()=>0,'message').action,'reminder');assert.equal(decide(cfg,findings,()=>1,'message').action,'warn');
  cfg.policies.find(p=>p.id==='medium')!.steps.push({count:3,action:'timeout',durationMs:60000});assert.equal(decide(cfg,findings,()=>2,'message').durationMs,60000);
});
test('cases and rolling escalation are transactional and duplicate events count once',()=>{
  const t=fixture();try{const first=t.process();assert.equal(first.record.decision.action,'reminder');assert.equal(t.process().fresh,false);assert.equal(t.store.count(guild,user,'medium',86400000),1);assert.equal(t.process('message-2').record.decision.action,'warn');assert.equal(t.store.recent(guild).length,2);}finally{t.store.close();}
});
test('edits create explainable cases without multiplying warnings or escalating twice',()=>{
  const t=fixture();try{t.process();const edited=t.process('message-1',{content:'edited scam again'});assert.equal(edited.fresh,true);assert.equal(edited.record.decision.action,'review');assert.equal(t.store.count(guild,user,'medium',86400000),1);}finally{t.store.close();}
});
test('rolling window and warning expiry use authoritative store time',()=>{
  const cfg=config();cfg.policies.find(p=>p.id==='medium')!.windowMs=2000;cfg.policies.find(p=>p.id==='medium')!.warningExpiryMs=3000;
  const t=fixture({policies:cfg.policies});try{t.process();t.tick(2000);assert.equal(t.process('message-2').record.decision.action,'reminder');t.tick(3000);assert.equal(t.store.count(guild,user,'medium',10000),0);}finally{t.store.close();}
});
test('shadow mode and preview never add rolling infractions or punitive actions',async()=>{
  const t=fixture({mode:'shadow'}),a=adapter();try{const result=t.process();await executeCase(t.store,result.record,a.io);assert.deepEqual(a.calls,['log']);assert.equal(t.store.count(guild,user,'medium',86400000),0);const cfg=t.store.config(guild);cfg.detect(input());assert.equal(t.store.recent(guild).length,1);}finally{t.store.close();}
});
test('persistent cases, configuration and action reservations survive restart',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'aleph-security-')),path=join(dir,'security.sqlite');let store=new SecurityStore(path,()=>10000);
  try{store.saveConfig(guild,config(),owner,0);const record=store.process(input(),owner)!.record;assert.equal(store.claim(record,'dispatch'),true);store.close();store=new SecurityStore(path,()=>10000);assert.equal(store.process(input(),owner)!.fresh,false);assert.equal(store.claim(record,'dispatch'),false);assert.equal(store.count(guild,user,'medium',86400000),1);assert.equal(store.config(guild).revision,1);}finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('separate connections serialize event deduplication and configuration revisions',()=>{
  const dir=mkdtempSync(join(tmpdir(),'aleph-security-')),path=join(dir,'security.sqlite');const a=new SecurityStore(path),b=new SecurityStore(path);
  try{a.saveConfig(guild,config(),owner,0);assert.equal(a.process(input(),owner)!.fresh,true);assert.equal(b.process(input(),owner)!.fresh,false);assert.throws(()=>b.saveConfig(guild,config(),owner,0),/changed/);assert.equal(a.recent(guild).length,1);}finally{a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});
test('store refuses unrelated databases and preserves their tables/version',()=>{
  const dir=mkdtempSync(join(tmpdir(),'aleph-security-')),path=join(dir,'unrelated.sqlite'),db=new DatabaseSync(path);db.exec('CREATE TABLE jobs(id TEXT); INSERT INTO jobs VALUES (\'keep\'); PRAGMA user_version=3');db.close();
  try{assert.throws(()=>new SecurityStore(path),/separate/);const check=new DatabaseSync(path);assert.equal(check.prepare('SELECT id FROM jobs').get()?.id,'keep');assert.equal(check.prepare('PRAGMA user_version').get()?.user_version,3);check.close();}finally{rmSync(dir,{recursive:true,force:true});}
});
test('guild isolation and immutable case/audit history are enforced',()=>{
  const t=fixture();try{const r=t.process().record;assert.equal(t.store.get('other',r.id),undefined);assert.deepEqual(t.store.events('other',r.id),[]);assert.throws(()=>t.store.db.prepare('UPDATE security_cases SET user=? WHERE id=?').run('bad',r.id));assert.throws(()=>t.store.db.prepare('DELETE FROM security_case_events WHERE caseId=?').run(r.id));}finally{t.store.close();}
});
test('action dispatch, notifications and logging execute once across duplicate deliveries',async()=>{
  const t=fixture(),a=adapter();try{const r=t.process().record;assert.equal(await executeCase(t.store,r,a.io),true);assert.equal(await executeCase(t.store,r,a.io),false);assert.deepEqual(a.calls,['delete','dm','log']);assert.ok(t.store.events(guild,r.id).some(e=>e.phase==='dm.succeeded'));}finally{t.store.close();}
});
test('permission denial and stale config prevent actions without destroying cases',async()=>{
  for(const stale of [true,false]){const t=fixture(),a=adapter({authorize:async()=>false});try{const r=t.process().record;if(stale)t.store.saveConfig(guild,config({mode:'disabled'}),owner,1);await executeCase(t.store,r,a.io);assert.deepEqual(a.calls,['log']);assert.ok(t.store.events(guild,r.id).some(e=>e.phase==='dispatch.denied'));}finally{t.store.close();}}
});
test('failed and uncertain actions never automatically retry or repeat DM/log side effects',async()=>{
  const t=fixture(),a=adapter({deleteMessage:async()=>{throw new Error('network');},notify:async()=>{throw {status:403};},log:async()=>{throw new Error('network');}});
  try{const r=t.process().record;await executeCase(t.store,r,a.io);await executeCase(t.store,r,a.io);const events=t.store.events(guild,r.id);assert.ok(events.some(e=>e.phase==='delete.uncertain'));assert.ok(events.some(e=>e.phase==='dm.failed'));assert.ok(events.some(e=>e.phase==='log.uncertain'));}finally{t.store.close();}
});
test('persisted rate limit prevents action floods and survives different events',async()=>{
  const t=fixture({maxActionsPerMinute:1}),a=adapter();try{await executeCase(t.store,t.process('a').record,a.io);const second=t.process('b').record;await executeCase(t.store,second,a.io);assert.deepEqual(a.calls,['delete','dm','log']);assert.ok(t.store.events(guild,second.id).some(e=>e.phase==='rate-limited'));}finally{t.store.close();}
});
test('ordinary moderators cannot disable security or self-authorize a security role',()=>{
  const before=config(),actor={id:user,ownerId:owner,roles:[],manageMessages:true};assert.equal(canConfigureSecurity(actor,before),false);assert.throws(()=>authorizeConfigChange(actor,before,{...before,mode:'disabled'}));
  before.securityRoles=[role];const security={...actor,roles:[role]};authorizeConfigChange(security,before,{...before,mode:'disabled'});assert.throws(()=>authorizeConfigChange(security,before,{...before,securityRoles:[]}));authorizeConfigChange({...actor,id:owner},before,{...before,securityRoles:[]});
});
test('diagnostics distinguish missing permissions, role degradation and future modules',()=>{
  const rows=diagnostics({messageContent:true,enabled:true,permissions:{ModerateMembers:true,ViewAuditLog:true},hierarchy:false,autoMod:null});assert.equal(rows.find(r=>r.name==='timeouts')!.state,'degraded');assert.equal(rows.find(r=>r.name==='message deletion')!.state,'unavailable');assert.equal(rows.find(r=>r.name==='audit attribution')!.state,'not implemented');assert.equal(rows.find(r=>r.name==='Discord AutoMod fallback')!.state,'unavailable');
});
test('new config defaults are disabled and commands stay outside AI tester admission',()=>{
  const cfg=parseConfig({DISCORD_TOKEN:'fixture',DISCORD_APPLICATION_ID:guild,DISCORD_GUILD_ID:guild},'development');assert.equal(cfg.moderationEngine,false);assert.equal(cfg.moderationDatabase,'data/moderation.development.sqlite');
  const commands=JSON.parse(commandJSON());for(const name of ['automod','protection']){const cmd=commands.find((c:any)=>c.name===name);assert.ok(cmd);assert.notEqual(cmd.default_member_permissions,'0');}
});

test('audit correlation requires exact action/target/time and refuses null or ambiguous actors',()=>{
  const event={action:12,targetId:channel,createdAt:10000},entry={id:'entry',action:12,targetId:channel,actorId:user,createdAt:10000};
  assert.deepEqual(correlateAudit([entry],event),{state:'matched',actorId:user,entryId:'entry'});
  assert.deepEqual(correlateAudit([entry,entry],event),{state:'matched',actorId:user,entryId:'entry'});
  for(const candidate of [{...entry,actorId:null},{...entry,targetId:'another'},{...entry,action:32},{...entry,createdAt:999999}])assert.equal(correlateAudit([candidate],event).state,'missing');
  assert.equal(correlateAudit([entry,{...entry,id:'second',actorId:owner}],event).state,'ambiguous');
});

test('raw SQL registry rejects moderation/admin aliases even under another database name',()=>{
  assert.throws(()=>protectedDatabaseRegistry({qotd:join(tmpdir(),'moderation.sqlite')},[join(tmpdir(),'moderation.sqlite')]),/separate/);
  assert.throws(()=>protectedDatabaseRegistry({ai:join(tmpdir(),'admin.sqlite')},[join(tmpdir(),'admin.sqlite')]),/separate/);
  assert.deepEqual(protectedDatabaseRegistry({ai:'data/ai.sqlite'},['data/moderation.sqlite','data/admin.sqlite']),{ai:'data/ai.sqlite'});
});
