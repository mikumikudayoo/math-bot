import { AttachmentBuilder, type Client, type MessageCreateOptions } from 'discord.js';
import { resolve } from 'node:path';
import { config as dotenv } from 'dotenv';
import { QotdStore, type Question } from './store.js';
let singleton: QotdStore | undefined;
export function qotdStore() {
  if (!singleton) {
    const env: NodeJS.ProcessEnv = {};
    const mode = process.env.BOT_ENV ?? 'development';
    if (!['development','production'].includes(mode)) throw new Error('Invalid BOT_ENV.');
    dotenv({ path:`.env.${mode}`,processEnv:env,quiet:true });
    singleton = new QotdStore(resolve(env.QOTD_DB_PATH ?? process.env.QOTD_DB_PATH ?? 'data/qotd.sqlite'));
  }
  return singleton;
}
export function questionMessage(q: Question): MessageCreateOptions {
  const title = `🎵 question of the day · ${q.section || 'math'}\n`;
  const content = title + q.text;
  const files: AttachmentBuilder[] = [];
  if (q.asset) files.push(new AttachmentBuilder(q.asset, { name:'question' + (q.asset.toLowerCase().endsWith('.png') ? '.png' : '.jpg') }));
  if (content.length > 1900) files.push(new AttachmentBuilder(Buffer.from(q.text), { name:'question.txt' }));
  const payload: MessageCreateOptions = { content: content.length > 1900 ? title + 'the full question is attached 💙' : content, files, allowedMentions:{parse:[]} };
  if (q.kind === 'mcq') {
    if (q.choices.length < 2 || q.choices.length > 10) throw new Error('Invalid source choice count.');
    // Long source options remain in an attachment; poll labels still map exactly
    // to source letters. No answer/solution fields enter the public payload.
    const long = q.choices.some(c => `${c.label}. ${c.text}`.length > 55);
    if (long) files.push(new AttachmentBuilder(Buffer.from(q.choices.map(c=>`${c.label}. ${c.text}`).join('\n')), { name:'choices.txt' }));
    payload.poll = { question:{text:'which answer do you choose? 🎵'}, answers:q.choices.map(c=>({text:long ? c.label : `${c.label}. ${c.text}`})), duration:24, allowMultiselect:false };
  }
  return payload;
}
export async function postDaily(store: QotdStore, guild: string, channel: string, send: (payload: MessageCreateOptions) => Promise<{id:string}>, day = new Date().toISOString().slice(0,10)) {
  const selected = store.claim(guild,channel,day);
  if (!selected) return 'already reserved today, or no approved unused questions remain.';
  try {
    const message = await send(questionMessage(selected.question));
    store.finish(selected.claim.id,message.id);
    return `posted 💙 question id: ${selected.question.id}`;
  } catch (error) {
    store.finish(selected.claim.id,null);
    throw new Error(`QOTD send uncertain; question ${selected.question.id} remains consumed. Check channel/history before an explicit moderator reset.`, {cause:error});
  }
}
export function startQotd(client: Client, allowedGuild?: string) {
  let busy = false;
  async function tick() {
    if (busy) return; busy = true;
    try {
      const store = qotdStore(); const now = new Date();
      const schedules = store.db.prepare('SELECT * FROM qotd_schedule WHERE hour<=?').all(now.getUTCHours());
      for (const s of schedules) {
        if (allowedGuild && s.guild !== allowedGuild) continue;
        const channel = await client.channels.fetch(String(s.channel));
        if (!channel || !('guildId' in channel) || channel.guildId !== s.guild || !channel.isSendable()) continue;
        await postDaily(store,String(s.guild),String(s.channel),payload=>channel.send(payload));
      }
    } catch (e) { console.error('QOTD scheduler:',e instanceof Error ? e.message : e); }
    finally { busy = false; }
  }
  const timer = setInterval(()=>void tick(),60_000); void tick();
  return ()=>clearInterval(timer);
}
