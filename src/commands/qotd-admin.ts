import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from './types.js';
import { isModerator } from '../admin/auth.js';
import { adminStore, type AdminStore } from '../admin/store.js';
import { loadConfig } from '../config.js';
import { Competition } from '../qotd/competition.js';
import { qotdStore } from '../qotd/posting.js';
import { correctMember, memberRecords } from '../admin/qotd.js';
import { bounded } from '../admin/sql.js';
export function qotdAdminCommand(deps={store:():AdminStore=>adminStore(loadConfig().adminDatabase),competition:()=>new Competition(qotdStore())}):Command {
  const data=new SlashCommandBuilder().setName('mpotd-admin').setDescription('Private corrections to scored MPoTD submissions.').setDefaultMemberPermissions(0)
    .addSubcommand(s=>s.setName('answer-key').setDescription('Privately inspect the current MPoTD answer key and aliases.'))
    .addSubcommand(s=>s.setName('answer-add').setDescription('Add an accepted answer to the current unscored MPoTD.').addStringOption(o=>o.setName('answer').setDescription('Accepted text or fraction (fraction aliases accept numeric equivalents)').setRequired(true).setMaxLength(200)))
    .addSubcommand(s=>s.setName('answer-remove').setDescription('Remove an added alias; canonical answers stay protected.').addStringOption(o=>o.setName('answer').setDescription('Alias to remove').setRequired(true).setMaxLength(200)))
    .addSubcommand(s=>s.setName('view').setDescription('Inspect derived stats and recent scored records.').addUserOption(o=>o.setName('user').setDescription('Member').setRequired(true)))
    .addSubcommand(s=>s.setName('reset').setDescription('Delete this member’s scored submissions in this server; preserves active answers.')
      .addUserOption(o=>o.setName('user').setDescription('Member').setRequired(true))
      .addBooleanOption(o=>o.setName('confirm').setDescription('Permanently remove scored records and rerank affected days').setRequired(true)));
  for(const action of ['set','add'])data.addSubcommand(s=>s.setName(action).setDescription(`${action} points on a scored submission; standings are derived.`)
    .addUserOption(o=>o.setName('user').setDescription('Member').setRequired(true))
    .addIntegerOption(o=>o.setName('post').setDescription('Scored MPoTD post ID').setMinValue(1).setRequired(true))
    .addNumberOption(o=>o.setName('points').setDescription(action==='add'?'Signed point adjustment':'New points'))
    .addBooleanOption(o=>o.setName('correct').setDescription('Correctness override; placements rerank by submission time')));
  return {data,async execute(i) {
    await i.deferReply({flags:MessageFlags.Ephemeral});
    if(!isModerator(i)){await i.editReply('moderator access is required.');return;}
    if(i.options.getSubcommand().startsWith('answer-')) {
      try {
        const c=deps.competition(),action=i.options.getSubcommand();
        if(action==='answer-key') {
          const {session:s,question,aliases}=c.currentAnswerKey(i.guildId!);
          const content=`current MPOTD #${s.id} · ${s.day}\nquestion: ${question}\ncanonical answer: ${JSON.stringify(s.snapshot.expectedAnswer)}\naccepted grading: ${JSON.stringify(s.snapshot.grading)}\nallowed aliases: ${JSON.stringify(aliases.map(a=>({answer:a.answer,grading:a.grading,created:a.created})))}\n${s.scoredAt===null?'unscored; aliases apply at scoring':'scored; historical key is read-only'}`;
          await i.editReply({content:content.length<=1900?content:`current MPOTD #${s.id}: private answer key attached.`,...(content.length>1900?{files:[{attachment:Buffer.from(content),name:'current-mpotd-answer-key.txt'}]}:{}),allowedMentions:{parse:[]}});
        }else {
          const result=c.manageCurrentAnswer(i.guildId!,i.user.id,action==='answer-add'?'add':'remove',i.options.getString('answer',true));
          await i.editReply({content:`current MPOTD #${result.id}: ${result.status==='duplicate'?'already accepted (duplicate after normalization)':`alias ${result.status}`}. canonical answers unchanged.`,allowedMentions:{parse:[]}});
        }
      }catch(error) {
        const message=error instanceof Error&&/^(No current|Current MPoTD|Invalid answer|No matching)/u.test(error.message)?error.message:'answer-key operation failed; inspect the current key before retrying.';
        await i.editReply({content:message,allowedMentions:{parse:[]}});
      }
      return;
    }
    const action=i.options.getSubcommand() as 'view'|'set'|'add'|'reset',user=i.options.getUser('user',true).id;
    const entry={actor:i.user.id,username:i.user.username,guild:i.guildId!,action:`qotd.${action}`,target:user};
    let store:AdminStore|undefined;
    try {
      store=deps.store();const c=deps.competition();
      if(action==='view'){await i.editReply({content:bounded({stats:c.stats(i.guildId!,user),records:memberRecords(c,i.guildId!,user).slice(-10)}),allowedMentions:{parse:[]}});return;}
      const post=i.options.getInteger('post')??undefined,points=i.options.getNumber('points')??undefined,correct=i.options.getBoolean('correct')??undefined;
      const options={...(post!==undefined?{post}:{}),...(points!==undefined?{points}:{}),...(correct!==undefined?{correct}:{}),confirm:i.options.getBoolean('confirm')===true};
      store.audit({...entry,phase:'attempt',details:{options,before:memberRecords(c,i.guildId!,user)}});
      const result=correctMember(c,i.guildId!,user,action,options);
      store.audit({...entry,phase:'success',details:result});
      await i.editReply({content:`${JSON.stringify(result.before)===JSON.stringify(result.after)?'no change':'updated'}: ${action==='reset'?'removed finalized submissions; active answers preserved':'corrected the scored submission'}. standings now derive from the remaining records. already-sent reveal messages are unchanged.`,allowedMentions:{parse:[]}});
    } catch(error) {
      try{store?.audit({...entry,phase:'failure',details:{error:'correction or audit failed; inspect attempt before retry'}});}catch{}
      const message=error instanceof Error && /^(Reset requires|Choose an existing|Provide points|Points must|Incorrect submissions)/.test(error.message)?error.message:'correction or audit failed. inspect records before retrying.';
      await i.editReply(message);
    }
  }};
}
export const qotdAdmin=qotdAdminCommand();
