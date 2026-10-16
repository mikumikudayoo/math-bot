import type { Catalog,ScheduleEvent } from './model.js';
import type { GmailMessage } from './gmail.js';
import type { ParsedMail } from './parsing.js';

export const sourceDispositions=['public','private','ignore','needs_review'] as const;
export type SourceDisposition=typeof sourceDispositions[number];
export interface Availability {state:'unknown'|'expected'|'available'|'partial'|'unavailable';asOf:number|null;expectedAt:number|null}
export interface TemporalFact {precision:'exact'|'date_only'|'window'|'relative'|'unknown';expression:string|null;sourceTime:number|null}
export interface TemporalFacts {start?:TemporalFact;end?:TemporalFact;deadline?:TemporalFact}
export interface Logistics {venue?:string;bring?:string[];participant?:string[]}
export interface SemanticContext {
  evidence?:readonly {id:string;text:string}[];
  /** Complete current organizer message, separate from inherited historical field proof. Host-only. */
  sourceEvidence?:readonly {id:string;text:string}[];
  evidenceIds?:readonly string[];
  sourceTime?:number|null;
  timezoneConfirmed?:boolean;
}
export interface SourceClassification {disposition:SourceDisposition;reason:string;correction:boolean}

const unsupported=/\b(?:HKISO|IESO|VTASPS?|science)\b/iu;
const supported=/\b(?:VTAMPS|TIMO|HKIMO|BBB|PhIMO|PIMSO)\b/iu;
const correctionPattern=/\b(?:errat(?:a|um)|correct(?:ed|ion)|reschedul(?:e|ed|ing)|revised|updated\s+(?:review\s+)?schedule|postpon(?:ed|ement)|cancel(?:led|lation))\b/iu;
const relativePattern=/\b(?:tomorrow|today|tonight|yesterday|next\s+(?:day|week|morning|afternoon|evening)|this\s+(?:morning|afternoon|evening)|later\s+(?:today|tomorrow))\b/iu;
const uncertainAvailability=/\b(?:empty|unavailable|partial(?:ly)?|not\s+(?:(?:yet|currently|now)\s+)?(?:available|uploaded|ready)|(?:aren['’]t|isn['’]t)\s+(?:yet\s+)?(?:available|uploaded|ready)|no\s+(?:files|materials)|will\s+(?:be\s+)?(?:upload(?:ed)?|(?:made\s+)?available|release[dr]?)|to\s+be\s+uploaded|expected|coming\s+soon|only\s+some|(?:available|uploaded|released)\s+(?:tomorrow|next|later|on|from|by|after))\b/iu;
const currentAvailability=/\b(?:(?:now|already|currently)\s+(?:available|uploaded|ready)|(?:materials?|files?|videos?|solutions?|manuals?|results?|folders?)\s+(?:(?:are|is|have\s+been|has\s+been)\s+)?(?:now\s+)?(?:available|uploaded|released)|(?:uploaded|released)\s+(?:the\s+)?(?:materials?|files?|videos?|solutions?|manuals?|results?))\b/iu;
const timestamp=(n:unknown):n is number=>Number.isSafeInteger(n)&&Math.abs(n as number)<=8.64e15;
const keys=(value:unknown,allowed:readonly string[])=>Boolean(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>allowed.includes(k)));

/** Trusted transport time only. A Date header without an explicit offset is ambiguous. */
export function sourceTimeAnchor(message:GmailMessage):number|null {
  if(message.internalDate&&/^\d+$/u.test(message.internalDate)){const time=Number(message.internalDate);if(timestamp(time))return time;}
  const header=message.payload?.headers?.find(h=>h.name.toLowerCase()==='date')?.value;
  if(!header||!/(?:[+-]\d{2}:?\d{2}|\b(?:GMT|UTC))\s*(?:\([^)]*\))?$/iu.test(header))return null;
  const time=Date.parse(header);return timestamp(time)?time:null;
}

