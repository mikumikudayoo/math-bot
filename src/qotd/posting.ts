import { AttachmentBuilder, type Client, type MessageCreateOptions } from 'discord.js';
import { qotdSettings } from './config.js';
import { validateCrop } from './crops.js';
import { QotdStore, type Question } from './store.js';
import { Competition, atomic, type Session, type PublicSource } from './competition.js';
import { answerButton } from './components.js';
import { manilaDay, dayTimes } from './periods.js';
import { readFileSync } from 'node:fs';
import { hash } from './parser.js';
import { prepareSolutionCrop } from './solutions.js';
const pick = <T>(items: readonly T[]): T =>
  items[Math.floor(Math.random() * items.length)]!;

let singleton: QotdStore | undefined;
export function qotdStore() { return singleton ??= new QotdStore(qotdSettings().database); }

export function questionMessage(q: Question, day = manilaDay(), roleId?: string, id = 0, notices: string[] = []): MessageCreateOptions {
  if (!q.cropReviewed || q.state !== 'approved') throw new Error('The student crop must be explicitly reviewed and approved.');
  validateCrop(q.crop);
  if (roleId && !/^\d{17,20}$/.test(roleId)) throw new Error('Invalid MPoTD role ID.');
  return {
    content: (roleId ? `<@&${roleId}> ` : '') +
      '**New Math Problem of the Day!**\n\n' + pick([
        'mpotd time :3',
        'new question. emu is making me do this again',
        'your daily mathematical problem has arrived. good luck with that',
        'alright, new question. go solve it or something',
        'the question has escaped containment',
      ]) +
      '\n\nDiscuss below or submit your answer privately using the button.\nYou may change your answer anytime before submissions close.' +
      (notices.length ? '\n\n'+notices.join('\n') : ''),
    files: q.crop.images.map((image,i) => new AttachmentBuilder(image.path,{name:`question-${i+1}.png`})),
    components: [answerButton(id)], allowedMentions: { parse: [], roles: roleId ? [roleId] : [] },
  };
}
type SentQuestion = { id: string; startThread?: (options: {name:string;autoArchiveDuration?:60|1440|4320|10080}) => Promise<unknown> };
export async function postDaily(store: QotdStore, guild: string, channel: string, send: (payload: MessageCreateOptions) => Promise<SentQuestion>, day = manilaDay(), roleId?: string, now = Date.now()) {
  const times = dayTimes(day);
  if (now < times.opensAt || now >= times.closesAt) throw new Error('New MPoTDs can post only between 08:00 and 21:59:59 Manila.');
  const selected = store.claim(guild,channel,day);
  if (!selected) return 'already reserved today, or no approved unused questions remain.';
  const competition = new Competition(store);
  let message: SentQuestion;
  try {
    const session = competition.create(selected.claim.id,selected.question,now);
    message = await send(questionMessage(selected.question,day,roleId,session.id,session.notices));
    store.finish(session.id,message.id);
    store.db.prepare('UPDATE qotd_sessions SET thread=? WHERE id=?').run(message.id,session.id);
  } catch (error) {
    store.finish(selected.claim.id,null);
    throw new Error(`MPoTD send uncertain; question ${selected.question.id} remains consumed. Check channel/history before an explicit moderator reset.`,{cause:error});
  }
  if (message.startThread) {
    try { await message.startThread({name:`MPoTD Discussion ${day.slice(5,7)}/${day.slice(8)}/${day.slice(0,4)}`,autoArchiveDuration:1440}); }
    catch { console.error(`MPoTD #${selected.claim.id}: discussion thread could not be created. Main question remains posted.`); }
  }
  return `posted 💙 question id: ${selected.question.id}`;
}
export function sourceText(source: PublicSource) {
  const details = [source.competition, source.year, source.edition ? `edition ${source.edition}` : undefined, source.level, source.set ? `set ${source.set}` : undefined].filter(Boolean);
  return (details.length ? `Source: ${details.join(', ')} · Problem ${source.number}\n` : '') + `Question: page ${source.questionPage}` + (source.solutionPage ? ` · Solution: page ${source.solutionPage}` : '');
}
export function revealMessages(competition: Competition, s: Session): MessageCreateOptions[] {
  const snap = s.snapshot, files: AttachmentBuilder[] = [];
  let text = `**MPoTD Answer Reveal · ${s.day}**\n\nAnswer: ${snap.expectedAnswer}`, hasCrop = false;
  if (snap.solutionCrop) {
    try {
      validateCrop(snap.solutionCrop);
      if (snap.solutionCrop.images.some(i => snap.questionCrop.images.some(q => q.sha256 === i.sha256))) throw new Error('Question crop is not a solution.');
      files.push(...snap.solutionCrop.images.map((i,n) => new AttachmentBuilder(i.path,{name:`solution-${n+1}.png`})));
      hasCrop = true;
    } catch { console.error(`MPoTD #${s.id}: solution crop unavailable; using official text.`); }
  }
  if (!hasCrop && snap.solution) text += `\n\n${snap.solution}`;
  const closing=pick([
    'submissions are closed now :3',
    "and that's it. submissions closed.",
    'submissions are closed. no sneaking answers in now',
    'pencils down. or keyboards down. whatever. submissions are closed.',
  ]);
  text += `\n\n${sourceText(snap.source)}\n\n${closing}`;
  const reveal: MessageCreateOptions = {content:text,files,allowedMentions:{parse:[]}};
  if (text.length > 1900) {
    const summary=`**MPoTD Answer Reveal · ${s.day}**\n\nAnswer: ${snap.expectedAnswer}\n\n${sourceText(snap.source)}\n\n${closing}`;
    reveal.content = summary.length<=1900 ? summary : `**MPoTD Answer Reveal · ${s.day}**\n${pick([
      'official answer and source details attached. submissions are closed :3',
      'discord said the answer was too long. attached it instead. submissions are closed.',
      'the answer would not fit. behold: attachment. submissions are closed.',
    ])}`;
    const textFile = new AttachmentBuilder(Buffer.from(text),{name:'official-answer-and-solution.txt'});
    if (files.length === 10) return [{...reveal,files:[textFile]}, {files,allowedMentions:{parse:[]}}, ...resultMessages(competition,s)];
    files.push(textFile);
  }
  return [reveal,...resultMessages(competition,s)];
}
function resultMessages(competition: Competition, s: Session): MessageCreateOptions[] {
  const correct = competition.results(s.id).filter(r => r.correct === 1);
  if (!correct.length) return [{
    content: "**Today's Results**\nNobody answered correctly today.\n\n" + pick([
      'well. the question won.',
      'zero correct answers. impressive',
      "i'm choosing to blame emu",
      'maybe tomorrow :<',
      'not a single correct answer 😭',
    ]),
    allowedMentions:{parse:[]}
  }];
  const messages: MessageCreateOptions[] = [];
  const heading = pick([
    "**today's results**",
    "**results are in :3**",
    "**alright, here's who got it**",
    "**mpotd results**",
    "**the numbers have spoken**",
  ]);
  for (let offset=0; offset<correct.length; offset+=20) {
    const rows = correct.slice(offset,offset+20), users = rows.map(r => r.user).filter(id => /^\d{17,20}$/.test(id));
    messages.push({content:heading+'\n'+rows.map(r => `${['🥇','🥈','🥉'][r.placement!-1] ?? `${r.placement}.`} <@${r.user}> · +${r.points} pts`).join('\n'),allowedMentions:{parse:[],users,roles:[],repliedUser:false}});
  }
  return messages;
}
interface DeliveryPayload { content?: string; allowedMentions?: MessageCreateOptions['allowedMentions']; files: {name:string;path?:string;data?:string;sha256:string}[] }
function freezePayload(p: MessageCreateOptions): string {
  return JSON.stringify({content:p.content,allowedMentions:p.allowedMentions,files:(p.files ?? []).map(f => {
    const file=f as AttachmentBuilder;
    if(typeof file.attachment==='string')return {name:file.name!,path:file.attachment,sha256:hash(readFileSync(file.attachment))};
    const bytes=file.attachment as Buffer;
    return {name:file.name!,data:bytes.toString('base64'),sha256:hash(bytes)};
  })});
}
function thawPayload(raw:string): MessageCreateOptions {
  const p:DeliveryPayload=JSON.parse(raw);
  return {...(p.content ? {content:p.content} : {}),allowedMentions:p.allowedMentions ?? {parse:[]},files:p.files.map(f=>{
    const bytes=f.path ? readFileSync(f.path) : Buffer.from(f.data!,'base64');
    if(hash(bytes)!==f.sha256)throw new Error('Saved reveal asset changed. Restore it before retrying.');
    return new AttachmentBuilder(bytes,{name:f.name});
  })};
}
export async function revealAnswer(store: QotdStore, guild: string, id: number, actor: string, send: (payload: MessageCreateOptions) => Promise<{id:string}>, now = Date.now(), _legacyAllowEarly = false) {
  const competition = new Competition(store), s = competition.session(id);
  if (!s || s.guild !== guild) throw new Error('This post has no modal-era MPoTD session. Legacy posting history is preserved.');
  competition.score(id,now);
  if (s.revealedAt !== null) return 'official answer already revealed.';
  if (!store.db.prepare('SELECT 1 FROM qotd_delivery WHERE qotd=?').get(id)) {
    const visualSession=await prepareSolutionCrop(competition,s);
    const payloads=revealMessages(competition,visualSession).map(freezePayload);
    atomic(store.db,()=>{
      if(store.db.prepare('SELECT 1 FROM qotd_delivery WHERE qotd=?').get(id))return;
      payloads.forEach((payload,part)=>store.db.prepare('INSERT INTO qotd_delivery(qotd,part,payload) VALUES(?,?,?)').run(id,part,payload));
    });
  }
  for (const delivery of store.db.prepare('SELECT part,payload,state FROM qotd_delivery WHERE qotd=? ORDER BY part').all(id)) {
    const part=Number(delivery.part);
    if(delivery.state==='sent')continue;
    const payload=thawPayload(String(delivery.payload));
    const state = atomic(store.db, () => {
      const row = store.db.prepare('SELECT state FROM qotd_delivery WHERE qotd=? AND part=?').get(id,part)!;
      if (row.state === 'pending') store.db.prepare("UPDATE qotd_delivery SET state='uncertain' WHERE qotd=? AND part=?").run(id,part);
      return row.state;
    });
    if (state === 'sent') continue;
    if (state !== 'pending') throw new Error(`Reveal #${id} part ${part} delivery is uncertain. Reconcile it before retrying; scores are already saved.`);
    try {
      const message = await send(payload);
      store.db.prepare("UPDATE qotd_delivery SET state='sent',message=? WHERE qotd=? AND part=?").run(message.id,id,part);
    } catch (error) {
      const status = Number((error as {status?:number})?.status);
      if (status >= 400 && status < 500) store.db.prepare("UPDATE qotd_delivery SET state='pending' WHERE qotd=? AND part=?").run(id,part);
      throw new Error(`Reveal #${id} part ${part} not confirmed; inspect delivery history. Scores will not be awarded twice.`,{cause:error});
    }
  }
  atomic(store.db, () => {
    store.db.prepare("UPDATE qotd_sessions SET revealedAt=?,state='revealed' WHERE id=?").run(now,id);
    store.db.prepare("INSERT INTO qotd_reveals VALUES(?,'posted',?) ON CONFLICT(history) DO UPDATE SET state='posted',message=excluded.message").run(id,String(store.db.prepare('SELECT message FROM qotd_delivery WHERE qotd=? AND part=0').get(id)!.message));
    store.audit(actor,`modal MPoTD ${id} revealed; immutable scores persisted`);
  });
  return 'official answer and results revealed.';
}
export async function disableAnswerButton(competition: Competition, s: Session, edit: (payload: {components:ReturnType<typeof answerButton>[]}) => Promise<unknown>, now = Date.now()) {
  competition.closeDue(now);
  if (now < s.closesAt || s.disabled) return;
  await edit({components:[answerButton(s.id,true)]});
  competition.db.prepare('UPDATE qotd_sessions SET disabled=1 WHERE id=?').run(s.id);
}
export function qotdScheduler(client: Client, store: QotdStore, allowedGuild?: string, clock = Date.now) {
  const competition = new Competition(store);
  let busy = false, lastPostCheck = 0;
  const retryAfter = new Map<string,number>();
  async function tick() {
    const now = clock(); competition.closeDue(now);
    if (busy) return; busy = true;
    try {
      for (const row of store.db.prepare('SELECT id FROM qotd_sessions WHERE disabled=0 OR revealedAt IS NULL').all()) {
        const s = competition.session(Number(row.id))!;
        if ((allowedGuild && s.guild !== allowedGuild) || s.historyState !== 'posted' || now < s.closesAt || (retryAfter.get(`session:${s.id}`) ?? 0) > now) continue;
        retryAfter.set(`session:${s.id}`,now < s.revealAt ? s.revealAt : now+30_000);
        try {
          const channel = await client.channels.fetch(s.channel);
          if (!channel || !('guildId' in channel) || channel.guildId !== s.guild || !channel.isSendable()) continue;
          if (!s.disabled) {
            try { const message = await channel.messages.fetch(s.message!); await disableAnswerButton(competition,s,p => message.edit(p),now); }
            catch { console.error(`MPoTD #${s.id}: button edit failed; backend is closed, will retry.`); }
          }
          if (now >= s.revealAt && s.revealedAt === null && !store.db.prepare("SELECT 1 FROM qotd_delivery WHERE qotd=? AND state='uncertain'").get(s.id)) await revealAnswer(store,s.guild,s.id,'scheduler',p => channel.send(p),now);
        } catch { console.error(`MPoTD #${s.id}: closing/reveal needs retry or delivery reconciliation.`); }
      }
      if (now-lastPostCheck < 60_000) return; lastPostCheck = now;
      const day = manilaDay(new Date(now)), times = dayTimes(day);
      if (now < times.opensAt || now >= times.closesAt) return;
      for (const schedule of store.db.prepare('SELECT * FROM qotd_schedule').all()) {
        const guild = String(schedule.guild);
        if ((allowedGuild && guild !== allowedGuild) || new Date(now).getUTCHours() < Number(schedule.hour) || store.db.prepare('SELECT 1 FROM qotd_history WHERE guild=? AND day=?').get(guild,day)) continue;
        try {
          const channel = await client.channels.fetch(String(schedule.channel));
          if (channel && 'guildId' in channel && channel.guildId === guild && channel.isSendable()) await postDaily(store,guild,channel.id,p => channel.send(p),day,schedule.role ? String(schedule.role) : qotdSettings().role,now);
        } catch { console.error(`MPoTD ${guild}: automatic posting failed; inspect reservation history.`); }
      }
    } finally { busy = false; }
  }
  return tick;
}
export function startQotd(client: Client, allowedGuild?: string) {
  const tick=qotdScheduler(client,qotdStore(),allowedGuild);
  const timer = setInterval(() => void tick().catch(() => console.error('MPoTD scheduler failed.')),1000);
  void tick().catch(() => console.error('MPoTD scheduler startup failed.'));
  return () => clearInterval(timer);
}
