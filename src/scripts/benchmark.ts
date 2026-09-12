import { serviceConfig } from '../service/config.js';
import { writeFile,mkdir } from 'node:fs/promises';
const config=serviceConfig();
if(!config.backend||!config.model)throw new Error('Configure a candidate backend and model first.');
const questions=[
  {prompt:'Compute 293*817. Return the integer.',expected:'239381'},
  {prompt:'Solve x^2 - 5*x + 6 = 0. Explain briefly.',expected:'2 and 3'},
  {prompt:'A triangle has sides 7 and 9 with included angle 60 degrees. Find the opposite side.',expected:'sqrt(67)'},
  {prompt:'Explain why mass and weight differ, including SI units.',expected:'kg, N, gravitational force'},
  {prompt:'Correct and explain: Neither of the answers are correct.',expected:'is'},
];
const rows=[];
for(const item of questions){
  const start=performance.now();
  const response=await fetch(`${config.backend}/chat/completions`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(config.timeoutMs),headers:{'Content-Type':'application/json',...(config.backendKey?{Authorization:`Bearer ${config.backendKey}`}:{})},body:JSON.stringify({model:config.model,messages:[{role:'user',content:item.prompt}],max_tokens:1024,temperature:0})});
  if(!response.ok)throw new Error(`Backend HTTP ${response.status}`);
  const body=await response.json() as {choices?:{message?:{content?:string}}[];usage?:unknown};
  rows.push({...item,answer:body.choices?.[0]?.message?.content??'',seconds:(performance.now()-start)/1000,usage:body.usage});
}
await mkdir('data/benchmarks',{recursive:true});const path=`data/benchmarks/${Date.now()}.json`;
await writeFile(path,JSON.stringify({model:config.model,platform:process.platform,arch:process.arch,rows,review:'Human quality review required; repeat on target VPS and separately test vision and concurrency.'},null,2));console.log(`Benchmark saved to ${path}`);
