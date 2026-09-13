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
    content: (roleId ? `<@&${roleId}> ` : '') + '**New Question of the Day!**\n*Submit your answer below!*',
    files: q.crop.images.map((image,i)=>new AttachmentBuilder(image.path,{name:`question-${String(i+1).padStart(2,'0')}.png`})),
    allowedMentions: {parse:[],roles:roleId?[roleId]:[]},
  };
  if (q.kind === 'mcq') {
    if (q.choices.length < 2 || q.choices.length > 10) throw new Error('Invalid source choice count.');
    payload.poll={question:{text:`QOTD ${day}`},answers:q.choices.map(c=>({text:c.label})),duration: 14,allowMultiselect:false};
  }
  return payload;
}
export async function postDaily(
  store: QotdStore,
  guild: string,
  channel: string,
  send: (payload: MessageCreateOptions) => Promise<{
    id: string;
    startThread?: (options: {
      name: string;
      autoArchiveDuration?: 60 | 1440 | 4320 | 10080;
    }) => Promise<unknown>;
  }>,
  day = new Date().toISOString().slice(0,10),
  roleId?: string,
) {
  const selected = store.claim(guild,channel,day);

  if (!selected) {
    return 'already reserved today, or no approved unused questions remain.';
  }

  try {
    const q = selected.question;

    // First message: question text + original source crop(s), no poll.
    const questionPayload = questionMessage(q,day,roleId);
    delete questionPayload.poll;

    const message = await send(questionPayload);

    store.finish(selected.claim.id,message.id);

    // Second message: native Discord poll for MCQs only.
    if (q.kind === 'mcq') {
      if (q.choices.length < 2 || q.choices.length > 10) {
        throw new Error('Invalid source choice count.');
      }

      await send({
        poll: {
          question: { text: `QOTD ${day}` },
          answers: q.choices.map(c => ({
            text: c.label,
          })),
          duration: 14,
          allowMultiselect: false,
        },
        allowedMentions: { parse: [] },
      });
    }

    // Discussion thread hangs off the original question message.
    if (message.startThread) {
      try {
        const prettyDay = new Date(`${day}T00:00:00Z`).toLocaleDateString(
          'en-US',
          {
            month: '2-digit',
            day: '2-digit',
            year: 'numeric',
            timeZone: 'UTC',
          },
        );

        await message.startThread({
          name: `QOTD Discussion ${prettyDay}`,
          autoArchiveDuration: 1440,
        });
      } catch (error) {
        console.error(
          'QOTD discussion thread creation failed:',
          error instanceof Error ? error.message : error,
        );
      }
    }

    return `posted 💙 question id: ${q.id}`;
  } catch (error) {
    store.finish(selected.claim.id,null);

    throw new Error(
      `QOTD send uncertain; question ${selected.question.id} remains consumed. Check channel/history before an explicit moderator reset.`,
      { cause: error },
    );
  }
}

export function startQotd(client: Client, allowedGuild?: string) {
  const REVEAL_HOUR_UTC = 14; // 22:00 UTC+8

  let busy = false;

  async function tick() {
    if (busy) return;

    busy = true;

    try {
      const store = qotdStore();
      const now = new Date();
      const utcHour = now.getUTCHours();
      const today = now.toISOString().slice(0,10);

      const schedules = store.db
        .prepare('SELECT * FROM qotd_schedule')
        .all() as Array<{
          guild: string;
          channel: string;
          hour: number;
          role: string | null;
        }>;

      for (const s of schedules) {
        if (allowedGuild && s.guild !== allowedGuild) continue;

        const channel = await client.channels.fetch(String(s.channel));

        if (
          !channel ||
          !('guildId' in channel) ||
          channel.guildId !== s.guild ||
          !channel.isSendable()
        ) {
          continue;
        }

        /*
         * --------------------------------------------------
         * 08:00 UTC+8 = 00:00 UTC
         *
         * Post today's QOTD after the configured UTC hour,
         * but never create a brand-new question after the
         * 22:00 reveal time.
         * --------------------------------------------------
         */

        if (
          utcHour >= Number(s.hour) &&
          utcHour < REVEAL_HOUR_UTC
        ) {
          const alreadyPostedToday = store.db.prepare(`
            SELECT 1
            FROM qotd_history
            WHERE guild=? AND day=?
            LIMIT 1
          `).get(String(s.guild), today);

          if (!alreadyPostedToday) {
            try {
              await postDaily(
                store,
                String(s.guild),
                String(s.channel),
                payload => channel.send(payload),
                today,
                s.role ? String(s.role) : qotdSettings().role,
              );
            } catch (error) {
              console.error(
                'QOTD automatic post:',
                error instanceof Error ? error.message : error,
              );
            }
          }
        }

        /*
         * --------------------------------------------------
         * 22:00 UTC+8 = 14:00 UTC
         *
         * Reveal today's posted QOTD.
         * --------------------------------------------------
         */

        if (utcHour >= REVEAL_HOUR_UTC) {
          const current = store.db.prepare(`
            SELECT
              h.id,
              r.state AS revealState
            FROM qotd_history h
            LEFT JOIN qotd_reveals r
              ON r.history = h.id
            WHERE h.guild = ?
              AND h.day = ?
              AND h.state = 'posted'
            ORDER BY h.id DESC
            LIMIT 1
          `).get(
            String(s.guild),
            today,
          ) as {
            id: number;
            revealState: string | null;
          } | undefined;

          if (!current) {
            continue;
          }

          if (current.revealState === null) {
            try {
              await revealAnswer(
                store,
                String(s.guild),
                current.id,
                'scheduler',
                payload => channel.send(payload),
                Date.now(),
                true,
              );
            } catch (error) {
              console.error(
                'QOTD automatic reveal:',
                error instanceof Error ? error.message : error,
              );
            }
          } else if (current.revealState !== 'posted') {
            console.error(
              `QOTD automatic reveal blocked: history ${current.id} has reveal state ${current.revealState}. Inspect the channel before continuing.`,
            );
          }
        }
      }
    } catch (error) {
      console.error(
        'QOTD scheduler:',
        error instanceof Error ? error.message : error,
      );
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(
    () => void tick(),
    60_000,
  );

  void tick();

  return () => clearInterval(timer);
}

export async function revealAnswer(store:QotdStore,guild:string,id:number,actor:string,send:(payload:MessageCreateOptions)=>Promise<{id:string}>,now=Date.now(),allowEarly=false) {
  const q=store.claimReveal(guild,id,actor,now,allowEarly);
  try {
    const content=`The official answer to the QOTD is:\n\`\`\`txt\n${q.officialAnswer}\n\`\`\`\n*Stay tuned for the next question!*`;
    const payload:MessageCreateOptions={content:content.length<=1900?content:'The official answer is attached.',allowedMentions:{parse:[]}};
    if(content.length>1900)payload.files=[new AttachmentBuilder(Buffer.from(q.officialAnswer),{name:'official-answer.txt'})];
    const message=await send(payload);store.finishReveal(id,message.id);return 'official answer revealed.';
  }catch(error){store.finishReveal(id,null);throw new Error('Answer reveal delivery is uncertain; inspect the channel. It will not retry automatically.',{cause:error});}
}
