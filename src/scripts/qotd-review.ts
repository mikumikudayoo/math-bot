import { readFile } from 'node:fs/promises';
import { realpathSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { QotdStore } from '../qotd/store.js';
import { qotdSettings } from '../qotd/config.js';
import { overrideImages } from '../qotd/crops.js';
const [action='list',id='',...options]=process.argv.slice(2);
const settings=qotdSettings();const store=new QotdStore(settings.database);
try {
  const actor=process.env.USER??process.env.USERNAME??'local-operator';
  if(action==='list')console.log(JSON.stringify(store.list(id||'pending',1000),null,2));
  else if(action==='show')console.log(JSON.stringify({question:store.get(id),sources:store.occurrences(id)},null,2));
  else if(action==='approve'||action==='reject'||action==='replace') {
    if(!store.get(id))throw new Error('Unknown question ID.');
    const paths=options.flatMap((value,i)=>value==='--image'?[options[i+1]??'']:[]);
    if(paths.length) {
      const directory=resolve(settings.assets,'overrides');mkdirSync(directory,{recursive:true});
      const crop=await overrideImages(await Promise.all(paths.map(p=>readFile(resolve(p)))),realpathSync(directory));
      store.replaceCrop(id,crop,actor);
    } else if(action==='replace')throw new Error('Use one or more --image paths, in page order.');
    if(action!=='replace')store.review(id,action==='approve'?'approved':'rejected',actor,options.includes('--ack-source-review'),options.includes('--ack-crop-review'));
    console.log(`${action}: ${id}`);
  } else throw new Error('Usage: list [state] | show ID | approve ID --ack-source-review --ack-crop-review | reject ID | replace ID --image page1.png [--image page2.png]');
} catch(error){console.error(error instanceof Error?error.message:error);process.exitCode=1;}finally{store.close();}
