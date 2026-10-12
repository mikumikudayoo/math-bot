import { SlashCommandBuilder,PermissionFlagsBits,MessageFlags,ActionRowBuilder,ButtonBuilder,ButtonStyle,type SlashCommandSubcommandBuilder,type ButtonInteraction } from 'discord.js';
import { isModerator } from '../admin/auth.js';
import type { Command } from './types.js';
import { automationConfig,type AutomationConfig } from '../announcements/config.js';
import { announcementStore } from '../announcements/delivery.js';
import { AnnouncementStore,type AnnouncementJob } from '../announcements/store.js';
import { describeEvent,digest,type ScheduleEvent,type Catalog,type Extraction } from '../announcements/model.js';
import { plan } from '../announcements/planner.js';
import { safeFetch } from '../service/network.js';
import { createHash } from 'node:crypto';
import { mkdirSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTime } from '../reminders/types.js';
import { inboxPanel,reviewPanel,sourcePanel,sourceId,requireCandidate,requireJob,jobCandidate,jobLabel,title,safeText,actionError,ReviewError } from '../announcements/review-ui.js';
const lockedHash=(job:AnnouncementJob)=>digest([job.payload_json,job.asset]);
const idOption=(s:SlashCommandSubcommandBuilder)=>s.addStringOption(o=>o.setName('id').setDescription('Candidate number from the inbox (for example 17)').setRequired(true).setAutocomplete(true));
export function makeAnnounceCommand(getConfig:()=>AutomationConfig=automationConfig,getStore:(path:string)=>AnnouncementStore=announcementStore,fetchAttachment:typeof safeFetch=safeFetch):Command {
  return {data:new SlashCommandBuilder().setName('announce').setDescription('Review mathematics events and announcement jobs.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(s=>s.setName('inbox').setDescription('Private factual review and delivery inbox').addStringOption(o=>o.setName('kind').setDescription('Inbox section').addChoices({name:'candidates',value:'candidates'},{name:'deliveries',value:'deliveries'},{name:'sources needing review',value:'sources'})).addIntegerOption(o=>o.setName('page').setDescription('Page number').setMinValue(1)))
    .addSubcommand(s=>s.setName('status').setDescription('Private worker and provider health'))
    .addSubcommand(s=>idOption(s.setName('review').setDescription('Preview candidate facts and approval button')))
    .addSubcommand(s=>idOption(s.setName('view').setDescription('View a numbered candidate and its review actions')))
    .addSubcommand(s=>idOption(s.setName('preview').setDescription('Preview exact persisted message and approval button')))
    .addSubcommand(s=>idOption(s.setName('approve').setDescription('Approve candidate facts from the reviewed version')).addIntegerOption(o=>o.setName('version').setDescription('Review version shown by /announce review').setRequired(true)))
    .addSubcommand(s=>idOption(s.setName('reject').setDescription('Reject candidate facts')).addIntegerOption(o=>o.setName('version').setDescription('Reviewed candidate version').setRequired(true)))
    .addSubcommand(s=>idOption(s.setName('source').setDescription('Review blocked organizer source and redacted evidence')))
    .addSubcommand(s=>idOption(s.setName('dismiss-source').setDescription('Dismiss a reviewed source and release its unresolved holds')))
    .addSubcommand(s=>idOption(s.setName('edit').setDescription('Correct candidate times/status; preview again afterwards')).addIntegerOption(o=>o.setName('version').setDescription('Reviewed candidate version').setRequired(true)).addStringOption(o=>o.setName('start').setDescription('YYYY-MM-DD HH:mm Manila')).addStringOption(o=>o.setName('end').setDescription('YYYY-MM-DD HH:mm Manila')).addStringOption(o=>o.setName('deadline').setDescription('YYYY-MM-DD HH:mm Manila')).addStringOption(o=>o.setName('state').setDescription('Event state').addChoices(...['active','cancelled','postponed'].map(value=>({name:value,value})))).addBooleanOption(o=>o.setName('resolve-issues').setDescription('Explicitly confirm all listed factual issues were resolved')))
    .addSubcommand(s=>idOption(s.setName('attach').setDescription('Persist your exported Canva PNG/JPG for a major post')).addAttachmentOption(o=>o.setName('image').setDescription('PNG/JPG exported by staff').setRequired(true)))
    .addSubcommand(s=>idOption(s.setName('cancel').setDescription('Approve cancellation or postponement of an event')).addIntegerOption(o=>o.setName('revision').setDescription('Current event revision').setRequired(true)).addBooleanOption(o=>o.setName('postponed').setDescription('No replacement time yet')))
    .addSubcommand(s=>idOption(s.setName('reconcile').setDescription('Resolve uncertain delivery after checking destination')).addStringOption(o=>o.setName('message').setDescription('Existing Discord message ID, or omit to cancel without retry')))
    .addSubcommand(s=>s.setName('import').setDescription('Manually propose structured facts for a blocked image/source').addAttachmentOption(o=>o.setName('facts').setDescription('Reviewed extraction JSON; proposals still need factual approval').setRequired(true))),
    async autocomplete(i){
      if(!isModerator(i)){await i.respond([]);return;}
      try{
        const config=getConfig();if(!config.enabled||i.guildId!==config.policy.guild){await i.respond([]);return;}
        const store=getStore(config.database),guild=i.guildId!;
        if(store.state('maintenance:reset')==='true'){await i.respond([]);return;}
        const action=i.options.getSubcommand(),query=String(i.options.getFocused()).toLowerCase().replace(/^#/,'');
        let choices:{name:string;value:string}[];
        if(['preview','attach','reconcile'].includes(action))choices=store.jobs(guild).flatMap(j=>{const c=jobCandidate(store,guild,j);return c?[{name:`${jobLabel(store,guild,j)} · ${j.state}`.slice(0,100),value:String(c.public_id)}]:[];}).filter((choice,index,all)=>all.findIndex(c=>c.value===choice.value)===index);
        else choices=store.candidates(guild).filter(c=>!['approve','reject','edit'].includes(action)||c.state==='pending').map(c=>({name:`#${c.public_id} · ${title(c)} · ${(JSON.parse(c.event_json) as ScheduleEvent).type}`.slice(0,100),value:String(c.public_id)}));
        await i.respond(choices.filter(c=>c.name.toLowerCase().includes(query)||c.value.startsWith(query)).slice(0,25));
      }catch{await i.respond([]);}
    },
    async execute(i){
      if(!isModerator(i)){await i.reply({content:'staff permission is required.',flags:MessageFlags.Ephemeral});return;}
      await i.deferReply({flags:MessageFlags.Ephemeral});
      try{
        const config=getConfig();if(!config.enabled||i.guildId!==config.policy.guild)throw new Error('Automation is disabled or not configured for this server.');const store=getStore(config.database),guild=i.guildId!,action=i.options.getSubcommand();
        if(store.state('maintenance:reset')==='true')throw new Error('Announcement storage is undergoing a verified reset. Please retry shortly.');
        const reply=async(text:string,components:ActionRowBuilder<ButtonBuilder>[]=[])=>{await i.editReply(text.length>1800?{content:'private review attached:',files:[{attachment:Buffer.from(text),name:'announcement-review.txt'}],components,allowedMentions:{parse:[]}}:{content:text,components,allowedMentions:{parse:[]}});};
        if(action==='inbox'){const panel=inboxPanel(store,guild,(i.options.getInteger('page')??1)-1,i.options.getString('kind')??'candidates');await reply(panel.text,panel.components);return;}
        if(action==='status'){await reply(`announcement status\nenabled: ${config.enabled} · public auto-send: ${config.autoSend?'ON':'OFF'}\ngmail configured: ${!!config.gmail.refreshToken} · health: ${safeText(store.state(`gmail:${config.gmail.account}:health`)??'not started')}\nbootstrap: ${safeText(store.state(`gmail:${config.gmail.account}:bootstrap-mode`)??'not started')}\ngroq configured: ${!!config.provider.backendKey} · health: ${safeText(store.state('provider:health')??'not started')}\npolicies: ${config.policy.policies.length} · uncertain deliveries: ${store.jobs(guild).filter(j=>['uncertain','delivering'].includes(j.state)).length}\nworker last tick: ${safeText(store.state('worker:last-tick')??'not started')}`);return;}
        if(action==='import'){const file=i.options.getAttachment('facts',true);if(file.size>100000)throw new Error('Facts JSON must be under 100 KB.');const url=new URL(file.url);if(!['cdn.discordapp.com','media.discordapp.net'].includes(url.hostname))throw new Error('Only Discord attachments are accepted.');const data=await fetchAttachment(file.url,AbortSignal.timeout(10000),100000);const batch=store.ingest(guild,JSON.parse(data.body.toString('utf8')) as Extraction);const ids=store.candidates(guild).filter(c=>c.batch===batch).map(c=>`#${c.public_id}`);await reply(`facts proposed: ${ids.join(', ')||'existing proposals retained'}. open /announce inbox to review; nothing was sent.`);return;}
        const id=i.options.getString('id',true);
        if(action==='source'){const panel=sourcePanel(store,guild,id);await reply(panel.text,panel.components);return;}
        if(action==='dismiss-source'){store.dismissSource(guild,sourceId(store,guild,id),i.user.id);await reply('source dismissed after staff review; remaining candidate holds still apply.');return;}
        if(action==='review'||action==='view'){const panel=reviewPanel(store,guild,id);await reply(panel.text,panel.components);return;}
        if(action==='preview'){
          const j=requireJob(store,guild,id);const buttons=j.major&&j.state==='pending_approval'?[new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`announce:post:${j.id}:${lockedHash(j).slice(0,32)}`).setLabel('approve this text + asset').setStyle(ButtonStyle.Success))]:[];
          const asset=j.asset?store.asset(guild,j.asset):undefined;
          await reply(`${jobLabel(store,guild,j)}\nstatus: ${j.state} · facts revision: ${j.revision}\nsend at: ${new Date(j.due).toISOString()}\nexpires: ${new Date(j.expires).toISOString()}\ndestination: <#${j.channel}>\nasset: ${asset?'attached':j.asset_policy==='required'?'required, missing':'not required'}\npublic auto-send: ${config.autoSend?'ON':'OFF'}\n\n${(JSON.parse(j.payload_json) as {content:string}).content}`,buttons);
          if(asset)await i.followUp({content:'persisted asset preview:',files:[asset.path],flags:MessageFlags.Ephemeral,allowedMentions:{parse:[]}});return;
        }
        if(action==='approve'){store.approve(guild,requireCandidate(store,guild,id).id,i.options.getInteger('version',true),i.user.id);plan(store,config.policy);await reply('facts approved; jobs planned. public auto-send follows the configured gate.');return;}
        if(action==='reject'){store.reject(guild,requireCandidate(store,guild,id).id,i.options.getInteger('version',true),i.user.id);await reply('proposal rejected.');return;}
        if(action==='edit'){
          const c=requireCandidate(store,guild,id);const e=JSON.parse(c.event_json) as ScheduleEvent;
          for(const field of ['start','end','deadline'] as const){const text=i.options.getString(field);if(text)e[field]=parseTime(text);}
          const status=i.options.getString('state') as ScheduleEvent['status'];if(status){e.status=status;if(status!=='active'){e.start=null;e.end=null;e.deadline=null;}}
          const issues=i.options.getBoolean('resolve-issues')?[]:JSON.parse(c.issues_json) as string[];const edited=store.edit(guild,c.id,i.options.getInteger('version',true),e,issues,i.user.id);const panel=reviewPanel(store,guild,String(edited.public_id));await reply(panel.text,panel.components);return;
        }
        if(action==='cancel'){const c=store.resolveCandidate(guild,id),event=store.cancel(guild,c?.event_key??id,i.options.getBoolean('postponed')?'postponed':'cancelled',i.user.id,i.options.getInteger('revision',true));await reply(`event ${JSON.parse(event.event_json).status}; revision ${event.revision}. affected deliveries are blocked; no message was sent.`);return;}
        if(action==='reconcile'){const message=i.options.getString('message');if(message&&!/^\d{17,20}$/.test(message))throw new Error('Invalid message ID.');store.reconcile(guild,requireJob(store,guild,id).id,message,i.user.id);await reply('delivery reconciled; no resend was queued.');return;}
        if(action==='attach'){
          const file=i.options.getAttachment('image',true),url=new URL(file.url);if(file.size>5_000_000||!['cdn.discordapp.com','media.discordapp.net'].includes(url.hostname))throw new Error('Use a Discord-hosted PNG/JPG under 5 MB.');const result=await fetchAttachment(file.url,AbortSignal.timeout(10000),5_000_000),data=result.body;
          const png=data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),jpg=data[0]===255&&data[1]===216&&data[2]===255;if(!png&&!jpg)throw new Error('Only PNG/JPG files are accepted.');
          const hash=createHash('sha256').update(data).digest('hex');mkdirSync(config.assets,{recursive:true,mode:0o700});const path=join(config.assets,`${hash}.${png?'png':'jpg'}`);writeFileSync(path,data,{mode:0o600});store.attach(guild,requireJob(store,guild,id).id,{hash,path,mime:png?'image/png':'image/jpeg',bytes:data.length},i.user.id);await reply('asset persisted and hashed. preview again before approving.');return;
        }
      }catch(error){await i.editReply({content:actionError(error),components:[],allowedMentions:{parse:[]}});}
    }};
}
export const announce=makeAnnounceCommand();
export function makeAnnounceButtonHandler(getConfig:()=>AutomationConfig=automationConfig,getStore:(path:string)=>AnnouncementStore=announcementStore){
  return async(i:ButtonInteraction)=>{
    if(!isModerator(i)){await i.reply({content:'staff permission is required.',flags:MessageFlags.Ephemeral});return;}
    await i.deferReply({flags:MessageFlags.Ephemeral});
    try{
      const config=getConfig();if(!config.enabled||i.guildId!==config.policy.guild)throw new ReviewError('announcement reviews are unavailable in this server.');
      const store=getStore(config.database),guild=i.guildId!,[,action,id,version]=i.customId.split(':');if(!id||!version)throw new ReviewError('invalid review action. open the inbox again.');
      if(store.state('maintenance:reset')==='true')throw new ReviewError('announcement storage is under maintenance. try again shortly.');
      const reply=async(panel:{text:string;components:ActionRowBuilder<ButtonBuilder>[]})=>{await i.editReply(panel.text.length>1800?{content:'private review attached:',files:[{attachment:Buffer.from(panel.text),name:'announcement-review.txt'}],components:panel.components,allowedMentions:{parse:[]}}:{content:panel.text,components:panel.components,allowedMentions:{parse:[]}});};
      if(action==='page'){await reply(inboxPanel(store,guild,Number(version),id));return;}
      if(action==='review'){await reply(reviewPanel(store,guild,id));return;}
      if(action==='source'){await reply(sourcePanel(store,guild,id,Number(version)));return;}
      if(action==='preview'){
        const j=requireJob(store,guild,id),asset=j.asset?store.asset(guild,j.asset):undefined;
        await reply({text:`${jobLabel(store,guild,j)}\nstatus: ${j.state} · revision: ${j.revision}\nsend at: ${new Date(j.due).toISOString()}\nasset: ${asset?'attached':j.asset_policy==='required'?'required, missing':'not required'}\npublic auto-send: ${config.autoSend?'ON':'OFF'}\n\n${(JSON.parse(j.payload_json) as {content:string}).content}`,components:j.major&&j.state==='pending_approval'?[new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`announce:post:${j.id}:${lockedHash(j).slice(0,32)}`).setLabel('approve this text + asset').setStyle(ButtonStyle.Success))]:[]});
        if(asset)await i.followUp({content:'persisted asset preview:',files:[asset.path],flags:MessageFlags.Ephemeral,allowedMentions:{parse:[]}});return;
      }
      if(action==='facts')store.approve(guild,requireCandidate(store,guild,id).id,Number(version),i.user.id);
      else if(action==='reject')store.reject(guild,requireCandidate(store,guild,id).id,Number(version),i.user.id);
      else if(action==='dismiss')store.dismissSource(guild,sourceId(store,guild,id),i.user.id);
      else if(action==='post'){const j=store.job(guild,id);if(!j||lockedHash(j).slice(0,32)!==version)throw new ReviewError('that preview changed. open the latest delivery preview.');store.approveJob(guild,id,i.user.id,lockedHash(j));}
      else throw new ReviewError('unknown review action.');
      if(action==='facts'||action==='reject'||action==='post')plan(store,config.policy);
      await i.editReply({content:'review action saved. public auto-send remains controlled by the configured gate.',components:[],allowedMentions:{parse:[]}});
    }catch(error){await i.editReply({content:actionError(error),components:[],allowedMentions:{parse:[]}});}
  };
}
export const handleAnnounceButton=makeAnnounceButtonHandler();
