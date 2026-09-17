export interface DiscordHit {
  id: string;
  channelId: string;
  content: string;
  author: { id: string };
}

export function groundedDiscordAnswer(
  selection: unknown,
  results: DiscordHit[],
  guildId: string,
  requesterId: string,
  creatorId: string
): string | null {
  if (!selection || typeof selection !== 'object') return null;

  const value = selection as Record<string, unknown>;
  if (typeof value.messageId !== 'string') return null;
  if (typeof value.support !== 'string') return null;

  const hit = results.find(r => r.id === value.messageId);
  if (!hit) return null;

  if (!/^\d{17,20}$/.test(hit.id)) return null;
  if (!/^\d{17,20}$/.test(hit.channelId)) return null;

  const support = value.support.trim();

  if (support.length < 8 || support.length > 280) return null;
  if (!hit.content.includes(support)) return null;

  const author =
    hit.author.id === requesterId ? 'you' :
    hit.author.id === creatorId ? 'emu' :
    'they';

  const verb = author === 'you' ? 'said' : 'said';

  // Don't let quoted Discord text create mentions or inject formatting.
  const excerpt = support
    .replace(/\s+/g, ' ')
    .replace(/@/g, '@\u200b')
    .replace(/[<>]/g, '');

  const url =
    `https://discord.com/channels/${guildId}/${hit.channelId}/${hit.id}`;

  return `${author} ${verb} “${excerpt}” in <#${hit.channelId}>. [message](<${url}>)`;
}
