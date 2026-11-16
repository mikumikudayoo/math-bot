import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { announcementAISettings, announcementProvider } from '../announcements/provider.js';
import { extractFacts } from '../announcements/extraction.js';
import { draftApprovedFacts } from '../announcements/writing.js';
import { digest } from '../announcements/model.js';
import type { OpenAIConfig } from '../service/openai-config.js';
import { OpenAIRuntime, installOpenAIRuntime, openAIRuntime, type ResponsesClient } from '../service/openai.js';

const ceilingMicros = 10_000;
const template = '{{program}} session {{slot}} will run on {{date}} from {{timeRange}}.';

/** Both production schema paths use the shared ledger. Extraction and drafting have
 * distinct system jobs, so the second reservation may use only the unused first-stage budget. */
export async function runAnnouncementSmoke(settings: OpenAIConfig, db: DatabaseSync, client?: ResponsesClient) {
  const cap = Math.min(ceilingMicros,Math.floor(settings.requestBudgetUsd.system * 1e6));
  const provider = {...announcementProvider({AI_PROVIDER:'openai'}),model:settings.models.luna};
  const signal = AbortSignal.timeout(120_000);
  const run = randomUUID();
  const text = 'VTAMPS V.30.0 Senior Secondary training Session 1 takes place on January 2, 2030 from 8 AM to 10 AM (Asia/Manila).';
  const source = {account:'synthetic',messageId:run,sha256:digest(text),attachment:null,locator:'body'};
  const prior = openAIRuntime();
  function install(remaining: number) {
    installOpenAIRuntime(new OpenAIRuntime({...settings,maxRetries:0,timeoutMs:Math.min(60_000,settings.timeoutMs),
      requestBudgetUsd:{...settings.requestBudgetUsd,system:remaining / 1e6}},db,client));
  }
  function metered(stage: 'extract'|'draft', id: string, remaining: number) {
    const rows = db.prepare('SELECT model,status,cost_micros,input_tokens,output_tokens,tier FROM openai_usage WHERE job=?')
      .all('announcement:'+stage+':'+id);
    const row = rows[0], cost = Number(row?.cost_micros);
    if (rows.length !== 1 || row?.model !== settings.models.luna || row?.tier !== 'announcement-'+stage ||
        row?.status !== 'ok' || Number(row.input_tokens) <= 0 || Number(row.output_tokens) <= 0 ||
        !Number.isSafeInteger(cost) || cost < 0 || cost > remaining) throw new Error('Synthetic '+stage+' did not produce valid usage.');
    return cost;
  }
  try {
    install(cap);
    const extraction = await extractFacts(provider,
      {evidence:[{id:'body',text}],blocked:[],sensitive:false,sourceTime:Date.UTC(2029,11,1)},source,signal);
    const extractionCost = metered('extract',digest([source.account,source.messageId,source.sha256]),cap);
    const candidate = extraction.events.find(c => c.event.type === 'training-session' && c.event.slot === '1');
    if (extraction.disposition !== 'public' || candidate?.event.start !== Date.UTC(2030,0,2) ||
        candidate.event.end !== Date.UTC(2030,0,2,2) || !candidate.evidenceIds?.includes('body'))
      throw new Error('Synthetic schedule failed validation.');

    const remaining = cap-extractionCost;
    install(remaining);
    const draftId = digest(['synthetic-editorial',run]);
    const draft = await draftApprovedFacts(provider,draftId,candidate.event,extraction.catalog,{
      guild:'111111111111111111',channel:'222222222222222222',role:null,templates:{session:template},
    },signal);
    const draftCost = metered('draft',draftId,remaining);
    const rendered = draft.payload.content;
    if (!['{{program}}','{{slot}}','{{date}}','{{timeRange}}'].every(token=>draft.template.includes(token)) ||
        !rendered.includes('VTAMPS') || !/January 2, 2030/i.test(rendered) || !/8:00\s*am[–-]10:00\s*am \(Asia\/Manila\)/i.test(rendered) ||
        rendered.includes('{{') || draft.payload.allowedMentions.roles.length || draft.payload.allowedMentions.parse.length)
      throw new Error('Synthetic locked draft failed public rendering checks.');
    return {extractionUsd:extractionCost/1e6,draftUsd:draftCost/1e6,estimatedUsd:(extractionCost+draftCost)/1e6,capUsd:cap/1e6};
  } finally { installOpenAIRuntime(prior); }
}

export async function announcementSmokeCli(args: string[], mode=process.env.BOT_ENV ?? 'development', log=console.log) {
  if (args.length !== 1 || args[0] !== '--confirm') {
    log('Use --confirm for paid synthetic extraction and drafting (combined estimated ceiling $0.01).'); return 2;
  }
  let db: DatabaseSync | undefined;
  try {
    const {config,database}=announcementAISettings(mode);
    if (!existsSync(database)) throw new Error('AI service database does not exist.');
    db = new DatabaseSync(database);
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='jobs'").get())
      throw new Error('AI service jobs table missing.');
    const result = await runAnnouncementSmoke(config,db);
    log('Synthetic extraction and locked draft passed strict schema, evidence, public rendering and usage checks. Estimated total $'+
      result.estimatedUsd.toFixed(6)+' of $'+result.capUsd.toFixed(6)+'.');
    return 0;
  } catch {
    log('Synthetic OpenAI checks failed. Verify the shared AI ledger, budgets, model compatibility and public facts before rollout.'); return 1;
  } finally { db?.close(); }
}

if (import.meta.main) process.exitCode = await announcementSmokeCli(process.argv.slice(2));
