import { PermissionFlagsBits, type ChatInputCommandInteraction } from 'discord.js';
import type { SecurityConfig } from './types.js';

export interface SecurityActor { id:string; ownerId:string; roles:string[]; manageMessages:boolean }
export function canReadSecurity(actor:SecurityActor,config:SecurityConfig){return actor.id===actor.ownerId||actor.manageMessages||actor.roles.some(r=>config.securityRoles.includes(r));}
export function canConfigureSecurity(actor:SecurityActor,config:SecurityConfig){return actor.id===actor.ownerId||actor.roles.some(r=>config.securityRoles.includes(r));}
export function authorizeConfigChange(actor:SecurityActor,before:SecurityConfig,after:SecurityConfig){
  if(!canConfigureSecurity(actor,before))throw new Error('Only the server owner or a configured security-admin role can change security configuration.');
  if(actor.id!==actor.ownerId&&JSON.stringify([...before.securityRoles].sort())!==JSON.stringify([...after.securityRoles].sort()))throw new Error('Only the server owner can change security-admin roles.');
}
export async function securityActor(i:ChatInputCommandInteraction):Promise<SecurityActor>{
  if(!i.guild)throw new Error('Use this command in a server.');
  const guild=await i.guild.fetch();await guild.roles.fetch();
  const member=await guild.members.fetch({user:i.user.id,force:true});
  return {id:member.id,ownerId:guild.ownerId,roles:[...member.roles.cache.keys()],manageMessages:member.permissions.has(PermissionFlagsBits.ManageMessages)};
}
