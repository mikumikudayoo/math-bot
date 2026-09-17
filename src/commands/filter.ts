import { isModerator } from '../admin/auth.js';
import { PermissionFlagsBits, SlashCommandBuilder, MessageFlags } from 'discord.js';
import { service } from '../ai-client.js';
import type { Command } from './types.js';
export const filter:Command={
  data:new SlashCommandBuilder().setName('filter').setDescription('Configure server-wide whole-word or phrase rules.').setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addSubcommand(o=>o.setName('add').setDescription('Add a deliberate moderation rule.').addStringOption(x=>x.setName('term').setDescription('Whole word or phrase').setRequired(true).setMaxLength(100)).addStringOption(x=>x.setName('action').setDescription('Flag or delete matching messages').setRequired(true).addChoices({name:'flag',value:'flag'},{name:'delete',value:'delete'})))
    .addSubcommand(o=>o.setName('remove').setDescription('Remove a rule.').addIntegerOption(x=>x.setName('id').setDescription('Rule ID').setRequired(true).setMinValue(1)))
    .addSubcommand(o=>o.setName('list').setDescription('Show rules.')),
  async execute(i){
    if(!isModerator(i,PermissionFlagsBits.ManageMessages)){await i.reply({content:'Manage Messages permission is required.',flags:MessageFlags.Ephemeral});return;}
    await i.deferReply({flags:MessageFlags.Ephemeral});const action=i.options.getSubcommand();
    if(action==='list'){
      const settings=await service<{rules:{id:number;term:string;action:string}[]}>(`/settings?guild=${i.guildId}`);
      await i.editReply((settings.rules.map(x=>`${x.id}: ${x.term} → ${x.action}`).join('\n')||'No rules configured.').slice(0,1900));
    }else{
      await service('/rules',{guild:i.guildId,user:i.user.id,moderator:true,...(action==='remove'?{remove:i.options.getInteger('id',true)}:{term:i.options.getString('term',true),action:i.options.getString('action',true)})});
      await i.editReply('Rule saved. Message features must be enabled for server-wide filtering; flagged matches are saved in the audit log.');
    }
  },
};
