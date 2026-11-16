import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Collection,PermissionFlagsBits,type Message} from 'discord.js';
import {parseConfig} from '../src/config.js';
import {moderateSecurity,securityStore,closeSecurityStores} from '../src/security/runtime.js';
import {defaultSecurityConfig,emptyExemptions} from '../src/security/types.js';

const guild='111111111111111111',user='222222222222222222',owner='333333333333333333',channel='444444444444444444',botId='555555555555555555';
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'aleph-runtime-'));const config=parseConfig({DISCORD_TOKEN:'fixture',DISCORD_APPLICATION_ID:botId,DISCORD_GUILD_ID:guild,MODERATION_ENGINE_ENABLED:'true',MODERATION_DB_PATH:join(dir,'security.sqlite')},'development');
  const settings=defaultSecurityConfig();settings.mode='enforce';settings.rules=[{id:'test',enabled:true,type:'keyword',patterns:['scam'],policy:'medium',severity:'medium',source:'message',minConfidence:1,obfuscation:false,exemptions:emptyExemptions(),notes:''}];
  settings.policies.find(p=>p.id==='medium')!.steps=[{count:1,action:'timeout',durationMs:60000}];
  const store=securityStore(config.moderationDatabase);store.saveConfig(guild,settings,owner,0);
  const state={manageMessages:true,moderateMembers:true,higher:true,moderatable:true,edited:false,staff:false,deleted:0,timeouts:0,dm:0,log:0};
  const target:any={id:user,user:{id:user,bot:false},roles:{cache:new Collection(),highest:{id:'target'}},permissions:{has:(flag:bigint)=>flag===PermissionFlagsBits.ManageMessages&&state.staff},get moderatable(){return state.moderatable;},timeout:async()=>{state.timeouts++;}};
  const bot:any={id:botId,permissions:{has:(flag:bigint)=>flag===PermissionFlagsBits.ModerateMembers&&state.moderateMembers},roles:{highest:{comparePositionTo:()=>state.higher?1:-1}}};
  const c:any={id:channel,guildId:guild,parentId:null,isThread:()=>false,permissionsFor:()=>({has:(flags:bigint|bigint[])=>Array.isArray(flags)?flags.every(f=>f===PermissionFlagsBits.ViewChannel||state.manageMessages):flags===PermissionFlagsBits.ViewChannel||state.manageMessages}),isSendable:()=>true,send:async()=>{state.log++;}};
  const g:any={id:guild,ownerId:owner,fetch:async()=>g,roles:{fetch:async()=>{}},members:{fetch:async()=>target,fetchMe:async()=>bot},channels:{fetch:async()=>c}};
  const message:any={id:'666666666666666666',guildId:guild,guild:g,channelId:channel,content:'scam',member:target,author:target.user,createdTimestamp:Date.now(),editedTimestamp:null,client:{user:{id:botId},users:{fetch:async()=>({send:async()=>{state.dm++;}})}},delete:async()=>{state.deleted++;},fetch:async()=>({...message,content:state.edited?'harmless':message.content})};
  return {message:message as Message,config,store,state,close(){closeSecurityStores();rmSync(dir,{recursive:true,force:true});}};
}

test('Discord runtime enforces once, records DM/log outcomes and suppresses repeat AI handling',async()=>{
  const f=fixture();try{assert.equal(await moderateSecurity(f.message,f.config),true);assert.equal(await moderateSecurity(f.message,f.config),true);assert.equal(f.state.deleted,1);assert.equal(f.state.timeouts,1);assert.equal(f.state.dm,1);const r=f.store.recent(guild)[0]!;assert.ok(f.store.events(guild,r.id).some(e=>e.phase==='log.skipped'));}finally{f.close();}
});
test('Discord timeout adapter rejects insufficient permission, hierarchy and protected members',async()=>{
  for(const key of ['moderateMembers','higher','moderatable'] as const){const f=fixture();try{f.state[key]=false;await moderateSecurity(f.message,f.config);assert.equal(f.state.timeouts,0,key);assert.equal(f.state.deleted,1);assert.ok(f.store.events(guild,f.store.recent(guild)[0]!.id).some(e=>e.phase==='timeout.failed'));}finally{f.close();}}
});
test('Discord deletion denial stays auditable and does not create an AI reply to blocked content',async()=>{
  const f=fixture();try{f.state.manageMessages=false;assert.equal(await moderateSecurity(f.message,f.config),true);assert.equal(f.state.deleted,0);assert.ok(f.store.events(guild,f.store.recent(guild)[0]!.id).some(e=>e.phase==='delete.failed'));}finally{f.close();}
});
test('fresh message edit prevents punishment of old content',async()=>{
  const f=fixture();try{f.state.edited=true;await moderateSecurity(f.message,f.config);assert.equal(f.state.deleted,0);assert.equal(f.state.timeouts,0);assert.ok(f.store.events(guild,f.store.recent(guild)[0]!.id).some(e=>e.phase==='dispatch.denied'));}finally{f.close();}
});
test('shadow mode leaves legacy ownership intact and disabled feature creates no cases',async()=>{
  const f=fixture();try{assert.equal(await moderateSecurity(f.message,{...f.config,moderationEngine:false}),null);assert.equal(f.store.recent(guild).length,0);f.store.saveConfig(guild,{...f.store.config(guild).config,mode:'shadow'},owner,1);assert.equal(await moderateSecurity(f.message,f.config),null);assert.equal(f.state.deleted,0);assert.equal(f.state.timeouts,0);assert.equal(f.store.count(guild,user,'medium',86400000),0);}finally{f.close();}
});

test('uncached message member is fetched instead of bypassing moderation',async()=>{
  const f=fixture();try{Object.assign(f.message,{member:null});assert.equal(await moderateSecurity(f.message,f.config),true);assert.equal(f.state.deleted,1);assert.equal(f.state.timeouts,1);}finally{f.close();}
});
