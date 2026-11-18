import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { service } from '../ai-client.js';
import { loadConfig } from '../config.js';
import { LUNA_FAST_CREATOR, lunaFastMode } from '../luna-fast-control.js';
import type { Command } from './types.js';

async function control(mode: string) {
  const { lunaFastToken } = loadConfig();
  if (lunaFastToken.length < 32) throw new Error('Luna Fast control is not configured.');
  return service<{ enabled: boolean }>('/luna-fast', {mode}, lunaFastToken);
}

export async function handleLunaFast(interaction: ChatInputCommandInteraction, invoke = control) {
  if (interaction.user.id !== LUNA_FAST_CREATOR) {
    await interaction.reply({content:'Only the bot creator can control Luna Fast mode.', flags:MessageFlags.Ephemeral});
    return;
  }
  const mode = interaction.options.getString('mode', true);
  if (!lunaFastMode(mode)) {
    await interaction.reply({content:'Invalid Luna Fast mode.', flags:MessageFlags.Ephemeral});
    return;
  }
  await interaction.deferReply({flags:MessageFlags.Ephemeral});
  try {
    const {enabled} = await invoke(mode);
    await interaction.editReply('Luna Fast mode is ' + (enabled ? 'enabled (requests Fast processing).' : 'disabled (requests Standard processing).'));
  } catch {
    await interaction.editReply('Could not access Luna Fast settings. Check the AI service and control configuration.');
  }
}

export const lunaFast: Command = {
  data: new SlashCommandBuilder().setName('luna-fast').setDescription('Control Luna processing speed (creator only)')
    .addStringOption(option => option.setName('mode').setDescription('Enable, disable or check Luna Fast mode').setRequired(true)
      .addChoices({name:'Enable',value:'enable'},{name:'Disable',value:'disable'},{name:'Status',value:'status'})),
  execute: handleLunaFast,
};
