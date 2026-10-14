export interface Provenance {
  version:1;
  classification:'public'|'private-discord';
  discordSources:{guildId:string;channelId:string}[];
  audienceUnknown:boolean;
}
export const publicProvenance=():Provenance=>({version:1,classification:'public',discordSources:[],audienceUnknown:false});
const id=(value:unknown):value is string=>typeof value==='string'&&/^\d{17,20}$/.test(value);
export function readProvenance(value:unknown):Provenance{
  try{
    const data=typeof value==='string'?JSON.parse(value):value;
    if(!data||data.classification!=='private-discord')return publicProvenance();
    const sources=Array.isArray(data.discordSources)?data.discordSources:[];
    const valid=sources.filter((s:unknown):s is {guildId:string;channelId:string}=>Boolean(s&&typeof s==='object'&&id((s as any).guildId)&&id((s as any).channelId)));
    return {version:1,classification:'private-discord',discordSources:valid,audienceUnknown:data.audienceUnknown===true||valid.length!==sources.length||!valid.length};
  }catch{return publicProvenance();}
}
export function mergeProvenance(...values:Provenance[]):Provenance{
  const privateValues=values.filter(v=>v.classification==='private-discord');
  if(!privateValues.length)return publicProvenance();
  const sources=new Map<string,{guildId:string;channelId:string}>();
  for(const value of privateValues)for(const source of value.discordSources)sources.set(`${source.guildId}:${source.channelId}`,source);
  return {version:1,classification:'private-discord',discordSources:[...sources.values()],audienceUnknown:privateValues.some(v=>v.audienceUnknown)};
}
export function rowProvenance(row:{provenance?:string;retrievalContext?:string;guild:string}):Provenance{
  const explicit=readProvenance(row.provenance);
  if(explicit.classification==='private-discord')return explicit;
  try{
    const legacy=JSON.parse(row.retrievalContext??'{}');
    if(legacy?.kind==='discord'){
      const refs=Array.isArray(legacy.refs)?legacy.refs:[];
      return readProvenance({classification:'private-discord',discordSources:refs.map((r:any)=>({guildId:row.guild,channelId:r.channelId}))});
    }
  }catch{}
  return explicit;
}
