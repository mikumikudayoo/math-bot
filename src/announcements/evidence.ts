import type {ScheduleEvent} from './model.js';
import type {CorrectionPatch} from './corrections.js';

export const publicFactFields=['competitionId','roundId','programId','preparesFor','yearLevel','type','slot','start','end','deadline','timezone','url','detailLabel','dateHint','status','timezoneAssumed','availability','temporal','logistics'] as const;
export type PublicFactField=typeof publicFactFields[number];
export interface FieldEvidence {field:PublicFactField;evidenceIds:string[]}
/** Internal linkage. UI assigns source ordinals; these keys never become display text. */
export interface EvidenceLink {field:PublicFactField;source:string;id:string}
export interface RetainedEvidence {id:string;text:string;locations?:string[]}

/** Manual edits replace complete fields; only unchanged fields inherit organizer proof. */
export function attributeStaffEdit(event:ScheduleEvent,baseline:EvidenceLink[],source:string,changedFields:readonly string[]):EvidenceLink[]{
  return publicFactFields.filter(field=>Object.hasOwn(event,field)).flatMap(field=>changedFields.includes(field)?[{field,source,id:'body'}]:baseline.filter(link=>link.field===field));
}

export function validateFieldEvidence(entries:FieldEvidence[]):void {
  if(!Array.isArray(entries)||entries.length>publicFactFields.length)throw new Error('Invalid field evidence attribution.');
  const seen=new Set<string>();
  for(const entry of entries){
    if(!entry||typeof entry!=='object'||Object.keys(entry).some(k=>!['field','evidenceIds'].includes(k))||!publicFactFields.includes(entry.field)||seen.has(entry.field)||!Array.isArray(entry.evidenceIds)||!entry.evidenceIds.length||entry.evidenceIds.length>100||new Set(entry.evidenceIds).size!==entry.evidenceIds.length||entry.evidenceIds.some(id=>typeof id!=='string'||!id.trim()||id.length>200))throw new Error('Invalid field evidence attribution.');
    seen.add(entry.field);
  }
}

export function attributeFields(event:ScheduleEvent,source:string,evidenceIds:string[],explicit?:FieldEvidence[],baseline:EvidenceLink[]=[],patch?:CorrectionPatch):EvidenceLink[]{
  if(explicit!==undefined)validateFieldEvidence(explicit);
  const changed=new Set([...(patch?.changedFields??[]),...(patch?.clearFields??[])]);
  if(patch?.kind==='cancellation'||patch?.kind==='postponement')for(const key of ['status','start','end','deadline','temporal'])changed.add(key);
  const partial=patch&&patch.kind!=='replacement',result:EvidenceLink[]=[];
  for(const field of publicFactFields){
    if(!Object.hasOwn(event,field))continue;
    const inherited=partial&&!changed.has(field)?baseline.filter(link=>link.field===field):[];
    if(inherited.length){result.push(...inherited);continue;}
    const ids=explicit===undefined?evidenceIds:explicit.find(entry=>entry.field===field)?.evidenceIds??[];
    for(const id of ids)result.push({field,source,id});
    // Structured partial patches retain both the baseline and correction evidence.
    if(partial&&['availability','temporal','logistics'].includes(field)&&changed.has(field))result.push(...baseline.filter(link=>link.field===field));
  }
  return [...new Map(result.map(link=>[JSON.stringify(link),link])).values()];
}

export function attributionIssues(event:ScheduleEvent,links:EvidenceLink[],lookup:(source:string,id:string)=>RetainedEvidence|undefined):string[]{
  const issues:string[]=[];
  for(const field of publicFactFields){
    if(!Object.hasOwn(event,field))continue;
    const refs=links.filter(link=>link.field===field);
    if(!refs.length||refs.some(ref=>!lookup(ref.source,ref.id)?.text.trim()))issues.push(`Public field ${field} requires retained source evidence.`);
  }
  return issues;
}
