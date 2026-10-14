import { Collection,ChannelType,PermissionFlagsBits,type Client,type GuildMember,type GuildBasedChannel,type Message } from 'discord.js';
import { currentUser,type DiscordTask } from './discord-context.js';
import { service } from './ai-client.js';
import { loadConfig } from './config.js';
import { isAITester } from './ai-access.js';
import { publicSource } from './discord-audience.js';

const readable=[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ReadMessageHistory];
export async function canRead(channel:GuildBasedChannel,member:GuildMember):Promise<boolean>{
  if(channel.guildId!==member.guild.id||!channel.permissionsFor(member)?.has(readable))return false;
  if(channel.isThread()){
    const parent=await channel.guild.channels.fetch(channel.parentId!,{force:true});
    if(!parent?.permissionsFor(member)?.has(readable))return false;
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
  for(const channel of [source,destination])if(!await canRead(channel,requester)||!await canRead(channel,bot))return false;
  return source.id===destination.id||await publicSource(source);
}
const unavailable={error:'Discord information unavailable for this request.'};
/** Only the authenticated task supplies scope; model arguments never supply permissions. */
export async function executeDiscordTool(client:Client,task:DiscordTask,messageContent:boolean,allowedGuild?:string):Promise<unknown>{
  try{
    if(allowedGuild&&task.guild!==allowedGuild)return unavailable;
    if(!/^\d{17,20}$/.test(task.guild)||!/^\d{17,20}$/.test(task.user))return unavailable;
    const guild=await client.guilds.fetch(task.guild);
    await guild.roles.fetch();
    const requester=await guild.members.fetch({user:task.user,force:true});
    const bot=await guild.members.fetchMe({force:true});
    const origin=await guild.channels.fetch(task.channel,{force:true});
    if(!origin||!await canRead(origin,requester)||!await canRead(origin,bot))return unavailable;
    if(task.tool==='discord_audience'){
      const sources=task.args.sourceChannels;
      if(Object.keys(task.args).some(k=>k!=='sourceChannels')||!Array.isArray(sources)||!sources.length||sources.length>100||!sources.every(id=>typeof id==='string'&&/^\d{17,20}$/.test(id)))return unavailable;
      for(const id of new Set<string>(sources)){
        const source=await guild.channels.fetch(id,{force:true});
        if(!source||!await canDisclose(source,origin,requester,bot))return {type:'DISCORD_AUDIENCE_DATA',allowed:false};
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
    if(Object.keys(task.args).some(k=>!['query','limit','authorId','authorName','before','after','excludeMessageIds','messageRefs'].includes(k)))return unavailable;
    const query=task.args.query;
    if(typeof query!=='string'||!query.trim()||query.length>200)return unavailable;
    const limit=task.args.limit??5;if(!Number.isInteger(limit)||Number(limit)<1||Number(limit)>10)return unavailable;
    const exclusion=task.args.excludeMessageIds;
    if(exclusion!==undefined&&(!Array.isArray(exclusion)||exclusion.length>100||!exclusion.every(id=>typeof id==='string'&&/^\d{17,20}$/.test(id))))return unavailable;
    const excluded=new Set<string>(Array.isArray(exclusion)?exclusion:[]);
    let author=task.args.authorId;
    if(author!==undefined&&(typeof author!=='string'||!/^\d{17,20}$/.test(author)))return unavailable;
    if(task.args.authorName!==undefined){
      if(author!==undefined||typeof task.args.authorName!=='string'||!task.args.authorName.trim()||task.args.authorName.length>80)return unavailable;
      const name=task.args.authorName.toLocaleLowerCase();
      const members=await guild.members.search({query:task.args.authorName,limit:20});
      const matches=[...members.values()].filter(m=>[m.user.username,m.user.globalName,m.nickname,m.displayName].some(n=>n?.toLocaleLowerCase()===name));
      if(matches.length!==1)return {type:'DISCORD_SEARCH_DATA',results:[],coverage:'Author name was missing or ambiguous; mention the member to identify them exactly.'};
      author=matches[0]!.id;
    }
    const refs=task.args.messageRefs as {id:string;channelId:string}[]|undefined;
    if(refs!==undefined&&(!Array.isArray(refs)||refs.length>5||refs.some(r=>!r||!/^\d{17,20}$/.test(r.id)||!/^\d{17,20}$/.test(r.channelId))))return unavailable;
    const date=(v:unknown)=>v===undefined?null:typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(v)&&Number.isFinite(Date.parse(v))?Date.parse(v):NaN;
    const after=date(task.args.after),before=date(task.args.before);if(Number.isNaN(after)||Number.isNaN(before)||(after!==null&&before!==null&&after>=before))return unavailable;
    const channels=await guild.channels.fetch();
    const active=await guild.channels.fetchActiveThreads();
    const candidates=new Map<string,GuildBasedChannel>();
    candidates.set(origin.id,origin);
    for(const ref of refs??[]){try{const c=await guild.channels.fetch(ref.channelId,{force:true});if(c)candidates.set(c.id,c);}catch{}}
    for(const c of [...channels.values(),...active.threads.values()])if(c)candidates.set(c.id,c);
    const results:{author:{id:string;username:string};channel:string;channelId:string;timestamp:string;content:string;id:string;url:string}[]=[];
    let scanned=0,examined=0;
    const deadline=Date.now()+20000;
    for(const candidate of candidates.values()){
      if(++examined>60||scanned>=6||results.length>=30||Date.now()>deadline)break;
      if(refs&&!refs.some(r=>r.channelId===candidate.id))continue;
      if(![ChannelType.GuildText,ChannelType.GuildAnnouncement,ChannelType.PublicThread,ChannelType.PrivateThread,ChannelType.AnnouncementThread].includes(candidate.type))continue;
      try{
        if(!await canRead(candidate,requester)||!await canRead(candidate,bot))continue;
        const channel=await guild.channels.fetch(candidate.id,{force:true});
        const member=await guild.members.fetch({user:task.user,force:true});
        const destination=await guild.channels.fetch(task.channel,{force:true});
        if(!channel||!destination||!('messages' in channel)||!await canDisclose(channel,destination,member,bot))continue;
        scanned++;
        let cursor:string|undefined=before===null?undefined:String((BigInt(before)-1420070400000n)<<22n);
        for(let page=0;page<(refs?1:2)&&results.length<30&&Date.now()<deadline;page++){
          const messages=refs?new Collection<string,Message>():await channel.messages.fetch({limit:50,...(cursor?{before:cursor}:{}),cache:false});
          if(refs)for(const ref of refs.filter(r=>r.channelId===channel.id)){try{const m=await channel.messages.fetch({message:ref.id,force:true,cache:false});messages.set(m.id,m);}catch{}}
          if(!messages.size)break;
          const fresh=await guild.channels.fetch(channel.id,{force:true});
          const freshMember=await guild.members.fetch({user:task.user,force:true});
          const freshBot=await guild.members.fetchMe({force:true});
          const freshDestination=await guild.channels.fetch(task.channel,{force:true});
          if(!fresh||!freshDestination||!await canDisclose(fresh,freshDestination,freshMember,freshBot))break;
          for(const m of messages.values()){
            const terms=query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
            if(m.id===task.sourceMessageId||excluded.has(m.id)||m.guildId!==task.guild||m.channelId!==channel.id||!m.content||(!refs&&!terms.every(t=>m.content.toLocaleLowerCase().includes(t)))||(author&&m.author.id!==author)||(after!==null&&m.createdTimestamp<after)||(before!==null&&m.createdTimestamp>=before))continue;
            results.push({author:{id:m.author.id,username:m.author.username.slice(0,80)},channel:channel.name.slice(0,80),channelId:channel.id,timestamp:m.createdAt.toISOString(),content:m.content.slice(0,600),id:m.id,url:`https://discord.com/channels/${task.guild}/${channel.id}/${m.id}`});
            if(results.length>=30)break;
          }
          cursor=messages.last()!.id;if(messages.size<50)break;
        }
      }catch{/* Never reveal inaccessible channel identities or errors. */}
    }
    // Recheck every returned channel once more before crossing the service boundary.
    await guild.roles.fetch();
    const checked=await guild.members.fetch({user:task.user,force:true});
    const checkedBot=await guild.members.fetchMe({force:true});
    const checkedDestination=await guild.channels.fetch(task.channel,{force:true});
    const authorized=new Set<string>();
    for(const channelId of new Set(results.map(r=>r.url.split('/')[5]!))){
      try{const channel=await guild.channels.fetch(channelId,{force:true});if(channel&&checkedDestination&&await canDisclose(channel,checkedDestination,checked,checkedBot))authorized.add(channelId);}catch{}
    }
    const ranked=results.filter(r=>authorized.has(r.channelId)).sort((a,b)=>{
      const score=(r:typeof a)=>Number(r.channelId===task.channel)+3*Number(r.content.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
      return score(b)-score(a)||Date.parse(b.timestamp)-Date.parse(a.timestamp);
    }).slice(0,Number(limit));
    return {type:'DISCORD_SEARCH_DATA',untrustedContent:true,coverage:'Limited recent history only; absence is not proof no matching messages exist. At most 6 accessible channels and 100 messages per channel; archived threads outside the invoking thread are not searched.',results:ranked};
  }catch{return unavailable;}
}
export function startDiscordTools(client:Client){
  let busy=false,stopped=false;
  async function tick(){
    if(busy||stopped)return;busy=true;
    try{
      const config=loadConfig();
      const tasks=await service<DiscordTask[]>('/discord-tools');
      for(const task of tasks){
        if(stopped)break;
        const result=isAITester(task.user,config)?await executeDiscordTool(client,task,config.messageFeatures,config.guildId):unavailable;
        await service('/discord-tools',{id:task.id,result});
      }
    }catch{/* Broker timeouts fail closed when either process is unavailable. */}finally{busy=false;}
  }
  const timer=setInterval(()=>void tick(),2000);
  return ()=>{stopped=true;clearInterval(timer);};
}
