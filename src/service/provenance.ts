export interface DiscordEvidence {channelId:string;messageId:string;digest:string;audience:string}
export const MAX_DISCORD_EVIDENCE=64;
export function validEvidence(value:unknown):value is DiscordEvidence{
  if(!value||typeof value!=='object')return false;
  const data=value as Record<string,unknown>;
  return id(data.channelId)&&id(data.messageId)&&typeof data.digest==='string'&&/^[a-f0-9]{64}$/.test(data.digest)&&
    typeof data.audience==='string'&&(data.audience==='public'||/^[a-f0-9]{64}$/.test(data.audience));
}
export interface Provenance {
  version:1;
  classification:'public'|'private-discord';
  discordSources:{guildId:string;channelId:string}[];
  discordEvidence?:DiscordEvidence[];
  audienceUnknown:boolean;
}
export const publicProvenance=():Provenance=>({version:1,classification:'public',discordSources:[],audienceUnknown:false});
const unknownAudience=():Provenance=>({version:1,classification:'private-discord',discordSources:[],audienceUnknown:true});
const id=(value:unknown):value is string=>typeof value==='string'&&/^\d{17,20}$/.test(value);
export function readProvenance(value:unknown):Provenance{
  try{
    const data=typeof value==='string'?JSON.parse(value):value;
    if(!data||data.classification!=='private-discord')return publicProvenance();
    const sources:unknown[]=Array.isArray(data.discordSources)?data.discordSources:[];
    const valid=sources.filter((s:unknown):s is {guildId:string;channelId:string}=>Boolean(s&&typeof s==='object'&&id((s as any).guildId)&&id((s as any).channelId)));
    const evidence:unknown[]=Array.isArray(data.discordEvidence)?data.discordEvidence:[];
    const checked=evidence.filter(validEvidence).filter(e=>valid.some(s=>s.channelId===e.channelId)).slice(0,MAX_DISCORD_EVIDENCE);
    return {version:1,classification:'private-discord',discordSources:valid,...(checked.length?{discordEvidence:checked}:{}),
      audienceUnknown:data.audienceUnknown===true||valid.length!==sources.length||!valid.length||checked.length!==evidence.length||
        (data.discordEvidence!==undefined&&!Array.isArray(data.discordEvidence))};
  }catch{return unknownAudience();}
}
export function mergeProvenance(...values:Provenance[]):Provenance{
  const privateValues=values.filter(v=>v.classification==='private-discord');
  if(!privateValues.length)return publicProvenance();
  const sources=new Map<string,{guildId:string;channelId:string}>();
  const evidence=new Map<string,DiscordEvidence>();let conflict=false;
  for(const value of privateValues){
    for(const source of value.discordSources)sources.set(`${source.guildId}:${source.channelId}`,source);
    for(const item of value.discordEvidence??[]){
      const key=item.channelId+':'+item.messageId,prior=evidence.get(key);
      if(prior&&(prior.digest!==item.digest||prior.audience!==item.audience))conflict=true;
      evidence.set(key,item);
    }
  }
  return {version:1,classification:'private-discord',discordSources:[...sources.values()],
    ...(evidence.size?{discordEvidence:[...evidence.values()].slice(0,MAX_DISCORD_EVIDENCE)}:{}),
    audienceUnknown:conflict||evidence.size>MAX_DISCORD_EVIDENCE||privateValues.some(v=>v.audienceUnknown)};
}
export function rowProvenance(row:{provenance?:string;retrievalContext?:string;context?:string;guild:string}):Provenance{
  const explicit=readProvenance(row.provenance);
  if(explicit.classification==='private-discord')return explicit;
  if(row.context && row.context!=='{}' && row.context!=='[]')return unknownAudience();
  try{
    const legacy=JSON.parse(row.retrievalContext||'{}');
    if(legacy?.kind==='discord'){
      const refs=Array.isArray(legacy.refs)?legacy.refs:[];
      return readProvenance({classification:'private-discord',discordSources:refs.map((r:any)=>({guildId:row.guild,channelId:r.channelId}))});
    }
  }catch{return unknownAudience();}
  return explicit;
}
