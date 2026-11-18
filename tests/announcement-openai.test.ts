import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { announcementProvider, installAnnouncementAI } from '../src/announcements/provider.js';
import { parseOpenAIConfig } from '../src/service/openai-config.js';
import { extractFacts } from '../src/announcements/extraction.js';
import { workerTick } from '../src/announcements/worker.js';
import { AnnouncementStore } from '../src/announcements/store.js';
import { recordSourceFailure, reconcileExtractionIncident, staffAlertContent } from '../src/announcements/alerts.js';
import { documentTemplates } from '../src/announcements/model.js';
import { announcementSmokeCli, runAnnouncementSmoke } from '../src/scripts/announcement-openai-smoke.js';
import type { ResponsesClient } from '../src/service/openai.js';
import type { GmailClient } from '../src/announcements/gmail.js';
import type { AutomationConfig } from '../src/announcements/config.js';

const key = 'sk-synthetic-aaaaaaaaaaaaaaaaaaaaaaaa';
const settings = parseOpenAIConfig({AI_PROVIDER: 'openai', OPENAI_API_KEY: key, OPENAI_MAX_RETRIES: '0'})!;
const provider = announcementProvider({AI_PROVIDER: 'openai', GROQ_API_KEY: 'legacy-must-not-be-used'});
const guild = '111111111111111111';
const config: AutomationConfig = {enabled: true, autoSend: false, database: ':memory:', assets: '.',
  policy: {guild, channel: '222222222222222222', role: null, staffChannel: null, policies: [], templates: documentTemplates},
  gmail: {account: 'synthetic', clientId: '', clientSecret: '', refreshToken: '', query: '', senders: []}, provider, pollMs: 120000};
const source = {account: 'synthetic', messageId: 'not-to-be-sent-to-a-provider', sha256: 'a'.repeat(64), attachment: null, locator: 'body'};
const body = 'VTAMPS V.30.0 Senior Secondary Session 1 on January 2, 2030, 8 AM to 10 AM Asia/Manila.';
const mail = {evidence: [{id: 'body', text: body}], blocked: [], sensitive: false};
const start = Date.UTC(2030, 0, 2), end = start + 7200000;
const time = (n: number) => ({precision: 'exact', expression: new Date(n).toISOString(), sourceTime: null});
const modelOutput = {disposition: 'public', dispositionReason: null, correction: false,
  catalog: {competitions: [], rounds: [], programs: [{id: 'vtamps-v30-0', name: 'VTAMPS', version: '30.0'}]},
  events: [{event: {competitionId: null, roundId: null, programId: 'vtamps-v30-0', preparesFor: [], yearLevel: 'Senior Secondary',
    type: 'training-session', slot: '1', start, end, deadline: null, timezone: 'Asia/Manila', timezoneAssumed: false, url: null,
    detailLabel: null, dateHint: null, status: 'active', availability: null, temporal: {start: time(start), end: time(end), deadline: null}, logistics: null},
    confidence: 'high', issues: [], evidenceIds: ['body'], correctionPatch: null, fieldEvidence: null}], issues: []};
const response = (value: unknown, status = 'completed') => ({status, service_tier:'default',
  output: [{type: 'message', content: [{type: 'output_text', text: JSON.stringify(value)}]}],
  usage: {input_tokens: 500, output_tokens: 200, output_tokens_details: {reasoning_tokens: 70}}});
const noLegacy: typeof fetch = Object.assign(async () => { throw new Error('unexpected legacy fetch'); }, {preconnect:fetch.preconnect});

test('the announcement provider switch is explicit and never carries the Groq key into OpenAI', () => {
  assert.equal(announcementProvider({}).backend, 'https://api.groq.com/openai/v1');
  assert.equal(provider.kind, 'openai');
  assert.equal(provider.backendKey, '');
  assert.throws(() => announcementProvider({AI_PROVIDER: 'other'}));
});

