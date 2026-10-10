export const CREATOR_ID='821682594830614578';
export interface DiscordContext {userId:string;guildId:string;isCreator:boolean;creatorName:'emu';username:string|null;displayName:string|null;nickname:string|null;globalName:string|null;channelId:string|null}
const label=(value:unknown)=>typeof value==='string'?value.slice(0,100):null;
/** IDs come from the authenticated bot submission; labels remain user-controlled data. */
export function currentUser(userId:string,guildId:string,metadata:unknown={}):DiscordContext {
  const data=metadata&&typeof metadata==='object'?metadata as Record<string,unknown>:{};
  return {userId,guildId,isCreator:userId===CREATOR_ID,creatorName:'emu',username:label(data.username),displayName:label(data.displayName),nickname:label(data.nickname),globalName:label(data.globalName),channelId:label(data.channelId)};
}
export function discordIdentity(user:{id:string;username?:string;globalName?:string|null},guildId:string,member:unknown) {
  const m=member&&typeof member==='object'?member as {displayName?:string;nickname?:string|null;nick?:string|null}:{};
  return currentUser(user.id,guildId,{username:user.username,globalName:user.globalName,displayName:m.displayName??m.nickname??m.nick??user.globalName??user.username,nickname:m.nickname??m.nick});
}
export type DiscordTool='discord_search'|'discord_member';
export interface DiscordTask {id:string;job:string;user:string;guild:string;channel:string;sourceMessageId?:string;tool:DiscordTool;args:Record<string,unknown>}
export function discordIntent(prompt:string):DiscordTool|null {
  if(/\b(?:what did .{1,80}? (?:say|mention|write|post)|did anyone mention|find (?:the |a )?message|search (?:this |the |our )?(?:server|discord|messages)|(?:server|discord) (?:history|search))\b/i.test(prompt))return 'discord_search';
  if(/\b(?:(?:my|your|their|his|her) (?:discord )?(?:profile|nickname|roles|user id)|(?:discord|server|member) (?:profile|nickname|roles))\b/i.test(prompt))return 'discord_member';
  return null;
}
/** Exact requester identity questions use authenticated event metadata, never prompt claims. */
export function requesterIdentityAnswer(prompt:string,context:DiscordContext):string|null{
  if(!/^(?:who am i|do you know who i am|what(?:'s| is) my (?:name|username))[?.!]*$/i.test(prompt.trim()))return null;
  const name=(context.username??context.displayName??'').replace(/[^\p{L}\p{N}_. -]/gu,'').slice(0,80);
  if(context.isCreator)return `you're ${name||'fyuc'} / emu. yes, i know who got me stuck here.`;
  return name?`your Discord username is ${name}. you're not emu from my backstory, though.`:"i can see which Discord account is talking, but its name wasn't supplied. you're not emu from my backstory.";
}
