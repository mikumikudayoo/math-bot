import { PermissionFlagsBits, type Message } from 'discord.js';
import { service } from './ai-client.js';
import { loadConfig } from './config.js';
export function matchesTerm(content:string,term:string){
  const escaped=term.normalize('NFKC').toLowerCase().replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`,'u').test(content.normalize('NFKC').toLowerCase());
}
export async function moderate(message:Message){
  if(!message.guildId||message.author.bot||message.member?.permissions.has(PermissionFlagsBits.ManageMessages))return false;
  const settings=await service<{rules:{id:number;term:string;action:string}[]}>(`/settings?guild=${message.guildId}`);
  const rule=settings.rules.find(r=>matchesTerm(message.content,r.term));if(!rule)return false;
  let deleted=false;
  if(rule.action==='delete'){
    try{await message.delete();deleted=true;}catch{console.error('Filter could not delete a message; check Manage Messages permission.');}
  }
  await service('/audit',{guild:message.guildId,user:message.author.id,event:`filter ${rule.id}: ${deleted?'deleted':'flagged'} message ${message.id} in ${message.channelId}`});
  const log=loadConfig().modLogChannel;
  if(log){const channel=await message.client.channels.fetch(log);if(channel?.isSendable())await channel.send({content:`Filter ${rule.id}: ${deleted?'deleted':'flagged'} a message by ${message.author.id}. ${message.url}`,allowedMentions:{parse:[]}});}
  return deleted;
}