test('synthetic smoke invokes both exact production schemas and verifies locked public rendering under one cap', async () => {
  const db=new DatabaseSync(':memory:'), formats:string[]=[];
  const template='{{program}} session {{slot}} runs on {{date}} from {{timeRange}}.';
  try {
    assert.equal(await announcementSmokeCli([], 'development', ()=>{}),2);
    const report=await runAnnouncementSmoke(settings,db,{create:async p=>{
      const format=(p.text as {format:{name:string;strict:boolean;schema:{additionalProperties:boolean}}}).format;
      assert.ok(format.strict); assert.equal(format.schema.additionalProperties,false); formats.push(format.name);
      return response(formats.length===1?modelOutput:{text:template});
    }});
    assert.deepEqual(formats,['mathematics_schedule','announcement_draft']); assert.equal(report.capUsd,0.01);
    assert.ok(report.estimatedUsd>0 && report.estimatedUsd<=report.capUsd);
    assert.equal(report.estimatedUsd,report.extractionUsd+report.draftUsd);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='announcement_jobs'").get()?.n,0);
    for (const bad of [{text:'{{program}} only.'},{text:template,autoSend:true},{text:'January 2 {{timeRange}}'}]) {
      let calls=0;
      await assert.rejects(runAnnouncementSmoke(settings,db,{create:async()=>response(++calls===1?modelOutput:bad)}),
        /rendering checks|draft schema|must remain locked/);
      assert.equal(calls,2);
    }
  } finally { db.close(); }
});

test('worker extracts only a pending candidate through Responses, recording the system call in the shared service database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'announcement-openai-'));
  const file = join(dir, 'ai.sqlite');
  const serviceDb = new DatabaseSync(file);
  const sent: Record<string, unknown>[] = [];
  const lockedText = '{{program}} session {{slot}} will run on {{date}} from {{timeRange}}.';
  const close = installAnnouncementAI(settings, file, {create: async p => {
    sent.push(p);
    return response(sent.length === 1 ? modelOutput : {text: lockedText});
  }});
  const editorial: AutomationConfig = {...config, policy: {...config.policy, policies: [{
    id: 'session', type: 'training-session', anchor: 'start', beforeMinutes: 0, template: 'session', major: true, asset: 'none'
  }], templates: {session: lockedText}}};
  const store = new AnnouncementStore(':memory:');
  try {
    store.source(guild, source);
    store.setState('gmail:retry-at', String(Date.now() + 3_600_000));
    const gmail = {get: async () => ({payload: {mimeType: 'text/plain', body: {data: Buffer.from(body).toString('base64url')}}})} as unknown as GmailClient;
    await workerTick(store, editorial, gmail);
    assert.equal(sent.length, 1);
    const request = sent[0]!;
    assert.equal(request.model, 'gpt-6-luna');
    assert.equal(request.store, false);
    const format = (request.text as {format: {type: string; strict: boolean; schema: Record<string, unknown>}}).format;
    assert.equal(format.type, 'json_schema');
    assert.equal(format.strict, true);
    assert.equal(format.schema.additionalProperties, false);
    assert.ok(!JSON.stringify(format.schema).includes('maxLength'));
    assert.ok(!JSON.stringify(request).includes(source.messageId));
    assert.equal(store.candidates(guild).length, 1);
    assert.equal(store.events(guild).length, 0);
    assert.equal(store.jobs(guild).length, 0);
    const row = serviceDb.prepare('SELECT job,user,tier,reasoning_tokens FROM openai_usage').get()!;
    assert.match(String(row.job), /^announcement:extract:[\da-f]{64}$/);
    assert.equal(row.user, 'system');
    assert.equal(row.tier, 'announcement-extract');
    assert.equal(row.reasoning_tokens, 70);
    const candidate = store.candidates(guild)[0]!;
    store.approve(guild, candidate.id, candidate.review_version, 'staff');
    await workerTick(store, editorial, gmail);
    assert.equal(sent.length, 2);
    assert.equal((sent[1]!.text as {format: {name: string}}).format.name, 'announcement_draft');
    const job = store.jobs(guild)[0]!;
    assert.equal(job.state, 'pending_approval');
    assert.equal(job.approved_by, null);
    assert.equal(store.db.prepare('SELECT state FROM announcement_drafts WHERE job=?').get(job.id)?.state, 'ready');
    await workerTick(store, editorial, gmail);
    assert.equal(sent.length, 2);
    assert.equal(serviceDb.prepare("SELECT COUNT(*) AS n FROM openai_usage WHERE tier='announcement-draft'").get()!.n, 1);
  } finally {store.close(); close(); serviceDb.close(); rmSync(dir, {recursive: true, force: true});}
});

