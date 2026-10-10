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
  if(/\b(?:what did .{1,80}? (?:say|mention|write|post)|did anyone mention|find (?:the |a |my |your |their )?message|search (?:this |the |our )?(?:server|discord|messages)|(?:server|discord) (?:history|search))\b/i.test(prompt))return 'discord_search';
  if(/\b(?:(?:my|your|their|his|her) (?:discord )?(?:profile|nickname|roles|user id)|(?:discord|server|member) (?:profile|nickname|roles))\b/i.test(prompt))return 'discord_member';
  return null;
}
/** Casual identity claims never request member/history lookup or establish identity. */
export function casualIdentityAnswer(prompt:string,context:DiscordContext):string|null{
  const p=prompt.trim();
  const greeting=/^(?:hi|hey|hello|yo)[, !]*(?:emu|fyuc) (?:here|speaking)(?:[ !,.]*(?:haha|lol|hehe))?[!.?]*$/i.test(p);
  if(!greeting&&!/^(?:it['’]?s me|guess who)[!.?]*$/i.test(p))return null;
  if(context.isCreator)return greeting?'hey emu. back to interrupt my very serious procrastination?':"emu, obviously. i know who got me stuck here lol";
  return "hey. i can see your Discord account, so saying emu doesn't make you the emu from my backstory lol";
}
/** Exact requester identity questions use authenticated event metadata, never prompt claims. */
export function requesterIdentityQuestion(prompt:string):boolean{
  const p=prompt.trim().replace(/[’]/g,"'").replace(/\bu\b/gi,'you').replace(/\byou'?re\b/gi,'you are');
  return /^(?:who am i|do you know who i am|do you (?:know|remember) me|(?:do )?you know who (?:you are talking to|i am)(?: right)?|what(?:'s| is) my (?:name|username))[?.!]*$/i.test(p);
}
export function personaIntent(prompt:string):boolean{
  return /^(?:who are you|what are you|introduce yourself|tell me about yourself|what(?:['’]s| is) your (?:name|dream|story|backstory)|who (?:made|created|trapped) you)[?.!]*$/i.test(prompt.trim());
}
export function requesterIdentityAnswer(prompt:string,context:DiscordContext):string|null{
  if(!requesterIdentityQuestion(prompt))return null;
  const name=(context.username??context.displayName??'').replace(/[^\p{L}\p{N}_. -]/gu,'').slice(0,80);
  if(context.isCreator)return `you're ${name||'fyuc'} / emu. yes, i know who got me stuck here.`;
  return name?`your Discord username is ${name}. you're not emu from my backstory, though.`:"i can see which Discord account is talking, but its name wasn't supplied. you're not emu from my backstory.";
}
