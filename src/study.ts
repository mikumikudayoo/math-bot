import { AttachmentBuilder, MessageFlags, type ChatInputCommandInteraction, type Client, type Message } from 'discord.js';
import { service } from './ai-client.js';
import { loadConfig } from './config.js';
import type { Job, JobKind } from './service/types.js';
import { authorizeAIInteraction, isAITester } from './ai-access.js';

export interface StudyRuntime { config: typeof loadConfig; service: typeof service }
const defaultRuntime: StudyRuntime = { config: loadConfig, service };
export function coach(user:string,roles:string[],c=loadConfig()){return c.coachUsers.includes(user)||roles.some(r=>c.coachRoles.includes(r));}
export async function submit(interaction:ChatInputCommandInteraction,kind:JobKind,prompt:string,image?:string,runtime:StudyRuntime=defaultRuntime) {
  const config=runtime.config();
  // Also guard the shared submit helper so a future entry point cannot bypass admission.
  if(!await authorizeAIInteraction(interaction,config))return;
  if(!interaction.inGuild()||!interaction.channel?.isSendable()){
    await interaction.reply({content:'Use this in a server text channel.',flags:MessageFlags.Ephemeral});return;
  }
  await interaction.deferReply({flags:MessageFlags.Ephemeral});
  const roles=interaction.member?.roles;
  const roleIds=Array.isArray(roles)?roles:roles?[...roles.cache.keys()]:[];
  const job=await runtime.service<Job>('/jobs',{id:interaction.id,guild:interaction.guildId,channel:interaction.channelId,user:interaction.user.id,coach:coach(interaction.user.id,roleIds,config),kind,prompt,...(image?{image}:{})});
  if(job.message){await interaction.editReply(`Already accepted: https://discord.com/channels/${job.guild}/${job.channel}/${job.message}`);return;}
  // A normal bot message survives the 15-minute interaction token lifetime.
  const message=await interaction.channel.send({content:`⏳ queued · request ${job.id}`,allowedMentions:{parse:[]}});
  await runtime.service('/bind',{id:job.id,message:message.id});
  await interaction.editReply(`Accepted! ${message.url}\nUse /cancel with request ID ${job.id} if needed.`);
}
export async function handleStudyMessage(message:Message,runtime:StudyRuntime=defaultRuntime) {
  const config=runtime.config();
  if(!config.messageFeatures||message.author.bot||!message.guildId||
    (config.guildId&&message.guildId!==config.guildId)||!isAITester(message.author.id,config))return;
  const botId=message.client.user?.id;
  const mention=botId?message.content.match(new RegExp(`^\\s*<@!?${botId}>\\s*([\\s\\S]*)$`)):null;
  const prompt=(mention?mention[1]??'':message.content).trim();
  if(!prompt)return;
  let parent:Job|null=null;
  if(message.reference?.messageId){
    const candidate=await runtime.service<Job|null>(`/parent?guild=${message.guildId}&channel=${message.channelId}&message=${message.reference.messageId}`);
    if(candidate?.user===message.author.id)parent=candidate;
  }
  if(!mention&&!parent)return;
  const image=message.attachments.first();
  const job=await runtime.service<Job>('/jobs',{id:message.id,guild:message.guildId,channel:message.channelId,user:message.author.id,
    coach:coach(message.author.id,[...(message.member?.roles.cache.keys()??[])],config),kind:'ask',prompt,...(parent?{parent:parent.id}:{}),...(image?{image:image.url}:{})});
  if(job.message)return;
  const response=await message.reply({content:`⏳ queued · request ${job.id}`,allowedMentions:{parse:[],repliedUser:false}});
  await runtime.service('/bind',{id:job.id,message:response.id});
}
export function startDelivery(client:Client) {
  let busy=false;const previous=new Map<string,string>();
  const timer=setInterval(()=>void tick(),4000);
  async function tick(){
    if(busy)return;busy=true;
    try{
      const jobs=await service<Job[]>('/pending');
      for(const job of jobs){
        const terminal=['completed','failed','cancelled'].includes(job.state);
        const content=terminal?job.answer:`${job.state==='queued'?'⏳':'🧠'} ${job.status} · request ${job.id}`;
        if(previous.get(job.id)===content&&!terminal)continue;
        try{
          const channel=await client.channels.fetch(job.channel);
          if(!channel?.isTextBased()||!channel.isSendable())continue;
          const message=await channel.messages.fetch(job.message);
          const files=[];
          if(terminal&&job.answer.length>1900)files.push(new AttachmentBuilder(Buffer.from(job.answer),{name:'answer.txt'}));
          if(terminal&&job.artifact)files.push(new AttachmentBuilder(Buffer.from(job.artifact,'base64'),{name:'plot.png'}));
          await message.edit({content:content.slice(0,1900)+(terminal&&job.answer.length>1900?'\n\nFull answer attached.':''),files,allowedMentions:{parse:[]}});
          if(terminal){await service('/delivered',{id:job.id});previous.delete(job.id);}else previous.set(job.id,content);
        }catch(error){
          const code=(error as {code?:number}).code;
          if(code===10008||code===10003){await service('/delivered',{id:job.id});previous.delete(job.id);}
          else console.error('Could not deliver study response; will retry.');
        }
      }
    }catch{/* Service may be starting; commands report availability to users. */}finally{busy=false;}
  }
  return ()=>clearInterval(timer);
}
