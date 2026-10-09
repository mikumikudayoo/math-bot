import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { AnnouncementStore } from '../src/announcements/store.js';
import { bootstrapGmail,syncGmail,GmailError,type GmailClient } from '../src/announcements/gmail.js';
import { canonicalEvent,eventKey,documentTemplates,type Extraction } from '../src/announcements/model.js';
import { plan } from '../src/announcements/planner.js';
import { workerTick } from '../src/announcements/worker.js';
import { staffAlertContent } from '../src/announcements/alerts.js';
import { completeProvider,ProviderPayloadTooLarge,providerHealth } from '../src/service/providers.js';
import { makeAnnounceCommand } from '../src/commands/announce.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import type { AutomationConfig } from '../src/announcements/config.js';
const guild='111111111111111111';
const config:AutomationConfig={enabled:true,autoSend:false,database:':memory:',assets:'/tmp/announcement-test-assets',policy:{guild,channel:'222222222222222222',role:null,staffChannel:null,policies:[],templates:documentTemplates},gmail:{account:'test',query:'subject:VTAMPS from:organizer@example.org',senders:['organizer@example.org'],clientId:'',clientSecret:'',refreshToken:''},provider:{backend:'https://api.groq.com/openai/v1',model:'test',backendKey:'fixture',vision:false,nativeTools:false},pollMs:120000};
function facts():Extraction{return JSON.parse(readFileSync(new URL('../docs/examples/announcements/vtamps-v25-0.json',import.meta.url),'utf8')) as Extraction;}
function count(s:AnnouncementStore,table:string){return Number(s.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n);}

test('fresh bootstrap only reads profile, saves the boundary, and inbox starts empty',async()=>{
 const s=new AnnouncementStore(':memory:');try{const paths:string[]=[];const client={get:async<T>(path:string)=>{paths.push(path);assert.equal(path,'profile');return {historyId:'100'} as T;}};
 assert.equal(await syncGmail(s,client,config,AbortSignal.timeout(1000)),0);assert.deepEqual(paths,['profile']);assert.equal(s.state('gmail:test:cursor'),'100');assert.equal(s.state('gmail:test:bootstrap-history-id'),'100');assert.equal(s.state('gmail:test:bootstrap-mode'),'future-only');
 for(const table of ['sources','candidate_events','events','announcement_jobs'])assert.equal(count(s,table),0);
 let reply='';const command=makeAnnounceCommand(()=>config,()=>s);await command.execute({inGuild:()=>true,guildId:guild,user:{id:'staff'},memberPermissions:{has:()=>true},deferReply:async()=>{},options:{getSubcommand:()=> 'inbox'},editReply:async(value:unknown)=>{reply=typeof value==='string'?value:String((value as {content:string}).content);}} as unknown as ChatInputCommandInteraction);
 assert.deepEqual(JSON.parse(reply),{candidates:[],jobs:[],sources:[]});
 await assert.rejects(()=>bootstrapGmail(s,client,config,AbortSignal.timeout(1000)),/already bootstrapped/);
 }finally{s.close();}
});

test('future messageAdded alone creates candidates; old search matches never enter sources; replay deduplicates',async()=>{
 const s=new AnnouncementStore(':memory:');try{
 const x=facts();let future=false;const paths:string[]=[];
 const client={get:async<T>(path:string,params:Record<string,string>)=>{paths.push(path);if(path==='profile')return {historyId:'100'} as T;if(path==='history'){assert.ok(['100','101'].includes(params.startHistoryId!));return {historyId:'101',history:future?[{messagesAdded:[{message:{id:'new'}},{message:{id:'new'}}]}]:[]} as T;}if(path==='messages')return {messages:[{id:'old'},{id:'new'}]} as T;assert.equal(path,'messages/new');return {id:'new',payload:{headers:[{name:'From',value:'organizer@example.org'}],mimeType:'text/plain',body:{data:Buffer.from('VTAMPS V.25.0 schedule').toString('base64url')}}} as T;}} as GmailClient;
 await workerTick(s,config,client,async()=>{throw new Error('bootstrap must not extract');});assert.equal(count(s,'sources'),0);future=true;
 await workerTick(s,config,client,async(_provider,_parsed,source)=>({...x,source}));assert.equal(count(s,'sources'),1);assert.equal(count(s,'candidate_events'),5);assert.equal(count(s,'events'),0);assert.equal(count(s,'announcement_jobs'),0);
 await syncGmail(s,client,config,AbortSignal.timeout(1000));assert.equal(count(s,'sources'),1);assert.ok(!paths.includes('messages/old'));
 const alert=s.db.prepare("SELECT id,kind,target FROM staff_alerts WHERE kind='factual-review'").get() as {id:string;kind:string;target:string};assert.equal(count(s,'staff_alerts'),1);assert.ok(staffAlertContent(s,guild,alert).includes('5 candidates'));
 for(const c of s.candidates(guild))s.approve(guild,c.id,c.review_version,'fixture-staff');assert.equal(count(s,'events'),5);
 }finally{s.close();}
});

