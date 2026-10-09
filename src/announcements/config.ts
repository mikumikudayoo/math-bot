import { config as dotenv } from 'dotenv';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { documentTemplates,validateConfig,type PreviewConfig,type EventType } from './model.js';
import type { ProviderConfig } from '../service/providers.js';

export interface Policy { id:string; type:EventType; anchor:'start'|'deadline'|'approval'; beforeMinutes:number; template:string; major:boolean; asset:'none'|'optional'|'required'; competitionId?:string; programId?:string; roundId?:string;channel?:string;role?:string|null }
export interface PolicyFile { guild:string; channel:string; role:string|null; staffChannel:string|null; policies:Policy[]; templates:Record<string,string> }
export interface AutomationConfig { enabled:boolean; autoSend:boolean; database:string; assets:string; policy:PolicyFile; gmail:{clientId:string;clientSecret:string;refreshToken:string;account:string;query:string;senders:string[]}; provider:ProviderConfig; pollMs:number }
export function validatePolicy(p:PolicyFile){
  const preview:PreviewConfig={guild:p.guild,channel:p.channel,role:p.role,rules:p.policies.map(r=>({...r,anchor:r.anchor==='approval'?'start':r.anchor})),templates:p.templates};validateConfig(preview);
  if(p.staffChannel!==null&&!/^\d{17,20}$/.test(p.staffChannel))throw new Error('Invalid private staff channel.');
  for(const r of p.policies){
    if(r.channel!==undefined&&!/^\d{17,20}$/.test(r.channel))throw new Error('Invalid policy channel.');
    if(r.role!==undefined&&r.role!==null&&(!/^\d{17,20}$/.test(r.role)||r.role===p.guild))throw new Error('Invalid policy role.');
    if(!['start','deadline','approval'].includes(r.anchor))throw new Error('Invalid reminder anchor.');
    if(typeof r.major!=='boolean'||!['none','optional','required'].includes(r.asset))throw new Error('Invalid asset policy.');
    if(['schedule-announcement','competition-announcement','results','qualification','materials-release'].includes(r.type)&&!r.major)throw new Error('Major milestones require message approval.');
    if(!r.major && r.asset==='required')throw new Error('Routine reminders cannot depend on unreviewed assets.');
  }
}
export function automationConfig(mode=process.env.BOT_ENV??'development'):AutomationConfig {
  if(!['development','production'].includes(mode))throw new Error('Invalid BOT_ENV.');
  const env:NodeJS.ProcessEnv={};dotenv({path:`.env.automation.${mode}`,processEnv:env,quiet:true});
  const enabled=env.ANNOUNCEMENT_AUTOMATION_ENABLED==='true';
  if(env.GMAIL_BOOTSTRAP_MODE&&env.GMAIL_BOOTSTRAP_MODE!=='future-only')throw new Error('Only future-only Gmail bootstrap is supported; historical backfill is disabled.');
  const policyPath=env.ANNOUNCEMENT_POLICY_PATH;
  const policy:PolicyFile=policyPath?JSON.parse(readFileSync(policyPath,'utf8')) as PolicyFile:{guild:'111111111111111111',channel:'222222222222222222',role:null,staffChannel:null,policies:[],templates:documentTemplates};
  if(enabled&&!policyPath)throw new Error('Configure ANNOUNCEMENT_POLICY_PATH before enabling automation.');validatePolicy(policy);
  const query=env.GMAIL_QUERY??'';const senders=(env.GMAIL_ORGANIZER_SENDERS??'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
  if(enabled&&(!query.trim()||!senders.length))throw new Error('Configure a restricted Gmail query and organizer sender list.');
  if(senders.some(s=>! /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(s)))throw new Error('Organizer senders must be explicit email addresses.');
  const pollMs=Number(env.ANNOUNCEMENT_POLL_SECONDS??120)*1000;if(!Number.isFinite(pollMs)||pollMs<30000||pollMs>3600000)throw new Error('Invalid polling interval.');
  return {enabled,autoSend:env.ANNOUNCEMENT_AUTO_SEND_ENABLED==='true',database:resolve(env.ANNOUNCEMENT_DB_PATH??`data/announcements.${mode}.sqlite`),assets:resolve(env.ANNOUNCEMENT_ASSET_PATH??`data/announcement-assets.${mode}`),policy,gmail:{clientId:env.GMAIL_CLIENT_ID??'',clientSecret:env.GMAIL_CLIENT_SECRET??'',refreshToken:env.GMAIL_REFRESH_TOKEN??'',account:env.GMAIL_ACCOUNT_ID??'primary',query,senders},provider:{backend:'https://api.groq.com/openai/v1',model:env.EXTERNAL_INFERENCE_MODEL??'openai/gpt-oss-120b',backendKey:env.GROQ_API_KEY??'',vision:false,nativeTools:false},pollMs};
}
