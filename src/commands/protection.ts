import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import type { Command } from './types.js';
import { loadConfig } from '../config.js';
import { securityStore } from '../security/runtime.js';
import { securityActor, canReadSecurity } from '../security/authorization.js';
import { diagnostics } from '../security/diagnostic.js';

export const protection:Command={
  data:new SlashCommandBuilder().setName('protection').setDescription('Inspect Aleph security capabilities.').setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addSubcommand(s=>s.setName('status').setDescription('Inspect installed protection modules.'))
    .addSubcommand(s=>s.setName('diagnostic').setDescription('Check bot permissions, hierarchy and AutoMod fallback.')),
  async execute(i){
    await i.deferReply({flags:MessageFlags.Ephemeral});
    try{
      const config=loadConfig(),actor=await securityActor(i),store=securityStore(config.moderationDatabase),settings=store.config(i.guildId!).config;
      if(!canReadSecurity(actor,settings)){await i.editReply('Manage Messages or security-admin authorization is required.');return;}
      const bot=await i.guild!.members.fetchMe({force:true});
      const permissions=Object.fromEntries(['ViewChannel','ManageMessages','ViewAuditLog','ManageRoles','ManageChannels','ModerateMembers','KickMembers','BanMembers','ManageWebhooks'].map(name=>[name,bot.permissions.has(PermissionFlagsBits[name as keyof typeof PermissionFlagsBits])]));
      let autoMod:boolean|null=null;
      if(bot.permissions.has(PermissionFlagsBits.ManageGuild)){try{autoMod=(await i.guild!.autoModerationRules.fetch()).some(r=>r.enabled);}catch{}}
      const hierarchy=[...i.guild!.roles.cache.values()].filter(r=>r.id!==i.guildId&&r.id!==bot.roles.highest.id).every(r=>bot.roles.highest.comparePositionTo(r)>0);
      const rows=diagnostics({messageContent:config.messageFeatures,enabled:config.moderationEngine&&settings.mode!=='disabled',permissions,hierarchy,autoMod});
      const text=rows.map(r=>`${r.name}: ${r.state}\n${r.detail}`).join('\n\n');
      await i.editReply({content:`Aleph security · ${settings.mode}\n\n${text}`.slice(0,1950),allowedMentions:{parse:[]}});
    }catch{await i.editReply('Unable to inspect current permissions. Check server membership and bot access.');}
  },
};
