import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from './types.js';
import { loadConfig } from '../config.js';
import { isDatabaseModerator } from '../admin/auth.js';
import { adminStore, type AdminStore } from '../admin/store.js';
import { bounded, databaseRegistry, runSQL, sqlText, type DatabaseRegistry } from '../admin/sql.js';

export function sqlCommand(deps = {store:():AdminStore=>adminStore(loadConfig().adminDatabase),registry:():DatabaseRegistry=>databaseRegistry(),python:()=>loadConfig().adminPython}) : Command {
  return {
    data:new SlashCommandBuilder().setName('sql').setDescription("Raw SQL. DO NOT USE IF YOU DON'T KNOW WHAT IT DOES.").setDefaultMemberPermissions(0)
      .addSubcommand(s=>s.setName('run').setDescription('DANGER: raw SQL can destroy bot data. One statement, no undo.')
        .addStringOption(o=>o.setName('database').setDescription('Known database name; see /sql databases').setRequired(true))
        .addStringOption(o=>o.setName('command').setDescription('One SQL statement, recorded in the private audit log').setMaxLength(4000).setRequired(true)))
      .addSubcommand(s=>s.setName('databases').setDescription('List selectable database names.'))
      .addSubcommand(s=>s.setName('schema').setDescription('Inspect table and index definitions.')
        .addStringOption(o=>o.setName('database').setDescription('Known database name').setRequired(true)))
      .addSubcommand(s=>s.setName('audit').setDescription('Recent private administrative audit entries for this server.')),
    async execute(i) {
      await i.deferReply({flags:MessageFlags.Ephemeral});
      const action=i.options.getSubcommand(), name=i.options.getString('database')??'', statement=i.options.getString('command')??'';
      const entry={actor:i.user.id,username:i.user.username,guild:i.guildId??'',action:`sql.${action}`,target:name};
      try {
        const store=deps.store();
        store.audit({...entry,phase:'attempt',details:{statement}});
        if(!await isDatabaseModerator(i)) {
          store.audit({...entry,phase:'failure',details:{error:'not authorized'}});
          await i.editReply('moderator access is required.');return;
        }
        let content:string;
        if(action==='audit') content=bounded(store.recent(i.guildId!));
        else {
          const registry=deps.registry();
          if(action==='databases') content=Object.keys(registry).join(', ');
          else {
            const query=action==='schema'?"SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name":statement;
            const result=await runSQL(registry,name,query,deps.python());
            store.audit({...entry,phase:result.ok?'success':'failure',details:{statement:query,changes:result.changes??0,error:result.error??null}});
            await i.editReply({content:sqlText(result),allowedMentions:{parse:[]}});return;
          }
        }
        store.audit({...entry,phase:'success'});
        await i.editReply({content,allowedMentions:{parse:[]}});
      } catch {
        // Never dump SQL/driver errors or environment values into Discord or stdout.
        await i.editReply('admin storage or audit is unavailable. execution stopped; inspect the private audit before retrying a mutation.');
      }
    },
  };
}
export const sql=sqlCommand();
