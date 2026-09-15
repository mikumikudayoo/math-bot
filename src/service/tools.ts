import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { ServiceConfig } from './config.js';
import { UserError, type Result } from './types.js';
import { fetchText,publicURL } from './network.js';

export function subprocess(executable:string,args:string[],input:string,signal:AbortSignal,timeoutMs=30000):Promise<string> {
  return new Promise((resolvePromise,reject)=>{
    const child=spawn(executable,args,{stdio:['pipe','pipe','ignore'],signal,
      env:{PATH:process.env.PATH ?? '/usr/bin:/bin',HOME:'/tmp',MPLCONFIGDIR:'/tmp/math-bot-matplotlib',OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'1'}});
    let output='';let settled=false;
    const timer=setTimeout(()=>child.kill('SIGKILL'),timeoutMs);
    child.stdout.on('data',(data:Buffer)=>{output+=data.toString();if(output.length>3_000_000)child.kill('SIGKILL');});
    child.stdin.on('error',()=>{});
    child.on('error',()=>{settled=true;clearTimeout(timer);reject(new UserError('Tool runtime is unavailable. Ask a moderator to check setup.'));});
    child.on('close',code=>{clearTimeout(timer);if(settled)return;code===0?resolvePromise(output):reject(new UserError('Tool stopped: time, resource, or runtime limit.'));});
    child.stdin.end(input);
  });
}
export async function mathTool(config:ServiceConfig,args:Record<string,unknown>,signal:AbortSignal):Promise<Result> {
  const raw=await subprocess(config.python,[resolve('python/math_worker.py')],JSON.stringify(args),signal);
  const result=JSON.parse(raw) as Result & {error?:string};
  if(result.error)throw new UserError(result.error);return result;
}
export async function sandboxPython(config:ServiceConfig,code:string,signal:AbortSignal):Promise<Result> {
  if(!config.sandbox)throw new UserError('Sandboxed Python is not enabled.');
  if(code.length>8000)throw new UserError('Python code is too long.');
  const name=`math-bot-${randomUUID()}`;
  try {
    const answer=await subprocess('docker',['run','--rm','--pull=never','--name',name,'--network=none','--read-only','--cap-drop=ALL',
      '--security-opt=no-new-privileges','--memory=128m','--memory-swap=128m','--cpus=0.5','--pids-limit=32','--ulimit','nofile=64:64',
      '--tmpfs','/tmp:rw,noexec,nosuid,size=16m','--user','10001:10001','-i',config.sandboxImage],code,signal,12000);
    return {answer:answer.slice(0,12000)||'(no output)'};
  } finally {
    // Killing the docker client alone does not stop a running container.
    await new Promise<void>(done=>{const cleanup=spawn('docker',['rm','-f',name],{stdio:'ignore'});const timer=setTimeout(()=>{cleanup.kill('SIGKILL');done();},5000);cleanup.on('error',()=>{clearTimeout(timer);done();});cleanup.on('close',()=>{clearTimeout(timer);done();});});
  }
}
export async function search(config:Pick<ServiceConfig,'searchKey'>,query:string,signal:AbortSignal,request:typeof fetch=fetch) {
  if(!config.searchKey)throw new UserError('Web search is not configured yet. You can supply a public HTTPS source URL.');
  const response=await request('https://api.tavily.com/search',{
    method:'POST',signal:AbortSignal.any([signal,AbortSignal.timeout(15000)]),redirect:'error',
    headers:{'Content-Type':'application/json',Authorization:`Bearer ${config.searchKey}`},
    body:JSON.stringify({query:query.slice(0,500),topic:'general',search_depth:'basic',auto_parameters:false,
      max_results:5,include_answer:false,include_raw_content:false,include_images:false}),
  });
  if(!response.ok)throw new UserError('Web search provider is unavailable.');
  const reader=response.body?.getReader();if(!reader)throw new UserError('Empty search response.');
  const chunks:Uint8Array[]=[];let bytes=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>1_000_000)throw new UserError('Search response exceeds size limit.');chunks.push(value);}}finally{await reader.cancel();}
  let body:unknown;
  try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new UserError('Invalid search response.');}
  if(!body||typeof body!=='object'||!('results' in body)||!Array.isArray(body.results))throw new UserError('Invalid search response.');
  const results:{title:string;url:string;description:string}[]=[];
  const seen=new Set<string>();
  for(const item of body.results){
    if(!item||typeof item!=='object'||typeof item.title!=='string'||typeof item.url!=='string'||typeof item.content!=='string'||!item.content.trim())continue;
    try{publicURL(item.url);}catch{continue;}
    if(seen.has(item.url))continue;
    seen.add(item.url);results.push({title:item.title.slice(0,300),url:item.url,description:item.content.slice(0,1000)});
    if(results.length===5)break;
  }
  return results;
}
export { fetchText };
