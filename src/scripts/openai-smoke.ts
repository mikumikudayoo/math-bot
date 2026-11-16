/** Operator-only preflight. A single system job shares the configured production ledger. */
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {config as dotenv} from 'dotenv';
import {serviceConfigFrom, type ServiceConfig} from '../service/config.js';
import type {ModelRole} from '../service/openai-config.js';
import {OpenAIRuntime, openaiContext, type ResponsesClient} from '../service/openai.js';
import {completeProvider} from '../service/providers.js';

export const SMOKE_CEILING_USD = 0.02;
const tokenCaps: Record<ModelRole,number> = {luna:256, terra:512, sol:512};

export function smokeSettings(mode: string, inheritedKey?: string, directory = '.') {
  if (mode !== 'development' && mode !== 'production') throw new Error('Invalid BOT_ENV.');
  const env: NodeJS.ProcessEnv = {};
  if (dotenv({path:join(directory,'.env.ai.'+mode), processEnv:env, quiet:true}).error) throw new Error('Cannot read the AI service configuration.');
  // Deliberately select OpenAI in this short-lived process during a legacy-mode rollout.
  return serviceConfigFrom({...env, AI_PROVIDER:'openai'}, mode, {OPENAI_API_KEY:inheritedKey}, () => {});
}

export async function runProviderSmoke(config: ServiceConfig, db: DatabaseSync, roles: ModelRole[], client?: ResponsesClient) {
  if (!config.openai || config.kind !== 'openai') throw new Error('OpenAI smoke configuration is missing.');
  if (!roles.length || roles.length !== new Set(roles).size) throw new Error('Specify one or more unique smoke roles.');
  const settings = config.openai;
  for (const role of roles) {
    if (!settings.allowed[role] || !settings.pricing[settings.models[role]]?.efforts.includes('low'))
      throw new Error('A requested smoke model or its low reasoning effort is disabled.');
  }
  const cap = Math.min(SMOKE_CEILING_USD, settings.requestBudgetUsd.system);
  const runtime = new OpenAIRuntime({...settings,maxRetries:0,timeoutMs:Math.min(60000,settings.timeoutMs),
    requestBudgetUsd:{...settings.requestBudgetUsd,system:cap}}, db, client);
  const job = {id:'smoke:'+randomUUID(), user:'system'};
  const samples: {role: ModelRole; model: string; passed:boolean; status:string; input:number; output:number;
    reasoning:number; costUsd:number; latencyMs:number}[] = [];
  const signal = AbortSignal.timeout(Math.min(180000, runtime.config.timeoutMs * roles.length));
  for (const role of roles) {
    const purpose = 'smoke-'+role;
    const model = settings.models[role];
    const started = performance.now();
    let validAnswer = false;
    let status = 'provider or budget rejection';
    try {
      const response = await openaiContext.run({role,effort:'low',purpose,job,runtime}, () =>
        completeProvider(config,{messages:[{role:'user',content:'Reply with only the number: 17*23'}],max_tokens:tokenCaps[role]},signal,
          async () => { throw new Error('unexpected legacy transport'); }));
      const choice = (response as {choices?:{finish_reason?:string;message?:{content?:unknown;tool_calls?:unknown[]}}[]})?.choices?.[0];
      validAnswer = choice?.finish_reason === 'stop' && !choice.message?.tool_calls?.length &&
        typeof choice.message?.content === 'string' && choice.message.content.trim() === '391';
      status = validAnswer ? 'answered' : 'incorrect or incomplete answer';
    } catch { /* Never emit SDK messages, credentials, or arbitrary model output. */ }
    // The same row both certifies metering for this role and accounts for uncertain charges.
    const rows = db.prepare('SELECT model,status,input_tokens,output_tokens,reasoning_tokens,cost_micros FROM openai_usage WHERE job=? AND tier=?').all(job.id,purpose);
    const row = rows[0];
    const metered = rows.length === 1 && row?.model === model && row.status === 'ok' &&
      Number(row.input_tokens) > 0 && Number(row.output_tokens) > 0 && Number(row.reasoning_tokens) <= Number(row.output_tokens);
    const passed = validAnswer && metered;
    samples.push({role,model,passed,status:validAnswer && !metered ? 'missing or invalid usage' : status,
      input:Number(row?.input_tokens ?? 0),output:Number(row?.output_tokens ?? 0),reasoning:Number(row?.reasoning_tokens ?? 0),
      costUsd:rows.reduce((sum,r) => sum+Number(r.cost_micros),0)/1e6,latencyMs:Math.round(performance.now()-started)});
    if (!passed) break;
  }
  return {passed:samples.length === roles.length && samples.every(s=>s.passed),cap,estimatedUsd:runtime.ledger.jobSpentMicros(job.id)/1e6,samples};
}

export async function smokeCli(args: string[], env: NodeJS.ProcessEnv = process.env,
  log: (line:string)=>void = console.log, load = smokeSettings, client?: ResponsesClient) {
  const flags = new Set(args);
  if ([...flags].some(s => !['--confirm','--terra','--sol'].includes(s))) { log('unknown smoke option.'); return 2; }
  if (!flags.has('--confirm')) { log('dry run: no model calls. pass --confirm [--terra] [--sol] for the paid check.'); return 2; }
  const roles: ModelRole[] = ['luna',...(flags.has('--terra') ? ['terra' as const] : []),...(flags.has('--sol') ? ['sol' as const] : [])];
  let db: DatabaseSync | undefined;
  try {
    const settings = load(env.BOT_ENV ?? 'development',env.OPENAI_API_KEY);
    if (!existsSync(settings.database)) { log('the configured AI database does not exist. verify the service ledger path.'); return 1; }
    log('shared ledger, estimated maximum for this smoke run: $'+Math.min(SMOKE_CEILING_USD,settings.openai!.requestBudgetUsd.system).toFixed(4));
    db = new DatabaseSync(settings.database);
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='jobs'").get()) {
      log('the configured database is missing the AI service jobs table.'); return 1;
    }
    const report = await runProviderSmoke(settings,db,roles,client);
    for(const sample of report.samples) log(sample.role+' ('+sample.model+') '+sample.status+', '+sample.latencyMs+' ms, '+sample.input+' input, '+sample.output+' output ('+sample.reasoning+' reasoning), estimated $'+sample.costUsd.toFixed(6));
    log('run '+(report.passed ? 'passed' : 'failed')+', estimated total $'+report.estimatedUsd.toFixed(6));
    return report.passed ? 0 : 1;
  } catch { log('smoke failed. check the configured models, credentials, database, and spending ceilings.'); return 1; }
  finally { db?.close(); }
}

if(import.meta.main) process.exitCode = await smokeCli(process.argv.slice(2));
