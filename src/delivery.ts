import { createHash } from 'node:crypto';
import type { Client, Message, MessageEditOptions } from 'discord.js';
import { service } from './ai-client.js';
import { DISCORD_PART_LENGTH, formatDiscord, needsTextAttachment, splitDiscordMessage } from './discord-format.js';
import { publicReply } from './public-reply.js';
import type { JobProgress } from './service/events.js';
import { rowProvenance } from './service/provenance.js';
import { assertPrivateOutputURLs, sanitizePrivateOutputURLs } from './service/output-url-policy.js';
import { TurnWebBoundary } from './service/turn-web-boundary.js';
import type { Job } from './service/types.js';
import { statusText } from './status.js';
import { studyDeliveryPayload } from './study-audience.js';

export type DeliveryJob = Job & { progress?: JobProgress; deliveryParts?: string[] };
const terminal = (job: Pick<Job,'state'>) => ['completed','failed','cancelled'].includes(job.state);
const noMentions = { parse: [] as [], repliedUser: false };
const blocked = "i can’t safely share this answer here.";
const preparing = 'preparing the next part…';

/** The model's answer has already passed the inference guards. Markdown conversion and
 * a message boundary must not create another link or join digits into a new raw ID. */
export function deliveryChunks(job: DeliveryJob, original: string) {
  const formatted = formatDiscord(publicReply(original,[job.id],true));
  const permitted = new TurnWebBoundary(original);
  const urlPattern = /https?:\/\/[^\s<>"`]+/gi;
  const originalURLs = new Set(original.match(urlPattern));
  const privateSource = rowProvenance(job).classification === 'private-discord';
  function validate(part: string) {
    let checked = part.replace(/\b\d{17,20}\b/g, digits => original.includes(digits) ? digits : '[id omitted]');
    if (privateSource) {
      checked = sanitizePrivateOutputURLs(checked,url => permitted.permitsOutbound(url));
      assertPrivateOutputURLs(checked,url => permitted.permitsOutbound(url));
    } else {
      // Preserve ordinary prose punctuation and Markdown around a pre-existing link.
      checked = checked.replace(urlPattern, raw =>
        originalURLs.has(raw) || permitted.permitsOutbound(raw.replace(/[.,;:!?\])]+$/,'')) ? raw : '[unverified link omitted]');
    }
    return checked;
  }
  try {
    // Validate the complete rendering and each individual Discord payload. If sanitizing
    // a chunk expands it past the limit, split it again and revalidate the final cut.
    return splitDiscordMessage(validate(formatted)).flatMap(part => {
      const checked = validate(part);
      if (checked.length <= DISCORD_PART_LENGTH) return [checked];
      return splitDiscordMessage(checked).map(last => {
        const final = validate(last);
        return final.length <= DISCORD_PART_LENGTH ? final : blocked;
      });
    });
  } catch { return [blocked]; }
}

export function studyContent(job: Pick<Job,'id'|'state'|'status'|'answer'>): string {
  return publicReply(terminal(job) ? job.answer : statusText(job.status,job.state), [job.id], terminal(job));
}