/** This classification is host policy; a provider cannot widen it. */
export function classifySource(mail:ParsedMail):SourceClassification {
  const subject=mail.evidence.find(e=>e.id==='subject')?.text??'';
  const text=mail.evidence.map(e=>e.text).join('\n');
  const correction=correctionPattern.test(subject+'\n'+text);
  const hasSupported=supported.test(text),hasUnsupported=unsupported.test(text);
  if(hasUnsupported&&!hasSupported)return {disposition:'ignore',reason:'Unsupported competition or training program; mathematics scope was not widened.',correction};
  if(hasUnsupported&&hasSupported)return {disposition:'needs_review',reason:'Mixed supported and unsupported source scope requires explicit factual separation.',correction};
  if(correction&&mail.blocked.length)return {disposition:'needs_review',reason:'Correction replacement evidence is unreadable or incomplete; retain the source hold.',correction:true};
  if(/\byour\s+(?:ClassMarker|(?:ClassMarker\s+)?(?:test|assessment))\s+(?:is\s+)?(?:now\s+)?ready\s+to\s+take\b/iu.test(subject+'\n'+text)){
    if(correction&&hasSupported)return {disposition:'needs_review',reason:'Supported correction mixed with personal readiness requires review; retain the source hold.',correction:true};
    return {disposition:'private',reason:'Personal assessment readiness is not evidence of public availability.',correction:false};
  }
  if(!hasSupported)return {disposition:'needs_review',reason:'Supported mathematics entity identity is unresolved.',correction};
  return {disposition:'public',reason:'Supported mathematics source; every extracted proposal still requires host validation.',correction};
}

const competitionAliases:Record<string,RegExp>={
  TIMO:/\bTIMO\b|\bThailand\s+International\s+Mathematical\s+Olympiad\b/iu,
  HKIMO:/\bHKIMO\b|\bHong\s+Kong\s+International\s+Mathematical\s+Olympiad\b/iu,
  BBB:/\bBBB\b|\bBig\s+Bay\s+Bei\b/iu,
  PhIMO:/\bPhIMO\b|\bPhilippine\s+International\s+Mathematical\s+Olympiad\b/iu,
  PIMSO:/\bPIMSO\b|\bPhilippine\s+International\s+Math(?:ematics)?\s+and\s+Science\s+Olympiad\b/iu,
};
export function supportedCompetition(name:string):string {
  // PIMSO's established name includes Science; its selected catalog subject must still be mathematics.
  if(/\b(?:HKISO|IESO|VTASPS?|VTAMPS)\b/iu.test(name))throw new Error('Unsupported competition identity.');
  const names=Object.entries(competitionAliases).filter(([,pattern])=>pattern.test(name));
  if(names.length!==1)throw new Error('Unsupported or ambiguous mathematics competition identity.');
  return names[0]![0];
}
export function canonicalProgramVersion(version:string):string {
  const match=version.trim().match(/^(?:v(?:ersion)?\.?\s*)?(\d+(?:\.\d+){0,3})$/iu);
  if(!match)throw new Error('Unsupported or ambiguous VTAMPS version.');
  const numbers=match[1]!.split('.').map(Number);if(numbers.some(n=>!Number.isSafeInteger(n)))throw new Error('Unsupported or ambiguous VTAMPS version.');
  return numbers.join('.');
}
function canonicalRound(name:string):{id:string;name:string} {
  const normalized=name.trim().toLowerCase().replace(/[\s_-]+/gu,' ').replace(/\s+round$/u,'');
  const rounds:Record<string,string>={heat:'Heat Round',final:'Final Round',national:'National Round',international:'International Round',qualifying:'Qualifying Round',qualification:'Qualifying Round',preliminary:'Preliminary Round'};
  const canonical=normalized==='qualification'?'qualifying':normalized;
  if(!rounds[normalized])throw new Error('Unsupported or ambiguous competition round.');
  return {id:canonical,name:rounds[normalized]};
}

