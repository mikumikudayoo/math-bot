import { AttachmentBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from './types.js';
import { isDatabaseModerator } from '../admin/auth.js';
import { adminStore } from '../admin/store.js';
import { loadConfig } from '../config.js';
import { qotdStore } from '../qotd/posting.js';
import { ProblemError, ProblemStore } from '../problems/store.js';
export function problemAdminCommand(deps = { store: () => new ProblemStore(qotdStore()), audit: () => adminStore(loadConfig().adminDatabase) }): Command {
  return {
    data: new SlashCommandBuilder().setName('problem-admin').setDescription('Review private practice banks and experimental rating corrections.').setDefaultMemberPermissions(0)
      .addSubcommand(s => s.setName('inspect').setDescription('Bank counts, provisional difficulty and calibration status.').addStringOption(o => o.setName('question').setDescription('Optional full source question ID.')))
      .addSubcommand(s => s.setName('promote').setDescription('Reserve one reviewed problem for a separate practice bank.')
        .addStringOption(o => o.setName('question').setDescription('Full approved source question ID.').setRequired(true))
        .addStringOption(o => o.setName('mode').setDescription('Bank destination; transfers are not allowed.').setRequired(true).addChoices({ name: 'rated', value: 'rated' }, { name: 'practice', value: 'practice' }))
        .addIntegerOption(o => o.setName('difficulty').setDescription('Explicit initial rated difficulty (required for rated).').setMinValue(0).setMaxValue(4000)))
      .addSubcommand(s => s.setName('eligibility').setDescription('Enable, disable or mark a bank problem invalid.')
        .addStringOption(o => o.setName('question').setDescription('Full question ID.').setRequired(true))
        .addBooleanOption(o => o.setName('enabled').setDescription('Allow new assignments.').setRequired(true))
        .addBooleanOption(o => o.setName('invalid').setDescription('Invalid: also cancel active attempts without rating changes.').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('Audit reason.').setRequired(true))
        .addIntegerOption(o => o.setName('difficulty').setDescription('Initial difficulty; editable only before any assignment.').setMinValue(0).setMaxValue(4000)))
      .addSubcommand(s => s.setName('attempts').setDescription('Inspect attempts affected by a source problem.').addStringOption(o => o.setName('question').setDescription('Full question ID.').setRequired(true)).addIntegerOption(o => o.setName('offset').setDescription('Offset for the next 100 records.').setMinValue(0)))
      .addSubcommand(s => s.setName('correct').setDescription('Append a correction and replay this player’s rating history.')
        .addStringOption(o => o.setName('attempt').setDescription('Scored attempt ID.').setRequired(true))
        .addStringOption(o => o.setName('result').setDescription('Corrected outcome.').setRequired(true).addChoices({ name: 'void', value: 'void' }, { name: 'correct', value: 'correct' }, { name: 'incorrect', value: 'incorrect' }))
        .addStringOption(o => o.setName('reason').setDescription('Correction audit reason.').setRequired(true)))
      .addSubcommand(s => s.setName('cancel-delivery').setDescription('Cancel an interrupted, unconfirmed delivery without scoring.')
        .addStringOption(o => o.setName('attempt').setDescription('Unconfirmed attempt ID.').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('Reconciliation audit reason.').setRequired(true)))
      .addSubcommand(s => s.setName('configure').setDescription('Explicitly enable experimental rated practice or update versioned limits.')
        .addBooleanOption(o => o.setName('enabled').setDescription('Enable only after bank and simulation review.').setRequired(true))
        .addBooleanOption(o => o.setName('confirm').setDescription('Confirm experimental rollout and limits have been reviewed.').setRequired(true))
        .addStringOption(o => o.setName('config').setDescription('Optional complete versioned rating configuration JSON.').setMaxLength(1500)))
      .addSubcommand(s => s.setName('disable').setDescription('Pause new rated assignments in this server. Existing deadlines remain.')),
    async execute(i) {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      if (!i.guildId || !await isDatabaseModerator(i)) { await i.editReply('Owner or authorized moderator access is required.'); return; }
      const action = i.options.getSubcommand(), question = i.options.getString('question'), store = deps.store();
      const record = { actor: i.user.id, guild: i.guildId, action: `problem.${action}`, target: question ?? i.options.getString('attempt') ?? i.guildId };
      deps.audit().audit({ ...record, phase: 'attempt' });
      try {
        let result: unknown = 'Saved.';
        if (action === 'inspect') result = { bank: store.inspect(question ?? undefined), ratedEnabled: store.controls(i.guildId).enabled, warning: 'Fewer than 31 eligible rated problems cannot sustain a 30-other-assignment cooldown. Automatic calibration and public rated leaderboards are disabled.' };
        else if (action === 'promote') store.promote(question!, i.options.getString('mode', true) as 'rated' | 'practice', i.options.getInteger('difficulty'), i.user.id);
        else if (action === 'eligibility') store.updateProblem(question!, i.options.getBoolean('enabled', true), i.options.getBoolean('invalid', true), i.user.id, i.options.getString('reason', true), i.options.getInteger('difficulty') ?? undefined);
        else if (action === 'attempts') result = store.attempts(question!, i.options.getInteger('offset') ?? 0);
        else if (action === 'correct') { const value = i.options.getString('result', true); result = store.correct(i.options.getString('attempt', true), value === 'void' ? null : value === 'correct', i.user.id, i.options.getString('reason', true), i.id); }
        else if (action === 'cancel-delivery') store.cancelDelivery(i.options.getString('attempt', true), i.user.id, i.options.getString('reason', true));
        else if (action === 'configure') {
          if (!i.options.getBoolean('confirm', true)) throw new ProblemError('Explicit review confirmation is required.');
          const raw = i.options.getString('config');
          store.control(i.guildId, i.options.getBoolean('enabled', true), raw ? JSON.parse(raw) : store.controls(i.guildId).config, i.user.id);
          result = 'Experimental rated settings saved. Bank warning: fewer than 31 eligible problems will exhaust the default cooldown. Automatic calibration and public rated leaderboards remain disabled.';
        }
        else if (action === 'disable') store.control(i.guildId, false, store.controls(i.guildId).config, i.user.id);
        deps.audit().audit({ ...record, phase: 'success' });
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        await i.editReply({ content: text.length <= 1900 ? text : 'Private review report attached. Attempts are paginated in groups of 100; use offset for older records.',
          ...(text.length > 1900 ? { files: [new AttachmentBuilder(Buffer.from(text), {name: 'problem-review.json'})] } : {}), allowedMentions: { parse: [] } });
      } catch (error) {
        deps.audit().audit({ ...record, phase: 'failure' });
        await i.editReply(error instanceof ProblemError ? error.message : 'Problem administration failed. Inspect the audit before retrying.');
      }
    },
  };
}
export const problemAdmin = problemAdminCommand();
