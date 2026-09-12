import { PermissionFlagsBits, type Client, type Role } from 'discord.js';
import { service } from './ai-client.js';
import { reconcileRoles } from './reaction-role-core.js';
import { collectReactors } from './reaction-pagination.js';
import type { ReactionRole } from './service/store.js';
const locks=new Map<string,Promise<unknown>>();
export function roleSafe(role:Role){return !role.managed&&role.id!==role.guild.id&&!role.permissions.has(PermissionFlagsBits.Administrator)&&
  !role.permissions.any([PermissionFlagsBits.ManageGuild,PermissionFlagsBits.ManageRoles,PermissionFlagsBits.ManageChannels,PermissionFlagsBits.ManageWebhooks,
    PermissionFlagsBits.ManageMessages,PermissionFlagsBits.KickMembers,PermissionFlagsBits.BanMembers,PermissionFlagsBits.ModerateMembers,PermissionFlagsBits.MentionEveryone,
    PermissionFlagsBits.ManageEvents,PermissionFlagsBits.ManageGuildExpressions,PermissionFlagsBits.ManageThreads,PermissionFlagsBits.ManageNicknames,PermissionFlagsBits.ViewAuditLog,
    PermissionFlagsBits.MoveMembers,PermissionFlagsBits.MuteMembers,PermissionFlagsBits.DeafenMembers]);}
export function serializeRole<T>(message:string,work:()=>Promise<T>):Promise<T>{
  const task=(locks.get(message)??Promise.resolve()).catch(()=>{}).then(work);
  locks.set(message,task);void task.finally(()=>{if(locks.get(message)===task)locks.delete(message);}).catch(()=>{});return task;
}
export async function syncRole(client:Client,mapping:ReactionRole){
  return serializeRole(mapping.message,async()=>{
    const current=await service<ReactionRole[]>('/reaction-roles');
    if(!current.some(x=>x.message===mapping.message))throw new Error('Mapping removed.');
    const guild=await client.guilds.fetch(mapping.guild);const me=await guild.members.fetchMe();const role=await guild.roles.fetch(mapping.role);
    if(!role||!roleSafe(role)||!me.permissions.has(PermissionFlagsBits.ManageRoles)||me.roles.highest.comparePositionTo(role)<=0)throw new Error('Cannot manage this role. Place the bot role above Science Geek and grant Manage Roles; privileged roles cannot be reaction roles.');
    const channel=await guild.channels.fetch(mapping.channel);if(!channel?.isTextBased())throw new Error('Message channel is unavailable.');
    // A missing message is an error, never evidence that all members unreacted.
    const message=await channel.messages.fetch({message:mapping.message,force:true});
    return reconcileRoles({
      async reactors(){
        const reaction=message.reactions.cache.find(r=>(r.emoji.id??r.emoji.name)===mapping.emoji);
        if(!reaction)return new Set<string>();
        return collectReactors(async after=>[...(await reaction.users.fetch({limit:100,...(after?{after}:{})})).values()]);
      },
      async owned(){return new Set(await service<string[]>(`/role-grants?message=${mapping.message}`));},
      async member(user){try{const member=await guild.members.fetch({user,force:true});return {hasRole:member.roles.cache.has(mapping.role),bot:member.user.bot};}catch(error){if((error as {code?:number}).code===10007)return null;throw error;}},
      async mark(user,owned){await service('/role-grants',{message:mapping.message,user,owned});},
      async add(user){await guild.members.addRole({user,role:mapping.role,reason:'Reaction role opt-in'});},
      async remove(user){await guild.members.removeRole({user,role:mapping.role,reason:'Reaction role opt-out (bot-owned assignment)'});},
    });
  });
}
export function startReactionRoles(client:Client){
  let busy=false;
  const requested=new Set<string>();
  const sync=async(message?:string)=>{
    try{const mappings=await service<ReactionRole[]>('/reaction-roles');for(const mapping of mappings){if(message&&mapping.message!==message)continue;try{await syncRole(client,mapping);}catch(error){console.error(`Reaction role ${mapping.message}: ${error instanceof Error?error.message:'sync failed'}`);}}}
    catch{console.error('Reaction role service unavailable; reconciliation will retry.');}
  };
  const onReaction=(reaction:{message:{id:string}})=>{requested.add(reaction.message.id);};
  client.on('messageReactionAdd',onReaction);client.on('messageReactionRemove',onReaction);
  client.on('messageReactionRemoveAll',message=>requested.add(message.id));client.on('messageReactionRemoveEmoji',onReaction);
  const changes=setInterval(()=>{if(busy||!requested.size)return;busy=true;const ids=[...requested];requested.clear();void (async()=>{for(const id of ids)await sync(id);})().finally(()=>{busy=false;});},2000);
  const timer=setInterval(()=>{if(busy)return;busy=true;void sync().finally(()=>{busy=false;});},60000);
  void sync();return ()=>{clearInterval(timer);clearInterval(changes);client.off('messageReactionAdd',onReaction);client.off('messageReactionRemove',onReaction);};
}
