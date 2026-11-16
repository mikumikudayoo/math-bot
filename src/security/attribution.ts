export interface AuditCandidate { id:string; action:number; targetId:string|null; actorId:string|null; createdAt:number }
/** Correlation only. Missing/ambiguous attribution never authorizes a sanction. */
export function correlateAudit(entries:AuditCandidate[],event:{action:number;targetId:string;createdAt:number},windowMs=10000):
  {state:'matched';actorId:string;entryId:string}|{state:'missing'|'ambiguous'} {
  if(!Number.isFinite(windowMs)||windowMs<0||windowMs>60000)throw new Error('Invalid audit correlation window.');
  const matches=[...new Map(entries.filter(e=>e.action===event.action&&e.targetId===event.targetId&&Number.isFinite(e.createdAt)&&Math.abs(e.createdAt-event.createdAt)<=windowMs).map(e=>[e.id,e])).values()];
  if(!matches.length)return {state:'missing'};
  if(matches.length!==1)return {state:'ambiguous'};
  const entry=matches[0]!;
  if(!entry.actorId||!/^\d{17,20}$/.test(entry.actorId))return {state:'missing'};
  return {state:'matched',actorId:entry.actorId,entryId:entry.id};
}
