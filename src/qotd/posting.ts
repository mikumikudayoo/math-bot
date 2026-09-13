import { AttachmentBuilder, type Client, type MessageCreateOptions } from 'discord.js';
import { qotdSettings } from './config.js';
import { validateCrop } from './crops.js';
import { QotdStore, type Question } from './store.js';
let singleton: QotdStore | undefined;
export function qotdStore() {
  if (!singleton) singleton = new QotdStore(qotdSettings().database);
  return singleton;
}
export function questionMessage(q: Question, day = new Date().toISOString().slice(0,10), roleId?:string): MessageCreateOptions {
  if (!q.cropReviewed || q.state !== 'approved') throw new Error('The student crop must be explicitly reviewed and approved.');
  validateCrop(q.crop);
  if (roleId && !/^\d{17,20}$/.test(roleId)) throw new Error('Invalid QOTD role ID.');
  const payload: MessageCreateOptions = {
    content: (roleId ? `<@&${roleId}> ` : '') + '**New QOTD of the Day!**\n*Submit your answer below!*',
    files: q.crop.images.map((image,i)=>new AttachmentBuilder(image.path,{name:`question-${String(i+1).padStart(2,'0')}.png`})),
    allowedMentions: {parse:[],roles:roleId?[roleId]:[]},
  };
  if (q.kind === 'mcq') {
    if (q.choices.length < 2 || q.choices.length > 10) throw new Error('Invalid source choice count.');
    payload.poll={question:{text:`QOTD ${day}`},answers:q.choices.map(c=>({text:c.label})),duration:24,allowMultiselect:false};
  }
  return payload;
}
export async function postDaily(store: QotdStore, guild: string, channel: string, send: (payload: MessageCreateOptions) => Promise<{id:string}>, day = new Date().toISOString().slice(0,10), roleId?:string) {
  const selected = store.claim(guild,channel,day);
  if (!selected) return 'already reserved today, or no approved unused questions remain.';
  try {
    const message = await send(questionMessage(selected.question,day,roleId));
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
        await postDaily(store,String(s.guild),String(s.channel),payload=>channel.send(payload),undefined,s.role ? String(s.role) : qotdSettings().role);
      }
    } catch (e) { console.error('QOTD scheduler:',e instanceof Error ? e.message : e); }
    finally { busy = false; }
  }
  const timer = setInterval(()=>void tick(),60_000); void tick();
  return ()=>clearInterval(timer);
}

export async function revealAnswer(store:QotdStore,guild:string,id:number,actor:string,send:(payload:MessageCreateOptions)=>Promise<{id:string}>,now=Date.now()) {
  const q=store.claimReveal(guild,id,actor,now);
  try {
    const content=`The official answer to the QOTD is:\n${q.officialAnswer}\n*Stay tuned for the next question!*`;
    const payload:MessageCreateOptions={content:content.length<=1900?content:'The official answer is attached.',allowedMentions:{parse:[]}};
    if(content.length>1900)payload.files=[new AttachmentBuilder(Buffer.from(q.officialAnswer),{name:'official-answer.txt'})];
    const message=await send(payload);store.finishReveal(id,message.id);return 'official answer revealed.';
  }catch(error){store.finishReveal(id,null);throw new Error('Answer reveal delivery is uncertain; inspect the channel. It will not retry automatically.',{cause:error});}
}
