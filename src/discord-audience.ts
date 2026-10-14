import { ChannelType, PermissionFlagsBits, type GuildBasedChannel } from 'discord.js';

const readable=[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ReadMessageHistory];

/** A sufficient, deliberately conservative proof that every guild member may read.
 * A requester's individual access never proves a destination audience is safe.
 * Callers must supply a freshly fetched source and recheck requester/bot access.
 */
function everyoneReadable(channel:GuildBasedChannel):boolean {
  const everyone=channel.guild.roles.everyone;
  if(!everyone||channel.guildId!==channel.guild.id||!channel.permissionsFor(everyone)?.has(readable))return false;
  // An @everyone allow does not override a member/role-specific deny. Rather
  // than enumerate members or guess audience inclusion, reject such channels.
  if(!('permissionOverwrites' in channel))return false;
  for(const overwrite of channel.permissionOverwrites.cache.values()){
    if(overwrite.deny.any(readable))return false;
  }
  return true;
}

/** Cross-channel republication is allowed only from positively public sources.
 * Role-restricted sources and private threads stay in their original channel.
 */
export async function publicSource(channel:GuildBasedChannel):Promise<boolean> {
  try{
    if(channel.guildId!==channel.guild.id)return false;
    if(channel.isThread()){
      if(channel.type!==ChannelType.PublicThread&&channel.type!==ChannelType.AnnouncementThread)return false;
      if(!channel.parentId)return false;
      const parent=await channel.guild.channels.fetch(channel.parentId,{force:true});
      if(!parent||parent.guildId!==channel.guildId||parent.isThread()||!everyoneReadable(parent))return false;
      return Boolean(channel.permissionsFor(channel.guild.roles.everyone)?.has(readable));
    }
    return everyoneReadable(channel);
  }catch{return false;}
}