/** Canonical host identities, never IDs selected by the model. Unrelated catalog entries do not affect a proposal. */
export function normalizeCatalogAndEvents<T extends {catalog:Catalog;events:{event:ScheduleEvent}[]}>(input:T):T {
  const value=structuredClone(input),competitionIds=new Map<string,string>(),programIds=new Map<string,string>(),roundIds=new Map<string,string>();
  const competitions=value.catalog.competitions.map(c=>{const name=supportedCompetition(c.name),id=`${name.toLowerCase()}-${c.year}`;competitionIds.set(c.id,id);return {...c,id,name};});
  const programs=value.catalog.programs.map(p=>{if(p.name!=='VTAMPS')throw new Error('Unsupported training program.');const version=canonicalProgramVersion(p.version),id=`vtamps-v${version.replace(/\./gu,'-')}`;programIds.set(p.id,id);return {...p,id,version};});
  const rounds=value.catalog.rounds.map(r=>{const competitionId=competitionIds.get(r.competitionId);if(!competitionId)throw new Error('Unknown round competition.');const round=canonicalRound(r.name),id=`${competitionId}-${round.id}`;roundIds.set(r.id,id);return {...r,id,competitionId,name:round.name};});
  const required=(map:Map<string,string>,id:string|null):string|null=>{if(id===null)return null;const result=map.get(id);if(!result)throw new Error('Unknown entity reference.');return result;};
  for(const c of value.events){const e=c.event;c.event={...e,competitionId:required(competitionIds,e.competitionId),roundId:required(roundIds,e.roundId),programId:required(programIds,e.programId),preparesFor:[...new Set(e.preparesFor.map(id=>required(competitionIds,id)!))].sort()};}
  const unique=<U extends {id:string}>(items:U[])=>[...new Map(items.map(item=>[item.id,item])).values()].sort((a,b)=>a.id.localeCompare(b.id));
  const usedCompetitions=new Set(value.events.flatMap(c=>[c.event.competitionId,...c.event.preparesFor]).filter((id):id is string=>id!==null)),usedRounds=new Set(value.events.map(c=>c.event.roundId)),usedPrograms=new Set(value.events.map(c=>c.event.programId));
  value.catalog={competitions:unique(competitions.filter(c=>usedCompetitions.has(c.id))),rounds:unique(rounds.filter(r=>usedRounds.has(r.id))),programs:unique(programs.filter(p=>usedPrograms.has(p.id)))};
  return value;
}
export function catalogForEvent(catalog:Catalog,event:ScheduleEvent):Catalog {
  const used=new Set([event.competitionId,...event.preparesFor]);
  return {competitions:catalog.competitions.filter(c=>used.has(c.id)).sort((a,b)=>a.id.localeCompare(b.id)),rounds:catalog.rounds.filter(r=>r.id===event.roundId).sort((a,b)=>a.id.localeCompare(b.id)),programs:catalog.programs.filter(p=>p.id===event.programId).sort((a,b)=>a.id.localeCompare(b.id))};
}

