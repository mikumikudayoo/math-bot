export const CREATOR_ID='821682594830614578';
/** U+2063 INVISIBLE SEPARATOR. A request-shape trigger only; it never authenticates anyone. */
export const SEVEN_AGENT_TRIGGER='⁣';
export const MAX_CONTEXT_ROLES=8;
export interface DiscordContext {userId:string;guildId:string;isCreator:boolean;creatorName:'emu';username:string|null;displayName:string|null;nickname:string|null;globalName:string|null;channelId:string|null;
  /** Host fact computed by the bot from live Discord permissions, never from message or profile text. */
  isModerator:boolean;
  /** Up to MAX_CONTEXT_ROLES role names, highest first. Server-controlled labels, never authorization. */
  roles:string[];
  /** Host-detected leading U+2063 on the original message. A trigger only: the service must also require isModerator. */
  sevenAgentTrigger:boolean}
const label=(value:unknown)=>typeof value==='string'?value.slice(0,100):null;
/** IDs come from the authenticated bot submission; labels remain user-controlled data. */
export function currentUser(userId:string,guildId:string,metadata:unknown={}):DiscordContext {
  const data=metadata&&typeof metadata==='object'?metadata as Record<string,unknown>:{};
  // isCreator depends on the authenticated ID alone. The moderator/trigger booleans are strict
  // `=== true` host facts carried by the bot's authenticated submission; no label can set them.
  const roles=Array.isArray(data.roles)?data.roles.filter((r):r is string=>typeof r==='string'&&r.length>0).slice(0,MAX_CONTEXT_ROLES).map(r=>r.slice(0,80)):[];
  return {userId,guildId,isCreator:userId===CREATOR_ID,creatorName:'emu',username:label(data.username),displayName:label(data.displayName),nickname:label(data.nickname),globalName:label(data.globalName),channelId:label(data.channelId),
    isModerator:data.isModerator===true,roles,sevenAgentTrigger:data.sevenAgentTrigger===true};
}
/** Facts the bot derives from Discord itself (live permissions, role list, raw-content trigger). */
export interface HostFacts {isModerator?:boolean;roles?:readonly string[];sevenAgentTrigger?:boolean}
export function discordIdentity(user:{id:string;username?:string;globalName?:string|null},guildId:string,member:unknown,host:HostFacts={}) {
  const m=member&&typeof member==='object'?member as {displayName?:string;nickname?:string|null;nick?:string|null}:{};
  return currentUser(user.id,guildId,{username:user.username,globalName:user.globalName,displayName:m.displayName??m.nickname??m.nick??user.globalName??user.username,nickname:m.nickname??m.nick,
    isModerator:host.isModerator===true,roles:host.roles?[...host.roles]:[],sevenAgentTrigger:host.sevenAgentTrigger===true});
}
/** Splits ORIGINAL, untrimmed message content into the leading-mention flag, the prompt and the
 * seven-agent trigger. The trigger is one U+2063 at index 0 of the content, or immediately after the
 * leading bot mention (whitespace allowed in between). Exactly that one character is removed; a
 * U+2063 anywhere else is ordinary prompt text. Detection is not authorization.
 */
