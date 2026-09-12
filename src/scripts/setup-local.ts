import { readFile,writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { parse } from 'dotenv';
async function read(path:string,fallback:string){try{return await readFile(path,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;return readFile(fallback,'utf8');}}
let bot=await read('.env.development','.env.development.example');
let ai=await read('.env.ai.development','.env.ai.development.example');
const existingBot=parse(bot).AI_SERVICE_TOKEN;const existingAI=parse(ai).AI_SERVICE_TOKEN;
if(existingBot&&existingAI&&existingBot!==existingAI)throw new Error('Service tokens differ. Resolve the local files before running setup.');
const token=existingBot||existingAI||randomBytes(32).toString('hex');
function put(source:string,key:string,value:string){const re=new RegExp(`^${key}=.*$`,'m');return re.test(source)?source.replace(re,`${key}=${value}`):`${source.trimEnd()}\n${key}=${value}\n`;}
bot=put(bot,'AI_SERVICE_TOKEN',token);ai=put(ai,'AI_SERVICE_TOKEN',token);
if(!parse(bot).AI_SERVICE_URL)bot=put(bot,'AI_SERVICE_URL','http://127.0.0.1:8787');
await writeFile('.env.development',bot,{mode:0o600});await writeFile('.env.ai.development',ai,{mode:0o600});
console.log('Local dev service credentials prepared. Existing Discord credentials preserved.');
