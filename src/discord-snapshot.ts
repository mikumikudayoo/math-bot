import { PermissionFlagsBits, type Guild, type GuildMember, type Message, type MessageReference } from 'discord.js';
import { CREATOR_ID, MAX_CONTEXT_ROLES, discordIntent,serverScope,visibleAtAnchor,type HostFacts } from './discord-context.js';
import { canRead } from './discord-tools.js';
import { historyVisibleToViewers } from './discord-audience.js';
import { CONTEXT_LIMITS, contextSnapshot, type ContextMessage, type ContextSnapshot } from './service/context-snapshot.js';
import { imageAttachments } from './service/vision.js';
import { audienceDigest,messageDigest } from './discord-evidence.js';

export interface SnapshotAnchor {
  id: string;
  guildId: string;
  channelId: string;
  userId: string;
  prompt: string;
  reference?: MessageReference | null;
  hasAttachments?:boolean;
}

function moderatorFacts(member: GuildMember): HostFacts {
  return {
    isModerator: member.permissions.has(PermissionFlagsBits.ManageGuild) || member.permissions.has(PermissionFlagsBits.ModerateMembers),
    roles: [...member.roles.cache.values()].filter(role => role.id !== member.guild.id)
      .sort((a, b) => b.position - a.position).slice(0, MAX_CONTEXT_ROLES).map(role => role.name),
  };
}

function localReply(reference: MessageReference | null | undefined, anchor: SnapshotAnchor) {
  if (!reference || reference.type === 1 || reference.channelId !== anchor.channelId ||
      (reference.guildId && reference.guildId !== anchor.guildId)) return undefined;
  return reference.messageId;
}

function captureMessage(message: Message, anchor: SnapshotAnchor, botId: string): ContextMessage | undefined {
  if (message.guildId !== anchor.guildId || message.channelId !== anchor.channelId ||
      !visibleAtAnchor(message,anchor.id) ||
      message.author.id === botId || message.system || message.webhookId) return undefined;
  // Bot answers can depend on sources with separate publication permissions.
  // The service already retrieves its own answers through authorized job history.
  const images = [];
  for (const attachment of message.attachments.values()) {
    if (images.length === CONTEXT_LIMITS.imagesPerMessage) break;
    try {
      images.push(...imageAttachments([{url:attachment.url,mime:attachment.contentType,size:attachment.size}]));
    } catch { /* Non-images and oversize files do not invalidate the rest of a reply. */ }
  }
  if (!message.content && !images.length) return undefined;
  const replyTo = localReply(message.reference, anchor);
  return {
    id: message.id, author: { id: message.author.id, bot: message.author.bot,
      name: message.author.id === CREATOR_ID ? 'emu' : (message.member?.displayName ?? message.author.displayName),
      relation: message.author.id === anchor.userId ? 'requester' : message.author.id === CREATOR_ID ? 'creator' : 'other' },
    content: message.content, timestamp: message.createdAt.toISOString(), images,digest:messageDigest(message),
    ...(replyTo ? {replyTo} : {}),
  };
}

const contextWords = /\b(?:this|that|these|those|they|above|earlier|here|chat|discussion|last message|just said)\b/i;
const stopWords = new Set('what which where when would could should does have with about from help explain please some tell just give want need'.split(' '));
function relevant(prompt: string, message: ContextMessage) {
  if (contextWords.test(prompt)) return true;
  const words = prompt.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const source = new Set(message.content.toLowerCase().match(/[\p{L}\p{N}]+/gu));
  return words.some(word => word.length > 2 && !stopWords.has(word) && source.has(word));
}

