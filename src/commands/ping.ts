import { SlashCommandBuilder } from 'discord.js';
import type { Command } from './types.js';
export default {
  data: new SlashCommandBuilder().setName('ping').setDescription('Check whether the bot is responding.'),
  async execute(interaction) {
    await interaction.reply({ content: 'pong! 🏓', allowedMentions: { parse: [] } });
  },
} satisfies Command;
