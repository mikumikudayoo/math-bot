import { qotdSettings } from '../qotd/config.js';
import { ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import type { Command } from './types.js';
import { postDaily, qotdStore, revealAnswer } from '../qotd/posting.js';
import { Competition } from '../qotd/competition.js';
import { leaderboardText, statsText } from '../qotd/standings.js';
export const qotd: Command = {
  data:new SlashCommandBuilder().setName('qotd').setDescription('Daily math questions and results.')
    .addSubcommand(s=>s.setName('leaderboard').setDescription('Show total, monthly and weekly QOTD standings.'))
    .addSubcommand(s=>s.setName('stats').setDescription('Show QOTD participation and scores.').addUserOption(o=>o.setName('user').setDescription('Whose stats to show (defaults to you)')))
    .addSubcommand(s=>s.setName('post').setDescription('Post today’s approved unused question in this channel.'))
    .addSubcommand(s=>s.setName('reveal').setDescription('Reveal today’s official answer after the QOTD window.')
      .addIntegerOption(o=>o.setName('post-id').setDescription('Post number shown by history').setMinValue(1).setRequired(true)))
    .addSubcommand(s=>s.setName('history').setDescription('Show recent posts and uncertain reservations.'))
    .addSubcommand(s=>s.setName('schedule').setDescription('Set automatic daily posting (UTC).')
      .addChannelOption(o=>o.setName('channel').setDescription('Destination').addChannelTypes(ChannelType.GuildText).setRequired(true))
      .addIntegerOption(o=>o.setName('hour').setDescription('UTC hour, 0–23; Manila is UTC+8').setMinValue(0).setMaxValue(23).setRequired(true))
      .addRoleOption(o=>o.setName('role').setDescription('Optional role to notify with each question')))
    .addSubcommand(s=>s.setName('disable').setDescription('Disable automatic daily posting.'))
    .addSubcommand(s=>s.setName('reset').setDescription('Explicitly allow one used question again; preserves audit history.')
      .addStringOption(o=>o.setName('question').setDescription('Full question ID from history').setRequired(true))
      .addBooleanOption(o=>o.setName('confirm').setDescription('Confirm you checked the channel and want to permit a repeat').setRequired(true))),
  async execute(i) {
    const action = i.options.getSubcommand();
    const isPublic = action === 'leaderboard' || action === 'stats';
    if (!i.inGuild() || (!isPublic && !i.memberPermissions?.has(PermissionFlagsBits.ManageGuild))) {
      await i.reply({content:'manage server permission is required.',flags:MessageFlags.Ephemeral});return;
    }
    await i.deferReply(isPublic ? {} : {flags:MessageFlags.Ephemeral});
    const store = qotdStore();
    if (isPublic) {
      const competition = new Competition(store);
      const target = i.options.getUser('user') ?? i.user;
      const alephZeroId = process.env.DISCORD_APPLICATION_ID;
      if (action === 'stats' && target.bot && target.id !== alephZeroId) {
        await i.editReply({content:"Bots aren't included in QOTD statistics.",allowedMentions:{parse:[]}});return;
      }
      if (action === 'stats' && target.id === alephZeroId) {
        await i.editReply({content:`**QOTD Stats for <@${target.id}>**

total: ∞ points · rank #0
month: ∞ points · rank #0
week: ∞ points · rank #0

Correct: ∞
Submitted (scored days): ∞
Accuracy: ∞%

🏅 Zeroth-place finishes: ∞
🥇 First-place finishes: ∞
🥈 Second-place finishes: 0
🥉 Third-place finishes: 0`,allowedMentions:{parse:[]}});return;
      }
      await i.editReply({content:action==='leaderboard' ? leaderboardText(competition,i.guildId!) : statsText(competition,i.guildId!,target.id),allowedMentions:{parse:[]}});
    } else if (action === 'post') {
      const channel = i.channel;
      if (!channel?.isSendable()) throw new Error('Use a sendable server channel.');
      await i.editReply(await postDaily(store,i.guildId!,i.channelId,payload=>channel.send(payload),undefined,(store.db.prepare('SELECT role FROM qotd_schedule WHERE guild=?').get(i.guildId!)?.role as string | undefined) ?? qotdSettings().role));
    } else if (action === 'reveal') {
      const id=i.options.getInteger('post-id',true);const entry=store.historyEntry(i.guildId!,id);
      if(!entry)throw new Error('Unknown QOTD post.');
      const channel=await i.client.channels.fetch(String(entry.channel));
      if(!channel || !('guildId' in channel) || channel.guildId!==i.guildId || !channel.isSendable())throw new Error('Original QOTD channel is unavailable.');
      await i.editReply(await revealAnswer(store,i.guildId!,id,i.user.id,payload=>channel.send(payload)));
    } else if (action === 'history') {
      const rows = store.history(i.guildId!);
      await i.editReply(rows.slice(0,10).map(r=>`#${r.id} · ${r.day} · ${r.state} · ${r.question}${r.message ? `\nhttps://discord.com/channels/${i.guildId}/${r.channel}/${r.message}` : ''}`).join('\n') || 'no qotd history yet.');
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
      const role=i.options.getRole('role')?.id ?? qotdSettings().role ?? null;
      store.db.prepare('INSERT INTO qotd_schedule VALUES(?,?,?,?) ON CONFLICT(guild) DO UPDATE SET channel=excluded.channel,hour=excluded.hour,role=excluded.role').run(i.guildId!,channel.id,hour,role);
      store.audit(i.user.id,`schedule guild=${i.guildId} channel=${channel.id} hour=${hour}`);
      await i.editReply(`daily qotd set for ${hour}:00 utc 💙 if that time has passed, today’s question will post shortly.`);
    }
  },
};
