import { readFileSync } from 'node:fs';
import { AutomationStore } from '../reminders/automation/store.js';
import type { Extraction,PreviewConfig,ScheduleEvent } from '../reminders/automation/model.js';

// Local operator CLI only. No Discord client, network calls, cron or default DB.
const [action,path,...args]=process.argv.slice(2);
const usage='bun src/scripts/reminder-automation.ts <import|review|edit|approve|reject|incorrect|preview> <path.automation-sandbox.sqlite> ...';
const read=(path:string)=>JSON.parse(readFileSync(path,'utf8')) as unknown;
let store:AutomationStore|undefined;
try {
  if(!action||!path)throw new Error(usage);
  store=new AutomationStore(path);
  const need=(i:number)=>{const v=args[i];if(!v)throw new Error(usage);return v;};
  let output:unknown;
  switch(action){
    case 'import': output=store.ingest(read(need(0)) as Extraction);break;
    case 'review': output=store.review(need(0));break;
    case 'edit': {const corrected=read(need(2)) as {event:ScheduleEvent;issues:string[]};store.edit(need(0),need(1),corrected.event,corrected.issues,need(3));output=store.review(need(0));break;}
    case 'approve': {output={approved:store.approve(need(0),args[2]?args.slice(2):null,need(1))};break;}
    case 'reject': store.reject(need(0),args[2]?args.slice(2):null,need(1));output=store.review(need(0));break;
    case 'incorrect': store.reject(need(0),null,need(1),true);output=store.review(need(0));break;
    case 'preview': {const now=args[1]?Date.parse(args[1]):Date.now();if(!Number.isFinite(now))throw new Error('Invalid preview clock.');output=store.preview(read(need(0)) as PreviewConfig,now);break;}
    default: throw new Error(usage);
  }
  console.log(JSON.stringify(output,null,2));
}catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}finally{store?.close();}
