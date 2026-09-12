import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { service } from '../ai-client.js';
import { roleSafe,serializeRole,syncRole } from '../reaction-roles.js';
import type { ReactionRole } from '../service/store.js';
import type { Command } from './types.js';
export const reactionRole:Command={
  data:new SlashCommandBuilder().setName('reaction-role').setDescription('Set up a persistent opt-in role, such as 🥼 Science Geek.').setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addSubcommand(o=>o.setName('set').setDescription('Connect an existing message and a non-privileged role.').addStringOption(x=>x.setName('message').setDescription('Discord message link').setRequired(true)).addRoleOption(x=>x.setName('role').setDescription('Role to grant, such as Science Geek').setRequired(true)).addStringOption(x=>x.setName('emoji').setDescription('Emoji to react with; default 🥼').setMaxLength(100)))
    .addSubcommand(o=>o.setName('sync').setDescription('Reconcile existing reactions and roles now.').addStringOption(x=>x.setName('message').setDescription('Message ID').setRequired(true)))
    .addSubcommand(o=>o.setName('remove').setDescription('Stop managing this message; keep all current roles.').addStringOption(x=>x.setName('message').setDescription('Message ID').setRequired(true)))
    .addSubcommand(o=>o.setName('list').setDescription('List configured reaction-role messages.')),
  async execute(i){
    if(!i.guild||!i.memberPermissions?.has(PermissionFlagsBits.ManageRoles)){await i.reply({content:'Manage Roles permission is required.',flags:MessageFlags.Ephemeral});return;}
    await i.deferReply({flags:MessageFlags.Ephemeral});const action=i.options.getSubcommand();
    if(action==='list'){const mappings=(await service<ReactionRole[]>('/reaction-roles')).filter(x=>x.guild===i.guildId);await i.editReply(mappings.map(x=>`${x.emoji} → <@&${x.role}>: https://discord.com/channels/${x.guild}/${x.channel}/${x.message}`).join('\n').slice(0,1900)||'No reaction roles configured.');return;}
    if(action==='set'){
      const link=i.options.getString('message',true).match(/^https:\/\/(?:canary\.|ptb\.)?discord.com\/channels\/(\d{17,20})\/(\d{17,20})\/(\d{17,20})$/);
      if(!link||link[1]!==i.guildId){await i.editReply('Use a message link from this server.');return;}
      const role=await i.guild.roles.fetch(i.options.getRole('role',true).id);const me=await i.guild.members.fetchMe();const actor=await i.guild.members.fetch(i.user.id);
      if(!role||!roleSafe(role)||me.roles.highest.comparePositionTo(role)<=0||!me.permissions.has(PermissionFlagsBits.ManageRoles)||
        (i.user.id!==i.guild.ownerId&&actor.roles.highest.comparePositionTo(role)<=0)){await i.editReply('Choose a non-privileged role below both your highest role and the bot role. The bot needs Manage Roles.');return;}
      const raw=i.options.getString('emoji')??'🥼';const emoji=raw.match(/^<a?:\w+:(\d+)>$/)?.[1]??raw;
      const mapping:ReactionRole={guild:i.guild.id,channel:link[2]!,message:link[3]!,role:role.id,emoji};
      const channel=await i.guild.channels.fetch(mapping.channel);if(!channel?.isTextBased()){await i.editReply('Choose a text-channel message.');return;}
      const message=await channel.messages.fetch(mapping.message);await message.react(emoji);
      await serializeRole(mapping.message,()=>service('/reaction-roles',{...mapping,user:i.user.id,moderator:true}));
      // Reconciliation can exceed interaction limits on a large server; report setup first.
      await i.editReply('Saved! Existing reactions will be reconciled now. Existing role holders keep their roles; only bot-granted roles are removed on opt-out. Use /reaction-role sync to check again.');
      void syncRole(i.client,mapping).catch(()=>console.error('Initial reaction-role sync failed; background reconciliation will retry.'));
    }else{
      const message=i.options.getString('message',true);const mapping=(await service<ReactionRole[]>('/reaction-roles')).find(x=>x.guild===i.guildId&&x.message===message);
      if(!mapping){await i.editReply('No matching reaction-role message in this server.');return;}
      if(action==='remove'){await serializeRole(message,()=>service('/reaction-roles',{guild:i.guildId,message,user:i.user.id,moderator:true,remove:true}));await i.editReply('Mapping removed. Existing roles were left unchanged.');}
      else{await i.editReply('Reconciliation started. Existing role holders are preserved; results will follow.');void syncRole(i.client,mapping).then(stats=>i.editReply(`Reconciled: ${stats.added} added, ${stats.removed} removed, ${stats.preserved} unchanged, ${stats.absent} departed.`)).catch(()=>console.error('Reaction-role sync failed. Check message access and role hierarchy.'));}
    }
  },
};
