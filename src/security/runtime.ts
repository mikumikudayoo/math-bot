import { PermissionFlagsBits, type Message, type GuildMember } from 'discord.js';
import { resolve } from 'node:path';
import { SecurityStore } from './store.js';
import { executeCase } from './actions.js';
import { exempt } from './detectors.js';
import type { ModerationInput } from './types.js';
import type { parseConfig } from '../config.js';

const stores=new Map<string,SecurityStore>();
export function securityStore(path:string){const key=path===':memory:'?path:resolve(path);let store=stores.get(key);if(!store){store=new SecurityStore(key);stores.set(key,store);}return store;}
export function closeSecurityStores(){for(const store of stores.values())store.close();stores.clear();}

async function inputFor(message:Message,member:GuildMember):Promise<ModerationInput>{
  const channel=await message.guild!.channels.fetch(message.channelId,{force:true});
  if(!channel)throw new Error('Message channel unavailable.');
  const parent=channel.isThread()&&channel.parentId?await message.guild!.channels.fetch(channel.parentId,{force:true}):null;
  return {guild:message.guildId!,eventId:message.id,source:'message',content:message.content,author:{id:member.id,bot:member.user.bot,staff:member.permissions.has(PermissionFlagsBits.ManageMessages)||member.id===message.guild!.ownerId},
    channel:{id:channel.id,parent:channel.isThread()?channel.parentId:null,category:parent?.parentId??(channel.isThread()?null:channel.parentId)},roles:[...member.roles.cache.keys()],timestamp:message.editedTimestamp??message.createdTimestamp};
}
/** Returns null when the old /filter owns enforcement for this guild. */
export async function moderateSecurity(message:Message,config:ReturnType<typeof parseConfig>):Promise<boolean|null>{
  if(!config.moderationEngine)return null;
  if(!message.guild||message.author.bot)return false;
  const store=securityStore(config.moderationDatabase), settings=store.config(message.guild.id).config;
  if(settings.mode==='disabled')return null;
  const member=await message.guild.members.fetch({user:message.author.id,force:true});
  const input=await inputFor(message,member),result=store.process(input,message.client.user!.id);
  if(!result)return settings.mode==='shadow'?null:false;
  if(!result.fresh)return settings.mode==='shadow'?null:result.record.decision.delete;
  const deleted=await executeCase(store,result.record,{
    authorize:async(record)=>{
      const freshMessage=await message.fetch();
      if(freshMessage.content!==input.content||freshMessage.guildId!==record.guild||freshMessage.author.id!==record.user)return false;
      await message.guild!.fetch();await message.guild!.roles.fetch();
      const target=await message.guild!.members.fetch({user:record.user,force:true});
      const live=await inputFor(message,target),current=store.config(record.guild).config;
      if(target.id===message.guild!.ownerId||target.id===message.client.user!.id||target.user.bot||(current.exemptStaff&&live.author.staff)||exempt(live,current.exemptions))return false;
      if(!store.config(record.guild).detect(live).length)return false;
      const bot=await message.guild!.members.fetchMe({force:true});
      const channel=await message.guild!.channels.fetch(message.channelId,{force:true});
      return Boolean(channel?.permissionsFor(bot)?.has(PermissionFlagsBits.ViewChannel));
    },
    deleteMessage:async()=>{
      const bot=await message.guild!.members.fetchMe({force:true}),channel=await message.guild!.channels.fetch(message.channelId,{force:true});
      if(!channel?.permissionsFor(bot)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ManageMessages]))throw {status:403};
      await message.delete();
    },
    timeout:async(record)=>{
      const bot=await message.guild!.members.fetchMe({force:true}),target=await message.guild!.members.fetch({user:record.user,force:true});
      if(!bot.permissions.has(PermissionFlagsBits.ModerateMembers)||target.id===message.guild!.ownerId||target.permissions.has(PermissionFlagsBits.Administrator)||bot.roles.highest.comparePositionTo(target.roles.highest)<=0||!target.moderatable)throw {status:403};
      const until=record.created+record.decision.durationMs;
      if(until<=Date.now())throw {status:409};
      await target.timeout(until-Date.now(),`Aleph case #${record.id}: ${record.reason}`.slice(0,400));
    },
    notify:async(record)=>{
      const target=await message.client.users.fetch(record.user);
      await target.send({content:`aleph moderation ${record.decision.action} · case #${record.id}\nserver: ${record.guild}\nrule: ${record.reason}\n${record.decision.action==='timeout'?'check the server moderation log for the timeout outcome.':'please check the server rules. you can ask the moderators to review this case.'}`,allowedMentions:{parse:[]}});
    },
    log:async(record)=>{
      const log=store.config(record.guild).config.logChannel??config.modLogChannel;
      if(!log)return 'skipped';
      const channel=await message.guild!.channels.fetch(log,{force:true});
      if(!channel||channel.guildId!==record.guild||!channel.isSendable())throw {status:403};
      await channel.send({content:`Aleph case #${record.id} · ${record.mode} · ${record.decision.action}\nuser: ${record.user}\nsource: ${record.source}\nrules: ${record.reason}\nmessage: ${message.id}\nInspect the case for permission, action and notification outcomes.`,allowedMentions:{parse:[]}});
    },
  });
  // Enforcement decisions stop AI replies even when Discord deletion is denied.
  return settings.mode==='shadow'?null:deleted||result.record.decision.delete;
}
