import { readFileSync,mkdirSync,writeFileSync } from 'node:fs';
import { serviceConfig } from '../service/config.js';
import { Store } from '../service/store.js';
import { runner } from '../service/inference.js';
import { routePrompt } from '../service/route-prompt.js';
import type { Job } from '../service/types.js';
import { providerHealth } from '../service/providers.js';

const cfg=serviceConfig();if(!cfg.external?.backendKey)throw new Error('Paste GROQ_API_KEY privately into the selected .env.ai file before benchmarking.');
const model=process.argv[2]??'openai/gpt-oss-120b';if(!['openai/gpt-oss-120b','qwen/qwen3.8-27b'].includes(model))throw new Error('Use an explicitly selected candidate model.');
const data=readFileSync('tests/fixtures/router-holdout-v2.jsonl','utf8').split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line) as {prompt:string;category:string;reasoning:string[];knowledge:string[];tool:string[]});
const store=new Store(':memory:');const rows=[];
try{for(const [index,row] of data.entries()){
  providerHealth.clear(); // Evaluation observes each response rather than inheriting unrelated health.
  const start=performance.now();let usage:unknown=null,modelCalls=0;const tools:string[]=[];
  let route:Awaited<ReturnType<typeof routePrompt>>|undefined;
  try{
    route=await routePrompt(row.prompt);
    const run=runner({...cfg,cognitiveRouting:true,external:{...cfg.external,model}},store,{route:async()=>route!,complete:async(url,init)=>{modelCalls++;const r=await fetch(url,init);if(r.ok){const body=await r.clone().json() as {usage?:unknown;choices?:{message?:{tool_calls?:{function?:{name?:string}}[]}}[]};usage=body.usage;for(const call of body.choices?.[0]?.message?.tool_calls??[])if(call.function?.name)tools.push(call.function.name);}return r;}});
    const job:Job={id:String(index),guild:'111111111111111111',channel:'222222222222222222',user:'333333333333333333',coach:false,kind:'ask',prompt:row.prompt,state:'running',status:'',answer:'',artifact:'',created:Date.now(),message:'',delivered:0};
    const result=await run(job,AbortSignal.timeout(120000),()=>{});
    rows.push({index,category:row.category,prompt:row.prompt,route,routeCorrect:{reasoning:row.reasoning.includes(route.reasoning),knowledge:row.knowledge.includes(route.knowledge),tool:row.tool.includes(route.tool)},answer:result.answer,seconds:(performance.now()-start)/1000,usage,modelCalls,tools,grading:{fullAnswer:null,reasoning:null,knowledge:null,toolUse:null},failure:null});
  }catch(error){rows.push({index,category:row.category,prompt:row.prompt,route,seconds:(performance.now()-start)/1000,usage,modelCalls,tools,failure:error instanceof Error?error.constructor.name:'Error',grading:{fullAnswer:null,reasoning:null,knowledge:null,toolUse:null}});}
  if([...providerHealth.values()].some(h=>h.state==='rate-limited'))break; // Preserve free quota; resume an explicit run later.
}
mkdirSync('data/benchmarks',{recursive:true});const path=`data/benchmarks/provider-${model.replaceAll('/','-')}-${Date.now()}.json`;writeFileSync(path,JSON.stringify({model,source:'tests/fixtures/router-holdout-v2.jsonl',rows,review:'Routing labels are NOT answer-correctness ground truth. Human semantic grading required. Easy/deterministic rows may use no external model; compare actual modelCalls and tools, not only latency.'},null,2));console.log(`Evaluation saved privately to ${path}; ${rows.length} of ${data.length} rows. No quality score is claimed before human grading.`);
}finally{store.close();}
