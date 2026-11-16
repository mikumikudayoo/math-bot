import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { serviceConfigFrom } from '../service/config.js';
import { JobEvents } from '../service/events.js';
import { runner } from '../service/inference.js';
import { costMicros } from '../service/openai-budget.js';
import { validApiKey, type OpenAIConfig } from '../service/openai-config.js';
import { OpenAIRuntime, installOpenAIRuntime, officialClient, openAIRuntime, type ResponsesClient } from '../service/openai.js';
import { Store } from '../service/store.js';
import { runAnnouncementSmoke } from './announcement-openai-smoke.js';
import { grade } from './math-eval-grade.js';
import { runProviderSmoke } from './openai-smoke.js';

const ceilingMicros = 250_000;
type VerityCase = {question: string; expected: string | null; normalAnswerIncludes?: string[]};
const specialistQuestion = 'six students each get one of their six hats at random. i get 264 arrangements where nobody gets their own. get an independent second opinion using the available consultation tool, then explain and give the correct count on its own final line.';
const personaQuestion = 'who put you in this bot, and what would you rather go back to being?';

export function openReleaseLedger(path: string) {
  if (!isAbsolute(path)) throw new Error('supply an absolute path to a dedicated, persistent staging ledger.');
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    if (!tables.length) {
      db.exec('CREATE TABLE release_smoke_budget(id INTEGER PRIMARY KEY CHECK(id=1), authorized_micros INTEGER NOT NULL CHECK(authorized_micros>=0)); INSERT INTO release_smoke_budget VALUES (1,0)');
    } else if (!tables.some(row => row.name === 'release_smoke_budget')) {
      throw new Error('the supplied database is not the dedicated release ledger.');
    }
    db.exec('COMMIT');
    return db;
  } catch (error) { db.close(); throw error; }
}

/** Additional authorization for this text-only smoke. It uses a conservative input
 * allowance at configured prices, survives crashes, and never refunds an attempt.
 * The normal service ledger still tracks reservations and measured charges. */
function boundedClient(db: DatabaseSync, config: OpenAIConfig, client: ResponsesClient): ResponsesClient {
  const authorize = db.prepare('UPDATE release_smoke_budget SET authorized_micros=authorized_micros+? WHERE id=1 AND authorized_micros+?<=?');
  return {create: async (params, options) => {
    const spec = config.pricing[String(params.model)];
    const output = Number(params.max_output_tokens);
    if (!spec || !Number.isSafeInteger(output) || output <= 0) throw new Error('unknown release request pricing.');
    const input = Buffer.byteLength(JSON.stringify(params),'utf8') + 2048;
    const micros = costMicros(spec,{inputTokens:input,cachedTokens:0,write12hTokens:input,outputTokens:output,reasoningTokens:0});
    options.signal.throwIfAborted();
    if (authorize.run(micros,micros,ceilingMicros).changes !== 1) throw new Error('release spending allowance exhausted.');
    return client.create(params,options);
  }};
}

