import {automationConfig,type AutomationConfig} from './config.js';
import {effectivePolicy,registerEffectivePolicy,type EffectivePolicySnapshot,type PolicySnapshotStore} from './delivery-identity.js';

/** Load from the host configuration after observing the durable policy epoch. */
export function loadAnnouncementRuntime(store:PolicySnapshotStore,guild:string,load:()=>AutomationConfig=automationConfig):{config:AutomationConfig;snapshot:EffectivePolicySnapshot}{
  for(let attempt=0;attempt<3;attempt++){
    const expected=effectivePolicy(store,guild)?.revision??0;
    const config=load();
    if(config.policy.guild!==guild)throw new Error('Announcement runtime guild changed.');
    const registered=registerEffectivePolicy(store,config.policy,expected);
    if(registered.accepted)return {config,snapshot:registered.snapshot};
  }
  throw new Error('Announcement policy changed concurrently; retry with fresh configuration.');
}

/** A captured worker configuration cannot overwrite a newer host policy. */
export function capturedAnnouncementRuntime(store:PolicySnapshotStore,config:AutomationConfig):{config:AutomationConfig;snapshot:EffectivePolicySnapshot}{
  const existing=effectivePolicy(store,config.policy.guild);
  if(existing)return {config:{...config,policy:existing.policy},snapshot:existing};
  const registered=registerEffectivePolicy(store,config.policy,0);
  return {config:{...config,policy:registered.snapshot.policy},snapshot:registered.snapshot};
}
