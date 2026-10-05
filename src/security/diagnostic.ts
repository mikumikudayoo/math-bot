export interface Capability { name:string; state:'operational'|'degraded'|'unavailable'|'not implemented'; detail:string }
export interface DiagnosticInput { messageContent:boolean; enabled:boolean; permissions:Record<string,boolean>; hierarchy:boolean; autoMod:boolean|null }
export function diagnostics(input:DiagnosticInput):Capability[]{
  const p=input.permissions;
  return [
    {name:'content detection',state:input.enabled&&input.messageContent?'operational':'unavailable',detail:!input.enabled?'New moderation engine is disabled.':!input.messageContent?'Enable Message Content intent and message features.':'Keyword, bounded regex and domain rules available.'},
    {name:'message deletion',state:p.ViewChannel&&p.ManageMessages?'operational':'unavailable',detail:'Requires View Channel and Manage Messages in the target channel; channel overwrites are rechecked for each action.'},
    {name:'timeouts',state:p.ModerateMembers?(input.hierarchy?'operational':'degraded'):'unavailable',detail:'Requires Moderate Members and a role above the target. Owners and administrators cannot be timed out.'},
    {name:'audit attribution',state:p.ViewAuditLog?'not implemented':'unavailable',detail:p.ViewAuditLog?'Permission available; attribution detectors are a later phase.':'View Audit Log is missing.'},
    {name:'role quarantine',state:p.ManageRoles&&input.hierarchy?'not implemented':'unavailable',detail:'Later phase. Requires Manage Roles and sufficient hierarchy; managed integration roles cannot simply be stripped.'},
    {name:'channel recovery',state:p.ManageChannels?'not implemented':'unavailable',detail:'Later phase. Restoration cannot preserve deleted resource IDs or promise perfect recovery.'},
    {name:'kick/ban protection',state:p.KickMembers&&p.BanMembers?'not implemented':'unavailable',detail:'Later phase; no kick/ban detector or automatic action is installed.'},
    {name:'webhook protection',state:p.ManageWebhooks?'not implemented':'unavailable',detail:'Later phase; Manage Webhooks required.'},
    {name:'Discord AutoMod fallback',state:input.autoMod===true?'operational':input.autoMod===false?'degraded':'unavailable',detail:input.autoMod===null?'Unable to inspect built-in rules; check Manage Server.':input.autoMod?'At least one built-in rule is enabled. Coverage still depends on that rule configuration.':'No enabled built-in rule was found.'},
  ];
}
