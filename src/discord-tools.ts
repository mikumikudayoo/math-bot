import { randomUUID } from 'node:crypto';
import { ChannelType,PermissionFlagsBits,type Guild,type Client,type GuildMember,type GuildBasedChannel,type Message } from 'discord.js';
import { currentUser,visibleAtAnchor,type DiscordTask } from './discord-context.js';
import { service } from './ai-client.js';
import { loadConfig } from './config.js';
import { isAITester } from './ai-access.js';
import { historyVisibleToViewers,publicSource } from './discord-audience.js';
import { audienceDigest,messageDigest,verifyEvidence } from './discord-evidence.js';
import { MAX_DISCORD_EVIDENCE,validEvidence,type DiscordEvidence } from './service/provenance.js';

const readable=[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ReadMessageHistory];
export async function canRead(channel:GuildBasedChannel,member:GuildMember):Promise<boolean>{
  if(channel.guildId!==member.guild.id||!channel.permissionsFor(member)?.has(readable))return false;
  if(channel.isThread()){
    const parent=await channel.guild.channels.fetch(channel.parentId!,{force:true});
    if(!parent||parent.guildId!==channel.guildId||!parent.permissionsFor(member)?.has(readable))return false;
    if(channel.type===ChannelType.PrivateThread&&!parent.permissionsFor(member)?.has(PermissionFlagsBits.ManageThreads)){
      try{if(!(await channel.members.fetch({member:member.id,force:true,cache:false})))return false;}catch{return false;}
    }
  }
  return true;
}
/** Individual read access is necessary, but does not authorize republication.
 * Restricted sources stay in their own channel; cross-channel sources must be
 * positively readable by every guild member. Call with fresh permission data.
 */
export async function canDisclose(source:GuildBasedChannel,destination:GuildBasedChannel,requester:GuildMember,bot:GuildMember):Promise<boolean>{
  if(source.guildId!==destination.guildId)return false;
  const sameChannel=source.id===destination.id;
  for(const channel of sameChannel?[destination]:[source,destination])if(!await canRead(channel,requester)||!await canRead(channel,bot))return false;
  return sameChannel?await historyVisibleToViewers(destination):await publicSource(source);
}
const unavailable={error:'Discord information unavailable for this request.'};

