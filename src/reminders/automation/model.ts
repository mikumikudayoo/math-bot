import { createHash } from 'node:crypto';

export const eventTypes = ['training-session','classmarker-deadline','competition-day','registration-deadline','login-details','server-event','schedule-announcement','materials-release','competition-announcement','results','qualification','other-deadline'] as const;
export type EventType = typeof eventTypes[number];
export interface Competition { id: string; name: string; year: number; subject: 'mathematics' }
export interface CompetitionRound { id: string; competitionId: string; name: string }
export interface TrainingProgram { id: string; name: 'VTAMPS'; version: string }
export interface Catalog { competitions: Competition[]; rounds: CompetitionRound[]; programs: TrainingProgram[] }
export interface ScheduleEvent {
  competitionId: string | null;
  roundId: string | null;
  programId: string | null;
  // A program can prepare for multiple competitions without becoming one.
  preparesFor: string[];
  yearLevel: 'Senior Secondary';
  type: EventType;
  slot: string; // Stable session/set/milestone identifier. Dates never form identity.
  start: number | null;
  end: number | null;
  deadline: number | null;
  timezone: string;
  url: string | null;
  detailLabel: string | null; // e.g. "login details"; never credentials themselves.
  dateHint?: string | null; // Date-only source evidence, never converted to an invented time.
}
export interface Source {
  account: string;
  messageId: string;
  attachment: string | null;
  sha256: string;
  locator: string; // Page/table/row/cells, without email body or passwords.
}
export interface Extraction {
  catalog: Catalog;
  source: Source;
  events: { event: ScheduleEvent; confidence: 'high'|'medium'|'low'; issues: string[] }[];
}
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const eventKey = (e: ScheduleEvent) => digest([e.competitionId,e.roundId,e.programId,e.yearLevel,e.type,e.slot]);
function text(value: unknown, max=200): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= max; }
function checkKeys(value: unknown, allowed: string[]) {
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(k=>!allowed.includes(k))) throw new Error('Unexpected fields; do not include raw email bodies or credentials in public candidate data.');
}
export function validateCatalog(c: Catalog) {
  checkKeys(c,['competitions','rounds','programs']);
  if(!c || ![c.competitions,c.rounds,c.programs].every(Array.isArray)) throw new Error('Catalog is required.');
  const ids=new Set<string>();
  for(const item of [...c.competitions,...c.rounds,...c.programs]) {
    if(!text(item.id) || ids.has(item.id)) throw new Error('Catalog IDs must be unique.'); ids.add(item.id);
  }
  for(const item of c.competitions) {
    checkKeys(item,['id','name','year','subject']);
    if(item.subject!=='mathematics' || !text(item.name) || /\b(?:VTAMPS|VTASPS?|IESO|HKISO|science)\b/i.test(item.name) || !Number.isInteger(item.year) || item.year<2000 || item.year>2200) throw new Error('Catalog accepts mathematics competitions only; VTAMPS is a separate program.');
  }
  for(const r of c.rounds) {checkKeys(r,['id','competitionId','name']);if(!text(r.name) || !c.competitions.some(x=>x.id===r.competitionId)) throw new Error('Round must belong to a known competition.');}
  for(const p of c.programs) {checkKeys(p,['id','name','version']);if(p.name!=='VTAMPS' || !text(p.version)) throw new Error('Only the mathematics training program VTAMPS is supported.');}
}
export function validateEvent(e: ScheduleEvent, catalog: Catalog, requireTimes=false) {
  checkKeys(e,['competitionId','roundId','programId','preparesFor','yearLevel','type','slot','start','end','deadline','timezone','url','detailLabel','dateHint']);
  validateCatalog(catalog);
  if (!e || !text(e.slot) || e.yearLevel !== 'Senior Secondary' || !eventTypes.includes(e.type)) throw new Error('Invalid milestone or target year level.');
  if(e.competitionId!==null && !catalog.competitions.some(x=>x.id===e.competitionId)) throw new Error('Unknown competition.');
  if(e.roundId!==null && !catalog.rounds.some(x=>x.id===e.roundId && x.competitionId===e.competitionId)) throw new Error('Round does not belong to event competition.');
  if(e.programId!==null && !catalog.programs.some(x=>x.id===e.programId)) throw new Error('Unknown training program.');
  if(e.competitionId===null && e.programId===null) throw new Error('An event needs a competition or training program.');
  if(e.type==='training-session' && e.programId===null) throw new Error('Training sessions need a training program.');
  if(e.type==='training-session' && (e.competitionId!==null || e.roundId!==null)) throw new Error('Use preparesFor to associate training with competitions; do not collapse identities.');
  if(e.type==='competition-day' && e.competitionId===null) throw new Error('Competition day needs an actual competition.');
  if(!Array.isArray(e.preparesFor) || new Set(e.preparesFor).size!==e.preparesFor.length || e.preparesFor.some(id=>!catalog.competitions.some(x=>x.id===id))) throw new Error('Invalid training/competition links.');
  if (!text(e.timezone)) throw new Error('Timezone is required.');
  try { new Intl.DateTimeFormat('en', {timeZone:e.timezone}).format(); } catch { throw new Error('Unknown timezone.'); }
  for (const n of [e.start,e.end,e.deadline]) if (n !== null && (!Number.isSafeInteger(n) || Math.abs(n)>8.64e15)) throw new Error('Times must be valid Unix milliseconds or null.');
  if (e.end !== null && (e.start === null || e.end <= e.start)) throw new Error('End must follow start.');
  if (requireTimes && e.type==='training-session' && (e.start === null || e.end === null)) throw new Error('Session requires confirmed start and end.');
  if (requireTimes && e.type==='competition-day' && e.start === null) throw new Error('Competition requires confirmed start.');
  if (requireTimes && e.type.endsWith('deadline') && e.deadline === null) throw new Error('Deadline time is unresolved.');
  if (e.detailLabel !== null && !text(e.detailLabel)) throw new Error('Invalid detail label.');
  if(e.dateHint!==undefined && e.dateHint!==null && !text(e.dateHint)) throw new Error('Invalid source date hint.');
  if (e.url !== null) { const url=new URL(e.url); if(url.protocol!=='https:' || url.username || url.password) throw new Error('Only HTTPS links without embedded credentials are accepted.'); }
}
export function validateExtraction(input: Extraction) {
  checkKeys(input,['catalog','source','events']);
  validateCatalog(input?.catalog);
  const s=input?.source;
  checkKeys(s,['account','messageId','attachment','sha256','locator']);
  if (!s || ![s.account,s.messageId,s.locator].every(v=>text(v,500)) || !/^[a-f0-9]{64}$/.test(s.sha256) || (s.attachment!==null && !text(s.attachment,500))) throw new Error('Source provenance is required.');
  if (!Array.isArray(input.events) || !input.events.length || input.events.length>100) throw new Error('Provide 1–100 candidates.');
  const keys=new Set<string>();
  for (const c of input.events) {
    checkKeys(c,['event','confidence','issues']);
    validateEvent(c.event,input.catalog);
    if (!['high','medium','low'].includes(c.confidence) || !Array.isArray(c.issues) || !c.issues.every(i=>text(i,500))) throw new Error('Invalid extraction review metadata.');
    const key=eventKey(c.event); if(keys.has(key)) throw new Error('Duplicate event identity inside extraction.'); keys.add(key);
  }
}

