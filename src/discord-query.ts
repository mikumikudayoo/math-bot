import {CREATOR_ID} from './discord-context.js';
export function discordQuery(prompt:string,user:string,now=Date.now()):Record<string,unknown>{
  const author=prompt.match(/\bwhat did (.+?) (?:say|mention|write|post)\b/i)?.[1]?.trim()
    ??prompt.match(/\bmessage where (.+?) (?:mentioned|said|wrote|posted)\b/i)?.[1]?.trim();
  const subject=prompt.match(/\babout\s+(?:the\s+)?(.+)/i)?.[1]
    ??prompt.match(/\b(?:mentioned|mention)\s+(?:the\s+)?(.+)/i)?.[1]
    ??prompt.replace(/^.*?\b(?:server|messages|discord)\b(?:\s+for\s+messages)?\s*(?:for|about)?\s*/i,'');
  const topic=subject.split(/[?!.\n]|\b(?:yesterday|today|earlier|last night|this week|my user id)\b/i)[0]!.trim();
  const words=(topic.match(/[\p{L}\p{N}_-]+/gu)??[]).filter(w=>!['the','a','an','for','messages','message','find','search','server','discord'].includes(w.toLowerCase()));
  const args:Record<string,unknown>={query:words.slice(0,8).join(' ').slice(0,200),limit:5};
  if(author){
    if(/^(?:i|me)$/i.test(author))args.authorId=user;
    else if(/^(?:emu|fyuc)$/i.test(author))args.authorId=CREATOR_ID;
    else if(/^<@!?\d{17,20}>$/.test(author))args.authorId=author.replace(/\D/g,'');
    else if(!/^(?:we|anyone|someone)$/i.test(author))args.authorName=author.slice(0,80);
  }
  // Relative days use the server community's Asia/Manila day boundary.
  const offset=8*3600000;const day=Math.floor((now+offset)/86400000)*86400000-offset;
  if(/\byesterday\b/i.test(prompt)){args.after=new Date(day-86400000).toISOString();args.before=new Date(day).toISOString();}
  else if(/\btoday\b/i.test(prompt)){args.after=new Date(day).toISOString();args.before=new Date(day+86400000).toISOString();}
  return args;
}
