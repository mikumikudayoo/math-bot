import { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags, type ButtonInteraction, type ModalSubmitInteraction } from 'discord.js';
import { ProblemError, type ProblemStore } from './store.js';
import { sendResult } from './media.js';
export async function handleProblemComponent(i: ButtonInteraction | ModalSubmitInteraction, store: ProblemStore, allowedGuild?: string) {
  try {
    if (!i.guildId || (allowedGuild && i.guildId !== allowedGuild) || i.user.bot) throw new ProblemError('Practice is unavailable here.');
    const match = /^problem:(answer|submit|solution):([a-f0-9-]{36})$/.exec(i.customId);
    if (!match) throw new ProblemError('Invalid practice control.');
    const id = match[2]!, action = match[1]!;
    const a = store.owned(id, i.guildId, i.user.id);
    if (i.isButton() && action === 'answer') {
      if (a.state !== 'active' || (a.deadline !== null && store.clock() >= a.deadline)) throw new ProblemError('This attempt is closed. Use /problem result.');
      await i.showModal(new ModalBuilder().setCustomId(`problem:submit:${id}`).setTitle(a.mode === 'rated' ? 'One final answer' : 'Practice answer')
        .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('answer').setLabel('Answer').setStyle(TextInputStyle.Short).setMaxLength(1000).setRequired(true))));
      return;
    }
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    if (i.isModalSubmit() && action === 'submit') {
      const result = store.submit(id, i.guildId, i.user.id, i.fields.getTextInputValue('answer'));
      if (result.mode === 'practice') await i.editReply({ content: result.correct ? 'Correct :3 No points or rating changes.' : 'Not quite. Try again or open the official solution.', allowedMentions: { parse: [] } });
      else await sendResult(store, store.solution(id, i.guildId, i.user.id), p => i.editReply(p), p => i.followUp({...p, flags: MessageFlags.Ephemeral}));
    } else if (i.isButton() && action === 'solution') await sendResult(store, store.solution(id, i.guildId, i.user.id), p => i.editReply(p), p => i.followUp({...p, flags: MessageFlags.Ephemeral}));
    else throw new ProblemError('Invalid practice control.');
  } catch (error) {
    const content = error instanceof ProblemError ? error.message : 'Practice could not complete this response. Your saved result is safe; use /problem resume or /problem result.';
    if (!(error instanceof ProblemError)) console.error('Practice interaction failed; persisted attempts remain authoritative.');
    try { if (i.deferred) await i.editReply({ content }); else await i.reply({ content, flags: MessageFlags.Ephemeral }); } catch { /* A new slash command does not depend on the expired token. */ }
  }
}
