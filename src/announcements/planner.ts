import { canonical,digest,renderEvent,type ScheduleEvent,type Catalog,type PreviewConfig } from './model.js';
import { validatePolicy,type PolicyFile } from './config.js';
import { AnnouncementStore,type Payload } from './store.js';

export function plan(store:AnnouncementStore,policy:PolicyFile,now=Date.now()){
  validatePolicy(policy);
  return store.transaction(()=>{
    const revision=digest(policy),key=`policy:${policy.guild}`;
    if(store.state(key)!==revision){
      store.db.prepare("UPDATE announcement_jobs SET state='superseded' WHERE guild=? AND state IN ('scheduled','held','pending_approval','blocked','draft')").run(policy.guild);store.setState(key,revision);
    }
    for(const row of store.events(policy.guild)){
      const e=JSON.parse(row.event_json) as ScheduleEvent,catalog=JSON.parse(row.catalog_json) as Catalog;
      if((e.status??'active')!=='active')continue;
      for(const rule of policy.policies){
        if(rule.type!==e.type || (rule.programId && rule.programId!==e.programId) || (rule.competitionId&&rule.competitionId!==e.competitionId) || (rule.roundId&&rule.roundId!==e.roundId))continue;
        const policyId=digest([revision,rule.id]),anchor=rule.anchor==='approval'?row.approved_at:e[rule.anchor],due=anchor===null?now:anchor-rule.beforeMinutes*60000;
        const expires=Math.min(due+60000,rule.anchor==='start'?anchor??Infinity:Infinity);
        let state=rule.major?'pending_approval':'scheduled',payload:Payload={content:'',allowedMentions:{parse:[],roles:[],users:[],repliedUser:false}};
        const config:PreviewConfig={guild:policy.guild,channel:rule.channel??policy.channel,role:rule.role===undefined?policy.role:rule.role,rules:[],templates:policy.templates};
        try{payload=renderEvent(e,catalog,config,rule.template);}catch{state='blocked';}
        if(anchor===null)state='blocked';else if(now>expires)state='skipped';
        const unheld=state;if(store.held(row.event_key))state='held';
        const job=store.addJob({guild:policy.guild,event_key:row.event_key,revision:row.revision,policy:policyId,channel:config.channel,role:config.role,due,expires,major:+rule.major,asset_policy:rule.asset,payload_json:canonical(payload),state});
        if(job.state==='held')store.db.prepare('UPDATE announcement_jobs SET held_from=COALESCE(held_from,?) WHERE id=?').run(unheld,job.id);
        if(job.state==='blocked')store.alert(policy.guild,'blocked-announcement',job.id,now);
        if(job.major && job.state==='pending_approval')store.alert(policy.guild,job.asset_policy==='required'&&!job.asset?'waiting-for-canva':'message-review',job.id,now);
      }
    }
    store.db.prepare("UPDATE announcement_jobs SET state='skipped' WHERE guild=? AND expires<? AND state='scheduled'").run(policy.guild,now);
    for(const c of store.candidates(policy.guild).filter(x=>x.state==='pending')){const e=JSON.parse(c.event_json) as ScheduleEvent;const time=e.deadline??e.start;if((e.status??'active')==='active'&&time!==null&&time>now&&time-now<86400000)store.alert(policy.guild,'approaching-unapproved',c.id,now);}
    return store.jobs(policy.guild);
  });
}
