import { ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import type { Command } from './types.js';
import { postDaily, qotdStore } from '../qotd/posting.js';
export const qotd: Command = {
  data:new SlashCommandBuilder().setName('qotd').setDescription('Manage daily math questions.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(s=>s.setName('post').setDescription('Post today’s approved unused question in this channel.'))
    .addSubcommand(s=>s.setName('history').setDescription('Show recent posts and uncertain reservations.'))
    .addSubcommand(s=>s.setName('schedule').setDescription('Set automatic daily posting (UTC).')
      .addChannelOption(o=>o.setName('channel').setDescription('Destination').addChannelTypes(ChannelType.GuildText).setRequired(true))
      .addIntegerOption(o=>o.setName('hour').setDescription('UTC hour, 0–23; Manila is UTC+8').setMinValue(0).setMaxValue(23).setRequired(true)))
    .addSubcommand(s=>s.setName('disable').setDescription('Disable automatic daily posting.'))
    .addSubcommand(s=>s.setName('reset').setDescription('Explicitly allow one used question again; preserves audit history.')
      .addStringOption(o=>o.setName('question').setDescription('Full question ID from history').setRequired(true))
      .addBooleanOption(o=>o.setName('confirm').setDescription('Confirm you checked the channel and want to permit a repeat').setRequired(true))),
  async execute(i) {
    if (!i.inGuild() || !i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await i.reply({content:'manage server permission is required.',flags:MessageFlags.Ephemeral});return;
    }
    await i.deferReply({flags:MessageFlags.Ephemeral});
    const store = qotdStore(); const action = i.options.getSubcommand();
    if (action === 'post') {
      const channel = i.channel;
      if (!channel?.isSendable()) throw new Error('Use a sendable server channel.');
      await i.editReply(await postDaily(store,i.guildId!,i.channelId,payload=>channel.send(payload)));
    } else if (action === 'history') {
      const rows = store.history(i.guildId!);
      await i.editReply(rows.slice(0,10).map(r=>`${r.day} · ${r.state} · ${r.question}${r.message ? `\nhttps://discord.com/channels/${i.guildId}/${r.channel}/${r.message}` : ''}`).join('\n') || 'no qotd history yet.');
    } else if (action === 'reset') {
      if (!i.options.getBoolean('confirm',true)) { await i.editReply('reset cancelled.');return; }
      store.reset(i.guildId!,i.options.getString('question',true),i.user.id);
      await i.editReply('this question is eligible again on a future day if approved. history is preserved.');
    } else if (action === 'disable') {
      store.db.prepare('DELETE FROM qotd_schedule WHERE guild=?').run(i.guildId!);
      store.audit(i.user.id,`schedule disabled guild=${i.guildId}`);
      await i.editReply('automatic qotd posting disabled.');
    } else {
      const channel = i.options.getChannel('channel',true); const hour = i.options.getInteger('hour',true);
      store.db.prepare('INSERT INTO qotd_schedule VALUES(?,?,?) ON CONFLICT(guild) DO UPDATE SET channel=excluded.channel,hour=excluded.hour').run(i.guildId!,channel.id,hour);
      store.audit(i.user.id,`schedule guild=${i.guildId} channel=${channel.id} hour=${hour}`);
      await i.editReply(`daily qotd set for ${hour}:00 utc 💙 if that time has passed, today’s question will post shortly.`);
    }
  },
};
