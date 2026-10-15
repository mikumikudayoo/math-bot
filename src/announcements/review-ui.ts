import { ActionRowBuilder,ButtonBuilder,ButtonStyle } from 'discord.js';
import { AnnouncementStore,type Candidate,type AnnouncementJob } from './store.js';
import { describeEvent,type Catalog,type ScheduleEvent } from './model.js';
import { redact } from './parsing.js';
import {validatePublicDiscordPayload} from './public-facts.js';

export class ReviewError extends Error {}
export const safeText=(value:string)=>redact(value).text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,'[internal reference withheld]');
export function reviewedPayload(j:AnnouncementJob){
  try{const payload=JSON.parse(j.payload_json) as unknown;if(j.public_safety_version!==1)throw new Error('Legacy payload.');validatePublicDiscordPayload(payload,{role:j.role,channel:j.channel});return (payload as {content:string}).content;}
  catch{return 'public payload withheld; public-safety review is required before this message can be approved.';}
}
const date=(at:number)=>new Intl.DateTimeFormat('en-PH',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Manila'}).format(at);
const row=(buttons:ButtonBuilder[])=>new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);
const button=(id:string,label:string,style=ButtonStyle.Secondary)=>new ButtonBuilder().setCustomId(id).setLabel(label.slice(0,80)).setStyle(style);
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
  const s=store.db.prepare('SELECT s.state,e.evidence_json FROM sources s LEFT JOIN source_evidence e ON e.source=s.id WHERE s.guild=? AND s.id=?').get(guild,id)!;
  const evidence=s.evidence_json?JSON.parse(String(s.evidence_json)) as {evidence?:{text?:unknown}[];blocked?:unknown[]}:{};
  const texts=(evidence.evidence??[]).slice(0,30).map(e=>typeof e.text==='string'?safeText(e.text).slice(0,16000):'').filter(Boolean);
  const ids=sourceGroup(store,guild,id),buttons=['blocked','retry','pending'].includes(String(s.state))?[row([button(`announce:dismiss:${id}:0`,'dismiss reviewed source',ButtonStyle.Danger)])]:[];
  const nav=[];if(candidate&&current>0)nav.push(button(`announce:source:${candidate.public_id}:${current-1}`,'previous source email'));if(candidate&&current+1<related.length)nav.push(button(`announce:source:${candidate.public_id}:${current+1}`,'next source email'));if(nav.length)buttons.push(row(nav));
  return {text:`organizer email · ${s.state}${candidate?` · source ${current+1}/${related.length} for #${candidate.public_id}`:''}\n${ids.length} candidates from this email: ${ids.slice(0,30).map(n=>`#${n}`).join(', ')||'none yet'}\n\n${texts.join('\n\n')||'no readable evidence saved. manual factual review may be needed.'}\n\n${(evidence.blocked??[]).length} attachment/evidence items require manual review. credential content is withheld.`,components:buttons};
}
export function reviewPanel(store:AnnouncementStore,guild:string,value:string){
  const c=requireCandidate(store,guild,value),e=JSON.parse(c.event_json) as ScheduleEvent,facts=describeEvent(e,JSON.parse(c.catalog_json) as Catalog);
  const source=sourceId(store,guild,String(c.public_id)),siblings=sourceGroup(store,guild,source);
  const detected=store.db.prepare("SELECT at FROM audit_log WHERE guild=? AND action='propose' AND target=? ORDER BY at LIMIT 1").get(guild,c.batch)?.at;
  const issues=JSON.parse(c.issues_json) as string[],previous=store.event(guild,c.event_key);
  const buttons=[button(`announce:source:${c.public_id}:0`,'view source')];
  if(c.state==='pending')buttons.unshift(button(`announce:facts:${c.public_id}:${c.review_version}`,'approve facts',ButtonStyle.Success),button(`announce:reject:${c.public_id}:${c.review_version}`,'reject',ButtonStyle.Danger));
  const details=Object.entries(facts).filter(([key,v])=>!['competition','trainingProgram','round'].includes(key)&&v!==null&&v!==undefined).map(([key,v])=>`${key}: ${safeText(String(v))}`).join('\n');
  return {text:`#${c.public_id} · ${title(c)}\ntype: ${e.type} · status: ${c.state} · review version: ${c.review_version}\nsource: organizer email · detected: ${detected?date(Number(detected)):'not recorded'}\n${siblings.length} candidates from this email: ${siblings.slice(0,30).map(n=>`#${n}`).join(', ')}\n\n${details}\ntimezone assumed: ${e.timezoneAssumed?'yes — verify':'no'}\nconfidence: ${c.confidence}\nissues: ${issues.length?issues.map(safeText).join('; '):'none'}\nprevious approved revision: ${previous?.revision??'none'}\n\napproval applies to this candidate only. review the source first; factual approval does not enable auto-send.`,components:[row(buttons)]};
}
export function inboxPanel(store:AnnouncementStore,guild:string,page=0,kind='candidates'){
  if(kind==='candidates'){
    const result=store.candidatePage(guild,page),blocks=result.items.map(c=>{
      const count=sourceGroup(store,guild,sourceId(store,guild,String(c.public_id))).length;
      const at=store.db.prepare("SELECT at FROM audit_log WHERE guild=? AND action='propose' AND target=? ORDER BY at LIMIT 1").get(guild,c.batch)?.at;
      return `#${c.public_id} · ${title(c)}\ntype: ${(JSON.parse(c.event_json) as ScheduleEvent).type} · status: ${c.state}\nsource: organizer email (${count} candidates) · detected: ${at?date(Number(at)):'not recorded'}`;
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
export function jobLabel(store:AnnouncementStore,guild:string,j:AnnouncementJob){const c=jobCandidate(store,guild,j);return `${c?`#${c.public_id} · ${title(c)}`:'approved event'} · ${date(j.due)}`;}
export function requireJob(store:AnnouncementStore,guild:string,value:string){
  const direct=store.job(guild,value);if(direct)return direct;
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
