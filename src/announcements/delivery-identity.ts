import { validatePolicy,type PolicyFile,type Policy } from './config.js';
import { canonical,digest,renderEvent,type ScheduleEvent,type Catalog,type PreviewConfig } from './model.js';

/** The host's configuration generation; this is not a delivery identity. */
export interface EffectivePolicySnapshot {
  guild:string;
  revision:number;
  fingerprint:string;
  policy:PolicyFile;
}

/** Structural so policy registration does not depend on AnnouncementStore. */
export interface PolicySnapshotStore {
  state(key:string):string|undefined;
  setState(key:string,value:string):void;
  transaction<T>(fn:()=>T):T;
}

const policyStateKey=(guild:string)=>{
  if(!/^\d{17,20}$/.test(guild))throw new Error('Invalid announcement policy guild.');
  return `policy:${guild}:effective`;
};

export function effectivePolicy(store:Pick<PolicySnapshotStore,'state'>,guild:string):EffectivePolicySnapshot|undefined {
  const value=store.state(policyStateKey(guild));if(value===undefined)return undefined;
  try{
    const snapshot=JSON.parse(value) as EffectivePolicySnapshot;
    if(!snapshot||snapshot.guild!==guild||!Number.isSafeInteger(snapshot.revision)||snapshot.revision<1||snapshot.policy?.guild!==guild)throw new Error();
    validatePolicy(snapshot.policy);
    if(snapshot.fingerprint!==digest(snapshot.policy))throw new Error();
    return snapshot;
  }catch{throw new Error('Invalid effective announcement policy state; reconciliation is blocked.');}
}

/**
 * Read the expected revision BEFORE loading fresh runtime configuration. A stale
 * caller cannot replace a newer generation. Conflicts require a fresh read of
 * both the durable snapshot and runtime configuration, never a blind retry.
 * This helper owns its transaction; call it before the planner transaction.
 */
export function registerEffectivePolicy(store:PolicySnapshotStore,policy:PolicyFile,expectedRevision:number):{accepted:boolean;snapshot:EffectivePolicySnapshot} {
  validatePolicy(policy);
  if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0)throw new Error('Invalid expected announcement policy revision.');
  const key=policyStateKey(policy.guild),fingerprint=digest(policy);
  return store.transaction(()=>{
    const current=effectivePolicy(store,policy.guild);
    if(current?.fingerprint===fingerprint)return {accepted:true,snapshot:current};
    if((current?.revision??0)!==expectedRevision){
      // A conflict necessarily has a current snapshot: revision zero is the
      // only valid expected revision when no policy has been registered.
      if(!current)throw new Error('Announcement policy revision is stale.');
      return {accepted:false,snapshot:current};
    }
    const revision=(current?.revision??0)+1;
    if(!Number.isSafeInteger(revision))throw new Error('Announcement policy revision limit reached.');
    const snapshot:EffectivePolicySnapshot={guild:policy.guild,revision,fingerprint,policy:JSON.parse(canonical(policy)) as PolicyFile};
    store.setState(key,canonical(snapshot));
    return {accepted:true,snapshot};
  });
}

/** Call inside the same transaction that changes the plan or reserves delivery. */
export function isEffectivePolicy(store:Pick<PolicySnapshotStore,'state'>,snapshot:EffectivePolicySnapshot):boolean {
  const current=effectivePolicy(store,snapshot.guild);
  return !!current&&current.revision===snapshot.revision&&current.fingerprint===snapshot.fingerprint&&snapshot.fingerprint===digest(snapshot.policy);
}

export interface LogicalDeliveryIdentity {
  guild:string;
  eventKey:string;
  revision:number;
  ruleId:string;
  anchor:'start'|'deadline'|'approval';
  channel:string;
  /** A distinct occurrence must come from an explicit audited staff action. */
  occurrence?:string;
}

