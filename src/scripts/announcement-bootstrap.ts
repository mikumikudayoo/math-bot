import { automationConfig } from '../announcements/config.js';
import { AnnouncementStore } from '../announcements/store.js';
import { GmailClient,bootstrapGmail,boundedResponse } from '../announcements/gmail.js';
import { dirname,basename,resolve } from 'node:path';

// Deliberate operator action: no mailbox listing or implicit expiry recovery.
const config=automationConfig();
if(config.autoSend)throw new Error('Disable public auto-send before bootstrap.');
if(process.argv[2]==='--database'){
  const path=resolve(process.argv[3]??'');
  if(dirname(path)!==dirname(config.database)||!/^announcements\.clean\.[\w-]+\.sqlite$/.test(basename(path)))throw new Error('Staging bootstrap must use a dedicated announcement database beside the configured database.');
  config.database=path;
}else if(process.argv.length>2)throw new Error('Unexpected bootstrap argument.');
const store=new AnnouncementStore(config.database);
try {
  for(const table of ['sources','candidate_events','events','announcement_jobs']){
    if(Number(store.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n))throw new Error('Bootstrap requires a clean announcement database.');
  }
  const historyId=await bootstrapGmail(store,new GmailClient(config.gmail),config,AbortSignal.timeout(30000));
  const response=await fetch(`${config.provider.backend}/models`,{headers:{Authorization:`Bearer ${config.provider.backendKey}`},signal:AbortSignal.timeout(15000),redirect:'error'});
  if(!response.ok){await response.body?.cancel();store.setState('provider:health',response.status===401||response.status===403?'misconfigured':'unavailable');throw new Error('Announcement provider health check failed.');}
  const models=JSON.parse(await boundedResponse(response,1_000_000)) as {data?:{id:string}[]};
  if(!models.data?.some(m=>m.id===config.provider.model))throw new Error('Configured announcement model is unavailable.');
  store.setState('provider:health','healthy');store.setState('provider:retry-at','0');store.setState('provider:checked-at',String(Date.now()));
  console.log(JSON.stringify({mode:'future-only',historyId,imported:0,gmail:'healthy',groq:'healthy',providerHttpStatus:response.status,autoSend:config.autoSend}));
}catch{console.error('Future-only bootstrap or provider check failed; inspect private configuration and announcement state.');process.exitCode=1;}
finally{store.close();}
