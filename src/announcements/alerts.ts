import { randomUUID } from 'node:crypto';
import type { AnnouncementStore } from './store.js';
import type { Catalog,ScheduleEvent } from './model.js';
import {sanitizeOrganizerEvidence} from './public-facts.js';

export const incidentCooldownMs=30*60*1000;
export interface StaffAlert {id:string;kind:string;target:string}
export function alertActionable(store:AnnouncementStore,guild:string,alert:StaffAlert,now=Date.now()):boolean {
  if(['factual-review','correction-held'].includes(alert.kind))return !!store.db.prepare(`SELECT c.id FROM candidate_events c JOIN candidate_sources cs ON cs.candidate=c.id JOIN candidate_batches b ON b.source=cs.source WHERE c.guild=? AND b.id=? AND c.state='pending' LIMIT 1`).get(guild,alert.target);
  if(alert.kind==='approaching-unapproved'){
    const c=store.candidate(guild,alert.target);if(!c||c.state!=='pending')return false;
    const e=JSON.parse(c.event_json) as ScheduleEvent,time=e.deadline??e.start;
    return (e.status??'active')==='active'&&time!==null&&time>now&&time-now<86400000;
  }
  if(alert.kind==='blocked-source')return !!store.db.prepare("SELECT id FROM sources WHERE id=? AND guild=? AND state IN ('pending','retry','blocked') AND source_disposition NOT IN ('private','ignore')").get(alert.target,guild);
  if(alert.kind==='provider-outage'||alert.kind==='provider-recovered'){
    const incident=store.db.prepare("SELECT active,episode FROM operational_incidents WHERE guild=? AND provider='groq'").get(guild);
    return !!incident&&Boolean(incident.active)===(alert.kind==='provider-outage')&&alert.target.startsWith(`groq:${incident.episode}`);
  }
  const job=store.job(guild,alert.target);
  if(alert.kind==='public-safety-review'){
    const event=job?store.event(guild,job.event_key):store.event(guild,alert.target);
    if(job&&['sent','superseded','cancelled','skipped'].includes(job.state))return false;
    return !!event&&(event.public_safety_version!==1||event.fact_semantics_version!==1||!store.eventEvidenceCurrent(event));
  }
  if(alert.kind==='delivery-identity-review'){
    if(job)return job.state==='blocked'&&store.event(guild,job.event_key)?.revision===job.revision;
    const event=store.event(guild,alert.target);return !!event&&!!store.db.prepare('SELECT job FROM legacy_delivery_guards WHERE guild=? AND event_key=? AND revision=? LIMIT 1').get(guild,event.event_key,event.revision);
  }
  if(['message-review','waiting-for-canva','blocked-announcement','uncertain-delivery','stuck-delivery','missed-reminder','delivery-preflight-blocked'].includes(alert.kind)){
    if(!job)return false;
    if(alert.kind==='uncertain-delivery')return job.state==='uncertain';
    if(alert.kind==='stuck-delivery')return job.state==='delivering';
    if(alert.kind==='missed-reminder')return job.state==='skipped';
    if(alert.kind==='delivery-preflight-blocked')return job.state==='cancelled';
    if(store.event(guild,job.event_key)?.revision!==job.revision||store.held(job.event_key))return false;
    if(alert.kind==='blocked-announcement')return job.state==='blocked';
    return job.state==='pending_approval'&&(alert.kind!=='waiting-for-canva'||job.asset_policy==='required'&&!job.asset);
  }
  if(['correction-after-send','cancellation-review'].includes(alert.kind)){
    const at=alert.target.lastIndexOf(':'),event=store.event(guild,alert.target.slice(0,at));
    return !!event&&event.revision===Number(alert.target.slice(at+1));
  }
  if(alert.kind==='gmail-unavailable')return store.state(`gmail:${alert.target}:health`)!=='healthy'&&store.state('gmail:retry-at')!=='0';
  if(alert.kind==='gmail-history-gap')return !!store.db.prepare("SELECT key FROM gmail_state WHERE key LIKE 'gmail:%:history-gap' AND value<>'' LIMIT 1").get();
  if(alert.kind==='gmail-pagination-review')return !!store.state(`gmail:${alert.target}:pagination-hold`);
  if(alert.kind==='extraction-provider-unavailable')return false;
  return true;
}
export function recordSourceFailure(store:AnnouncementStore,source:string,provider:string,reason:string,now=Date.now()){
  if(!['groq','gmail','review'].includes(provider))throw new Error('Unknown source failure provider.');
  reason=sanitizeOrganizerEvidence(reason).text;
  const guild=store.db.prepare('SELECT guild FROM sources WHERE id=?').get(source)?.guild as string|undefined;
  if(guild)store.audit(guild,'automation','source-failure',source,{provider,reason},now);
  store.db.prepare('INSERT INTO source_failures VALUES(?,?,?,?) ON CONFLICT(source) DO UPDATE SET provider=excluded.provider,reason=excluded.reason,at=excluded.at').run(source,provider,reason,now);
}
export function clearSourceFailure(store:AnnouncementStore,source:string){store.db.prepare('DELETE FROM source_failures WHERE source=?').run(source);}
export function reconcileExtractionIncident(store:AnnouncementStore,guild:string,healthy:boolean,now=Date.now(),observedOutage=true){
  store.transaction(()=>{
    // Retain pre-upgrade alerts for audit, but prevent their per-email dispatch.
    store.db.prepare("UPDATE staff_alerts SET state='superseded' WHERE guild=? AND kind='extraction-provider-unavailable' AND state='pending'").run(guild);
    const count=Number(store.db.prepare("SELECT COUNT(*) n FROM source_failures f JOIN sources s ON s.id=f.source WHERE s.guild=? AND f.provider='groq' AND s.state IN ('pending','retry','blocked')").get(guild)!.n);
    const old=store.db.prepare("SELECT * FROM operational_incidents WHERE guild=? AND provider='groq'").get(guild) as {episode:string;active:number;last_notice:number;count:number}|undefined;
    if(old?.active&&healthy){
      store.db.prepare("UPDATE staff_alerts SET state='superseded' WHERE guild=? AND kind='provider-outage' AND state='pending'").run(guild);
      store.alert(guild,'provider-recovered',`groq:${old.episode}`,now);
      store.db.prepare("UPDATE operational_incidents SET active=0,count=? WHERE guild=? AND provider='groq'").run(count,guild);
    }else if(count&&(old?.active||observedOutage)&&!healthy){
      const episode=old?.active?old.episode:randomUUID();
      const queued=store.db.prepare("SELECT id FROM staff_alerts WHERE guild=? AND kind='provider-outage' AND state IN ('pending','delivering') LIMIT 1").get(guild);
      const notify=!queued&&(!old?.active||(count!==old.count&&now-old.last_notice>=incidentCooldownMs));
      if(notify)store.alert(guild,'provider-outage',`groq:${episode}:${now}`,now);
      store.db.prepare("INSERT INTO operational_incidents VALUES(?,'groq',?,1,?,?,'temporarily unavailable') ON CONFLICT(guild,provider) DO UPDATE SET episode=excluded.episode,active=1,last_notice=excluded.last_notice,count=excluded.count").run(guild,episode,notify?now:(old?.last_notice??now),count);
      // Count at last notification is retained so growth during cooldown is reported later.
      if(!notify&&old?.active)store.db.prepare("UPDATE operational_incidents SET count=? WHERE guild=? AND provider='groq'").run(old.count,guild);
    }
  });
}
const descriptions:Record<string,string>={
  'factual-review':'New organizer facts need review.', 'correction-held':'Changed organizer facts need review; reminders are held.',
  'gmail-history-gap':'Gmail history expired. Ingestion is paused; staff must explicitly choose a new future-only starting cursor. No historical mail was imported.',
  'blocked-source':'An organizer email needs manual review.', 'gmail-unavailable':'Gmail access is temporarily unavailable. Organizer emails will be retried.',
  'extraction-provider-misconfigured':'Groq extraction is not configured in the automation environment.',
  'writing-unavailable':'Announcement drafting is temporarily unavailable.', 'message-review':'An announcement draft needs approval.',
  'blocked-announcement':'An announcement is blocked pending review.', 'waiting-for-canva':'An announcement is waiting for its required image.',
  'approaching-unapproved':'An upcoming event still needs approval.', 'missed-reminder':'A reminder expired before it could be sent.',
  'uncertain-delivery':'A delivery needs manual reconciliation.', 'stuck-delivery':'A delivery is still awaiting reconciliation.',
  'correction-after-send':'Facts changed after an announcement was sent.', 'cancellation-review':'A cancellation or postponement needs review.'
};
function safeLabel(value:string){return sanitizeOrganizerEvidence(value).text.replace(/[^\p{L}\p{N} .,:()/_-]/gu,' ').slice(0,160);}
export function staffAlertContent(store:AnnouncementStore,guild:string,alert:StaffAlert){
  const header='⚠️ Announcement automation';
  if(alert.kind==='provider-outage'){
    const n=Number(store.db.prepare("SELECT COUNT(*) n FROM source_failures f JOIN sources s ON s.id=f.source WHERE s.guild=? AND f.provider='groq' AND s.state IN ('pending','retry','blocked')").get(guild)!.n);
    return `${header}\nGroq extraction is temporarily unavailable.\n${n} organizer email${n===1?' is':'s are'} waiting for extraction.\n\nUse /announce status for details.`;
  }
  if(alert.kind==='provider-recovered')return '✅ Announcement automation\nGroq extraction is healthy again. Remaining organizer emails will be retried when eligible.\n\nUse /announce status for details.';
  let detail='';
  if(['factual-review','correction-held'].includes(alert.kind)){
    const rows=store.db.prepare("SELECT DISTINCT c.event_json,c.catalog_json FROM candidate_events c JOIN candidate_sources cs ON cs.candidate=c.id JOIN candidate_batches b ON b.source=cs.source WHERE c.guild=? AND b.id=? AND c.state='pending'").all(guild,alert.target) as {event_json:string;catalog_json:string}[];
    if(rows.length){const labels=[...new Set(rows.map(row=>{const e=JSON.parse(row.event_json) as ScheduleEvent,c=JSON.parse(row.catalog_json) as Catalog;const p=c.programs.find(p=>p.id===e.programId),competition=c.competitions.find(p=>p.id===e.competitionId);return safeLabel([p?`${p.name} ${p.version}`:null,competition?`${competition.name} ${competition.year}`:null,e.type].filter(Boolean).join(' · '));}))];
      return `${header}\n${descriptions[alert.kind]}\n${rows.length} candidate${rows.length===1?'':'s'} from one organizer email.\n${labels.slice(0,5).join('\n')}\n\nUse /announce inbox to review each candidate and its source evidence.`;
    }
  }
  if(alert.kind==='blocked-source'){
    const row=store.db.prepare('SELECT reason FROM source_failures WHERE source=?').get(alert.target) as {reason:string}|undefined;
    detail=row?`\nReason: ${safeLabel(row.reason)}`:'';
  }
  const candidate=store.db.prepare('SELECT event_json,catalog_json FROM candidate_events WHERE guild=? AND (event_key=? OR id=?) ORDER BY rowid DESC LIMIT 1').get(guild,alert.target,alert.target) as {event_json:string;catalog_json:string}|undefined;
  if(candidate){const event=JSON.parse(candidate.event_json) as ScheduleEvent,catalog=JSON.parse(candidate.catalog_json) as Catalog;
    const competition=catalog.competitions.find(c=>c.id===event.competitionId),program=catalog.programs.find(p=>p.id===event.programId),round=catalog.rounds.find(r=>r.id===event.roundId);
    detail+=`\n${safeLabel([competition?.name,competition?.year,program?`${program.name} ${program.version}`:null,round?.name,event.type,event.slot].filter(Boolean).join(' · '))}`;
  }
  return `${header}\n${descriptions[alert.kind]??'An announcement needs staff attention.'}${detail}\n\nUse /announce inbox or /announce status for details.`;
}
