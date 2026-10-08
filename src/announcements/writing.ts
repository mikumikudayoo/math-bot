import { completeProvider,type ProviderConfig } from '../service/providers.js';
import { renderEvent,digest,type ScheduleEvent,type Catalog,type PreviewConfig } from './model.js';
import { AnnouncementStore } from './store.js';
import type { PolicyFile } from './config.js';
const placeholders=new Set(['role','competition','year','round','program','version','slot','date','timeRange','deadline','url','detailLabel']);
export function validateLockedDraft(text:string){
  if(typeof text!=='string'||!text.trim()||text.length>1600)throw new Error('Invalid draft length.');
  const tokens=[...text.matchAll(/\{\{(\w+)\}\}/g)];if(!tokens.length||tokens.some(t=>!placeholders.has(t[1]!)))throw new Error('Unknown or missing locked placeholders.');
  const prose=text.replace(/\{\{\w+\}\}/g,'');if(/\d|https?:|@|<t:|\{\{|\}\}|\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(prose))throw new Error('Authoritative dates/mentions/links must remain locked.');
}
export async function draftMajor(store:AnnouncementStore,policy:PolicyFile,provider:ProviderConfig,signal:AbortSignal,complete:typeof fetch=fetch){
  const jobs=store.jobs(policy.guild).filter(j=>j.major&&j.state==='pending_approval');
  for(const j of jobs.slice(0,5)){
    if(store.db.prepare('SELECT job FROM announcement_drafts WHERE job=?').get(j.id))continue;
    const row=store.event(policy.guild,j.event_key);if(!row||row.revision!==j.revision||store.held(row.event_key))continue;
    const e=JSON.parse(row.event_json) as ScheduleEvent,catalog=JSON.parse(row.catalog_json) as Catalog;
    // AI sees approved public structured facts, never organizer body or credentials.
    const result=await completeProvider(provider,{messages:[{role:'system',content:'Draft a short Mathematikaws announcement from approved facts. Return JSON {"text":"..."}. Use only lowercase named locked placeholders {{role}}, {{competition}}, {{year}}, {{round}}, {{program}}, {{version}}, {{slot}}, {{date}}, {{timeRange}}, {{deadline}}, {{url}}, {{detailLabel}} for authoritative values. Do not type dates, numbers, role IDs or URLs. Do not invent outcomes or qualification. This message still needs human editorial approval.'},{role:'user',content:JSON.stringify({event:e,catalog,templateStyle:policy.templates})}],response_format:{type:'json_object'},max_tokens:600,temperature:0.2},signal,complete) as {choices?:{message?:{content?:string}}[]};
    const output=JSON.parse(result.choices?.[0]?.message?.content??'{}') as {text?:string};validateLockedDraft(output.text??'');
    const config:PreviewConfig={guild:policy.guild,channel:j.channel,role:j.role,rules:[],templates:{draft:output.text!}};
    const payload=renderEvent(e,catalog,config,'draft');
    store.transaction(()=>{
      const latest=store.job(policy.guild,j.id);if(latest?.state!=='pending_approval'||store.event(policy.guild,j.event_key)?.revision!==j.revision||store.held(j.event_key))return;
      store.db.prepare("UPDATE announcement_jobs SET payload_json=?,approved_by=NULL WHERE id=?").run(JSON.stringify(payload),j.id);store.db.prepare("INSERT INTO announcement_drafts(job,state) VALUES(?,'ready')").run(j.id);store.audit(policy.guild,'writer','draft',j.id,{payloadHash:digest(payload)});
    });
  }
}