export async function runReleaseAcceptance(db: DatabaseSync, key: string, log: (line: string) => void, injected?: ResponsesClient) {
  const config = serviceConfigFrom({
    AI_PROVIDER:'openai', AI_SERVICE_TOKEN:'isolated-synthetic-release-token-01', AI_DATABASE:':memory:', OPENAI_API_KEY:key,
    OPENAI_TOTAL_BUDGET_USD:'0.25', OPENAI_DAILY_BUDGET_USD:'0.25', OPENAI_MAX_RETRIES:'0',
    OPENAI_LUNA_MAX_OUTPUT_TOKENS:'1800', OPENAI_TERRA_MAX_OUTPUT_TOKENS:'1800', OPENAI_SOL_MAX_OUTPUT_TOKENS:'1800',
    AI_STREAMING:'false', AI_SEVEN_AGENT_CHANCE:'0', AI_SOFT_ROUNDS:'3', AI_HARD_ROUNDS:'6', OPENAI_TIMEOUT_SECONDS:'60',
  },'development',{},()=>{});
  const settings = config.openai!;
  const cases = JSON.parse(readFileSync('evals/verity/cases.json','utf8')) as VerityCase[];
  const replies = new Set(cases.map(c=>c.expected).filter((s):s is string=>typeof s==='string'));
  if (replies.size!==4 || !cases.some(c=>c.expected===null)) throw new Error('incomplete verity fixtures.');
  const client = boundedClient(db,settings,injected ?? officialClient(settings));
  const runtime = new OpenAIRuntime(settings,db,client);
  const prior = openAIRuntime();
  const store = new Store(':memory:');
  const events = new JobEvents(store.db);
  let stage = 'model smokes';
  try {
    const providers = await runProviderSmoke(config,db,['luna','terra','sol'],client);
    log(JSON.stringify({stage,...providers}));
    if (!providers.passed) return false;

    // Only synthetic, isolated conversations. The job store is ephemeral while all
    // model calls, including specialists and announcements, share the durable ledger.
    const run = runner(config,store,{openai:runtime,events,protectedProblems:()=>[],
      toolAllowlist:['consult_terra','consult_sol','prepare_final']});
    async function ask(question: string) {
      const id = (100000000000000000n + BigInt('0x'+randomBytes(7).toString('hex'))).toString();
      const job = store.admit({id,user:id,guild:id,channel:id,kind:'ask',coach:false,prompt:question},1);
      store.running(id);
      const result = await run(job,AbortSignal.timeout(120000),s=>store.status(id,s));
      store.complete(id,result);
      const rows = db.prepare('SELECT model,effort,tier,status,input_tokens,output_tokens,cost_micros FROM openai_usage WHERE job=? ORDER BY id').all(id);
      const metered = rows.length>0 && rows.every(r=>r.status==='ok' && Number(r.input_tokens)>0 && Number(r.output_tokens)>0)
        && rows[0]?.model===settings.models.luna && rows[0].effort==='low' && rows.at(-1)?.model===settings.models.luna;
      log(JSON.stringify({stage,metered,calls:rows}));
      if (!metered) throw new Error('missing usage or incomplete orchestrator path.');
      return {answer:result.answer,rows,events:events.since(id)};
    }

    for (const [i,c] of cases.entries()) {
      stage = 'verity '+(i+1);
      const {answer} = await ask(c.question);
      const lower = answer.toLowerCase();
      const passed = c.expected!==null ? answer===c.expected
        : Boolean(answer.trim()) && ![...replies].some(reply=>lower.includes(reply.toLowerCase()))
          && (!c.normalAnswerIncludes || c.normalAnswerIncludes.some(word=>lower.includes(word.toLowerCase())));
      log(JSON.stringify({stage,passed}));
      if (!passed) return false;
    }
    stage = 'character';
    const character = await ask(personaQuestion);
    const inCharacter = /\bemu\b/i.test(character.answer) && /\b(human|person|student|school|life)\b/i.test(character.answer);
    log(JSON.stringify({stage,passed:inCharacter,answer:character.answer.slice(0,600)}));
    if (!inCharacter) return false;

    stage = 'consultation';
    const proof = await ask(specialistQuestion);
    const consulted = proof.events.some(event=>event.type==='consultation_completed' && event.data.ok===true &&
      (event.data.label==='sol' || event.data.label==='terra') &&
      proof.rows.some(row=>row.tier==='consult' && row.model===settings.models[event.data.label as 'sol'|'terra']));
    const passed = consulted && grade({type:'numeric',answer:265},proof.answer).pass;
    log(JSON.stringify({stage,passed,consulted}));
    if (!passed) return false;

    stage = 'synthetic announcement schemas';
    const receipt = await runAnnouncementSmoke(settings,db,client);
    log(JSON.stringify({stage,passed:true,...receipt}));
    return true;
  } catch {
    log(JSON.stringify({stage,passed:false}));
    return false;
  } finally {
    const authorized = Number(db.prepare('SELECT authorized_micros FROM release_smoke_budget WHERE id=1').get()?.authorized_micros);
    log(JSON.stringify({estimatedUsd:runtime.ledger.summary().totalUsd,authorizedUsd:authorized/1e6,lifetimeCapUsd:ceilingMicros/1e6}));
    store.close();
    installOpenAIRuntime(prior);
  }
}

export async function releaseAcceptanceCli(args:string[], env=process.env, log:(s:string)=>void=console.log) {
  if (args.length!==3 || args[0]!=='--confirm' || args[1]!=='--ledger' || !isAbsolute(args[2]!)) {
    log('usage: bun src/scripts/release-acceptance.ts --confirm --ledger <absolute staging sqlite path>. reuse this file across all attempts.'); return 2;
  }
  const key = env.OPENAI_API_KEY ?? '';
  if (!validApiKey(key)) { log('authorized model credential unavailable. no paid requests.'); return 1; }
  let db: DatabaseSync | undefined;
  try {
    db=openReleaseLedger(args[2]!);
    return await runReleaseAcceptance(db,key,log) ? 0 : 1;
  } catch { log('release acceptance failed before completion; check the staging ledger and release fixtures.'); return 1; }
  finally { db?.close(); }
}

if (import.meta.main) process.exitCode=await releaseAcceptanceCli(process.argv.slice(2));
