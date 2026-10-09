import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ChannelType,PermissionFlagsBits,type Client } from 'discord.js';
import { automationConfig,type AutomationConfig } from './config.js';
import { AnnouncementStore,type AnnouncementJob,type Payload } from './store.js';
import { digest } from './model.js';
import { staffAlertContent } from './alerts.js';
import { plan } from './planner.js';

export async function deliverAnnouncements(store:AnnouncementStore,config:AutomationConfig,send:(job:AnnouncementJob,payload:Payload)=>Promise<{id:string}>,now=Date.now()){
  if(!config.enabled||!config.autoSend)return;
  for(const candidate of store.dueJobs(config.policy.guild,now)){
    const job=store.claim(candidate.id,now);if(!job)continue;let id:string|null=null;
    try{id=(await send(job,JSON.parse(job.payload_json) as Payload)).id;}catch{/* No automatic resend after a possibly accepted send. */}
    store.finish(job,id);
  }
}
let shared:AnnouncementStore|undefined,sharedPath='';
export function announcementStore(path:string){if(shared&&sharedPath!==path)throw new Error('Announcement database path changed while bot is running.');if(!shared){shared=new AnnouncementStore(path);sharedPath=path;}return shared;}
export function startAnnouncements(client:Client,config:AutomationConfig){
  if(!config.enabled)return ()=>{};
  const store=announcementStore(config.database);let busy=false,stopped=false;
  const send=async(job:AnnouncementJob,payload:Payload)=>{
    if(stopped)throw new Error('Stopping.');
    // Refresh gates and policy before transport. Secrets never enter the payload.
    const fresh=automationConfig();if(!fresh.enabled||!fresh.autoSend||digest(fresh.policy)!==store.state(`policy:${job.guild}`))throw new Error('Delivery gate/policy changed.');
    const channel=await client.channels.fetch(job.channel);
    if(!channel||channel.type!==ChannelType.GuildText||channel.guildId!==job.guild)throw new Error('Destination unavailable.');
    const bot=await channel.guild.members.fetchMe();if(!channel.permissionsFor(bot)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages]))throw new Error('Bot permissions unavailable.');
    if(job.role){const role=await channel.guild.roles.fetch(job.role);if(!role||role.id===job.guild||(!role.mentionable&&!channel.permissionsFor(bot)?.has(PermissionFlagsBits.MentionEveryone)))throw new Error('Role unavailable.');}
    const latest=store.event(job.guild,job.event_key);if(latest?.revision!==job.revision||store.held(job.event_key))throw new Error('Revision changed while delivering; staff must reconcile.');
    const files=[] as {attachment:Buffer;name:string}[];
    if(job.asset){const asset=store.asset(job.guild,job.asset);if(!asset||!resolve(asset.path).startsWith(resolve(config.assets)+'/')&&!resolve(asset.path).startsWith(resolve(config.assets)+'\\'))throw new Error('Asset unavailable.');const data=readFileSync(asset.path);if(createHash('sha256').update(data).digest('hex')!==asset.hash)throw new Error('Asset integrity failed.');files.push({attachment:data,name:`announcement.${asset.mime==='image/png'?'png':'jpg'}`});}
    return channel.send({...payload,files,nonce:createHash('sha256').update(job.id).digest('hex').slice(0,25),enforceNonce:true});
  };
  const tick=async()=>{if(busy||stopped)return;busy=true;try{
    if(store.state('maintenance:reset')==='true'){store.setState('maintenance:bot-ack',String(Date.now()));return;}
    const current=automationConfig();if(!current.enabled)return;plan(store,current.policy);
    for(const j of store.jobs(config.policy.guild).filter(j=>j.state==='delivering'))store.alert(j.guild,'stuck-delivery',j.id);
    await deliverAnnouncements(store,current,send);
    // Private alerts are separately configured. Durable claim prevents duplicate escalations.
    if(current.policy.staffChannel){const channel=await client.channels.fetch(current.policy.staffChannel);if(!channel||channel.type!==ChannelType.GuildText||channel.guildId!==current.policy.guild)throw new Error('Staff channel unavailable.');
      const everyone=channel.permissionsFor(channel.guild.roles.everyone);if(everyone?.has(PermissionFlagsBits.ViewChannel))throw new Error('Staff alerts require a private channel.');
      const alerts=store.db.prepare("SELECT id,kind,target FROM staff_alerts WHERE guild=? AND state='pending' ORDER BY at LIMIT 5").all(current.policy.guild) as {id:string;kind:string;target:string}[];
      for(const a of alerts){const claimed=store.db.prepare("UPDATE staff_alerts SET state='delivering' WHERE id=? AND state='pending'").run(a.id);if(!claimed.changes)continue;
        try{const message=await channel.send({content:staffAlertContent(store,current.policy.guild,a),allowedMentions:{parse:[]},nonce:a.id.replaceAll('-','').slice(0,25),enforceNonce:true});store.db.prepare("UPDATE staff_alerts SET state='sent',message=? WHERE id=?").run(message.id,a.id);}catch{store.db.prepare("UPDATE staff_alerts SET state='uncertain' WHERE id=?").run(a.id);}
      }
    }
  }catch{console.error('Announcement scheduler blocked; inspect private status.');}finally{busy=false;}};
  const timer=setInterval(()=>void tick(),15000);void tick();return ()=>{stopped=true;clearInterval(timer);};
}