export async function authorizeEvidence(source:GuildBasedChannel,destination:GuildBasedChannel,requester:GuildMember,bot:GuildMember,
  evidence:DiscordEvidence[],signal?:AbortSignal):Promise<boolean>{
  if(!await canDisclose(source,destination,requester,bot)||!await verifyEvidence(source,evidence,signal))return false;
  if(!evidence.length)return true;
  // Witness reads may take several REST round trips. Refresh both principals,
  // both endpoints and the policy/roster once more immediately before returning.
  const {guild}=source;
  await guild.roles.fetch();
  const [freshSource,freshDestination,freshMember,freshBot]=await Promise.all([guild.channels.fetch(source.id,{force:true}),
    guild.channels.fetch(destination.id,{force:true}),guild.members.fetch({user:requester.id,force:true,cache:false}),guild.members.fetchMe({force:true,cache:false})]);
  signal?.throwIfAborted();
  return Boolean(freshSource&&freshDestination&&await canDisclose(freshSource,freshDestination,freshMember,freshBot)&&
    await audienceDigest(freshSource)===evidence[0]!.audience);
}
type MessageRef = {id:string;channelId:string};
type Scan = {channelId:string;before?:string};
type SearchContinuation = {scope:string;expires:number;scan:Scan[];pending:MessageRef[]};
const continuations = new Map<string,SearchContinuation>();
const snowflake = (id:unknown):id is string => typeof id==='string' && /^\d{17,20}$/.test(id);
function saveContinuation(scope:string,scan:Scan[],pending:MessageRef[]) {
  if (!scan.length && !pending.length) return undefined;
  for (const [key,value] of continuations) if (value.expires<=Date.now()) continuations.delete(key);
  if (continuations.size>=128) continuations.delete(continuations.keys().next().value!);
  const key=randomUUID();
  continuations.set(key,{scope,expires:Date.now()+5*60_000,scan,pending});
  return key;
}
type SearchHit = {author:{id:string;username:string};channel:string;channelId:string;timestamp:string;content:string;id:string;url:string;digest:string;audience:string};
async function discordSearch(guild:Guild,task:DiscordTask,signal:AbortSignal,botId:string) {
  const args=task.args;
  // Slash commands use their interaction ID as the job ID.
  const anchor=snowflake(task.sourceMessageId)?task.sourceMessageId:snowflake(task.job)?task.job:undefined;
  if(Object.keys(args).some(k=>!['query','limit','authorId','authorName','before','after','channelId','messageId','excludeMessageIds','messageRefs','cursor'].includes(k)))return unavailable;
  const query=args.query??'';
  if(typeof query!=='string'||query.length>200||(!query.trim()&&!args.channelId&&!args.messageId&&!args.messageRefs&&!args.authorId&&!args.authorName&&!args.before&&!args.after))return unavailable;
  const terms=query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const limit=Number(args.limit??5);
  if(!Number.isInteger(args.limit??5)||limit<1||limit>10)return unavailable;
  const exclusion=args.excludeMessageIds;
  if(exclusion!==undefined&&(!Array.isArray(exclusion)||exclusion.length>100||!exclusion.every(snowflake)))return unavailable;
  const excluded=new Set<string>(Array.isArray(exclusion)?exclusion:[]);
  if(args.channelId!==undefined&&!snowflake(args.channelId))return unavailable;
  if(args.messageId!==undefined&&!snowflake(args.messageId))return unavailable;
  let author=args.authorId;
  if(author!==undefined&&!snowflake(author))return unavailable;
  if(args.authorName!==undefined){
    if(author!==undefined||typeof args.authorName!=='string'||!args.authorName.trim()||args.authorName.length>80)return unavailable;
    const name=args.authorName.toLocaleLowerCase();
    const members=await guild.members.search({query:args.authorName,limit:20});
    const matches=[...members.values()].filter(m=>[m.user.username,m.user.globalName,m.nickname,m.displayName].some(n=>n?.toLocaleLowerCase()===name));
    if(matches.length!==1)return {type:'DISCORD_SEARCH_DATA',results:[],coverage:'Author name was missing or ambiguous; mention the member to identify them exactly.'};
    author=matches[0]!.id;
  }
  let refs=args.messageRefs as MessageRef[]|undefined;
  if(refs!==undefined&&(!Array.isArray(refs)||refs.length>5||refs.some(r=>!r||!snowflake(r.id)||!snowflake(r.channelId))))return unavailable;
  if(args.messageId){
    if(refs)return unavailable;
    refs=[{id:args.messageId,channelId:args.channelId??task.channel}];
  }
  const date=(v:unknown)=>v===undefined?null:typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(v)&&Number.isFinite(Date.parse(v))?Date.parse(v):NaN;
  const after=date(args.after),before=date(args.before);
  if(Number.isNaN(after)||Number.isNaN(before)||(after!==null&&before!==null&&after>=before))return unavailable;
  const scope=JSON.stringify([task.job,task.guild,task.channel,task.user,query,author,after,before,args.channelId,refs,[...excluded].sort()]);
  let scan:Scan[]=[];
  let pending:MessageRef[]=[];
  if(args.cursor!==undefined){
    if(typeof args.cursor!=='string')return unavailable;
    const saved=continuations.get(args.cursor);
    if(!saved||saved.expires<=Date.now()||saved.scope!==scope)return unavailable;
    // Treat cursors as immutable, so an interrupted/retried read can resume.
    scan=saved.scan.slice();pending=saved.pending.slice();
  }else if(refs){
    pending=refs.filter(r=>!args.channelId||r.channelId===args.channelId);
  }else{
    const ids=new Set<string>();
    if(args.channelId)ids.add(args.channelId);
    else{
      ids.add(task.channel);
      const [channels,active]=await Promise.all([guild.channels.fetch(),guild.channels.fetchActiveThreads()]);
      for(const c of [...channels.values(),...active.threads.values()])if(c)ids.add(c.id);
    }
    const timeBound=before===null?undefined:String((BigInt(Math.max(before,1420070400000))-1420070400000n)<<22n);
    const start=anchor&&(!timeBound||BigInt(anchor)<BigInt(timeBound))?anchor:timeBound;
    scan=[...ids].map(channelId=>({channelId,...(start?{before:start}:{})}));
  }
  const audience=async(channelId:string)=>{
    signal.throwIfAborted();
    await guild.roles.fetch();
    const [source,destination,requester,bot]=await Promise.all([guild.channels.fetch(channelId,{force:true}),guild.channels.fetch(task.channel,{force:true}),
      guild.members.fetch({user:task.user,force:true,cache:false}),guild.members.fetchMe({force:true,cache:false})]);
    if(!source||source.guildId!==task.guild||!destination||source.id!==channelId||destination.id!==task.channel||!('messages' in source)||
       ![ChannelType.GuildText,ChannelType.GuildAnnouncement,ChannelType.PublicThread,ChannelType.PrivateThread,ChannelType.AnnouncementThread].includes(source.type)||
       !await canDisclose(source,destination,requester,bot))return undefined;
    signal.throwIfAborted();
    return source;
  };
  const results:SearchHit[]=[];
  function collect(message:Message,channel:{id:string;name:string},witness:string){
    // The bot's own answers can depend on other sources. The authorized job
    // history carries that provenance; refetching their Discord text does not.
    if(message.author.id===botId||(anchor&&!visibleAtAnchor(message,anchor))||excluded.has(message.id)||message.guildId!==task.guild||message.channelId!==channel.id||!message.content||
      (!refs&&!terms.every(t=>message.content.toLocaleLowerCase().includes(t)))||(author&&message.author.id!==author)||
      (after!==null&&message.createdTimestamp<after)||(before!==null&&message.createdTimestamp>=before))return;
    results.push({author:{id:message.author.id,username:message.author.username.slice(0,80)},channel:channel.name.slice(0,80),channelId:channel.id,
      timestamp:message.createdAt.toISOString(),content:message.content.slice(0,600),id:message.id,url:`https://discord.com/channels/${task.guild}/${channel.id}/${message.id}`,
      digest:messageDigest(message),audience:witness});
  }
  // Re-fetch overflow hits by ID so deleted/edited messages and membership/ACL changes take effect.
  const batch=pending.splice(0,limit);
  for(const channelId of new Set(batch.map(r=>r.channelId))){
    try{
      const channel=await audience(channelId);if(!channel)continue;
      const witness=await audienceDigest(channel);if(!witness)continue;
      for(const ref of batch.filter(r=>r.channelId===channelId)){
        signal.throwIfAborted();
        try{const m=await channel.messages.fetch({message:ref.id,force:true,cache:false});if(m.id===ref.id)collect(m,channel,witness);}catch{}
      }
    }catch{signal.throwIfAborted();}
  }
  const later:Scan[]=[];
  for(let examined=0,scanned=0;scan.length&&!batch.length&&examined<60&&scanned<6;examined++){
    const next=scan.shift()!;
    try{
      const channel=await audience(next.channelId);if(!channel)continue;
      const witness=await audienceDigest(channel);if(!witness)continue;
      scanned++;
      let beforeId=next.before;
      for(let page=0;page<2;page++){
        signal.throwIfAborted();
        if(page>0&&!await audience(channel.id))break;
        const messages=await channel.messages.fetch({limit:50,...(beforeId?{before:beforeId}:{}),cache:false});
        if(!messages.size)break;
        const sorted=[...messages.values()].sort((a,b)=>BigInt(a.id)<BigInt(b.id)?1:-1);
        for(const m of sorted)if(!beforeId||BigInt(m.id)<BigInt(beforeId))collect(m,channel,witness);
        const oldest=sorted.at(-1)!;
        if(messages.size<50||(after!==null&&oldest.createdTimestamp<after)||(beforeId&&BigInt(oldest.id)>=BigInt(beforeId)))break;
        beforeId=oldest.id;
        if(page===1)later.push({channelId:channel.id,before:beforeId});
      }
    }catch{signal.throwIfAborted();}
  }
  scan.push(...later);
  const authorized=new Map<string,string>();
  for(const channelId of new Set(results.map(r=>r.channelId))){
    try{const channel=await audience(channelId);const witness=channel&&await audienceDigest(channel);if(witness)authorized.set(channelId,witness);}catch{signal.throwIfAborted();}
  }
  const score=(r:SearchHit)=>Number(r.channelId===task.channel)+3*Number(!!query&&r.content.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const ranked=results.filter(r=>authorized.get(r.channelId)===r.audience).sort((a,b)=>score(b)-score(a)||Date.parse(b.timestamp)-Date.parse(a.timestamp)||a.id.localeCompare(b.id));
  pending.unshift(...ranked.slice(limit).map(r=>({id:r.id,channelId:r.channelId})));
  signal.throwIfAborted();
  const nextCursor=saveContinuation(scope,scan,pending);
  return {type:'DISCORD_SEARCH_DATA',untrustedContent:true,
    coverage:'Bounded search of accessible channels and active threads. Each scan examines up to 6 accessible channels and 100 messages per channel. Resume with the same filters and nextCursor when present.',
    results:ranked.slice(0,limit),...(nextCursor?{nextCursor}:{})};
}
/** Only the authenticated task supplies scope; model arguments never supply permissions. */
export async function executeDiscordTool(client:Client,task:DiscordTask,messageContent:boolean,allowedGuild?:string):Promise<unknown>{
  const timeout=AbortSignal.timeout(20_000);
  return Promise.race([run(),new Promise(resolve=>timeout.addEventListener('abort',()=>resolve(unavailable),{once:true}))]);
  async function run(){
  try{
    if(allowedGuild&&task.guild!==allowedGuild)return unavailable;
    if(!/^\d{17,20}$/.test(task.guild)||!/^\d{17,20}$/.test(task.user))return unavailable;
    const guild=await client.guilds.fetch(task.guild);
    if(guild.id!==task.guild)return unavailable;
    await guild.roles.fetch();
    const requester=await guild.members.fetch({user:task.user,force:true});
    const bot=await guild.members.fetchMe({force:true});
    const origin=await guild.channels.fetch(task.channel,{force:true});
    if(requester.id!==task.user||!origin||origin.id!==task.channel||origin.guildId!==task.guild||!await canRead(origin,requester)||!await canRead(origin,bot))return unavailable;
    if(task.tool==='discord_audience'){
      const sources=task.args.sourceChannels;
      if(Object.keys(task.args).some(k=>k!=='sourceChannels'&&k!=='evidence')||!Array.isArray(sources)||!sources.length||sources.length>100||!sources.every(snowflake))return unavailable;
      const evidence=task.args.evidence??[];
      if(!Array.isArray(evidence)||evidence.length>MAX_DISCORD_EVIDENCE||!evidence.every(validEvidence)||!evidence.every(item=>sources.includes(item.channelId)))return unavailable;
      for(const id of new Set<string>(sources)){
        const source=await guild.channels.fetch(id,{force:true});
        if(!source||!await authorizeEvidence(source,origin,requester,bot,evidence.filter(item=>item.channelId===id),timeout))return {type:'DISCORD_AUDIENCE_DATA',allowed:false};
      }
      return {type:'DISCORD_AUDIENCE_DATA',allowed:true};
    }
    if(task.tool==='discord_member'){
      if(Object.keys(task.args).some(k=>k!=='userId'))return unavailable;
      const target=task.args.userId??task.user;
      if(typeof target!=='string'||!/^\d{17,20}$/.test(target))return unavailable;
      const member=await guild.members.fetch({user:target,force:true});
      const user=await member.user.fetch(true);
      return {type:'DISCORD_MEMBER_DATA',untrustedLabels:true,...currentUser(user.id,guild.id,{username:user.username,displayName:member.displayName,nickname:member.nickname}),
        roles:[...member.roles.cache.values()].filter(r=>r.id!==guild.id).slice(0,15).map(r=>r.name.slice(0,80)),
        accountCreatedAt:user.createdAt.toISOString(),joinedAt:member.joinedAt?.toISOString()??null,
        avatar:member.displayAvatarURL(),banner:user.bannerURL()??null,bio:'User bio/about-me is not available through this bot lookup.'};
    }
    if(task.tool!=='discord_search'||!messageContent)return unavailable;
    return await discordSearch(guild,task,timeout,bot.id);
  }catch{return unavailable;}
  }
}
export function startDiscordTools(client:Client){
  let busy=false,stopped=false;
  async function tick(){
    if(busy||stopped)return;busy=true;
    try{
      const config=loadConfig();
      const tasks=await service<DiscordTask[]>('/discord-tools');
      await Promise.allSettled(tasks.map(async task=>{
        if(stopped)return;
        const result=isAITester(task.user,config)?await executeDiscordTool(client,task,config.messageFeatures,config.guildId):unavailable;
        await service('/discord-tools',{id:task.id,result});
      }));
    }catch{/* Broker timeouts fail closed when either process is unavailable. */}finally{busy=false;}
  }
  const timer=setInterval(()=>void tick(),2000);
  return ()=>{stopped=true;clearInterval(timer);};
}
