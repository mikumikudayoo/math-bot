export interface DiscordHit {
  id: string;
  channelId: string;
  content: string;
  author: { id: string };
  timestamp?:string;
}
export function discordPassages(content:string):string[]{
  const passages:string[]=[];
  for(let start=0;start<content.length&&passages.length<4;){
    let end=Math.min(start+260,content.length);
    if(end<content.length){const space=content.lastIndexOf(' ',end);if(space>start+80)end=space;}
    const passage=content.slice(start,end).trim();if(passage.length>=8)passages.push(passage);
    start=end;while(content[start]===' ')start++;
  }
  return passages;
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
  if(value.message!==undefined&&!Number.isInteger(value.message))return null;
  const hit=typeof value.message==='number'?results[value.message-1]:results.find(r=>r.id===value.messageId);
  if (!hit) return null;
  if(value.messageId!==undefined&&value.messageId!==hit.id)return null;
  if(value.passage!==undefined&&!Number.isInteger(value.passage))return null;
  const selected=typeof value.passage==='number'?discordPassages(hit.content)[value.passage-1]:value.support;
  if(typeof selected!=='string'||value.support!==undefined&&value.support!==selected)return null;

  if (!/^\d{17,20}$/.test(hit.id)) return null;
  if (!/^\d{17,20}$/.test(hit.channelId)) return null;

  const support = selected.trim();

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

  const timestamp=hit.timestamp&&Number.isFinite(Date.parse(hit.timestamp))?` at ${hit.timestamp}`:'';
  return `${author} ${verb} “${excerpt}” in <#${hit.channelId}>${timestamp}. [message](<${url}>)`;
}
