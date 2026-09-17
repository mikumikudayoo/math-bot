export const CREATOR_ID='821682594830614578';
export interface DiscordContext {userId:string;guildId:string;isCreator:boolean;creatorName:'emu';username:string|null;displayName:string|null;nickname:string|null}
const label=(value:unknown)=>typeof value==='string'?value.slice(0,100):null;
/** IDs come from the authenticated bot submission; labels remain user-controlled data. */
export function currentUser(userId:string,guildId:string,metadata:unknown={}):DiscordContext {
  const data=metadata&&typeof metadata==='object'?metadata as Record<string,unknown>:{};
  return {userId,guildId,isCreator:userId===CREATOR_ID,creatorName:'emu',username:label(data.username),displayName:label(data.displayName),nickname:label(data.nickname)};
}
export function discordIdentity(user:{id:string;username?:string;globalName?:string|null},guildId:string,member:unknown) {
  const m=member&&typeof member==='object'?member as {displayName?:string;nickname?:string|null;nick?:string|null}:{};
  return currentUser(user.id,guildId,{username:user.username,displayName:m.displayName??m.nickname??m.nick??user.globalName??user.username,nickname:m.nickname??m.nick});
}
export type DiscordTool='discord_search'|'discord_member';
export interface DiscordTask {id:string;job:string;user:string;guild:string;channel:string;sourceMessageId?:string;tool:DiscordTool;args:Record<string,unknown>}
export function discordIntent(prompt:string):DiscordTool|null {
  if(/\b(?:what did (?:i|we|emu|<@!?\d+>) say|did anyone mention|find the message|search (?:this |the |our )?(?:server|discord|messages)|(?:server|discord) (?:history|search))\b/i.test(prompt))return 'discord_search';
  if(/\b(?:(?:my|your|their|his|her) (?:discord )?(?:profile|nickname|roles|user id)|(?:discord|server|member) (?:profile|nickname|roles)|who am i|am i (?:emu|your creator))\b/i.test(prompt))return 'discord_member';
  return null;
}
