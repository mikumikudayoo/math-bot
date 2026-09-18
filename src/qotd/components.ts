import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, type Interaction } from 'discord.js';
import { Competition } from './competition.js';
export function answerButton(id: number, disabled = false) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`qotd:answer:${id}`).setLabel('Submit Answer').setStyle(ButtonStyle.Primary).setDisabled(disabled));
}
export function answerModal(token: string) {
  return new ModalBuilder().setCustomId(`qotd:submit:${token}`).setTitle('Submit MPoTD Answer').addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('answer').setLabel('Your answer').setPlaceholder('Enter your final answer...').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(1000)));
}
export async function handleQotdComponent(i: Interaction, competition: Competition, allowedGuild?: string) {
  if ((!i.isButton() && !i.isModalSubmit()) || !i.customId.startsWith('qotd:')) return false;
  try {
    if (!i.guildId || !i.channelId || (allowedGuild && i.guildId !== allowedGuild)) throw new Error('Use this in the MPoTD server.');
    if (i.isButton()) {
      const match = /^qotd:answer:([1-9]\d*)$/.exec(i.customId);
      if (!match) throw new Error('Invalid MPoTD button.');
      const token = competition.openModal(Number(match[1]),i.guildId,i.channelId,i.message.id,i.user.id);
      await i.showModal(answerModal(token));
    } else {
      const match = /^qotd:submit:([a-f0-9]{48})$/.exec(i.customId);
      if (!match) throw new Error('Invalid MPoTD modal.');
      const updated = competition.submit(match[1]!,i.guildId,i.channelId,i.user.id,i.fields.getTextInputValue('answer'));
      await i.reply({ content: `Answer ${updated ? 'updated' : 'submitted'}! 🔒\nYour latest answer has been recorded.\nYou can change it ${updated ? 'again' : 'anytime'} before submissions close.`, flags: MessageFlags.Ephemeral });
    }
  } catch (error) {
    // Never log private answers or return correctness before reveal.
    if (!i.replied && !i.deferred) await i.reply({ content: error instanceof Error ? error.message : 'Could not record your answer.', flags: MessageFlags.Ephemeral }).catch(() => {});
  }
  return true;
}