test('synthetic drafting cannot reserve a fresh cent after the extractor has spent part of it',async()=>{
  const db=new DatabaseSync(':memory:'); let calls=0;
  const largerReply={...settings,maxOutputTokens:{...settings.maxOutputTokens,luna:12_000}};
  try {
    await assert.rejects(runAnnouncementSmoke(largerReply,db,{create:async()=>{
      calls++;
      return {...response(modelOutput),usage:{input_tokens:500,output_tokens:10_000,output_tokens_details:{reasoning_tokens:9700}}};
    }}),/spending limit/);
    assert.equal(calls,1);
    const rows=db.prepare('SELECT tier,cost_micros FROM openai_usage').all();
    assert.equal(rows.length,1); assert.equal(rows[0]!.tier,'announcement-extract');
    assert.ok(Number(rows[0]!.cost_micros)>4000 && Number(rows[0]!.cost_micros)<10_000);
  } finally {db.close();}
});

test('extraction enforces private-source, review, system budget, incomplete, and malformed-output boundaries', async () => {
  const sent: Record<string, unknown>[] = [];
  let output: unknown = response(modelOutput, 'incomplete');
  const client: ResponsesClient = {create: async p => {sent.push(p); return output;}};
  let close = installAnnouncementAI({...settings, requestBudgetUsd: {...settings.requestBudgetUsd, system: 0}}, ':memory:', client);
  try {
    for (const text of ['Your ClassMarker is ready to take', 'VTAMPS and VTASP timetable correction']) {
      const result = await extractFacts(provider, {...mail, evidence: [{id: 'body', text}]}, source, AbortSignal.timeout(2000), noLegacy);
      assert.ok(['private', 'needs_review'].includes(result.disposition!));
    }
    await assert.rejects(extractFacts(provider, mail, source, AbortSignal.timeout(2000), noLegacy), /spending limit/);
    assert.equal(sent.length, 0);
  } finally {close();}
  close = installAnnouncementAI(settings, ':memory:', client);
  try {
    await assert.rejects(extractFacts(provider, mail, source, AbortSignal.timeout(2000), noLegacy), /Incomplete/);
    output = response({...modelOutput, autoSend: true});
    await assert.rejects(extractFacts(provider, mail, source, AbortSignal.timeout(2000), noLegacy), /Schema field/);
    assert.equal(sent.length, 2);
  } finally {close();}
});

test('an unreadable attachment never permits extraction of personal or mixed-scope correction text', async () => {
  const legacy = announcementProvider({AI_PROVIDER:'legacy', GROQ_API_KEY:'synthetic'});
  const blocked = ['Unreadable replacement image.'];
  const signal = AbortSignal.timeout(2000);
  for (const engine of [legacy, provider]) {
    for (const text of ['VTAMPS and VTASP timetable correction', 'VTAMPS correction: your ClassMarker is ready to take']) {
      const result = await extractFacts(engine, {...mail, blocked, evidence:[{id:'body', text}]}, source, signal, noLegacy);
      assert.equal(result.disposition,'needs_review');
      assert.deepEqual(result.events,[]);
    }
  }
  const result = await extractFacts(provider, {...mail, blocked, evidence:[{id:'body', text:body+' Schedule correction.'}]}, source, signal, noLegacy);
  assert.equal(result.disposition,'needs_review');
  assert.deepEqual(result.events,[]);
});

test('provider incidents aggregate separately across the worker rollout', () => {
  const store = new AnnouncementStore(':memory:');
  try {
    const first = store.source(guild, source), second = store.source(guild, {...source, messageId: 'second'});
    recordSourceFailure(store, first, 'groq', 'older outage');
    recordSourceFailure(store, second, 'openai', 'provider backoff');
    for (const engine of ['groq', 'openai'] as const) reconcileExtractionIncident(store, guild, false, 1000, true, engine);
    const incidents = store.db.prepare("SELECT id,kind,target FROM staff_alerts WHERE kind='provider-outage'").all();
    assert.equal(incidents.length, 2);
    for (const a of incidents) {
      const text = staffAlertContent(store, guild, {id: String(a.id), kind: String(a.kind), target: String(a.target)});
      assert.match(text, /1 organizer email is/);
      assert.ok(text.includes(String(a.target).startsWith('openai:') ? 'OpenAI' : 'Groq'));
    }
  } finally {store.close();}
});
