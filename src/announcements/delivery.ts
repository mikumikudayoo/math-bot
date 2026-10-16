import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ChannelType,PermissionFlagsBits,type Client } from 'discord.js';
import { automationConfig,type AutomationConfig } from './config.js';
import { AnnouncementStore,type AnnouncementJob,type Payload } from './store.js';
import { digest } from './model.js';
import { staffAlertContent,alertActionable } from './alerts.js';
import { plan } from './planner.js';
import {validatePublicDiscordPayload,validatePublicText} from './public-facts.js';
import {effectivePolicy,type EffectivePolicySnapshot} from './delivery-identity.js';
import {loadAnnouncementRuntime} from './runtime-policy.js';

class AnnouncementPreflightError extends Error {}

export async function deliverAnnouncements(store:AnnouncementStore,config:AutomationConfig,send:(job:AnnouncementJob,payload:Payload)=>Promise<{id:string}>,now=Date.now(),snapshot?:EffectivePolicySnapshot){
  if(!config.enabled||!config.autoSend)return;
  snapshot??=effectivePolicy(store,config.policy.guild);
  if(!snapshot||snapshot.fingerprint!==digest(config.policy))return;
  for(const candidate of store.dueJobs(config.policy.guild,now)){
    const job=store.claim(candidate.id,now,snapshot);if(!job)continue;let id:string|null=null;
    try{
      let payload:Payload;
      try{payload=JSON.parse(job.payload_json) as Payload;validatePublicDiscordPayload(payload,{role:job.role,channel:job.channel});store.validateDelivery(job.id,snapshot,now,payload);}
      catch{throw new AnnouncementPreflightError('Announcement delivery preflight blocked.');}
      id=(await send(job,payload)).id;
    }
    catch(error){
      if(error instanceof AnnouncementPreflightError){store.finish(job,null);if(store.job(job.guild,job.id)?.state==='uncertain')store.reconcile(job.guild,job.id,null,'transport-preflight');store.alert(job.guild,'delivery-preflight-blocked',job.id);continue;}
      // A transport error may follow acceptance; its reservation stays consumed.
    }
    store.finish(job,id);
  }
}
let shared:AnnouncementStore|undefined,sharedPath='';
export function announcementStore(path:string){if(shared&&sharedPath!==path)throw new Error('Announcement database path changed while bot is running.');if(!shared){shared=new AnnouncementStore(path);sharedPath=path;}return shared;}
/** Exposed for isolated transport probes; production uses the same host checks. */
export function createAnnouncementTransport(client:Client,store:AnnouncementStore,load:()=>AutomationConfig=automationConfig,isStopped:()=>boolean=()=>false){
  return async(job:AnnouncementJob,payload:Payload)=>{
    let channel:Awaited<ReturnType<Client['channels']['fetch']>>;
    const files=[] as {attachment:Buffer;name:string}[];
    try{
    if(isStopped())throw new Error('Stopping.');
    // Refresh gates and policy before transport. Secrets never enter the payload.
    const fresh=loadAnnouncementRuntime(store,job.guild,load).config;if(!fresh.enabled||!fresh.autoSend)throw new Error('Delivery gate/policy changed.');
    channel=await client.channels.fetch(job.channel,{force:true});
    if(!channel||channel.type!==ChannelType.GuildText||channel.guildId!==job.guild)throw new Error('Destination unavailable.');
    const bot=await channel.guild.members.fetchMe({force:true,cache:false});if(!channel.permissionsFor(bot)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages]))throw new Error('Bot permissions unavailable.');
    if(job.role){const role=await channel.guild.roles.fetch(job.role);if(!role||role.id===job.guild||(!role.mentionable&&!channel.permissionsFor(bot)?.has(PermissionFlagsBits.MentionEveryone)))throw new Error('Role unavailable.');}
    const latest=store.event(job.guild,job.event_key);if(latest?.revision!==job.revision||store.held(job.event_key))throw new Error('Revision changed while delivering; staff must reconcile.');
    validatePublicDiscordPayload(payload,{role:job.role,channel:job.channel});
    if(job.asset){const asset=store.asset(job.guild,job.asset);if(!asset||!resolve(asset.path).startsWith(resolve(fresh.assets)+'/')&&!resolve(asset.path).startsWith(resolve(fresh.assets)+'\\'))throw new Error('Asset unavailable.');const data=readFileSync(asset.path);if(createHash('sha256').update(data).digest('hex')!==asset.hash)throw new Error('Asset integrity failed.');files.push({attachment:data,name:`announcement.${asset.mime==='image/png'?'png':'jpg'}`});}
    // No awaits between this final host check and the actual Discord operation.
    const final=loadAnnouncementRuntime(store,job.guild,load);
    if(isStopped()||!final.config.enabled||!final.config.autoSend||final.config.assets!==fresh.assets)throw new Error('Delivery runtime changed.');
    if(!channel.permissionsFor(bot)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages]))throw new Error('Bot permissions changed.');
    store.validateDelivery(job.id,final.snapshot,Date.now(),payload);
    }catch{throw new AnnouncementPreflightError('Announcement transport preflight blocked.');}
    if(!channel||channel.type!==ChannelType.GuildText)throw new AnnouncementPreflightError('Destination unavailable.');
    return channel.send({...payload,files,nonce:createHash('sha256').update(job.id).digest('hex').slice(0,25),enforceNonce:true});
  };
}
export async function deliverStaffAlerts(client:Client,store:AnnouncementStore,config:AutomationConfig,load:()=>AutomationConfig=automationConfig,isStopped:()=>boolean=()=>false){
  const destination=config.policy.staffChannel;if(!config.enabled||!destination||isStopped())return;
  const channel=await client.channels.fetch(destination,{force:true});
  if(!channel||channel.type!==ChannelType.GuildText||channel.guildId!==config.policy.guild)throw new Error('Staff channel unavailable.');
  const bot=await channel.guild.members.fetchMe({force:true,cache:false});
  const alerts=store.db.prepare("SELECT id,kind,target FROM staff_alerts WHERE guild=? AND state='pending' ORDER BY at,id LIMIT 50").all(config.policy.guild) as {id:string;kind:string;target:string}[];
  let sent=0;
  for(const alert of alerts){
    if(sent>=5)break;
    // Everything after these awaits is checked synchronously at the send boundary.
    const fresh=loadAnnouncementRuntime(store,config.policy.guild,load).config;
    if(isStopped()||!fresh.enabled||fresh.policy.staffChannel!==destination||store.state('maintenance:reset')==='true')return;
    if(channel.permissionsFor(channel.guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel)||!channel.permissionsFor(bot)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages]))throw new Error('Staff channel permissions changed.');
    const claimed=store.transaction(()=>{
      if(!alertActionable(store,config.policy.guild,alert)){
        store.db.prepare("UPDATE staff_alerts SET state='superseded' WHERE id=? AND state='pending'").run(alert.id);return false;
      }
      return !!store.db.prepare("UPDATE staff_alerts SET state='delivering' WHERE id=? AND state='pending'").run(alert.id).changes;
    });
    if(!claimed)continue;
    try{
      const content=staffAlertContent(store,config.policy.guild,alert);validatePublicText(content,'staff alert');
      if(!alertActionable(store,config.policy.guild,alert)){store.db.prepare("UPDATE staff_alerts SET state='superseded' WHERE id=? AND state='delivering'").run(alert.id);continue;}
      const message=await channel.send({content,allowedMentions:{parse:[]},nonce:alert.id.replaceAll('-','').slice(0,25),enforceNonce:true});
      store.db.prepare("UPDATE staff_alerts SET state='sent',message=? WHERE id=? AND state='delivering'").run(message.id,alert.id);sent++;
    }catch{store.db.prepare("UPDATE staff_alerts SET state='uncertain' WHERE id=? AND state='delivering'").run(alert.id);}
  }
}
export function startAnnouncements(client:Client,config:AutomationConfig){
  if(!config.enabled)return ()=>{};
  const store=announcementStore(config.database);let busy=false,stopped=false;
  const send=createAnnouncementTransport(client,store,automationConfig,()=>stopped);
  const tick=async()=>{if(busy||stopped)return;busy=true;try{
    if(store.state('maintenance:reset')==='true'){store.setState('maintenance:bot-ack',String(Date.now()));return;}
    const runtime=loadAnnouncementRuntime(store,config.policy.guild);const current=runtime.config;if(!current.enabled)return;plan(store,current.policy,Date.now(),runtime.snapshot);
    for(const j of store.db.prepare("SELECT id,guild FROM announcement_jobs WHERE guild=? AND state='delivering'").all(config.policy.guild))store.alert(String(j.guild),'stuck-delivery',String(j.id));
    await deliverAnnouncements(store,current,send,Date.now(),runtime.snapshot);
    await deliverStaffAlerts(client,store,current,automationConfig,()=>stopped);
  }catch{console.error('Announcement scheduler blocked; inspect private status.');}finally{busy=false;}};
  const timer=setInterval(()=>void tick(),15000);void tick();return ()=>{stopped=true;clearInterval(timer);};
}
