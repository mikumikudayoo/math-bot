import { digest,type ScheduleEvent } from './model.js';
import { validatePolicy,type PolicyFile } from './config.js';
import { AnnouncementStore,type AnnouncementJob } from './store.js';
import { effectivePolicy,isEffectivePolicy,registerEffectivePolicy,projectDelivery,policyMatchesEvent,type EffectivePolicySnapshot } from './delivery-identity.js';

export function plan(store:AnnouncementStore,policy:PolicyFile,now=Date.now(),snapshot?:EffectivePolicySnapshot){
  validatePolicy(policy);
  // First-time synthetic/standalone callers may initialize authority. Once set,
  // only an explicit host registration can install a different policy.
  let current=snapshot??effectivePolicy(store,policy.guild);
  if(!current){const initialized=registerEffectivePolicy(store,policy,0);current=initialized.snapshot;}
  const authoritative=current;
  return store.transaction(()=>{
    if(authoritative.guild!==policy.guild||authoritative.fingerprint!==digest(policy)||!isEffectivePolicy(store,authoritative))throw new Error('Announcement policy snapshot is stale; reload runtime configuration.');
    const desired=new Set<string>();
    for(const row of store.events(policy.guild)){
      if(row.public_safety_version!==1||row.fact_semantics_version!==1){store.alert(policy.guild,'public-safety-review',row.event_key,now);continue;}
      const e=JSON.parse(row.event_json) as ScheduleEvent;
      if((e.status??'active')!=='active')continue;
      for(const rule of policy.policies){
        if(!policyMatchesEvent(rule,e))continue;
        const projection=projectDelivery(row,policy,rule),logical=projection.logical_delivery_id;
        desired.add(logical);
        if(store.legacyDeliveryGuard(policy.guild,row.event_key,row.revision,projection.channel)){store.alert(policy.guild,'delivery-identity-review',row.event_key,now);continue;}
        const active=store.db.prepare("SELECT * FROM announcement_jobs WHERE guild=? AND logical_delivery_id=? AND state IN ('scheduled','held','pending_approval','blocked','draft') ORDER BY rowid DESC").all(policy.guild,logical) as unknown as AnnouncementJob[];
        if(store.logicalDeliveryConsumed(logical)){
          for(const old of active)store.db.prepare("UPDATE announcement_jobs SET state='superseded' WHERE id=? AND NOT EXISTS(SELECT 1 FROM delivery_attempts WHERE job=?)").run(old.id,old.id);
          continue;
        }
        const same=active.find(j=>j.plan_hash===projection.plan_hash&&(projection.blocked||j.public_safety_version===1));
        for(const old of active){if(old.id!==same?.id)store.db.prepare("UPDATE announcement_jobs SET state='superseded' WHERE id=? AND NOT EXISTS(SELECT 1 FROM delivery_attempts WHERE job=?)").run(old.id,old.id);}
        let state=projection.blocked?'blocked':rule.major?'pending_approval':'scheduled';
        if(!projection.blocked&&now>projection.expires)state='skipped';
        const unheld=state;if(store.held(row.event_key))state='held';
        const job=same??store.addJob({guild:policy.guild,event_key:row.event_key,revision:row.revision,policy:digest([authoritative.revision,rule.id,projection.plan_hash]),channel:projection.channel,role:projection.role,due:projection.due,expires:projection.expires,major:projection.major,asset_policy:projection.asset_policy,payload_json:projection.payload_json,state,logical_delivery_id:logical,rule_id:rule.id,policy_revision:authoritative.revision,plan_hash:projection.plan_hash});
        if(job.state==='held')store.db.prepare('UPDATE announcement_jobs SET held_from=COALESCE(held_from,?) WHERE id=?').run(unheld,job.id);
        if(job.state==='blocked')store.alert(policy.guild,'blocked-announcement',job.id,now);
        if(job.state==='skipped')store.alert(policy.guild,'missed-reminder',job.id,now);
        if(job.major && job.state==='pending_approval')store.alert(policy.guild,job.asset_policy==='required'&&!job.asset?'waiting-for-canva':'message-review',job.id,now);
      }
    }
    const obsolete=store.db.prepare("SELECT id,logical_delivery_id FROM announcement_jobs WHERE guild=? AND logical_delivery_id IS NOT NULL AND state IN ('scheduled','held','pending_approval','blocked','draft') AND NOT EXISTS(SELECT 1 FROM delivery_attempts WHERE job=announcement_jobs.id)").all(policy.guild) as {id:string;logical_delivery_id:string}[];
    for(const job of obsolete)if(!desired.has(job.logical_delivery_id))store.db.prepare("UPDATE announcement_jobs SET state='superseded' WHERE id=?").run(job.id);
    const expired=store.db.prepare("SELECT id FROM announcement_jobs WHERE guild=? AND expires<? AND state='scheduled'").all(policy.guild,now) as {id:string}[];
    for(const job of expired){store.db.prepare("UPDATE announcement_jobs SET state='skipped' WHERE id=?").run(job.id);store.alert(policy.guild,'missed-reminder',job.id,now);}
    for(const c of store.candidates(policy.guild).filter(x=>x.state==='pending')){const e=JSON.parse(c.event_json) as ScheduleEvent;const time=e.deadline??e.start;if((e.status??'active')==='active'&&time!==null&&time>now&&time-now<86400000)store.alert(policy.guild,'approaching-unapproved',c.id,now);}
    return store.jobs(policy.guild);
  });
}
