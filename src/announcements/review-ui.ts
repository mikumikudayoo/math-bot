import { ActionRowBuilder,ButtonBuilder,ButtonStyle } from 'discord.js';
import { AnnouncementStore,type Candidate,type AnnouncementJob } from './store.js';
import { describeEvent,type Catalog,type ScheduleEvent } from './model.js';
import { redact } from './parsing.js';
import {validatePublicDiscordPayload,validatePublicText} from './public-facts.js';
import type {EvidenceLink,PublicFactField,RetainedEvidence} from './evidence.js';

export class ReviewError extends Error {}
export const safeText=(value:string)=>redact(value).text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,'[internal reference withheld]');
const safeFactText=(value:string)=>{try{validatePublicText(value);return value.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,'[internal reference withheld]');}catch{return safeText(value);}};
export function reviewedPayload(j:AnnouncementJob){
  try{const payload=JSON.parse(j.payload_json) as unknown;if(j.public_safety_version!==1)throw new Error('Legacy payload.');validatePublicDiscordPayload(payload,{role:j.role,channel:j.channel});return (payload as {content:string}).content;}
  catch{return 'public payload withheld; public-safety review is required before this message can be approved.';}
}
const date=(at:number)=>new Intl.DateTimeFormat('en-PH',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Manila'}).format(at);
const row=(buttons:ButtonBuilder[])=>new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);
const button=(id:string,label:string,style=ButtonStyle.Secondary)=>new ButtonBuilder().setCustomId(id).setLabel(label.slice(0,80)).setStyle(style);
const fieldLabels:Record<PublicFactField,string>={competitionId:'competition',roundId:'round',programId:'training program',preparesFor:'prepares for',yearLevel:'target year level',type:'milestone type',slot:'milestone',start:'start',end:'end',deadline:'deadline',timezone:'timezone',url:'public URL',detailLabel:'public detail',dateHint:'source date hint',status:'event lifecycle',timezoneAssumed:'timezone assumption',availability:'availability',temporal:'temporal precision',logistics:'public logistics'};
const locationLabel=(value:unknown):string|null=>typeof value==='string'&&/^(?:subject|body(?:\.\d+)*)(?::(?:pdf|page-\d+))?(?::chunk-\d+)?$/u.test(value)?value:null;
function publicFactRows(event:ScheduleEvent,catalog:Catalog):{field:PublicFactField;label:string;value:string}[]{
  const facts=describeEvent(event,catalog),stamp=(at:number|null)=>at===null?'unresolved':new Intl.DateTimeFormat('en-PH',{timeZone:event.timezone,dateStyle:'full',timeStyle:'short'}).format(at);
  const competition=(id:string)=>{const item=catalog.competitions.find(c=>c.id===id);return item?`${item.name} ${item.year}`:'unresolved competition';};
  const availability=event.availability,temporal=event.temporal,logistics=event.logistics;
  const values:Record<PublicFactField,string>={
    competitionId:facts.competition?`${facts.competition.name} ${facts.competition.year}`:'none',roundId:facts.round?.name??'none',programId:facts.trainingProgram?`${facts.trainingProgram.name} V.${facts.trainingProgram.version}`:'none',preparesFor:event.preparesFor.length?event.preparesFor.map(competition).join('; '):'none',yearLevel:event.yearLevel,type:event.type,slot:event.slot,start:facts.start??'not set',end:facts.end??'not set',deadline:facts.deadline??'not set',timezone:event.timezone,url:event.url??'none',detailLabel:event.detailLabel??'none',dateHint:event.dateHint??'none',status:event.status??'active',timezoneAssumed:event.timezoneAssumed===undefined?'not recorded; confirmation required':event.timezoneAssumed?'assumed; explicit confirmation required':'resolved / explicitly confirmed',
    availability:availability?`${availability.state}; as of: ${stamp(availability.asOf)}; expected: ${availability.expectedAt===null?'not set':stamp(availability.expectedAt)}`:'not specified',
    temporal:temporal?(['start','end','deadline'] as const).filter(field=>temporal[field]).map(field=>{const fact=temporal[field]!;return `${field}: ${fact.precision}; source expression: ${fact.expression??'not recorded'}; organizer time: ${fact.sourceTime===null?'not recorded':stamp(fact.sourceTime)}`;}).join('\n  ')||'not specified':'not specified',
    logistics:logistics?[`venue: ${logistics.venue??'not set'}`,`bring: ${logistics.bring?.join('; ')||'not set'}`,`participant instructions: ${logistics.participant?.join('; ')||'not set'}`].join('\n  '):'not specified',
  };
  return Object.entries(values).map(([field,value])=>({field:field as PublicFactField,label:fieldLabels[field as PublicFactField],value:safeFactText(value)}));
}
function fieldEvidenceView(store:AnnouncementStore,guild:string,c:Candidate,original:string){
  let links:EvidenceLink[]=[],invalid=false;
  try{const value:unknown=JSON.parse((c as Candidate&{field_evidence_json?:string}).field_evidence_json??'[]');
    if(Array.isArray(value))links=value.filter((item):item is EvidenceLink=>{const valid=Boolean(item&&typeof item==='object'&&typeof item.field==='string'&&Object.hasOwn(fieldLabels,item.field)&&typeof item.source==='string'&&item.source.length>0&&item.source.length<=200&&typeof item.id==='string'&&item.id.length>0&&item.id.length<=200);invalid||=!valid;return valid;});else invalid=true;
  }catch{invalid=true;}
  const sources=[...new Set([original,...links.map(link=>link.source)])].filter(id=>store.db.prepare('SELECT id FROM sources WHERE guild=? AND id=?').get(guild,id));
  const records=new Map<string,RetainedEvidence[]>();
  for(const id of sources){try{const value=(JSON.parse(String(store.db.prepare('SELECT evidence_json FROM source_evidence WHERE source=?').get(id)?.evidence_json??'{}')) as {evidence?:unknown}).evidence;
    records.set(id,Array.isArray(value)?value.filter((item):item is RetainedEvidence=>Boolean(item&&typeof item==='object'&&typeof item.id==='string'&&typeof item.text==='string')):[]);
  }catch{records.set(id,[]);}}
  const text=Object.entries(fieldLabels).map(([field,label])=>{
    const refs=links.filter(link=>link.field===field).map(link=>{const record=records.get(link.source)?.find(item=>item.id===link.id);if(!record)return 'retained evidence missing or outside this server';const locations=(Array.isArray(record.locations)?record.locations:[record.id]).map(locationLabel).filter((item):item is string=>item!==null);return `source ${sources.indexOf(link.source)+1} · ${locations.length?locations.join(', '):'evidence item (location requires review)'}`;});
    return refs.length?`${label}: ${[...new Set(refs)].join('; ')}`:null;
  }).filter(Boolean).join('\n');
  return (text||'retained field attribution is missing; source review is required.')+(invalid?'\nmalformed evidence linkage requires manual source review.':'');
}
export function title(c:Candidate){
  const facts=describeEvent(JSON.parse(c.event_json) as ScheduleEvent,JSON.parse(c.catalog_json) as Catalog);
  return safeText([facts.trainingProgram?.name,facts.trainingProgram?.version,facts.competition?.name,facts.round?.name].filter(Boolean).join(' ')||'mathematics event');
}
export function requireCandidate(store:AnnouncementStore,guild:string,value:string){const c=store.resolveCandidate(guild,value);if(!c)throw new ReviewError('candidate not found. choose a number from /announce inbox.');return c;}
export function sourceId(store:AnnouncementStore,guild:string,value:string){
  const c=store.resolveCandidate(guild,value);
  if(c)return String(store.db.prepare('SELECT source FROM candidate_batches WHERE id=?').get(c.batch)!.source);
  if(store.db.prepare('SELECT id FROM sources WHERE guild=? AND id=?').get(guild,value))return value;
  throw new ReviewError('source not found. open a candidate or the source inbox.');
}
export function sourceGroup(store:AnnouncementStore,guild:string,id:string){
  return store.db.prepare(`SELECT DISTINCT p.public_id FROM candidate_events c JOIN candidate_public_ids p ON p.candidate=c.id
    JOIN candidate_batches b ON b.id=c.batch LEFT JOIN candidate_sources s ON s.candidate=c.id
    WHERE c.guild=? AND (b.source=? OR s.source=?) ORDER BY p.public_id`).all(guild,id,id).map(r=>Number(r.public_id));
}
export function sourcePanel(store:AnnouncementStore,guild:string,value:string,page=0){
  const candidate=store.resolveCandidate(guild,value),original=sourceId(store,guild,value);
  const related=candidate?[original,...store.db.prepare('SELECT s.id FROM sources s JOIN candidate_sources cs ON cs.source=s.id WHERE cs.candidate=? AND s.guild=? AND s.id<>? ORDER BY s.rowid').all(candidate.id,guild,original).map(s=>String(s.id))]:[original];
  const current=Math.max(0,Math.min(related.length-1,Math.floor(page)||0)),id=related[current]!;
  const s=store.db.prepare('SELECT s.state,s.source_disposition,s.disposition_reason,s.source_time,e.evidence_json FROM sources s LEFT JOIN source_evidence e ON e.source=s.id WHERE s.guild=? AND s.id=?').get(guild,id)!;
  const evidence=s.evidence_json?JSON.parse(String(s.evidence_json)) as {evidence?:{id?:unknown;text?:unknown;locations?:unknown[]}[];blocked?:unknown[];incomplete?:boolean}:{};
  const texts=(evidence.evidence??[]).map((e,index)=>{if(typeof e.text!=='string')return '';const locations=(Array.isArray(e.locations)?e.locations:[e.id]).map(locationLabel).filter((item):item is string=>item!==null);return `evidence ${index+1}${locations.length?` · ${locations.join(', ')}`:''}\n${safeText(e.text)}`;}).filter(Boolean);
  const ids=sourceGroup(store,guild,id),buttons=['blocked','retry','pending'].includes(String(s.state))?[row([button(`announce:dismiss:${id}:0`,'dismiss reviewed source',ButtonStyle.Danger)])]:[];
  const nav=[];if(candidate&&current>0)nav.push(button(`announce:source:${candidate.public_id}:${current-1}`,'previous source email'));if(candidate&&current+1<related.length)nav.push(button(`announce:source:${candidate.public_id}:${current+1}`,'next source email'));if(nav.length)buttons.push(row(nav));
  const warnings=(evidence.blocked??[]).map(item=>safeText(String(item)));
  return {text:`organizer email · ${s.state}${candidate?` · source ${current+1}/${related.length} for #${candidate.public_id}`:''}\nsource disposition: ${safeText(String(s.source_disposition))}\ndisposition reason: ${safeText(String(s.disposition_reason))}\norganizer source time: ${typeof s.source_time==='number'?date(s.source_time):'unresolved'}\n${ids.length} candidates from this email: ${ids.map(n=>`#${n}`).join(', ')||'none yet'}\n\n${texts.join('\n\n')||'no readable evidence saved. manual factual review may be needed.'}\n\n${warnings.length} attachment/evidence items require manual review.${evidence.incomplete?' evidence is incomplete.':''}${warnings.length?'\n'+warnings.join('\n'):''}\nprivacy notice: participant/account details and credential content are withheld.`,components:buttons};
}
export function reviewPanel(store:AnnouncementStore,guild:string,value:string){
  const c=requireCandidate(store,guild,value),e=JSON.parse(c.event_json) as ScheduleEvent,catalog=JSON.parse(c.catalog_json) as Catalog;
  const source=sourceId(store,guild,String(c.public_id)),siblings=sourceGroup(store,guild,source);
  const detected=store.db.prepare("SELECT at FROM audit_log WHERE guild=? AND action='propose' AND target=? ORDER BY at LIMIT 1").get(guild,c.batch)?.at;
  const issues=JSON.parse(c.issues_json) as string[],previous=store.event(guild,c.event_key);
  const buttons=[button(`announce:source:${c.public_id}:0`,'view source')];
  if(c.state==='pending')buttons.unshift(button(`announce:facts:${c.public_id}:${c.review_version}`,'approve facts',ButtonStyle.Success),button(`announce:reject:${c.public_id}:${c.review_version}`,'reject',ButtonStyle.Danger));
  const rows=publicFactRows(e,catalog),details=rows.map(fact=>`${fact.label}: ${fact.value}`).join('\n');
  const baseline=c.base_revision>0?store.db.prepare('SELECT event_json,catalog_json FROM event_revisions WHERE event_key=? AND revision=?').get(c.event_key,c.base_revision):undefined;
  let changes='';
  if(baseline){const before=publicFactRows(JSON.parse(String(baseline.event_json)) as ScheduleEvent,JSON.parse(String(baseline.catalog_json)) as Catalog);const changed=rows.filter(fact=>before.find(old=>old.field===fact.field)?.value!==fact.value);changes=`\n\nsupersedes approved revision ${c.base_revision} · before → after\n${changed.length?changed.map(fact=>`changed · ${fact.label}\n  before: ${before.find(old=>old.field===fact.field)?.value??'not set'}\n  after: ${fact.value}`).join('\n'):'no public field changes'}`;}
  const sourceRecord=store.db.prepare('SELECT s.source_disposition,e.evidence_json FROM sources s LEFT JOIN source_evidence e ON e.source=s.id WHERE s.guild=? AND s.id=?').get(guild,source);
  let warnings:string[]=[];try{warnings=((JSON.parse(String(sourceRecord?.evidence_json??'{}')) as {blocked?:string[]}).blocked??[]).map(safeText);}catch{}
  return {text:`#${c.public_id} · ${title(c)}\ncandidate state: ${c.state} · event lifecycle: ${e.status??'active'} · review version: ${c.review_version}\nsource: organizer email · disposition: ${safeText(String(sourceRecord?.source_disposition??'needs_review'))} · detected: ${detected?date(Number(detected)):'not recorded'}\n${siblings.length} candidates from this email: ${siblings.map(n=>`#${n}`).join(', ')}\n\nproposed public facts${baseline?' (after)':''}\n${details}\nconfidence: ${c.confidence}\nissues: ${issues.length?issues.map(safeText).join('; '):'none'}\nprevious approved revision: ${previous?.revision??'none'}${changes}\n\nfield evidence references\n${fieldEvidenceView(store,guild,c,source)}\n\nattachment/manual-review warnings: ${warnings.length?warnings.join('; '):'none'}\nprivacy notice: participant/account details and credential content are withheld.\n\napproval applies to this candidate only. review the source first; factual approval does not enable auto-send.`,components:[row(buttons)]};
}
export function inboxPanel(store:AnnouncementStore,guild:string,page=0,kind='candidates'){
  if(kind==='candidates'){
    const result=store.candidatePage(guild,page),blocks=result.items.map(c=>{
      const count=sourceGroup(store,guild,sourceId(store,guild,String(c.public_id))).length;
      const at=store.db.prepare("SELECT at FROM audit_log WHERE guild=? AND action='propose' AND target=? ORDER BY at LIMIT 1").get(guild,c.batch)?.at;
      const event=JSON.parse(c.event_json) as ScheduleEvent;
      return `#${c.public_id} · ${title(c)}\ntype: ${event.type} · candidate state: ${c.state} · event lifecycle: ${event.status??'active'}\nsource: organizer email (${count} candidates) · detected: ${at?date(Number(at)):'not recorded'}`;
    });
    const components=result.items.length?[row(result.items.map(c=>button(`announce:review:${c.public_id}:0`,`review #${c.public_id}`)))]:[];
    const nav=[];if(result.page>0)nav.push(button(`announce:page:candidates:${result.page-1}`,'previous'));if(result.page+1<result.pages)nav.push(button(`announce:page:candidates:${result.page+1}`,'next'));if(nav.length)components.push(row(nav));
    return {text:`announcement inbox · candidates · page ${result.page+1}/${result.pages} (${result.total} total)\n\n${blocks.join('\n\n')||'no candidates.'}\n\nuse /announce inbox kind:deliveries or kind:sources for other reviews.`,components};
  }
  const table=kind==='deliveries'?'announcement_jobs':'sources',filter=kind==='deliveries'?'guild=?':"guild=? AND state IN ('blocked','retry','pending')";
  const total=Number(store.db.prepare(`SELECT count(*) n FROM ${table} WHERE ${filter}`).get(guild)!.n);
  const pages=Math.max(1,Math.ceil(total/5)),current=Math.max(0,Math.min(pages-1,Math.floor(page)||0));
  const slice=store.db.prepare(`SELECT * FROM ${table} WHERE ${filter} ORDER BY ${kind==='deliveries'?'due DESC, rowid DESC':'rowid DESC'} LIMIT 5 OFFSET ?`).all(guild,current*5);
  const texts=slice.map((item,n)=>kind==='deliveries'?`${jobLabel(store,guild,item as unknown as AnnouncementJob)} · ${item.state}`:`organizer email ${current*5+n+1} · ${item.state}`);
  const components=slice.length?[row(slice.map((item,n)=>button(`announce:${kind==='deliveries'?'preview':'source'}:${item.id}:0`,kind==='deliveries'?`preview ${n+1}`:`view email ${current*5+n+1}`)))]:[];
  const nav=[];if(current>0)nav.push(button(`announce:page:${kind}:${current-1}`,'previous'));if(current+1<pages)nav.push(button(`announce:page:${kind}:${current+1}`,'next'));if(nav.length)components.push(row(nav));
  return {text:`announcement inbox · ${kind} · page ${current+1}/${pages}\n\n${texts.join('\n\n')||'nothing waiting for review.'}`,components};
}
export function jobCandidate(store:AnnouncementStore,guild:string,j:AnnouncementJob){return store.db.prepare('SELECT c.*,p.public_id FROM candidate_events c JOIN candidate_public_ids p ON p.candidate=c.id WHERE c.guild=? AND c.event_key=? AND c.base_revision=? AND c.state=? ORDER BY p.public_id LIMIT 1').get(guild,j.event_key,j.revision-1,'approved') as unknown as Candidate|undefined;}
export function jobLabel(store:AnnouncementStore,guild:string,j:AnnouncementJob){const c=jobCandidate(store,guild,j);let publicId=(j as AnnouncementJob&{public_id?:number}).public_id;try{publicId??=Number(store.db.prepare('SELECT public_id FROM announcement_job_public_ids WHERE job=?').get(j.id)?.public_id)||undefined;}catch{}return `${publicId?`D#${publicId} · `:''}${c?`candidate #${c.public_id} · ${title(c)}`:'approved event'} · ${date(j.due)}`;}
export function requireJob(store:AnnouncementStore,guild:string,value:string){
  const reference=value.match(/^D#?(\d+)$/iu);
  const direct=reference?store.db.prepare('SELECT j.* FROM announcement_jobs j JOIN announcement_job_public_ids p ON p.job=j.id WHERE j.guild=? AND p.public_id=?').get(guild,Number(reference[1])) as unknown as AnnouncementJob|undefined:store.job(guild,value);if(direct)return direct;
  const c=store.resolveCandidate(guild,value);
  const jobs=c?store.db.prepare('SELECT * FROM announcement_jobs WHERE guild=? AND event_key=? AND revision=?').all(guild,c.event_key,c.base_revision+1) as unknown as AnnouncementJob[]:[];
  if(jobs.length!==1)throw new ReviewError(jobs.length?'multiple deliveries match. choose a preview button in the delivery inbox.':'delivery not found. open /announce inbox kind:deliveries.');
  return jobs[0]!;
}
export function actionError(error:unknown){
  if(error instanceof ReviewError)return error.message;
  if(error instanceof Error&&/stale|revision|candidate unavailable/i.test(error.message))return 'that review is stale or unavailable. open the latest review and try again; no message was sent.';
  return 'announcement action blocked. check the review version, factual issues and configuration; no message was sent.';
}