// Select the source before inspecting any conversation text. Standalone public
// research needs only the user's question; attachments and replies keep their context.
function standaloneWeb(anchor:SnapshotAnchor):boolean {
  if(anchor.reference||anchor.hasAttachments||serverScope(anchor.prompt)||discordIntent(anchor.prompt))return false;
  if(/<[@#]|\b(?:earlier|above|previous|last message|replied|this (?:message|thread|channel|discussion)|our (?:chat|discussion)|what (?:i|they|we) said)\b/i.test(anchor.prompt))return false;
  if(/(?:discord(?:app)?\.com|discord\.gg|discordapp\.net)(?:[/:\s]|$)/i.test(anchor.prompt))return false;
  return /https:\/\/[^\s<>"`]+/i.test(anchor.prompt)||/\b(?:search (?:the )?web for|search online for|look up online|browse (?:the )?web for)\s+\S/i.test(anchor.prompt);
}

/** Context is fetched only inside the invoking channel, after checking both members'
 * current permissions (including private thread membership), then checked again before return.
 */
export async function captureDiscordState(guild: Guild | null, anchor: SnapshotAnchor, includeContext: boolean):
  Promise<{host: HostFacts; context?: ContextSnapshot}> {
  if (!guild || guild.id !== anchor.guildId || !/^\d{17,20}$/.test(anchor.id)) return {host:{}};
  const access = async () => {
    await guild.roles.fetch();
    const [channel, requester, bot] = await Promise.all([
      guild.channels.fetch(anchor.channelId, {force:true}),
      guild.members.fetch({user:anchor.userId,force:true,cache:false}), guild.members.fetchMe({force:true,cache:false}),
    ]);
    if (!channel || channel.guildId !== anchor.guildId || channel.id !== anchor.channelId ||
        requester.id !== anchor.userId || !('messages' in channel) ||
        !await canRead(channel,requester)||!await canRead(channel,bot)) return undefined;
    return {channel, requester, bot};
  };
  try {
    const initial = await access();
    if (!initial) return {host:{}};
    if (!includeContext || standaloneWeb(anchor)) return {host:moderatorFacts(initial.requester)};
    const {channel, bot} = initial;
    if(!await historyVisibleToViewers(channel))return {host:moderatorFacts(initial.requester)};
    const audience=await audienceDigest(channel);
    if(!audience)return {host:moderatorFacts(initial.requester)};
    let next = localReply(anchor.reference, anchor);
    let reply: ContextMessage | undefined;
    const chain: ContextMessage[] = [];
    const seen = new Set<string>([anchor.id]);
    while (next && /^\d{17,20}$/.test(next) && BigInt(next) < BigInt(anchor.id) && !seen.has(next) && seen.size <= CONTEXT_LIMITS.chain + 1) {
      seen.add(next);
      let source: Message;
      try { source = await channel.messages.fetch({message:next,force:true,cache:false}); } catch { break; }
      if (source.id !== next) break;
      const entry = captureMessage(source, anchor, bot.id);
      if (!entry) break;
      if (!reply) reply = entry;
      else chain.unshift(entry);
      next = entry.replyTo;
    }
    const batch = await channel.messages.fetch({before:anchor.id,limit:CONTEXT_LIMITS.recent,cache:false});
    const recent: ContextMessage[] = [];
    for (const source of batch.values()) {
      if (seen.has(source.id)) continue;
      const entry = captureMessage(source, anchor, bot.id);
      if (entry && relevant(anchor.prompt, entry)) recent.push(entry);
    }
    recent.sort((a,b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
    const checked = await access();
    if (!checked||!await historyVisibleToViewers(checked.channel)||
      audience!==await audienceDigest(checked.channel)) return {host:{}};
    const host = moderatorFacts(checked.requester);
    if (!reply && !chain.length && !recent.length) return {host};
    const context = contextSnapshot({version:1,anchorMessageId:anchor.id,channelId:anchor.channelId,capturedAt:Date.now(),audience,
      ...(reply ? {reply} : {}),chain,recent}, {channel:anchor.channelId,sourceMessageId:anchor.id});
    return context ? {host,context} : {host};
  } catch { return {host:{}}; }
}
