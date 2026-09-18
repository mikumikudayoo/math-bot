import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, type InteractionEditReplyOptions, type InteractionReplyOptions } from 'discord.js';
import { validateCrop } from '../qotd/crops.js';
import { renderSolutionSnapshot } from '../qotd/solutions.js';
import { sourceText } from '../qotd/posting.js';
import type { Attempt, ProblemStore } from './store.js';
export function questionPayload(a: Attempt): InteractionEditReplyOptions {
  validateCrop(a.snapshot.questionCrop);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`problem:answer:${a.id}`)
    .setLabel(a.mode === 'rated' ? 'Submit final answer' : 'Try an answer').setStyle(ButtonStyle.Primary));
  if (a.mode === 'practice') row.addComponents(new ButtonBuilder().setCustomId(`problem:solution:${a.id}`).setLabel('Official solution').setStyle(ButtonStyle.Secondary));
  return { content: a.mode === 'rated' ? '**Rated practice**\nOne final answer. Ten minutes from confirmed delivery. Use /problem resume if this message disappears.\nYour experimental rating measures performance in this bank, not intelligence.'
    : '**Unrated practice**\nUntimed, unlimited tries. No daily points or rating changes. take your time :3',
    files: a.snapshot.questionCrop.images.map((im, i) => new AttachmentBuilder(im.path, { name: `problem-${i + 1}.png` })),
    components: [row], allowedMentions: { parse: [] } };
}
export async function resultPayload(store: ProblemStore, a: Attempt): Promise<InteractionEditReplyOptions> {
  let snapshot = a.snapshot;
  try { snapshot = await renderSolutionSnapshot(store.source, a.question, snapshot); }
  catch { console.error(`Practice attempt ${a.id}: official solution crop unavailable; using preserved official text.`); }
  const files: AttachmentBuilder[] = [];
  if (snapshot.solutionCrop) {
    try { validateCrop(snapshot.solutionCrop); files.push(...snapshot.solutionCrop.images.map((im, i) => new AttachmentBuilder(im.path, { name: `solution-${i + 1}.png` }))); }
    catch { console.error(`Practice attempt ${a.id}: cached solution crop invalid; using official text.`); }
  }
  const correction = store.db.prepare('SELECT result FROM problem_corrections WHERE attempt=? ORDER BY rowid DESC LIMIT 1').get(a.id);
  const correct = correction ? correction.result : a.correct;
  let content = `**${a.mode === 'practice' ? 'Practice' : 'Rated practice'} result**\n` +
    (a.state === 'expired' ? 'Time expired. Abandoned; no rating change.' : a.state === 'cancelled' ? 'Attempt cancelled; no rating change. If delivery was interrupted, this problem is conservatively on cooldown because it may have been visible. Use /problem rated for another attempt.' : correct === null ? 'No scored answer.' : correct ? 'Correct :3' : 'Incorrect.') +
    `\n\nAnswer: ${snapshot.expectedAnswer}\n\n${sourceText(snapshot.source)}`;
  if (a.mode === 'rated') {
    const p = store.player(a.guild, a.user);
    const e = store.effectiveEvent(a.id);
    content += `\n\n${e?.revised ? 'Rating history was replayed after a moderator correction. ' : ''}Rating change: ${e ? e.delta.toFixed(2) : '0.00'}\nCurrent experimental rating: ${p.rating.toFixed(2)}`;
  } else content += '\n\nNo points or rating changes.';
  content += '\n\nthere you go. the source gets the last word :3';
  if (!files.length && snapshot.solution) files.push(new AttachmentBuilder(Buffer.from(snapshot.solution), { name: 'official-solution.txt' }));
  if (content.length > 1950) { files.push(new AttachmentBuilder(Buffer.from(content), { name: 'answer-and-source.txt' })); content = 'Official answer, source citation and result attached.'; }
  return { content, files, components: [], allowedMentions: { parse: [] } };
}
/** Send failure keeps the same pending problem. Database retries reuse the successful acknowledgement time. */
export async function deliverAttempt(store: ProblemStore, a: Attempt, send: (payload: InteractionEditReplyOptions) => Promise<{ id: string }>) {
  if (a.mode === 'practice' || a.state === 'active') { await send(questionPayload(a)); return a; }
  const payload = questionPayload(a); // Validate assets before leasing a send.
  const pending = store.beginDelivery(a.id, a.guild, a.user);
  let message: { id: string };
  try { message = await send(payload); }
  catch (error) {
    const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
    // A confirmed API rejection did not publish the problem. Network/5xx outcomes
    // may have done so; leave the lease for explicit conservative resume recovery.
    if (status >= 400 && status < 500) store.deliveryFailed(a.id, pending.lease!);
    throw error;
  }
  const acknowledged = store.clock();
  let failure: unknown;
  for (let retry = 0; retry < 3; retry++) {
    try { return store.delivered(a.id, pending.lease!, message.id, acknowledged); }
    catch (error) { failure = error; }
  }
  console.error(`Practice attempt ${a.id}: delivered, but confirmation needs recovery through /problem resume after the delivery lease. Rating was not changed.`);
  throw failure;
}

/** Preserve every page when Discord's ten-file limit requires a second private reply. */
export async function sendResult(store: ProblemStore, a: Attempt,
  send: (payload: InteractionEditReplyOptions) => Promise<unknown>,
  follow: (payload: Pick<InteractionReplyOptions, 'content' | 'files' | 'allowedMentions'>) => Promise<unknown>) {
  const payload = await resultPayload(store, a), files = payload.files ?? [];
  await send({ ...payload, files: files.slice(0, 10) });
  for (let offset = 10; offset < files.length; offset += 10) {
    await follow({ content: 'Additional official source material.', files: files.slice(offset, offset + 10), allowedMentions: { parse: [] } });
  }
}