function citedEvidence(context:SemanticContext):string {
  const ids=context.evidenceIds===undefined?null:new Set(context.evidenceIds);
  return (context.evidence??[]).filter(e=>ids===null||ids.has(e.id)).map(e=>e.text).join('\n');
}
function sourceConfirmsTimezone(event:ScheduleEvent,context:SemanticContext):boolean {
  const text=citedEvidence(context),escaped=event.timezone.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
  const suffix=/^(?:UTC|GMT)$/iu.test(event.timezone)?'(?!\\s*[+-])':'';
  if(new RegExp(`(?:^|[^\\w/])${escaped}(?=$|[^\\w/])${suffix}`,'iu').test(text))return true;
  if(event.timezone==='Asia/Manila'&&/\bPHT\b|\bPhilippine(?:s)?\s+Standard\s+Time\b|\b(?:UTC|GMT)\s*\+\s*0?8(?::?00)?(?![\w:])/iu.test(text))return true;
  // An ISO offset specifies an absolute instant even when display uses an IANA zone.
  for(const match of text.matchAll(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})(?![\w:+-])/giu))if(timestamp(Date.parse(match[0])))return true;
  return false;
}
function relevantRelativeSource(event:ScheduleEvent,context:SemanticContext):boolean {
  const slot=event.slot.match(/(\d+)\s*$/u)?.[1];
  for(const clause of (context.sourceEvidence??context.evidence??[]).flatMap(item=>item.text.split(/\r?\n|;|(?<=[.!?])\s+/u))){
    if(!relativePattern.test(clause))continue;
    const sessions=[...clause.matchAll(/\b(?:session|set)\s*[-_]?\s*(\d+)\b/giu)].map(match=>String(Number(match[1])));
    if(slot&&sessions.length&&!sessions.includes(String(Number(slot))))continue;
    const materials=/\b(?:materials?|folders?|files?|videos?|solutions?|manuals?|upload(?:ed|ing)?)\b/iu.test(clause);
    if(event.type==='materials-release'&&materials)return true;
    if(event.type==='training-session'&&!materials&&slot&&sessions.includes(String(Number(slot))))return true;
    if(event.type==='mock-test-window'&&/\bmock[ -]?test\b/iu.test(clause))return true;
    if(event.type==='check-in'&&/\bcheck[ -]?in\b/iu.test(clause))return true;
    if(event.type==='competition-day'&&!materials&&/\b(?:competition|exam)\b/iu.test(clause))return true;
    if(event.type==='registration-deadline'&&/\bregistration\b/iu.test(clause))return true;
    if(event.type==='classmarker-deadline'&&!materials&&/\b(?:ClassMarker|pre[ -]?test|assessment)\b/iu.test(clause))return true;
    if(event.type==='other-deadline'&&/\bdeadline\b/iu.test(clause))return true;
  }
  return false;
}
/** Check identity only against the source pieces actually cited by this proposal. */
export function entityEvidenceIssues(event:ScheduleEvent,catalog:Catalog,context:SemanticContext):string[] {
  if(context.evidence===undefined)return [];
  const text=citedEvidence(context),issues:string[]=[],used=catalogForEvent(catalog,event);
  for(const c of used.competitions){const acronym=supportedCompetition(c.name);if(!competitionAliases[acronym]!.test(text)||!new RegExp(`\\b${c.year}\\b`,'u').test(text))issues.push('Competition name and year must be supported by the cited source evidence.');}
  for(const p of used.programs){const version=canonicalProgramVersion(p.version),pattern=version.split('.').join('[.\\s_-]');if(!/\bVTAMPS\b/iu.test(text)||!new RegExp(`\\b(?:v(?:ersion)?[.\\s]*)?${pattern}(?![.\\d])`,'iu').test(text))issues.push('Training program and version must be supported by the cited source evidence.');}
  for(const r of used.rounds){const round=canonicalRound(r.name).id;if(!new RegExp(`\\b${round==='qualifying'?'qualif(?:ying|ication)':round}(?:[\\s_-]+round)?\\b`,'iu').test(text))issues.push('Competition round must be supported by the cited source evidence.');}
  return [...new Set(issues)];
}

