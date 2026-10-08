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
const lockedHash=(job:AnnouncementJob)=>digest([job.payload_json,job.asset]);
const idOption=(s:SlashCommandSubcommandBuilder)=>s.addStringOption(o=>o.setName('id').setDescription('Candidate, event or job ID').setRequired(true));
export function makeAnnounceCommand(getConfig:()=>AutomationConfig=automationConfig,getStore:(path:string)=>AnnouncementStore=announcementStore):Command {
  return {data:new SlashCommandBuilder().setName('announce').setDescription('Review mathematics events and announcement jobs.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(s=>s.setName('inbox').setDescription('Private factual review and delivery inbox'))
    .addSubcommand(s=>s.setName('status').setDescription('Private worker and provider health'))
    .addSubcommand(s=>idOption(s.setName('review').setDescription('Preview candidate facts and approval button')))
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
    async execute(i){
      if(!isModerator(i)){await i.reply({content:'staff permission is required.',flags:MessageFlags.Ephemeral});return;}
      await i.deferReply({flags:MessageFlags.Ephemeral});
      try{
        const config=getConfig();if(!config.enabled||i.guildId!==config.policy.guild)throw new Error('Automation is disabled or not configured for this server.');const store=getStore(config.database),guild=i.guildId!,action=i.options.getSubcommand();
        const reply=async(value:unknown,components:ActionRowBuilder<ButtonBuilder>[]=[])=>{const text=typeof value==='string'?value:JSON.stringify(value,null,2);await i.editReply(text.length>1800?{content:'private review attached:',files:[{attachment:Buffer.from(text),name:'announcement-review.txt'}],components,allowedMentions:{parse:[]}}:{content:text,components,allowedMentions:{parse:[]}});};
        if(action==='inbox'){await reply({candidates:store.candidates(guild).map(c=>({id:c.id,state:c.state,version:c.review_version})),jobs:store.jobs(guild).map(j=>({id:j.id,event:j.event_key,state:j.state,major:!!j.major,waitingForCanva:j.asset_policy==='required'&&!j.asset})),sources:store.db.prepare('SELECT id,state,attempts FROM sources WHERE guild=? ORDER BY rowid DESC LIMIT 30').all(guild)});return;}
        if(action==='status'){await reply({enabled:config.enabled,publicAutoSend:config.autoSend,gmailConfigured:!!config.gmail.refreshToken,groqConfigured:!!config.provider.backendKey,gmailHealth:store.state(`gmail:${config.gmail.account}:health`)??'not started',workerLastTick:store.state('worker:last-tick')??'not started',policies:config.policy.policies.length,uncertain:store.jobs(guild).filter(j=>['uncertain','delivering'].includes(j.state)).length});return;}
        if(action==='import'){const file=i.options.getAttachment('facts',true);if(file.size>100000)throw new Error('Facts JSON must be under 100 KB.');const url=new URL(file.url);if(!['cdn.discordapp.com','media.discordapp.net'].includes(url.hostname))throw new Error('Only Discord attachments are accepted.');const data=await safeFetch(file.url,AbortSignal.timeout(10000),100000);await reply({batch:store.ingest(guild,JSON.parse(data.body.toString('utf8')) as Extraction)});return;}
        const id=i.options.getString('id',true);
        if(action==='source'){await reply(store.db.prepare('SELECT s.id,s.state,s.metadata,e.evidence_json FROM sources s LEFT JOIN source_evidence e ON e.source=s.id WHERE s.id=? AND s.guild=?').get(id,guild)??'source not found.');return;}
        if(action==='dismiss-source'){store.dismissSource(guild,id,i.user.id);await reply('source dismissed after staff review; remaining candidate holds still apply.');return;}
        if(action==='review'){
          const c=store.candidate(guild,id);if(!c)throw new Error('Candidate not found.');const event=JSON.parse(c.event_json) as ScheduleEvent;
          const source=store.db.prepare('SELECT s.metadata,e.evidence_json FROM sources s JOIN candidate_batches b ON b.source=s.id LEFT JOIN source_evidence e ON e.source=s.id WHERE b.id=?').get(c.batch);
          const buttons=c.state==='pending'?[new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`announce:facts:${c.id}:${c.review_version}`).setLabel('approve facts').setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId(`announce:reject:${c.id}:${c.review_version}`).setLabel('reject').setStyle(ButtonStyle.Danger))]:[];
          await reply({id,version:c.review_version,state:c.state,facts:describeEvent(event,JSON.parse(c.catalog_json) as Catalog),assumedTimezone:event.timezoneAssumed??false,issues:JSON.parse(c.issues_json),confidence:c.confidence,source,previous:store.event(guild,c.event_key),notice:'Review source evidence; approval is a factual decision, not an OCR-confidence shortcut.'},buttons);return;
        }
        if(action==='preview'){
          const j=store.job(guild,id);if(!j)throw new Error('Job not found.');const buttons=j.major&&j.state==='pending_approval'?[new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`announce:post:${id}:${lockedHash(j).slice(0,32)}`).setLabel('approve this text + asset').setStyle(ButtonStyle.Success))]:[];
          const asset=j.asset?store.asset(guild,j.asset):undefined;
          await reply({id,state:j.state,factsRevision:j.revision,sendAt:new Date(j.due).toISOString(),expires:new Date(j.expires).toISOString(),channel:j.channel,role:j.role,payload:JSON.parse(j.payload_json),assetHash:asset?.hash??null,assetRequired:j.asset_policy==='required',publicAutoSend:config.autoSend},buttons);
          if(asset)await i.followUp({content:'persisted asset preview:',files:[asset.path],flags:MessageFlags.Ephemeral,allowedMentions:{parse:[]}});return;
        }
        if(action==='approve'){store.approve(guild,id,i.options.getInteger('version',true),i.user.id);plan(store,config.policy);await reply('facts approved; jobs planned. public auto-send follows the configured gate.');return;}
        if(action==='reject'){store.reject(guild,id,i.options.getInteger('version',true),i.user.id);await reply('proposal rejected.');return;}
        if(action==='edit'){
          const c=store.candidate(guild,id);if(!c)throw new Error('Candidate not found.');const e=JSON.parse(c.event_json) as ScheduleEvent;
          for(const field of ['start','end','deadline'] as const){const text=i.options.getString(field);if(text)e[field]=parseTime(text);}
          const status=i.options.getString('state') as ScheduleEvent['status'];if(status){e.status=status;if(status!=='active'){e.start=null;e.end=null;e.deadline=null;}}
          const issues=i.options.getBoolean('resolve-issues')?[]:JSON.parse(c.issues_json) as string[];await reply(store.edit(guild,id,i.options.getInteger('version',true),e,issues,i.user.id));return;
        }
        if(action==='cancel'){await reply(store.cancel(guild,id,i.options.getBoolean('postponed')?'postponed':'cancelled',i.user.id,i.options.getInteger('revision',true)));return;}
        if(action==='reconcile'){const message=i.options.getString('message');if(message&&!/^\d{17,20}$/.test(message))throw new Error('Invalid message ID.');store.reconcile(guild,id,message,i.user.id);await reply('delivery reconciled; no resend was queued.');return;}
        if(action==='attach'){
          const file=i.options.getAttachment('image',true),url=new URL(file.url);if(file.size>5_000_000||!['cdn.discordapp.com','media.discordapp.net'].includes(url.hostname))throw new Error('Use a Discord-hosted PNG/JPG under 5 MB.');const result=await safeFetch(file.url,AbortSignal.timeout(10000),5_000_000),data=result.body;
          const png=data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),jpg=data[0]===255&&data[1]===216&&data[2]===255;if(!png&&!jpg)throw new Error('Only PNG/JPG files are accepted.');
          const hash=createHash('sha256').update(data).digest('hex');mkdirSync(config.assets,{recursive:true,mode:0o700});const path=join(config.assets,`${hash}.${png?'png':'jpg'}`);writeFileSync(path,data,{mode:0o600});store.attach(guild,id,{hash,path,mime:png?'image/png':'image/jpeg',bytes:data.length},i.user.id);await reply('asset persisted and hashed. preview again before approving.');return;
        }
      }catch{await i.editReply({content:'announcement action blocked. check the ID, review version, factual issues and configuration; no message was sent.',components:[],allowedMentions:{parse:[]}});}
    }};
}
export const announce=makeAnnounceCommand();
export async function handleAnnounceButton(i:ButtonInteraction){
  if(!isModerator(i)){await i.reply({content:'staff permission is required.',flags:MessageFlags.Ephemeral});return;}
  await i.deferReply({flags:MessageFlags.Ephemeral});
  try{const config=automationConfig();if(!config.enabled||i.guildId!==config.policy.guild)throw new Error('Wrong guild.');const store=announcementStore(config.database),[,action,id,version]=i.customId.split(':');if(!id||!version)throw new Error('Invalid action.');
    if(action==='facts')store.approve(i.guildId!,id,Number(version),i.user.id);
    else if(action==='reject')store.reject(i.guildId!,id,Number(version),i.user.id);
    else if(action==='post'){const j=store.job(i.guildId!,id);if(!j||lockedHash(j).slice(0,32)!==version)throw new Error('Stale preview.');store.approveJob(i.guildId!,id,i.user.id,lockedHash(j));}
    else throw new Error('Unknown action.');plan(store,config.policy);await i.editReply({content:'review action saved. public auto-send remains controlled by the configured gate.',allowedMentions:{parse:[]}});
  }catch{await i.editReply({content:'approval blocked: re-open the latest factual/message preview and resolve issues or required assets.',allowedMentions:{parse:[]}});}
}