const toolProgress: Record<string, string> = {
  calculate:'checking the arithmetic.', calculator:'checking the arithmetic.',
  plot:'drawing the graph.', python:'checking this with python.', sandbox_python:'checking this with python.',
  search:'looking for a source.', fetch:'reading the source.',
  discord_search:'looking up the channel context.', discord_member:'checking the member details.',
  regex:'checking the pattern.', think_harder:'giving this one another look.',
};
export function progressContent(job: DeliveryJob): {content: string; checked: boolean} {
  const p = job.progress;
  if (!p || job.state === 'queued' || p.phase === 'started' && job.status !== 'thinking')
    return {content:studyContent(job), checked:false};
  if (p.stream && rowProvenance(job).classification === 'public' && !needsTextAttachment(p.stream)) {
    return {content:deliveryChunks(job,p.stream)[0]!, checked:true};
  }
  const last = p.recent.at(-1);
  let line = '';
  switch (p.phase) {
    case 'tool_started': line = toolProgress[p.label] ?? 'working through a tool call.'; break;
    case 'tool_completed': line = last?.data.ok === false ? 'that tool didn’t work. checking what’s left.' : 'got the tool result. checking it.'; break;
    case 'consultation_requested': line = 'checking whether i can ask for a second opinion.'; break;
    case 'consultation_approved': line = 'asking for a second opinion on this one.'; break;
    case 'consultation_denied': line = 'carrying on with what i have.'; break;
    case 'consultation_completed': line = last?.data.ok === false ? 'that second opinion didn’t come through.' : 'checking the second opinion.'; break;
    case 'image_inspection': line = 'checking the picture before i send it.'; break;
    case 'seven_agents': line = 'getting the others to look at this.'; break;
    case 'limit_assessment': line = 'checking what i’ve verified so far.'; break;
    case 'reasoning_summary': line = 'reviewing the reasoning so far.'; break;
    case 'started': line = 'ugh, okay. lemme look at this.'; break;
    default: line = p.seq % 2 ? 'thinking this through.' : 'give me a moment with this one.';
  }
  return {content:line, checked:false};
}

interface Snapshot { job: DeliveryJob; key: string; sent: string; until: number; busy: boolean; acknowledged: boolean }
type Publish = (job: DeliveryJob, current: () => boolean) => Promise<void>;

function discordCode(error: unknown) { return (error as {code?:number} | null)?.code; }
function retryDelay(error: unknown): number {
  const e = error as {status?:number; retryAfter?:number; rawError?:{retry_after?:number}; retry_after?:number; headers?:{get?:(key:string)=>string|null}} | null;
  const seconds = e?.rawError?.retry_after ?? e?.retry_after ?? Number(e?.headers?.get?.('retry-after') ?? e?.headers?.get?.('x-ratelimit-reset-after'));
  const delay = e?.retryAfter ?? seconds * 1000;
  return Number.isFinite(delay) && delay > 0 ? Math.ceil(delay) : 1500;
}

/** One writer per job. A later snapshot can invalidate an edit while authorization is pending.
 * Discord operations already in flight finish before the terminal writer runs. */
export class DeliveryManager {
  private readonly jobs = new Map<string,Snapshot>();
  private readonly buckets = new Map<string,number>();
  constructor(private readonly publish: Publish, private readonly now = Date.now, private readonly concurrency = 4) {}
  rateLimit(channel: string, delayMs: number) {
    if (Number.isFinite(delayMs) && delayMs > 0)
      this.buckets.set(channel, Math.max(this.buckets.get(channel) ?? 0, this.now() + delayMs));
  }
  async update(rows: DeliveryJob[]) {
    const present = new Set(rows.map(j => j.id));
    for (const [id,s] of this.jobs) if (!s.busy && !present.has(id)) this.jobs.delete(id);
    for (const [key,until] of this.buckets) if (until <= this.now()) this.buckets.delete(key);
    for (const job of rows) {
      const prev = this.jobs.get(job.id);
      if (prev?.acknowledged || prev && terminal(prev.job) && !terminal(job)) continue;
      if (!terminal(job) && job.progress && prev?.job.progress &&
          (job.progress.seq < prev.job.progress.seq || job.progress.seq === prev.job.progress.seq && job.progress.updated < prev.job.progress.updated)) continue;
      const shown = terminal(job) ? undefined : progressContent(job);
      const key = shown ? (shown.checked ? 'stream/' : 'status/') + shown.content : 'terminal/' + job.state;
      if (prev) { prev.key = key; prev.job = job; }
      else this.jobs.set(job.id,{job,key,sent:'',until:0,busy:false,acknowledged:false});
    }
    const states = [...this.jobs.values()];
    const free = this.concurrency - states.filter(s => s.busy).length;
    if (free < 1 || this.buckets.has('*')) return;
    const ready = states.filter(s => present.has(s.job.id) && !s.busy && !s.acknowledged && s.sent !== s.key &&
      s.until <= this.now() && !this.buckets.has(s.job.channel) && (terminal(s.job) || !this.buckets.has('edit/' + s.job.id)));
    ready.sort((a,b) => Number(terminal(b.job)) - Number(terminal(a.job)) || a.until - b.until);
    await Promise.all(ready.slice(0,free).map(s => this.deliver(s)));
  }
  private async deliver(s: Snapshot) {
    const job = s.job, key = s.key;
    s.busy = true;
    try {
      await this.publish(job, () => s.key === key);
      if (s.key === key) {
        s.sent = key; s.acknowledged = terminal(job);
      }
    } catch (error) {
      s.until = this.now() + retryDelay(error);
      const e = error as {status?:number; global?:boolean;rawError?:{global?:boolean}} | null;
      if (e?.status === 429) this.rateLimit(e.global || e.rawError?.global ? '*' : job.channel, retryDelay(error));
    } finally {
      if (!terminal(job)) this.rateLimit('edit/' + job.id,1500);
      s.busy = false;
    }
  }
  stop() {
    for (const s of this.jobs.values()) s.key = '';
    this.jobs.clear();
  }
}

