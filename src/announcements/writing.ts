import { completeAnnouncement } from './provider.js';
import type { ProviderConfig } from '../service/providers.js';
import { renderEvent,digest,validateEvent,type ScheduleEvent,type Catalog,type PreviewConfig } from './model.js';
import { AnnouncementStore } from './store.js';
import type { PolicyFile } from './config.js';
import {effectivePolicy,isEffectivePolicy,type EffectivePolicySnapshot} from './delivery-identity.js';
const placeholders=new Set(['role','competition','year','round','program','version','slot','date','timeRange','deadline','url','detailLabel']);
export function validateLockedDraft(text:string){
  if(typeof text!=='string'||!text.trim()||text.length>1600)throw new Error('Invalid draft length.');
  const tokens=[...text.matchAll(/\{\{(\w+)\}\}/g)];if(!tokens.length||tokens.some(t=>!placeholders.has(t[1]!)))throw new Error('Unknown or missing locked placeholders.');
  const prose=text.replace(/\{\{\w+\}\}/g,'');if(/\d|https?:|@|<t:|\{\{|\}\}|\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(prose))throw new Error('Authoritative dates/mentions/links must remain locked.');
}
export async function draftApprovedFacts(provider: ProviderConfig, operationId: string, e: ScheduleEvent, catalog: Catalog,
  destination: Pick<PreviewConfig,'guild'|'channel'|'role'|'templates'>, signal: AbortSignal, complete: typeof fetch = fetch) {
  validateEvent(e,catalog,true);
  // Only the approved, structured public facts and editorial style are sent to the writer.
  const format = provider.kind === 'openai'
    ? {type:'json_schema',json_schema:{name:'announcement_draft',strict:true,
      schema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false}}}
    : {type:'json_object'};
  const result = await completeAnnouncement(provider,'draft',operationId,{
    messages:[
      {role:'system',content:'Draft a short Mathematikaws announcement from approved facts. Return JSON {"text":"..."}. Use only these exact named locked placeholders {{role}}, {{competition}}, {{year}}, {{round}}, {{program}}, {{version}}, {{slot}}, {{date}}, {{timeRange}}, {{deadline}}, {{url}}, {{detailLabel}} for authoritative values. Do not type dates, numbers, role IDs or URLs. Do not invent outcomes or qualification. This message still needs human editorial approval.'},
      {role:'user',content:JSON.stringify({event:e,catalog,templateStyle:destination.templates})},
    ],response_format:format,max_tokens:600,temperature:0.2,
  },signal,complete) as {choices?:{finish_reason?:string;message?:{content?:string}}[]};
  if (provider.kind==='openai' && result.choices?.[0]?.finish_reason !== 'stop') throw new Error('Incomplete or refused announcement draft.');
  const output: unknown = JSON.parse(result.choices?.[0]?.message?.content ?? '{}');
  if (!output || typeof output !== 'object' || !('text' in output) || typeof output.text !== 'string' ||
      (provider.kind==='openai' && Object.keys(output).length !== 1)) throw new Error('Invalid announcement draft schema.');
  validateLockedDraft(output.text);
  const payload = renderEvent(e,catalog,{...destination,rules:[],templates:{draft:output.text}},'draft');
  return {template:output.text,payload};
}
export async function draftMajor(store:AnnouncementStore,policy:PolicyFile,provider:ProviderConfig,signal:AbortSignal,complete:typeof fetch=fetch,snapshot?:EffectivePolicySnapshot){
  snapshot??=effectivePolicy(store,policy.guild);
  if(!snapshot||snapshot.fingerprint!==digest(policy)||!isEffectivePolicy(store,snapshot))return;
  const jobs=store.jobs(policy.guild).filter(j=>j.major&&j.state==='pending_approval');
  for(const j of jobs.slice(0,5)){
    if(store.db.prepare('SELECT job FROM announcement_drafts WHERE job=?').get(j.id))continue;
    const row=store.event(policy.guild,j.event_key);if(!row||row.revision!==j.revision||store.held(row.event_key))continue;
    const e=JSON.parse(row.event_json) as ScheduleEvent,catalog=JSON.parse(row.catalog_json) as Catalog;
    if(row.public_safety_version!==1||row.fact_semantics_version!==1||!store.eventEvidenceCurrent(row))continue;
    const {payload}=await draftApprovedFacts(provider,digest([j.id,j.revision,snapshot.fingerprint]),e,catalog,
      {guild:policy.guild,channel:j.channel,role:j.role,templates:policy.templates},signal,complete);
    store.transaction(()=>{
      if(!isEffectivePolicy(store,snapshot!))return;
      const latest=store.job(policy.guild,j.id);if(latest?.state!=='pending_approval'||store.event(policy.guild,j.event_key)?.revision!==j.revision||store.held(j.event_key))return;
      store.db.prepare("UPDATE announcement_jobs SET payload_json=?,approved_by=NULL,approved_payload_hash=NULL WHERE id=?").run(JSON.stringify(payload),j.id);store.db.prepare("INSERT INTO announcement_drafts(job,state) VALUES(?,'ready')").run(j.id);store.audit(policy.guild,'writer','draft',j.id,{payloadHash:digest(payload)});
    });
  }
}