export function semanticIssues(event:ScheduleEvent,context:SemanticContext={}):string[] {
  const issues:string[]=[],active=(event.status??'active')==='active';
  if(event.timezoneAssumed&&context.timezoneConfirmed!==true)issues.push('Timezone assumption requires explicit factual confirmation.');
  if(active&&context.evidence!==undefined)for(const field of ['start','end','deadline'] as const)if(event[field]!==null&&!event.temporal?.[field])issues.push(`${field} temporal precision requires retained source evidence.`);
  const hasProposedTime=[event.start,event.end,event.deadline,event.availability?.expectedAt??null].some(time=>time!==null);
  if(active&&context.evidence!==undefined&&hasProposedTime&&context.timezoneConfirmed!==true&&!sourceConfirmsTimezone(event,context))issues.push('Source timezone is unconfirmed; an advisory timezoneAssumed flag cannot establish source timezone.');
  if(active&&context.evidence!==undefined&&hasProposedTime&&context.timezoneConfirmed!==true&&relevantRelativeSource(event,context))issues.push('Source relative time requires explicit factual resolution; provider exact precision cannot invent a clock time.');
  if(event.temporal)for(const field of ['start','end','deadline'] as const){const fact=event.temporal[field];if(!fact)continue;
    if(fact.precision==='date_only'||fact.precision==='relative'||fact.precision==='unknown')issues.push(`${field} temporal precision is unresolved; a confirmed clock time is required.`);
    if(fact.precision==='exact'&&event[field]===null)issues.push(`${field} exact time is unresolved.`);
    if(fact.precision==='window'&&(event.start===null||event.end===null))issues.push('Time window requires confirmed opening and closing times.');
    if(fact.expression&&relativePattern.test(fact.expression)){
      if(!timestamp(context.sourceTime)||fact.sourceTime!==context.sourceTime)issues.push('Relative time requires the trusted organizer source-time anchor.');
      issues.push('Relative temporal expression remains unresolved; do not invent its intended clock time.');
    }
  }
  if(active&&(event.type==='check-in'||event.type==='mock-test-window')&&event.start===null)issues.push('Check-in or mock-test opening time is unresolved.');
  if(active&&event.type==='mock-test-window'&&event.end===null)issues.push('Mock-test closing time is unresolved.');
  if(active&&event.type==='materials-release'&&!event.availability)issues.push('Materials availability state is unresolved.');
  const a=event.availability;
  if(a){
    if(a.state==='unknown')issues.push('Availability is unresolved.');
    if(a.state==='expected'&&a.expectedAt===null)issues.push('Expected availability time is unresolved.');
    if((a.state==='available'||a.state==='partial'||a.state==='unavailable')&&a.asOf===null)issues.push('Availability as-of time is unresolved.');
    if(a.state==='available'&&a.expectedAt!==null)issues.push('Current availability cannot retain a future expected-availability claim.');
    if(a.state==='available'&&context.evidence!==undefined){const text=citedEvidence(context),completeSource=(context.sourceEvidence??context.evidence).map(item=>item.text).join('\n');if(uncertainAvailability.test(completeSource)||!currentAvailability.test(text))issues.push('Available-now claim is not supported by the complete source and cited evidence.');}
    if(a.state==='available'&&timestamp(context.sourceTime)&&a.asOf!==null&&a.asOf>context.sourceTime)issues.push('Availability cannot be confirmed at a time later than its source.');
  }
  return [...new Set(issues)];
}

/** Drafts may retain uncertainty, but malformed semantic data is never accepted. */
export function validateSemanticEvent(event:ScheduleEvent,context:SemanticContext={},requireComplete=false):void {
  const a=event.availability;
  if(a!==undefined){if(!keys(a,['state','asOf','expectedAt'])||!['unknown','expected','available','partial','unavailable'].includes(a.state)||![a.asOf,a.expectedAt].every(n=>n===null||timestamp(n)))throw new Error('Invalid structured availability.');}
  if(event.temporal!==undefined){if(!keys(event.temporal,['start','end','deadline']))throw new Error('Invalid temporal facts.');for(const fact of Object.values(event.temporal)){if(!keys(fact,['precision','expression','sourceTime'])||!['exact','date_only','window','relative','unknown'].includes(fact.precision)||!(fact.expression===null||typeof fact.expression==='string'&&fact.expression.trim().length>0&&fact.expression.length<=500)||!(fact.sourceTime===null||timestamp(fact.sourceTime)))throw new Error('Invalid temporal precision fact.');}}
  if(event.logistics!==undefined){const l=event.logistics;if(!keys(l,['venue','bring','participant'])||l.venue!==undefined&&(typeof l.venue!=='string'||!l.venue.trim()||l.venue.length>300))throw new Error('Invalid public venue.');for(const values of [l.bring,l.participant])if(values!==undefined&&(!Array.isArray(values)||values.length>20||values.some(v=>typeof v!=='string'||!v.trim()||v.length>300)))throw new Error('Invalid typed public logistics.');}
  // Source evidence is a separate authority gate, even for a draft. An empty evidence array proves nothing.
  const issues=semanticIssues(event,context);
  if(context.evidence!==undefined&&issues.some(i=>i.startsWith('Available-now')||i.startsWith('Availability cannot')))throw new Error('Availability claim lacks supporting source evidence.');
  if(requireComplete&&issues.length)throw new Error(issues.join(' '));
}

export function validateRenderedSemantics(event:ScheduleEvent,content:string):void {
  if(event.availability&&event.availability.state!=='available'&&/\b(?:now|currently|already)\s+(?:available|ready|uploaded)|\b(?:materials?|files?|videos?|solutions?|manuals?|results?)\s+(?:are|is)\s+(?:now\s+)?available\b/iu.test(content))throw new Error('Rendered message contradicts the approved availability state.');
}