type Service = typeof service;
const scrubPayload = (content: string): MessageEditOptions => ({content,allowedMentions:noMentions,files:[],attachments:[],embeds:[]});

function deliveryNonce(job: string,index: number,previous = '') {
  return createHash('sha256').update([job,index,previous].join('/')).digest('hex').slice(0,24);
}

export function queuedPayload(id: string) {
  return {content:'⏳ queued',nonce:deliveryNonce(id,0),enforceNonce:true,allowedMentions:noMentions};
}

/** Discord may have accepted the message before the service confirmed its binding.
 * Only remove a duplicate when the service names a different authoritative primary. */
export async function bindPrimary(request: Service,job: string,sent: Pick<Message,'id'|'delete'>) {
  const binding = await request<{ok:boolean;message?:string}>('/bind',{id:job,message:sent.id});
  if (binding?.ok === false) {
    if (!binding.message || !/^\d{17,20}$/.test(binding.message) || binding.message === sent.id)
      throw new Error('service could not bind the reply');
    try { await sent.delete(); } catch (error) { if (discordCode(error) !== 10008) throw error; }
    return binding.message;
  }
  return sent.id;
}

export async function recoverPrimary(client: Client,request: Service,job: DeliveryJob) {
  if (job.message || job.delivered) return;
  try {
    const channel = await client.channels.fetch(job.channel);
    if (!channel?.isSendable() || !('guildId' in channel) || channel.guildId !== job.guild) return;
    // Slash interaction IDs do not identify a channel message. A message-triggered
    // job retains its original reply reference, including after a bot restart.
    const sent = await channel.send({...queuedPayload(job.id),...(job.sourceMessageId ?
      {reply:{messageReference:job.sourceMessageId,failIfNotExists:true}} : {})});
    await bindPrimary(request,job.id,sent);
  } catch (error) {
    if (![10003,10008].includes(discordCode(error) ?? 0)) throw error;
    await request('/delivered',{id:job.id});
  }
}