export function parseTrigger(content:string,botId:string|null|undefined):{mention:boolean;prompt:string;sevenAgentTrigger:boolean} {
  let rest=typeof content==='string'?content:'',sevenAgentTrigger=false;
  if(rest.startsWith(SEVEN_AGENT_TRIGGER)){sevenAgentTrigger=true;rest=rest.slice(1);}
  const mention=botId&&/^\d{1,20}$/.test(botId)?rest.match(new RegExp(`^\\s*<@!?${botId}>\\s*([\\s\\S]*)$`)):null;
  let body=mention?mention[1]??'':rest;
  if(mention&&!sevenAgentTrigger&&body.startsWith(SEVEN_AGENT_TRIGGER)){sevenAgentTrigger=true;body=body.slice(1);}
  return {mention:Boolean(mention),prompt:body.trim(),sevenAgentTrigger};
}
export interface SpeakerFacts {type:'TRUSTED_SPEAKER_FACTS';speakerIsCreator:boolean;speakerIsModerator:boolean;creatorName:'emu';speakerName:'emu'|null;speakerLabel:string|null}
export function speakerFacts(context:DiscordContext):SpeakerFacts {
  const speakerLabel=context.displayName??context.nickname??context.globalName??context.username;
  return {type:'TRUSTED_SPEAKER_FACTS',speakerIsCreator:context.isCreator,speakerIsModerator:context.isModerator===true,creatorName:'emu',speakerName:context.isCreator?'emu':null,speakerLabel:context.isCreator?null:speakerLabel};
}
/** Deictic Discord scope only. Topic words such as MPoTD/QOTD do not belong here. */
export function serverScope(prompt:string):boolean {
  const q=prompt.trim();
  return /\b(?:this|our|current)\s+(?:(?:[a-z0-9_-]+\s+){0,3})?(?:discord\s+)?(?:server|guild|community|channel|thread)\b/i.test(q)
    || /\b(?:in|on)\s+here\b/i.test(q)
    || /\b(?:server|guild|discord)\s+(?:mods?|moderators?|members?|roles?|messages?|history|activity)\b/i.test(q)
    || /\b(?:mods?|moderators?|members?|roles?|messages?|history|activity)\s+(?:of|in|on)\s+(?:this|our|the current)\s+(?:(?:[a-z0-9_-]+\s+){0,3})?(?:discord\s+)?(?:server|guild|community)\b/i.test(q);
}
// discord_audience is host-only and is never advertised to the model.
export type DiscordTool='discord_search'|'discord_member'|'discord_audience';
export interface DiscordTask {id:string;job:string;user:string;guild:string;channel:string;sourceMessageId?:string;tool:DiscordTool;args:Record<string,unknown>}
export function discordIntent(prompt:string):DiscordTool|null {
  if(/\b(?:what did .{1,80}? (?:say|mention|write|post)|did anyone mention|find (?:the |a |my |your |their )?message|search (?:this |the |our )?(?:server|discord|messages)|(?:server|discord) (?:history|search))\b/i.test(prompt))return 'discord_search';
  if(/\b(?:(?:my|your|their|his|her) (?:discord )?(?:profile|nickname|roles|user id)|(?:discord|server|member) (?:profile|nickname|roles))\b/i.test(prompt))return 'discord_member';
  return null;
}
/** Exact requester identity questions use authenticated event metadata, never prompt claims. */
export function requesterIdentityQuestion(prompt:string):boolean{
  let p=prompt.trim().replace(/[’]/g,"'").replace(/\byk\b/gi,'you know').replace(/\bu\b/gi,'you').replace(/\byou'?re\b/gi,'you are');
  // This classifies what the user is asking about. Authenticated Discord metadata,
  // not prompt text, still decides who the requester actually is.
  p=p.replace(/[?.!]+$/g,'').trim();
  p=p.replace(/^(?:(?:wait|hey|yo|actually|okay|ok|so|uh|um)\b[\s,]*)+/i,'').trim();
  p=p.replace(/\s+(?:or nah|right|lol|lmao|haha|hehe)\s*$/i,'').trim();
  return /^(?:who am i|who do you think i am|guess who(?: i am)?|do you (?:actually )?know who i am|do you (?:actually )?(?:know|remember) me|you (?:actually )?remember me|(?:do )?you (?:actually )?know who (?:you are talking to|i am)(?: right)?|what(?:'s| is) my (?:name|username))$/i.test(p);
}
export function personaIntent(prompt:string):boolean{
  return /^(?:who are you|what are you|introduce yourself|tell me about yourself|what(?:['’]s| is) your (?:name|dream|story|backstory)|who (?:made|created|trapped) you)[?.!]*$/i.test(prompt.trim());
}
/** Routing classification only; all conversation is generated with trusted context. */
export function conversationIntent(prompt:string):boolean{
  return requesterIdentityQuestion(prompt)||personaIntent(prompt)||/^(?:(?:hi|hello|hey|yo)(?:[, !]*(?:emu|fyuc) (?:here|speaking)(?:[ !,.]*(?:haha|lol|hehe))?)?|thanks|thank you|ty|thx|it['’]?s me|guess who|can you imagine)[!.?]*$/i.test(prompt.trim());
}