export function describeEvent(e: ScheduleEvent, catalog: Catalog) {
  const format=(n:number|null)=>n===null?null:new Intl.DateTimeFormat('en-PH',{timeZone:e.timezone,dateStyle:'full',timeStyle:'short'}).format(n);
  return {competition:catalog.competitions.find(c=>c.id===e.competitionId)??null,round:catalog.rounds.find(r=>r.id===e.roundId)??null,trainingProgram:catalog.programs.find(p=>p.id===e.programId)??null,target:e.yearLevel,milestone:e.slot,type:e.type,start:format(e.start),end:format(e.end),deadline:format(e.deadline),dateHint:e.dateHint??null,timezone:e.timezone};
}

export interface ReminderRule { id: string; type: EventType; anchor: 'start'|'deadline'; beforeMinutes: number; template: string }
export interface PreviewConfig { guild: string; channel: string; role: string | null; rules: ReminderRule[]; templates: Record<string,string> }
// Wording transcribed from the supplied Google Doc; only placeholders changed.
export const documentTemplates: Record<string,string> = {
  session: '{{role}} participants, please be reminded that our Session {{slot}} is on {{date}} from {{timeRange}}',
  classmarker: '{{role}} participants, please be reminded to answer Set {{slot}} in Classmarker before {{deadline}}',
  email: '{{role}} participants, please check your email for the {{detailLabel}} sent to you.\nIf you did not receive it, kindly check your spam folder or let us know.',
  server: '{{role}} participants, please make sure to join the server event for {{competition}} {{year}}. {{url}}',
};
export function validateConfig(c: PreviewConfig) {
  if(!c || ![c.guild,c.channel,...(c.role===null?[]:[c.role])].every(v=>typeof v==='string' && /^\d{17,20}$/.test(v)) || c.role===c.guild) throw new Error('Configure valid Discord destination IDs; everyone is forbidden.');
  if(!Array.isArray(c.rules) || !c.templates || typeof c.templates!=='object') throw new Error('Configure rules and templates.');
  const ids=new Set<string>();
  for(const r of c.rules) {
    if(!text(r.id) || ids.has(r.id) || !eventTypes.includes(r.type) || !['start','deadline'].includes(r.anchor) || !Number.isSafeInteger(r.beforeMinutes) || r.beforeMinutes<0 || r.beforeMinutes>525600 || !text(c.templates[r.template],2000)) throw new Error('Invalid or duplicate rule/template.');
    ids.add(r.id);
  }
}
export function renderEvent(e: ScheduleEvent, catalog: Catalog, c: PreviewConfig, template: string) {
  validateEvent(e,catalog,true); validateConfig(c);
  const date=(n:number)=>new Intl.DateTimeFormat('en-PH',{timeZone:e.timezone,weekday:'long',year:'numeric',month:'long',day:'numeric'}).format(n);
  const time=(n:number)=>new Intl.DateTimeFormat('en-PH',{timeZone:e.timezone,hour:'numeric',minute:'2-digit',hour12:true}).format(n);
  const competition=catalog.competitions.find(x=>x.id===e.competitionId),program=catalog.programs.find(x=>x.id===e.programId);
  const vars:Record<string,string|null>={role:c.role?`<@&${c.role}>`:null,competition:competition?.name??null,year:competition?String(competition.year):null,round:catalog.rounds.find(x=>x.id===e.roundId)?.name??null,program:program?.name??null,version:program?.version??null,slot:e.slot,date:e.start===null?null:date(e.start),timeRange:e.start===null||e.end===null?null:`${time(e.start)}–${time(e.end)} (${e.timezone})`,deadline:e.deadline===null?null:`${date(e.deadline)}, ${time(e.deadline)} (${e.timezone}); <t:${Math.floor(e.deadline/1000)}:F>`,url:e.url,detailLabel:e.detailLabel};
  const source=c.templates[template]; if(!source) throw new Error('Missing approved template.');
  const content=source.replace(/\{\{(\w+)\}\}/g,(_,key:string)=>{const v=vars[key];if(v===null||v===undefined)throw new Error(`Unresolved placeholder: ${key}`);return v;});
  if(content.includes('{{') || content.length>2000) throw new Error('Malformed template or Discord message too long.');
  return {content,allowedMentions:{parse:[] as string[],roles:c.role?[c.role]:[],users:[] as string[],repliedUser:false}};
}
