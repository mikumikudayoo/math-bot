import { createHash } from 'node:crypto';
import { ChannelType, PermissionFlagsBits, type GuildBasedChannel, type Message } from 'discord.js';
import { publicSource } from './discord-audience.js';
import type { DiscordEvidence } from './service/provenance.js';

const digest=(values:unknown)=>createHash('sha256').update(JSON.stringify(values)).digest('hex');
const audienceBits=PermissionFlagsBits.Administrator|PermissionFlagsBits.ViewChannel|PermissionFlagsBits.ReadMessageHistory|PermissionFlagsBits.ManageThreads;
function attachmentPath(url:string) { try { const u=new URL(url);return u.origin+u.pathname; } catch { return ''; } }

export function messageDigest(m:Message):string {
  // Discord may refresh signed CDN query parameters between requests.
  const attachments=[...(m.attachments?.values()??[])].map(a=>[a.id,a.size,a.contentType,attachmentPath(a.url)]);
  return digest([m.guildId,m.channelId,m.id,m.author.id,m.author.username,m.author.globalName,m.member?.displayName,
    m.content,m.editedTimestamp??null,attachments]);
}

/** A restricted source is tied to its captured channel policy. Private threads
 * also bind their roster. Overlarge or unavailable rosters cannot be witnessed. */
export async function audienceDigest(channel:GuildBasedChannel):Promise<string|undefined>{
  if(await publicSource(channel))return 'public';
  const source=channel.isThread()&&channel.parentId?await channel.guild.channels.fetch(channel.parentId,{force:true}):channel;
  if(!source||source.guildId!==channel.guildId||!('permissionOverwrites' in source))return undefined;
  const mask=(value:bigint)=>String(value&audienceBits);
  const roles=[...channel.guild.roles.cache.values()].map(r=>[r.id,mask(r.permissions.bitfield)]).filter(r=>r[1]!=='0').sort();
  const policy=[...source.permissionOverwrites.cache.values()].map(o=>[o.type,o.id,mask(o.allow.bitfield),mask(o.deny.bitfield)])
    .filter(o=>o[2]!=='0'||o[3]!=='0').sort();
  let members:string[]=[];
  if(channel.type===ChannelType.PrivateThread){
    const roster=await channel.members.fetch({withMember:true,limit:100,cache:false});
    if(!Number.isSafeInteger(roster.size)||roster.size>=100)return undefined;
    members=[...roster.keys()].sort();
  }
  return digest([channel.guildId,channel.id,channel.type,source.id,'nsfw' in source&&source.nsfw,roles,policy,members]);
}

/** Caller must authorize the audience before these reads, including same-channel
 * history permissions. A missing/edited message withdraws all dependent content. */
export async function verifyEvidence(channel:GuildBasedChannel,entries:DiscordEvidence[],signal?:AbortSignal) {
  if(!entries.length)return true;
  if(!('messages' in channel))return false;
  const audience=await audienceDigest(channel);
  if(!audience||entries.some(e=>e.channelId!==channel.id||e.audience!==audience))return false;
  for(let i=0;i<entries.length;i+=4){
    signal?.throwIfAborted();
    const matches=await Promise.all(entries.slice(i,i+4).map(async entry=>{
      const m=await channel.messages.fetch({message:entry.messageId,force:true,cache:false});
      return m.id===entry.messageId&&m.channelId===channel.id&&m.guildId===channel.guildId&&messageDigest(m)===entry.digest;
    }));
    if(matches.some(match=>!match))return false;
  }
  signal?.throwIfAborted();
  return true;
}
