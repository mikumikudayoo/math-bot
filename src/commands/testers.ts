import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from './types.js';
import { loadConfig } from '../config.js';
import { isOwner } from '../admin/auth.js';
import { adminStore, type AdminStore } from '../admin/store.js';
import { bounded } from '../admin/sql.js';

export function testersCommand(deps={store:():AdminStore=>adminStore(loadConfig().adminDatabase),staticIds:()=>loadConfig().aiTesterUserIds}):Command {
  return {data:new SlashCommandBuilder().setName('ai-testers').setDescription('Owner-only private AI tester management.').setDefaultMemberPermissions(0)
    .addSubcommand(s=>s.setName('list').setDescription('List static and runtime testers.'))
    .addSubcommand(s=>s.setName('add').setDescription('Add a runtime tester.').addUserOption(o=>o.setName('user').setDescription('Tester').setRequired(true)))
    .addSubcommand(s=>s.setName('remove').setDescription('Remove a runtime tester; static entries remain.').addUserOption(o=>o.setName('user').setDescription('Tester').setRequired(true))),
    async execute(i) {
      await i.deferReply({flags:MessageFlags.Ephemeral});
      try {
        const store=deps.store(), statics=deps.staticIds(), action=i.options.getSubcommand();
        if(!isOwner(i)) {store.audit({actor:i.user.id,username:i.user.username,guild:i.guildId??'',action:`tester.${action}`,target:'',phase:'failure',details:{error:'owner required'}});await i.editReply('only emu can manage testers.');return;}
        if(action==='list') {await i.editReply({content:bounded({static:statics,runtime:store.testers(),effective:[...new Set([...statics,...store.testers()])]}),allowedMentions:{parse:[]}});return;}
        const target=i.options.getUser('user',true).id;
        const changed=store.changeTester(i.user.id,target,action==='add',i.guildId??'',i.user.username);
        await i.editReply({content:`${changed?'updated':'no change'}: runtime tester ${target} ${action==='add'?'added':'removed'}.${statics.includes(target)?' this user remains enabled by static configuration.':''}`,allowedMentions:{parse:[]}});
      } catch {await i.editReply('tester update failed; no change was committed.');}
    }};
}
export const testers=testersCommand();
