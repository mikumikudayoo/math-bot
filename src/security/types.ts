export type Source = 'message' | 'profile';
export type Action = 'review' | 'reminder' | 'warn' | 'timeout';
export interface Exemptions { users: string[]; roles: string[]; channels: string[]; categories: string[] }
export interface ModerationInput {
  guild: string; eventId: string; source: Source; content: string;
  author: { id: string; bot: boolean; staff: boolean };
  channel: { id: string; category: string | null; parent: string | null };
  roles: string[]; timestamp: number;
}
export interface Rule {
  id: string; enabled: boolean; type: 'keyword' | 'regex' | 'domain'; patterns: string[];
  policy: string; severity: 'soft' | 'medium' | 'severe' | 'scam' | 'spam';
  source: Source; minConfidence: number; obfuscation: boolean; exemptions: Exemptions; notes: string;
}
export interface Policy {
  id: string; delete: boolean; count: boolean; windowMs: number; warningExpiryMs: number;
  steps: { count: number; action: Action; durationMs: number }[];
}
export interface SecurityConfig {
  version: 1; mode: 'disabled' | 'shadow' | 'enforce'; rules: Rule[]; policies: Policy[];
  exemptions: Exemptions; exemptStaff: boolean; securityRoles: string[]; logChannel: string | null;
  maxActionsPerMinute: number;
}
export interface Finding { ruleId: string; category: Rule['type']; severity: Rule['severity']; policy: string; confidence: number; evidence: string; variant: string }
export interface Decision { findings: Finding[]; action: Action; delete: boolean; durationMs: number; policy: string | null; count: boolean; windowMs: number; warningExpiryMs: number }
export interface CaseRecord { id: number; guild: string; event: string; eventId: string; user: string; source: Source; created: number; mode: SecurityConfig['mode']; origin: 'automatic' | 'manual'; actor: string; reason: string; findings: Finding[]; decision: Decision; configVersion: number }
export const emptyExemptions = (): Exemptions => ({ users: [], roles: [], channels: [], categories: [] });
export function defaultSecurityConfig(): SecurityConfig {
  return { version: 1, mode: 'disabled', rules: [], policies: [
    { id:'soft', delete:true, count:false, windowMs:7*86400000, warningExpiryMs:30*86400000, steps:[{count:1,action:'reminder',durationMs:0}] },
    { id:'medium', delete:true, count:true, windowMs:7*86400000, warningExpiryMs:30*86400000, steps:[{count:1,action:'reminder',durationMs:0},{count:2,action:'warn',durationMs:0}] },
  ], exemptions:emptyExemptions(), exemptStaff:true, securityRoles:[], logChannel:null, maxActionsPerMinute:5 };
}
