import { domainToASCII } from 'node:url';
import type { SecurityConfig, Exemptions, Rule } from './types.js';
import { normalizeText } from './normalization.js';

const object=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('Expected a configuration object.');return v as Record<string,unknown>;};
const keys=(v:Record<string,unknown>,allowed:string[])=>{if(Object.keys(v).some(k=>!allowed.includes(k)))throw new Error('Unknown configuration field.');};
const integer=(v:unknown,min:number,max:number)=>{if(!Number.isSafeInteger(v)||Number(v)<min||Number(v)>max)throw new Error('Invalid configuration number.');return Number(v);};
const bool=(v:unknown)=>{if(typeof v!=='boolean')throw new Error('Expected true or false.');return v;};
const name=(v:unknown)=>{if(typeof v!=='string'||! /^[a-z][a-z0-9-]{0,63}$/.test(v))throw new Error('Use a stable lowercase ID.');return v;};
const ids=(v:unknown)=>{if(!Array.isArray(v)||v.length>100||v.some(x=>typeof x!=='string'||!/^\d{17,20}$/.test(x)))throw new Error('Expected up to 100 Discord IDs.');return [...new Set(v)] as string[];};
export function validateExemptions(value:unknown):Exemptions {
  const v=object(value);keys(v,['users','roles','channels','categories']);
  return {users:ids(v.users),roles:ids(v.roles),channels:ids(v.channels),categories:ids(v.categories)};
}
/** Bounded regex subset: no groups, alternation, backreferences or unbounded repetition. */
export function compileSafeRegex(pattern:string):RegExp {
  if(pattern.length>160||/[()|*+]/.test(pattern)||/\\[1-9k]/.test(pattern))throw new Error('Regex uses unsupported unbounded or branching syntax.');
  if((pattern.match(/[?{]/g)??[]).length>1)throw new Error('Regex supports at most one bounded repetition or optional atom.');
  const bounds=[...pattern.matchAll(/\{([^}]+)\}/g)];
  for(const bound of bounds){const match=bound[1]!.match(/^(\d+)(?:,(\d+))?$/);if(!match||Number(match[1])>32||Number(match[2]??match[1])>32||Number(match[2]??match[1])<Number(match[1]))throw new Error('Regex repetition must be bounded to 32.');}
  if(/(?:\?|\})(?:\?|\{)/.test(pattern)||/\{[^}]*$/.test(pattern))throw new Error('Nested repetition is unsupported.');
  return new RegExp(pattern,'iu');
}
export function normalizeDomain(pattern:string):string {
  if(/[\s/@:#?\\]/.test(pattern))throw new Error('Use a domain name, without a URL or wildcard.');
  const domain=domainToASCII(pattern.normalize('NFKC').toLowerCase()).replace(/\.$/,'');
  if(!domain||domain.length>253||!domain.includes('.')||domain.split('.').some(label=>! /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))throw new Error('Invalid domain.');
  return domain;
}
export function validateSecurityConfig(value:unknown):SecurityConfig {
  const v=object(value);keys(v,['version','mode','rules','policies','exemptions','exemptStaff','securityRoles','logChannel','maxActionsPerMinute']);
  if(v.version!==1||!['disabled','shadow','enforce'].includes(String(v.mode)))throw new Error('Unsupported config version or mode.');
  if(!Array.isArray(v.rules)||v.rules.length>100||!Array.isArray(v.policies)||!v.policies.length||v.policies.length>20)throw new Error('Limit rules to 100 and policies to 20.');
  const policies=v.policies.map(value=>{
    const p=object(value);keys(p,['id','delete','count','windowMs','warningExpiryMs','steps']);
    if(!Array.isArray(p.steps)||!p.steps.length||p.steps.length>10)throw new Error('Supply 1–10 escalation steps.');
    let previous=0;
    const steps=p.steps.map(value=>{const s=object(value);keys(s,['count','action','durationMs']);const count=integer(s.count,1,100);if(count<=previous)throw new Error('Escalation counts must increase.');previous=count;
      if(!['review','reminder','warn','timeout'].includes(String(s.action)))throw new Error('Unsupported phase 1 action.');
      const durationMs=integer(s.durationMs,0,28*86400000);if((s.action==='timeout'&&durationMs<1000)||(s.action!=='timeout'&&durationMs!==0))throw new Error('Invalid action duration.');
      return {count,action:s.action as 'review'|'reminder'|'warn'|'timeout',durationMs};});
    if(steps[0]!.count!==1)throw new Error('First step must start at one violation.');
    return {id:name(p.id),delete:bool(p.delete),count:bool(p.count),windowMs:integer(p.windowMs,1000,90*86400000),warningExpiryMs:integer(p.warningExpiryMs,1000,365*86400000),steps};
  });
  if(new Set(policies.map(p=>p.id)).size!==policies.length)throw new Error('Duplicate policy IDs.');
  const rules:Rule[]=v.rules.map(value=>{
    const r=object(value);keys(r,['id','enabled','type','patterns','policy','severity','source','minConfidence','obfuscation','exemptions','notes']);
    if(!['keyword','regex','domain'].includes(String(r.type))||!['message','profile'].includes(String(r.source))||!['soft','medium','severe','scam','spam'].includes(String(r.severity)))throw new Error('Invalid rule type, source or severity.');
    if(!Array.isArray(r.patterns)||!r.patterns.length||r.patterns.length>20||r.patterns.some(x=>typeof x!=='string'||!x.trim()||x.length>160))throw new Error('Supply 1–20 bounded patterns.');
    const patterns=(r.patterns as string[]).map(p=>{if(r.type==='regex')compileSafeRegex(p);if(r.type==='keyword'&&!normalizeText(p).clean)throw new Error('Keyword cannot normalize to empty text.');return r.type==='domain'?normalizeDomain(p):p;});
    const policy=name(r.policy);if(!policies.some(p=>p.id===policy))throw new Error('Rule references a missing policy.');
    if(typeof r.minConfidence!=='number'||!Number.isFinite(r.minConfidence)||r.minConfidence<0.8||r.minConfidence>1)throw new Error('Confidence must be between 0.8 and 1.');
    if(typeof r.notes!=='string'||r.notes.length>500)throw new Error('Notes must be at most 500 characters.');
    return {id:name(r.id),enabled:bool(r.enabled),type:r.type as Rule['type'],patterns,policy,severity:r.severity as Rule['severity'],source:r.source as Rule['source'],minConfidence:r.minConfidence,obfuscation:bool(r.obfuscation),exemptions:validateExemptions(r.exemptions),notes:r.notes};
  });
  if(new Set(rules.map(r=>r.id)).size!==rules.length)throw new Error('Duplicate rule IDs.');
  if(rules.reduce((n,r)=>n+r.patterns.length,0)>200)throw new Error('Limit the complete configuration to 200 patterns.');
  const logChannel=v.logChannel===null?null:ids([v.logChannel])[0]!;
  return {version:1,mode:v.mode as SecurityConfig['mode'],rules,policies,exemptions:validateExemptions(v.exemptions),exemptStaff:bool(v.exemptStaff),securityRoles:ids(v.securityRoles),logChannel,maxActionsPerMinute:integer(v.maxActionsPerMinute,1,20)};
}
