import { canonicalEvent,digest,eventKey,type Catalog,type ScheduleEvent } from './model.js';
import { catalogForEvent,normalizeCatalogAndEvents } from './semantics.js';

export interface CorrectionPatch {
  kind:'partial'|'replacement'|'cancellation'|'postponement';
  changedFields:string[];
  clearFields:string[];
}

const mutableFields=new Set(['start','end','deadline','timezone','url','detailLabel','dateHint','status','timezoneAssumed','preparesFor','availability','temporal','logistics']);
const nullableFields=new Set(['start','end','deadline','url','detailLabel','dateHint']);
const optionalFields=new Set(['availability','temporal','logistics']);

export function validateCorrectionPatch(patch:CorrectionPatch):void {
  if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(k=>!['kind','changedFields','clearFields'].includes(k))||!['partial','replacement','cancellation','postponement'].includes(patch.kind))throw new Error('Invalid correction patch.');
  if(!Array.isArray(patch.changedFields)||!Array.isArray(patch.clearFields)||patch.changedFields.some(k=>typeof k!=='string'||!mutableFields.has(k))||patch.clearFields.some(k=>typeof k!=='string'||(!nullableFields.has(k)&&!optionalFields.has(k))))throw new Error('Correction fields must be supported mutable public facts.');
  if(new Set(patch.changedFields).size!==patch.changedFields.length||new Set(patch.clearFields).size!==patch.clearFields.length||patch.changedFields.some(k=>patch.clearFields.includes(k)))throw new Error('Correction change and clear fields must be unique and disjoint.');
}

// Only explicit changes can replace known good values in a partial correction.
// Unlisted provider nulls mean unspecified; erasure requires an explicit clear field.
export function applyCorrectionPatch(baseline:ScheduleEvent,proposal:ScheduleEvent,patch:CorrectionPatch):ScheduleEvent {
  validateCorrectionPatch(patch);
  if(eventKey(baseline)!==eventKey(proposal))throw new Error('A correction cannot change stable event identity.');
  const result=structuredClone(patch.kind==='replacement'?canonicalEvent(proposal):canonicalEvent(baseline));
  const target=result as unknown as Record<string,unknown>,incoming=proposal as unknown as Record<string,unknown>;
  for(const field of patch.changedFields)if(!Object.hasOwn(incoming,field)||incoming[field]===null||incoming[field]===undefined)throw new Error('Correction changed field requires an explicit non-null value.');
  if(patch.kind!=='replacement')for(const field of patch.changedFields){
    const value=incoming[field];
    // A partial logistics/temporal/availability block must not erase unrelated
    // members merely because the extraction omitted them.
    if(optionalFields.has(field)&&typeof value==='object'&&!Array.isArray(value))target[field]={...(target[field] as object|undefined),...structuredClone(value)};
    else target[field]=structuredClone(value);
  }
  for(const field of patch.clearFields){if(optionalFields.has(field))delete target[field];else target[field]=null;}
  if(patch.kind==='cancellation'||patch.kind==='postponement'){
    result.status=patch.kind==='cancellation'?'cancelled':'postponed';
    result.start=null;result.end=null;result.deadline=null;
    delete result.temporal;
  }
  return canonicalEvent(result);
}

// Observation timestamps and expressions describe the evidence, not a changed
// public fact. Precision remains material: unresolved dates cannot equal exact
// dates merely because both extractions happen to carry the same timestamp.
export function factFingerprint(event:ScheduleEvent,catalog:Catalog):string {
  const input=normalizeCatalogAndEvents({catalog,events:[{event}]}),normalized=canonicalEvent(input.events[0]!.event),facts={...normalized,status:normalized.status??'active',timezoneAssumed:normalized.timezoneAssumed??false,dateHint:normalized.dateHint??null,preparesFor:[...normalized.preparesFor].sort()} as Record<string,unknown>;
  const availability=normalized.availability;
  if(availability)facts.availability={state:availability.state,expectedAt:availability.expectedAt};
  else delete facts.availability;
  const temporal=normalized.temporal;
  if(temporal&&Object.keys(temporal).length)facts.temporal=Object.fromEntries(Object.entries(temporal).map(([field,value])=>[field,{precision:value?.precision}]));
  else delete facts.temporal;
  if(normalized.logistics&&Object.keys(normalized.logistics).length===0)delete facts.logistics;
  const scope=catalogForEvent(input.catalog,normalized);
  const ordered={competitions:[...scope.competitions].sort((a,b)=>a.id.localeCompare(b.id)),rounds:[...scope.rounds].sort((a,b)=>a.id.localeCompare(b.id)),programs:[...scope.programs].sort((a,b)=>a.id.localeCompare(b.id))};
  return digest({event:facts,catalog:ordered});
}

export function assessCorrection(input:{correction:boolean;unresolvedEvidence:boolean;baselineExists:boolean;sameFacts:boolean}):{allowUnchanged:boolean;issues:string[]} {
  const issues:string[]=[];
  if(input.correction&&!input.baselineExists)issues.push('Correction refers to an unavailable authoritative baseline; manual review is required without historical mailbox replay.');
  if(input.correction&&input.unresolvedEvidence)issues.push('Replacement correction evidence is unresolved; the previous schedule must remain held until manual resolution or explicit dismissal.');
  return {allowUnchanged:input.sameFacts&&issues.length===0,issues};
}

export interface CorrectionSourceOrder { sourceTime:number|null;sourceHash:string }
export function compareCorrectionSources(incoming:CorrectionSourceOrder,existing:CorrectionSourceOrder):'newer'|'older'|'same'|'ambiguous' {
  if(incoming.sourceHash&&incoming.sourceHash===existing.sourceHash)return 'same';
  if(incoming.sourceTime===null||existing.sourceTime===null||!Number.isSafeInteger(incoming.sourceTime)||!Number.isSafeInteger(existing.sourceTime)||incoming.sourceTime===existing.sourceTime)return 'ambiguous';
  return incoming.sourceTime>existing.sourceTime?'newer':'older';
}