test('expired cursor fails closed, alerts once, and never lists or imports mail on later polls',async()=>{
 const s=new AnnouncementStore(':memory:');try{s.setState('gmail:test:cursor','100');let calls=0;const client={get:async<T>(path:string)=>{calls++;assert.equal(path,'history');throw new GmailError(404);}};
 await syncGmail(s,client,config,AbortSignal.timeout(1000));await syncGmail(s,client,config,AbortSignal.timeout(1000));assert.equal(calls,1);assert.equal(s.state('gmail:test:cursor'),'100');assert.equal(s.state('gmail:test:health'),'history-gap');assert.equal(count(s,'staff_alerts'),1);assert.equal(count(s,'sources'),0);
 }finally{s.close();}
});

test('session aliases and login notices have canonical identity before storage, with ambiguity rejected',()=>{
 const x=facts(),event=x.events[0]!.event;const keys=['1','01','Session 1','session-1','vtamps-23-0-session-1'].map(slot=>eventKey({...event,slot}));assert.equal(new Set(keys).size,1);assert.throws(()=>canonicalEvent({...event,slot:'sessions 1 and 2'}),/ambiguous/);
 const s=new AnnouncementStore(':memory:');try{for(const [i,slot] of ['Session 1','session-1','vtamps-23-0-session-1'].entries()){const copy=structuredClone(x);copy.source.messageId=String(i);copy.events=[{...copy.events[0]!,event:{...event,slot}}];s.ingest(guild,copy);}assert.equal(count(s,'candidate_events'),1);assert.equal(JSON.parse(s.candidates(guild)[0]!.event_json).slot,'1');
 assert.equal(eventKey({...event,type:'login-details',slot:'login-1'}),eventKey({...event,type:'login-details',slot:'login-2'}));
 }finally{s.close();}
});

test('413 is a payload error, not provider configuration or outage; worker blocks safely for manual disposition',async()=>{
 providerHealth.clear();let calls=0;await assert.rejects(()=>completeProvider(config.provider,{},AbortSignal.timeout(1000),async()=>{calls++;return new Response('private provider body',{status:413});}),ProviderPayloadTooLarge);assert.equal(calls,1);assert.equal([...providerHealth.values()][0]!.state,'healthy');
 const s=new AnnouncementStore(':memory:');try{const x=facts();s.source(guild,x.source);s.setState('gmail:retry-at',String(Date.now()+60000));const client={get:async()=>({id:x.source.messageId,payload:{mimeType:'text/plain',body:{data:Buffer.from('VTAMPS').toString('base64url')}}})} as unknown as GmailClient;
 await workerTick(s,config,client,async()=>{throw new ProviderPayloadTooLarge();});assert.equal(s.db.prepare('SELECT state FROM sources').get()!.state,'blocked');assert.ok(String(s.db.prepare('SELECT reason FROM source_failures').get()!.reason).includes('payload too large'));assert.equal(s.db.prepare("SELECT COUNT(*) n FROM staff_alerts WHERE kind='provider-outage'").get()!.n,0);
 }finally{s.close();providerHealth.clear();}
});

test('past starts, past deadlines, and cancelled events never generate approaching-unapproved alerts',()=>{
 const now=Date.now();for(const type of ['training-session','registration-deadline'] as const)for(const delta of [-1000,0,1000]){
 const s=new AnnouncementStore(':memory:');try{const x=facts();x.events=[x.events[0]!];const e=x.events[0]!.event;e.type=type;e.start=type==='training-session'?now+delta:null;e.end=e.start===null?null:e.start+60000;e.deadline=type==='registration-deadline'?now+delta:null;s.ingest(guild,x);plan(s,config.policy,now);assert.equal(s.db.prepare("SELECT COUNT(*) n FROM staff_alerts WHERE kind='approaching-unapproved'").get()!.n,delta>0?1:0);}finally{s.close();}
 }
 const s=new AnnouncementStore(':memory:');try{const x=facts();x.events=[x.events[0]!];x.events[0]!.event.status='cancelled';x.events[0]!.event.start=now+1000;x.events[0]!.event.end=now+60000;s.ingest(guild,x);plan(s,config.policy,now);assert.equal(s.db.prepare("SELECT COUNT(*) n FROM staff_alerts WHERE kind='approaching-unapproved'").get()!.n,0);}finally{s.close();}
});

test('announcement maintenance blocks late review writes; SQLite replacement remains visible through the open bot connection',()=>{
 const dir=mkdtempSync(join(tmpdir(),'announcement-reset-')),active=join(dir,'active.sqlite'),clean=join(dir,'clean.sqlite');const s=new AnnouncementStore(active),fresh=new AnnouncementStore(clean);
 try{s.ingest(guild,facts());s.setState('maintenance:reset','true');assert.throws(()=>s.ingest(guild,facts()),/reset in progress/);assert.throws(()=>plan(s,config.policy),/reset in progress/);
 fresh.setState('gmail:test:cursor','123');fresh.setState('gmail:test:bootstrap-mode','future-only');fresh.close();
 execFileSync(process.env.PYTHON_EXECUTABLE??'python3',['-c','import sqlite3,sys\ns=sqlite3.connect(sys.argv[1]);d=sqlite3.connect(sys.argv[2]);s.backup(d);d.close();s.close()',clean,active]);
 assert.equal(count(s,'sources'),0);assert.equal(count(s,'candidate_events'),0);assert.equal(s.state('gmail:test:cursor'),'123');assert.equal(s.state('maintenance:reset'),undefined);plan(s,config.policy);
 }finally{s.close();try{fresh.close();}catch{}rmSync(dir,{recursive:true,force:true});}
});
