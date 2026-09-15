import { readFile } from 'node:fs/promises';
import { mkdirSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { QotdStore } from '../qotd/store.js';
import { Competition, atomic, type QuestionSettings } from '../qotd/competition.js';
import { qotdSettings } from '../qotd/config.js';
import { overrideImages } from '../qotd/crops.js';
const [action,id,...args] = process.argv.slice(2);
const settings=qotdSettings(), store=new QotdStore(settings.database), c=new Competition(store);
const actor=process.env.QOTD_REVIEW_ACTOR ?? process.env.USER ?? 'local-operator';
try {
  if(action==='question' && id && args[0]) {
    const config:QuestionSettings=JSON.parse(await readFile(resolve(args[0]),'utf8'));
    const paths=args.flatMap((v,i)=>v==='--solution-image'?[args[i+1]??'']:[]);
    if(paths.length) {
      if(!args.includes('--ack-solution-review'))throw new Error('Inspect solution-only images and pass --ack-solution-review.');
      const directory=resolve(settings.assets,'solution-overrides');mkdirSync(directory,{recursive:true});
      config.solutionCrop=await overrideImages(await Promise.all(paths.map(p=>readFile(resolve(p)))),realpathSync(directory));
    }
    c.configure(id,config,actor);console.log('Question grading, scoring and solution settings saved. Existing daily snapshots are unchanged.');
  } else if(action==='delivery' && id) {
    console.log(JSON.stringify(store.db.prepare('SELECT qotd,part,state,message FROM qotd_delivery WHERE qotd=? ORDER BY part').all(Number(id)),null,2));
  } else if(action==='reconcile' && id && args[0]) {
    const part=Number(args[0]), message=args[args.indexOf('--message')+1];
    if(!Number.isInteger(part)||part<0||!Number.isSafeInteger(Number(id)))throw new Error('Invalid post/part.');
    const sent=args.includes('--message') && message && /^\d{17,20}$/.test(message);
    if(!sent && !args.includes('--confirm-not-delivered'))throw new Error('Inspect Discord first, then supply --message ID or --confirm-not-delivered.');
    atomic(store.db,()=>{
      const result=store.db.prepare("UPDATE qotd_delivery SET state=?,message=? WHERE qotd=? AND part=? AND state='uncertain'").run(sent?'sent':'pending',sent?message:null,Number(id),part);
      if(!result.changes)throw new Error('No uncertain delivery matches.');
      store.audit(actor,`reconciled QOTD ${id} part ${part}: ${sent?message:'operator confirmed not delivered; retry permitted'}`);
    });
    console.log('Delivery reconciled. Scheduler or /qotd reveal can resume without changing scores.');
  } else throw new Error('Usage: question ID config.json [--solution-image image.png --ack-solution-review] | delivery POST_ID | reconcile POST_ID PART --message MESSAGE_ID | reconcile POST_ID PART --confirm-not-delivered');
} catch(error) {console.error(error instanceof Error?error.message:error);process.exitCode=1;} finally {store.close();}