/** Templates, mentions, timing anchors/offsets and staff routing do not reissue a delivery. */
export function logicalDeliveryId(identity:LogicalDeliveryIdentity):string {
  const {guild,eventKey,revision,ruleId,anchor,channel}=identity,occurrence=identity.occurrence??'original';
  if(!/^\d{17,20}$/.test(guild)||!/^\d{17,20}$/.test(channel)||typeof eventKey!=='string'||!eventKey.startsWith(`${guild}:`)||eventKey.length<=guild.length+1||!Number.isSafeInteger(revision)||revision<1||typeof ruleId!=='string'||!ruleId.trim()||ruleId.length>200||!['start','deadline','approval'].includes(anchor)||typeof occurrence!=='string'||!occurrence.trim()||occurrence.length>200)throw new Error('Invalid logical announcement delivery identity.');
  return digest(['announcement-logical-delivery-v1',guild,eventKey,revision,ruleId,channel,occurrence]);
}

export interface DeliveryEventProjection {
  event_key:string;
  revision:number;
  approved_at:number;
  event_json:string;
  catalog_json:string;
}

export function policyMatchesEvent(rule:Policy,event:ScheduleEvent):boolean {
  return rule.type===event.type&&(!rule.programId||rule.programId===event.programId)&&(!rule.competitionId||rule.competitionId===event.competitionId)&&(!rule.roundId||rule.roundId===event.roundId);
}

/** The deterministic baseline stays separate from an individually approved draft. */
export function projectDelivery(row:DeliveryEventProjection,policy:PolicyFile,rule:Policy) {
  const event=JSON.parse(row.event_json) as ScheduleEvent,catalog=JSON.parse(row.catalog_json) as Catalog;
  if((event.status??'active')!=='active'||!policyMatchesEvent(rule,event))throw new Error('Announcement policy does not apply to the current event.');
  const channel=rule.channel??policy.channel,role=rule.role===undefined?policy.role:rule.role;
  const logical_delivery_id=logicalDeliveryId({guild:policy.guild,eventKey:row.event_key,revision:row.revision,ruleId:rule.id,anchor:rule.anchor,channel});
  const anchor=rule.anchor==='approval'?row.approved_at:event[rule.anchor];
  // An unresolved anchor remains blocked and stable across planner retries.
  const scheduled=anchor===null?row.approved_at:anchor-rule.beforeMinutes*60000;
  const due=rule.major?Math.max(row.approved_at,scheduled):scheduled;
  const grace=(rule.reminderGraceMinutes??1)*60000;
  // Scheduled reminders get a short clock-based grace, never a late catch-up
  // horizon. At offset zero the grace starts at the anchor, rather than creating
  // an unusable zero-length interval. Earlier reminders stop at their anchor.
  let expires=due+grace;
  if(!rule.major&&rule.anchor!=='approval'&&rule.beforeMinutes>0&&anchor!==null)expires=Math.min(expires,anchor);
  if(rule.major){
    // Fact approval fixes editorial freshness. A restart or delayed asset/text
    // review cannot move this horizon forward to the current clock time.
    expires=row.approved_at+(rule.editorialWindowMinutes??1440)*60000;
    // Results, qualification, resources, and login notices may be announced
    // after their occurrence. Operative schedule/deadline announcements stop
    // being timely when participation is no longer possible.
    const operative=['training-session','competition-day','check-in','mock-test-window','schedule-announcement','competition-announcement','server-event'].includes(event.type)?event.start:event.type.endsWith('deadline')?event.deadline:null;
    if(operative!==null){const zeroOffsetGrace=rule.anchor!=='approval'&&rule.beforeMinutes===0&&anchor===operative?grace:0;expires=Math.min(expires,operative+zeroOffsetGrace);}
  }
  let blocked=anchor===null,payload={content:'',allowedMentions:{parse:[] as [],roles:[] as string[],users:[] as string[],repliedUser:false}};
  const config:PreviewConfig={guild:policy.guild,channel,role,rules:[],templates:policy.templates};
  try{payload=renderEvent(event,catalog,config,rule.template);}catch{blocked=true;}
  const projection={logical_delivery_id,rule_id:rule.id,channel,role,due,expires,major:+rule.major,asset_policy:rule.asset,payload_json:canonical(payload),blocked};
  return {...projection,plan_hash:digest(projection)};
}
