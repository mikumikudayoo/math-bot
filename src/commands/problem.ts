import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from './types.js';
import { qotdStore } from '../qotd/posting.js';
import { ProblemError, ProblemStore } from '../problems/store.js';
import { deliverAttempt, sendResult } from '../problems/media.js';
export function problemCommand(makeStore = () => new ProblemStore(qotdStore())): Command {
  return {
    data: new SlashCommandBuilder().setName('problem').setDescription('Private math practice; separate from daily MPoTD points.')
      .addSubcommand(s => s.setName('practice').setDescription('Untimed practice with unlimited tries and official solutions.'))
      .addSubcommand(s => s.setName('rated').setDescription('Start or resume one experimental timed rated problem.'))
      .addSubcommand(s => s.setName('resume').setDescription('Recover your rated attempt without restarting its timer.'))
      .addSubcommand(s => s.setName('result').setDescription('Read your private rated result.').addStringOption(o => o.setName('attempt').setDescription('Optional attempt ID from your private history.')))
      .addSubcommand(s => s.setName('profile').setDescription('Your private experimental rating and rated statistics.'))
      .addSubcommand(s => s.setName('history').setDescription('Your private rated history and corrections.')),
    async execute(i) {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        if (!i.guildId || i.user.bot) throw new ProblemError('Use practice from your own account in a server.');
        const store = makeStore(), action = i.options.getSubcommand(), guild = i.guildId, user = i.user.id;
        if (action === 'profile') {
          const p = store.player(guild, user), provisional = p.scored < store.controls(guild).config.provisionalUntil;
          await i.editReply({ content: `**Private rated profile**\nRating: ${p.rating.toFixed(2)}${provisional ? ' (provisional)' : ''}\nPeak: ${p.peak.toFixed(2)}\nScored: ${p.scored} · Correct: ${p.correct}\n\nExperimental performance in this problem bank and timed format, not intelligence.\nDaily MPoTD points and unrated practice are separate.`, allowedMentions: { parse: [] } });
        } else if (action === 'history') {
          const rows = store.history(guild, user);
          const revisions = store.db.prepare('SELECT correction,created,rating FROM problem_revisions WHERE guild=? AND user=? ORDER BY id DESC LIMIT 5').all(guild, user);
          const text = rows.slice(0, 12).map(e => `${e.attempt}: ${e.result ? 'correct' : 'incorrect'}, original Δ ${Number(e.delta).toFixed(2)}, encounter ${e.encounter}`).join('\n') || 'No scored rated attempts yet.';
          await i.editReply({ content: (`**Original immutable rating events**\n${text}\n\nCorrections/replays: ${JSON.stringify(revisions)}\nCurrent effective rating: ${store.player(guild, user).rating.toFixed(2)}`).slice(0, 1950), allowedMentions: { parse: [] } });
        } else if (action === 'result') {
          const id = i.options.getString('attempt') ?? store.resume(guild, user).id;
          await sendResult(store, store.solution(id, guild, user), p => i.editReply(p), p => i.followUp({...p, flags: MessageFlags.Ephemeral}));
        } else {
          const a = action === 'practice' ? store.practice(guild, user) : action === 'rated' ? store.start(guild, user) : store.resume(guild, user);
          if (['completed', 'expired', 'cancelled'].includes(a.state)) await sendResult(store, store.solution(a.id, guild, user), p => i.editReply(p), p => i.followUp({...p, flags: MessageFlags.Ephemeral}));
          else {
            const delivered = await deliverAttempt(store, a, p => i.editReply(p));
            if (delivered.deadline !== null) await i.followUp({ content: `Final answer deadline: <t:${Math.floor(delivered.deadline / 1000)}:F> (<t:${Math.floor(delivered.deadline / 1000)}:R>). Closing Discord does not pause it.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
          }
        }
      } catch (error) {
        if (!(error instanceof ProblemError)) console.error('Private practice command failed; use persisted state for recovery.');
        await i.editReply({ content: error instanceof ProblemError ? error.message : 'Practice could not complete this response. Use /problem resume or /problem result; saved results are not lost.', allowedMentions: { parse: [] } }).catch(() => {});
      }
    },
  };
}
export const problem = problemCommand();
