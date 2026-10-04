import type { CaseRecord } from './types.js';
import type { SecurityStore } from './store.js';
export interface ActionAdapter {
  authorize(record:CaseRecord):Promise<boolean>;
  deleteMessage(record:CaseRecord):Promise<void>;
  timeout(record:CaseRecord):Promise<void>;
  notify(record:CaseRecord):Promise<void>;
  log(record:CaseRecord):Promise<void|'skipped'>;
}
export async function executeCase(store:SecurityStore,record:CaseRecord,adapter:ActionAdapter):Promise<boolean>{
  if(!store.claim(record,'dispatch'))return false;
  let deleted=false;
  if(record.mode==='enforce'){
    try {
      const current=store.config(record.guild);
      if(current.revision!==record.configVersion||current.config.mode!=='enforce'||!await adapter.authorize(record)){
        store.outcome(record.id,'dispatch','denied',{reason:'Current authorization or configuration no longer permits this action.'});
      }else{
      if(record.decision.delete&&store.claim(record,'delete')){
        try{await adapter.deleteMessage(record);deleted=true;store.outcome(record.id,'delete','succeeded',{});}
        catch(error){store.outcome(record.id,'delete',failureState(error),{reason:'Message deletion failed.'});}
      }
      if(record.decision.action==='timeout'&&store.claim(record,'timeout')){
        try{await adapter.timeout(record);store.outcome(record.id,'timeout','succeeded',{durationMs:record.decision.durationMs});}
        catch(error){store.outcome(record.id,'timeout',failureState(error),{reason:'Timeout failed; check permission and role hierarchy.'});}
      }
      if(record.decision.action==='warn')store.audit(record.id,'warning',{expiresAt:record.created+record.decision.warningExpiryMs});
      if(record.decision.action!=='review'&&store.claim(record,'dm')){
        try{await adapter.notify(record);store.outcome(record.id,'dm','succeeded',{});}
        catch(error){store.outcome(record.id,'dm',failureState(error),{reason:'Notification unavailable.'});}
      }
      store.outcome(record.id,'dispatch','finished',{deleted});
      }
    }catch(error){store.outcome(record.id,'dispatch',failureState(error),{reason:'Authorization unavailable; no automatic retry.'});}
  }else store.outcome(record.id,'dispatch','shadow',{deleted:false});
  if(store.claim(record,'log')){
    try{const result=await adapter.log(record);store.outcome(record.id,'log',result==='skipped'?'skipped':'succeeded',{});}
    catch(error){store.outcome(record.id,'log',failureState(error),{reason:'Audit log delivery unavailable; case remains saved.'});}
  }
  return deleted;
}
function failureState(error:unknown){const status=error&&typeof error==='object'&&'status' in error?Number(error.status):0;return status>=400&&status<500?'failed':'uncertain';}
