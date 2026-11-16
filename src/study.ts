import { MessageFlags, type ChatInputCommandInteraction, type Message } from 'discord.js';
import { service } from './ai-client.js';
import { loadConfig } from './config.js';
import type { Job, JobKind } from './service/types.js';
import { authorizeAIInteraction, isAITester } from './ai-access.js';
import { Competition } from './qotd/competition.js';
import { qotdStore } from './qotd/posting.js';
import { discordIdentity, parseTrigger } from './discord-context.js';
import { captureDiscordState } from './discord-snapshot.js';
import {imageAttachments} from './service/vision.js';
import {ServiceError} from './ai-client.js';
import type {ImageAttachment} from './service/types.js';
import {bindPrimary,queuedPayload} from './delivery.js';
export {startDelivery,studyContent} from './delivery.js';

export interface StudyRuntime { config: typeof loadConfig; service: typeof service; isQotdDiscussion?: (guild:string,channel:string)=>boolean; v2Enabled?:()=>Promise<boolean> }
const defaultRuntime: StudyRuntime = { config: loadConfig, service,
  v2Enabled:async()=> (await service<{provider:string}>('/health')).provider==='openai',
  isQotdDiscussion:(guild,channel)=>new Competition(qotdStore()).isDiscussion(guild,channel) };
export function coach(user:string,roles:string[],c=loadConfig()){return c.coachUsers.includes(user)||roles.some(r=>c.coachRoles.includes(r));}
export async function submit(interaction:ChatInputCommandInteraction,kind:JobKind,prompt:string,image?:ImageAttachment,runtime:StudyRuntime=defaultRuntime) {
  const config=runtime.config();
  // Also guard the shared submit helper so a future entry point cannot bypass admission.
  if(!await authorizeAIInteraction(interaction,config))return;
  if(!interaction.inGuild()||(config.guildId&&interaction.guildId!==config.guildId)||!interaction.channel?.isSendable()){
    await interaction.reply({content:'Use this in a server text channel.',flags:MessageFlags.Ephemeral});return;
  }
  await interaction.deferReply({flags:MessageFlags.Ephemeral});
  const roles=interaction.member?.roles;
  const roleIds=Array.isArray(roles)?roles:roles?[...roles.cache.keys()]:[];
  let images:ImageAttachment[]=[];try{images=image?imageAttachments([image]):[];}catch(e){throw new ServiceError(e instanceof Error?e.message:'invalid image attachment.');}
  const v2=kind==='ask'&&await runtime.v2Enabled?.()===true;
  const trigger=v2?parseTrigger(prompt,null):{prompt,sevenAgentTrigger:false};
  const captured=v2?await captureDiscordState(interaction.guild,{id:interaction.id,guildId:interaction.guildId,channelId:interaction.channelId,
    userId:interaction.user.id,prompt:trigger.prompt,hasAttachments:images.length>0},config.messageFeatures):{host:{},context:undefined};
  const job=await runtime.service<Job>('/jobs',{id:interaction.id,guild:interaction.guildId,channel:interaction.channelId,user:interaction.user.id,
    discordContext:{...discordIdentity(interaction.user,interaction.guildId,interaction.member,{...captured.host,sevenAgentTrigger:trigger.sevenAgentTrigger}),channelId:interaction.channelId},
    coach:coach(interaction.user.id,roleIds,config),kind,prompt:trigger.prompt,...(captured.context?{context:captured.context}:{}),...(images.length?{images}:{})});
  if(job.message){await interaction.editReply(`Already accepted: https://discord.com/channels/${job.guild}/${job.channel}/${job.message}`);return;}
  // A normal bot message survives the 15-minute interaction token lifetime.
  const message=await interaction.channel.send(queuedPayload(job.id));
  const primary=await bindPrimary(runtime.service,job.id,message);
  const url=primary===message.id?message.url:`https://discord.com/channels/${job.guild}/${job.channel}/${primary}`;
  await interaction.editReply(`okay, queued: ${url}`);
}
export async function handleStudyMessage(message:Message,runtime:StudyRuntime=defaultRuntime) {
  const config=runtime.config();
  if(!config.messageFeatures||message.author.bot||!message.guildId||
    (config.guildId&&message.guildId!==config.guildId)||!isAITester(message.author.id,config))return;
  if(runtime.isQotdDiscussion?.(message.guildId,message.channelId))return;
  const initial=parseTrigger(message.content,message.client.user?.id);
  if(!initial.prompt)return;
  let parent:Job|null=null;
  if(message.reference?.messageId){
    const candidate=await runtime.service<Job|null>(`/parent?guild=${message.guildId}&channel=${message.channelId}&message=${message.reference.messageId}`);
    if(candidate?.user===message.author.id&&candidate.state==='completed')parent=candidate;
  }
  if(!initial.mention&&!parent&&!initial.sevenAgentTrigger)return;
  const v2=await runtime.v2Enabled?.()===true;
  const {mention,prompt,sevenAgentTrigger}=v2?initial:parseTrigger(message.content,message.client.user?.id,false);
  if(!mention&&!parent&&!sevenAgentTrigger)return;
  const captured=v2?await captureDiscordState(message.guild,{id:message.id,guildId:message.guildId,channelId:message.channelId,
    userId:message.author.id,prompt,reference:message.reference,hasAttachments:message.attachments.size>0},true):{host:{isModerator:false},context:undefined};
  if(!mention&&!parent&&captured.host.isModerator!==true)return;
  let images:ImageAttachment[]=[];
  try{images=imageAttachments([...message.attachments.values()].map(a=>({url:a.url,mime:a.contentType,size:a.size})));}catch(e){throw new ServiceError(e instanceof Error?e.message:'invalid image attachment.');}
  const job=await runtime.service<Job>('/jobs',{id:message.id,sourceMessageId:message.id,guild:message.guildId,channel:message.channelId,user:message.author.id,
    discordContext:{...discordIdentity(message.author,message.guildId,message.member,{...captured.host,sevenAgentTrigger}),channelId:message.channelId},
    coach:coach(message.author.id,[...(message.member?.roles.cache.keys()??[])],config),kind:'ask',prompt,...(parent?{parent:parent.id}:{}),
    ...(captured.context?{context:captured.context}:{}),...(images.length?{images}:{})});
  if(job.message)return;
  const response=await message.reply(queuedPayload(job.id));
  await bindPrimary(runtime.service,job.id,response);
}
