import { pathToFileURL } from 'node:url';
import { automationConfig,type AutomationConfig } from './config.js';
import { AnnouncementStore } from './store.js';
import { GmailClient,syncGmail,type GmailMessage,GmailError } from './gmail.js';
import { parseMail } from './parsing.js';
import { extractFacts } from './extraction.js';
import { plan } from './planner.js';
import { draftMajor } from './writing.js';
import { clearSourceFailure,recordSourceFailure,reconcileExtractionIncident } from './alerts.js';
import { ProviderBackoff,ProviderPayloadTooLarge,providerHealth } from '../service/providers.js';
import { digest,type Source } from './model.js';

export async function workerTick(store:AnnouncementStore,config:AutomationConfig,gmail=new GmailClient(config.gmail),extract=extractFacts){
  if(!config.enabled||store.state('maintenance:reset')==='true')return;
  const signal=AbortSignal.timeout(120000);
  if(Number(store.state('gmail:retry-at')??0)<=Date.now()){
    try{await syncGmail(store,gmail,config,signal);store.setState('gmail:retry-at','0');}
    catch(error){store.setState(`gmail:${config.gmail.account}:health`,error instanceof GmailError&&error.status===401?'misconfigured':'unavailable');store.setState('gmail:retry-at',String(error instanceof GmailError?error.retryAt:Date.now()+60000));store.alert(config.policy.guild,'gmail-unavailable','gmail');}
  }
  let extractionHealthy=false,providerFailed=false;
  const sources=store.db.prepare("SELECT id,metadata,attempts FROM sources WHERE guild=? AND state IN ('pending','retry') AND retry_at<=? ORDER BY rowid LIMIT 5").all(config.policy.guild,Date.now()) as {id:string;metadata:string;attempts:number}[];
  for(const row of sources){
    // Until parsing resolves identity, a trusted organizer source may revise any event.
    // Successful ingestion narrows this to candidate holds; failure needs staff disposition.
    store.holdSource(config.policy.guild,row.id);
    if(extract===extractFacts&&!config.provider.backendKey){store.setState('provider:health','misconfigured');store.alert(config.policy.guild,'extraction-provider-misconfigured','groq');continue;}
    try{
      const source=JSON.parse(row.metadata) as Source;
      const message=await gmail.get<GmailMessage>(`messages/${encodeURIComponent(source.messageId)}`,{format:'full'},signal);
      const parsed=await parseMail(message,async(id,mime)=>{const body=await gmail.get<{data:string}>(`messages/${encodeURIComponent(source.messageId)}/attachments/${encodeURIComponent(id)}`,{},signal);const data=Buffer.from(body.data,'base64url');store.db.prepare("INSERT OR IGNORE INTO source_attachments VALUES(?,?,?,?,?,'parsed')").run(digest([row.id,id]),row.id,digest(data.toString('base64')),mime,data.length);return data;});
      store.saveEvidence(row.id,parsed); // Redacted and bounded; no raw mailbox bodies/passwords.
      const extraction=await extract(config.provider,parsed,source,signal);
      if(!extraction.events.length)throw new Error('No resolvable event identities; source needs staff disposition.');
      store.ingest(config.policy.guild,extraction);clearSourceFailure(store,row.id);extractionHealthy=true;
    }catch(error){
      const transient=error instanceof ProviderBackoff||error instanceof GmailError;
      if(transient&&row.attempts<12)store.sourceState(row.id,'retry',error instanceof ProviderBackoff?error.retryAt:Date.now()+Math.min(3600000,30000*2**row.attempts));
      else store.sourceState(row.id,'blocked');
      if(error instanceof ProviderBackoff)providerFailed=true;
      const provider=error instanceof ProviderBackoff?'groq':error instanceof GmailError?'gmail':'review';
      const reason=error instanceof ProviderPayloadTooLarge?'Groq request/payload too large (HTTP 413); split or shorten the source for manual review.':error instanceof ProviderBackoff?`Groq ${error.reason}; ${row.attempts<12?'retry scheduled':'retry budget exhausted; manual review required'}.`:provider==='gmail'?'Gmail message or attachment could not be fetched.':error instanceof Error&&/Inference backend returned HTTP (\d{3})/.test(error.message)?`Groq configuration rejected (HTTP ${error.message.match(/HTTP (\d{3})/)![1]}); manual review required.`:'Extraction output could not be validated; manual review required.';
      recordSourceFailure(store,row.id,provider,reason);
      if(provider==='gmail')store.alert(config.policy.guild,'gmail-unavailable','gmail');
      else if(provider==='review'||row.attempts>=12)store.alert(config.policy.guild,'blocked-source',row.id);
    }
  }
  reconcileExtractionIncident(store,config.policy.guild,extractionHealthy&&!providerFailed,Date.now(),providerFailed);
  plan(store,config.policy);
  try{if(config.provider.backendKey)await draftMajor(store,config.policy,config.provider,signal);}catch{store.alert(config.policy.guild,'writing-unavailable','writer');}
  const health=providerHealth.get(`${config.provider.backend}:${config.provider.model}`);
  if(health){store.setState('provider:health',health.state);store.setState('provider:retry-at',String(health.retryAt));}
  store.setState('worker:last-tick',String(Date.now()));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    const config=automationConfig();const store=new AnnouncementStore(config.database);let stopped=false,busy=false;
    const tick=async()=>{if(stopped||busy)return;busy=true;try{await workerTick(store,config);}catch{console.error('Announcement worker tick failed; inspect private status.');}finally{busy=false;}};
    const timer=setInterval(()=>void tick(),config.pollMs);void tick();console.log(`Announcement worker: ${config.enabled?'shadow ingestion enabled':'disabled'}; public delivery is controlled only by the Discord bot gate.`);
    for(const s of ['SIGINT','SIGTERM'] as const)process.once(s,()=>{stopped=true;clearInterval(timer);const wait=setInterval(()=>{if(!busy){clearInterval(wait);store.close();}},50);});
  }catch{console.error('Announcement configuration failed. Check the private automation env and policy file.');process.exitCode=1;}
}
