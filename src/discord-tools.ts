import { ChannelType,PermissionFlagsBits,type Client,type GuildMember,type GuildBasedChannel } from 'discord.js';
import { currentUser,type DiscordTask } from './discord-context.js';
import { service } from './ai-client.js';
import { loadConfig } from './config.js';
import { isAITester } from './ai-access.js';

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
    if(Object.keys(task.args).some(k=>!['query','limit','authorId','before','after'].includes(k)))return unavailable;
    const query=task.args.query;
    if(typeof query!=='string'||!query.trim()||query.length>200)return unavailable;
    const limit=task.args.limit??5;if(!Number.isInteger(limit)||Number(limit)<1||Number(limit)>10)return unavailable;
    const exclusion=task.args.excludeMessageIds;
    if(exclusion!==undefined&&(!Array.isArray(exclusion)||exclusion.length>100||!exclusion.every(id=>typeof id==='string'&&/^\d{17,20}$/.test(id))))return unavailable;
    const excluded=new Set<string>(Array.isArray(exclusion)?exclusion:[]);
    const author=task.args.authorId;
    if(author!==undefined&&(typeof author!=='string'||!/^\d{17,20}$/.test(author)))return unavailable;
    const date=(v:unknown)=>v===undefined?null:typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(v)&&Number.isFinite(Date.parse(v))?Date.parse(v):NaN;
    const after=date(task.args.after),before=date(task.args.before);if(Number.isNaN(after)||Number.isNaN(before))return unavailable;
    const channels=await guild.channels.fetch();
    const active=await guild.channels.fetchActiveThreads();
    const candidates=new Map<string,GuildBasedChannel>();
    candidates.set(origin.id,origin);
    for(const c of [...channels.values(),...active.threads.values()])if(c)candidates.set(c.id,c);
    const results:{author:{id:string;username:string};channel:string;channelId:string;timestamp:string;content:string;id:string;url:string}[]=[];
    let scanned=0,examined=0;
    const deadline=Date.now()+20000;
    for(const candidate of candidates.values()){
      if(++examined>60||scanned>=6||results.length>=Number(limit)||Date.now()>deadline)break;
      if(![ChannelType.GuildText,ChannelType.GuildAnnouncement,ChannelType.PublicThread,ChannelType.PrivateThread,ChannelType.AnnouncementThread].includes(candidate.type))continue;
      try{
        if(!await canRead(candidate,requester)||!await canRead(candidate,bot))continue;
        const channel=await guild.channels.fetch(candidate.id,{force:true});
        const member=await guild.members.fetch({user:task.user,force:true});
        if(!channel||!('messages' in channel)||!await canRead(channel,member)||!await canRead(channel,bot))continue;
        scanned++;
        let cursor:string|undefined;
        for(let page=0;page<2&&results.length<Number(limit)&&Date.now()<deadline;page++){
          const messages=await channel.messages.fetch({limit:50,...(cursor?{before:cursor}:{}),cache:false});
          if(!messages.size)break;
          const fresh=await guild.channels.fetch(channel.id,{force:true});
          const freshMember=await guild.members.fetch({user:task.user,force:true});
          if(!fresh||!await canRead(fresh,freshMember))break;
          for(const m of messages.values()){
            if(m.id===task.sourceMessageId||excluded.has(m.id)||m.guildId!==task.guild||m.channelId!==channel.id||!m.content||!m.content.toLocaleLowerCase().includes(query.toLocaleLowerCase())||(author&&m.author.id!==author)||(after!==null&&m.createdTimestamp<after)||(before!==null&&m.createdTimestamp>=before))continue;
            results.push({author:{id:m.author.id,username:m.author.username.slice(0,80)},channel:channel.name.slice(0,80),channelId:channel.id,timestamp:m.createdAt.toISOString(),content:m.content.slice(0,600),id:m.id,url:`https://discord.com/channels/${task.guild}/${channel.id}/${m.id}`});
            if(results.length>=Number(limit))break;
          }
          cursor=messages.last()!.id;if(messages.size<50)break;
        }
      }catch{/* Never reveal inaccessible channel identities or errors. */}
    }
    // Recheck every returned channel once more before crossing the service boundary.
    await guild.roles.fetch();
    const checked=await guild.members.fetch({user:task.user,force:true});
    const authorized=new Set<string>();
    for(const channelId of new Set(results.map(r=>r.url.split('/')[5]!))){
      try{const channel=await guild.channels.fetch(channelId,{force:true});if(channel&&await canRead(channel,checked))authorized.add(channelId);}catch{}
    }
    return {type:'DISCORD_SEARCH_DATA',untrustedContent:true,coverage:'Limited recent history only; absence is not proof no matching messages exist. Archived threads outside the invoking thread are not searched.',results:results.filter(r=>authorized.has(r.url.split('/')[5]!))};
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