export function discordPublisher(client: Client, request: Service = service): Publish {
  return async (job, current) => {
    const ack = () => request('/delivered',{id:job.id});
    let channel;
    try { channel = await client.channels.fetch(job.channel); }
    catch (error) { if (discordCode(error) === 10003) { await ack(); return; } throw error; }
    if (!channel?.isTextBased() || !channel.isSendable() || !('guildId' in channel) || channel.guildId !== job.guild) {
      throw new Error('destination is currently unavailable');
    }
    const destination = channel;
    const parts = [...(job.deliveryParts ?? [])];
    async function scrub(id: string, text: string) {
      try { await destination.messages.edit(id,scrubPayload(text)); }
      catch (error) { if (discordCode(error) !== 10008) throw error; }
    }
    async function retract(text: string) {
      await scrub(job.message,text);
      for (const id of parts) await scrub(id,'this part was withdrawn.');
    }
    async function allowed(content: string) {
      try {
        const draft = !terminal(job) && job.progress;
        const result = await request<{allowed:boolean}>('/publication',{id:job.id,content,
          ...(draft ? {streamSeq:draft.seq,streamUpdated:draft.updated} : {})});
        return result?.allowed === true;
      } catch (error) {
        // A previous edit may already be visible when the live gate goes offline.
        if (current()) await retract('checking what i can share.');
        throw error;
      }
    }
    let primary: Message;
    try { primary = await destination.messages.fetch(job.message); }
    catch (error) {
      if (discordCode(error) !== 10008) throw error;
      for (const id of parts) await scrub(id,'the original reply was removed.');
      await ack(); return;
    }
    if (!terminal(job)) {
      const {content,checked} = progressContent(job);
      if (checked && !await allowed(content)) {
        if (current()) await primary.edit(scrubPayload('checking what i can share.'));
        return;
      }
      if (current()) await primary.edit(scrubPayload(content));
      return;
    }

    const original = studyContent(job);
    const asFile = needsTextAttachment(original);
    const chunks = asFile ? ['the complete answer is in the text attachment so the notation stays intact.'] : deliveryChunks(job,job.answer);
    for (let i = 0; i < chunks.length; i++) {
      if (!current()) return;
      const content = chunks[i]!;
      let target = primary;
      if (i > 0) {
        const previous = parts[i-1];
        let existing: Message | undefined;
        if (previous) {
          try { existing = await destination.messages.fetch(previous); }
          catch (error) { if (discordCode(error) !== 10008) throw error; }
        }
        if (!existing) {
          // A lost acknowledgement can leave only a generic placeholder. Persist its ID
          // before sending any model text, permission-sensitive metadata, or attachment.
          const nonce = deliveryNonce(job.id,i,previous);
          existing = await destination.send({content:preparing,nonce,enforceNonce:true,allowedMentions:noMentions});
          await request('/delivery-part',{id:job.id,index:i,message:existing.id,...(previous ? {previous} : {})});
          parts[i-1] = existing.id;
        }
        target = existing;
      }
      const payload = await studyDeliveryPayload(client,i === chunks.length-1 ? job : {...job,artifact:''},asFile ? original : content);
      if (payload.denied || !await allowed(content)) {
        await retract(payload.denied ? payload.content : blocked);
        await ack(); return;
      }
      if (!current()) return;
      // Clearing existing attachments also makes a retried successful edit idempotent.
      await target.edit({content:asFile ? content : payload.content,files:payload.files,attachments:[],embeds:[],allowedMentions:noMentions});
    }
    for (const id of parts.slice(chunks.length-1)) await scrub(id,'this part was withdrawn.');
    await ack();
  };
}

export function startDelivery(client: Client) {
  const manager = new DeliveryManager(discordPublisher(client));
  let closed = false, fetching = false, recovering = false;
  const observe = (limit: {global:boolean;majorParameter:string;retryAfter:number}) =>
    manager.rateLimit(limit.global ? '*' : limit.majorParameter,limit.retryAfter);
  client.rest.on('rateLimited',observe);
  async function poll() {
    if (closed || fetching) return;
    fetching = true;
    try {
      const rows = await service<DeliveryJob[]>('/pending');
      if (!closed) void manager.update(rows).catch(() => {});
    } catch { /* The durable pending list is replayed when the service reconnects. */ }
    finally { fetching = false; }
  }
  const timer = setInterval(() => void poll(),750);
  async function recover() {
    if (closed || recovering) return;
    recovering = true;
    try {
      const rows = await service<DeliveryJob[]>('/unbound');
      for (const row of rows) {
        if (closed) return;
        try { await recoverPrimary(client,service,row); } catch { /* retry the next aged unbound scan */ }
      }
    } catch { /* A service restart leaves the authoritative rows intact. */ }
    finally { recovering = false; }
  }
  const recovery = setInterval(() => void recover(),15_000);
  void poll();
  return () => { closed = true; clearInterval(timer); clearInterval(recovery); client.rest.off('rateLimited',observe); manager.stop(); };
}
