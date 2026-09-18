import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCanvas } from '@napi-rs/canvas';
import { QotdStore } from '../src/qotd/store.js';
import { Competition } from '../src/qotd/competition.js';
import { parseManual, hash } from '../src/qotd/parser.js';
import { phimo } from './qotd-fixtures.js';
import { DEFAULT_RATING, rate, expected, repeatEligible, chooseProblem } from '../src/problems/rating.js';
import { calibrationStep } from '../src/problems/calibration.js';
import { ProblemStore } from '../src/problems/store.js';
import { deliverAttempt, questionPayload, resultPayload, sendResult } from '../src/problems/media.js';
import { handleProblemComponent } from '../src/problems/interactions.js';
import { AdminStore } from '../src/admin/store.js';
import { CREATOR_ID } from '../src/discord-context.js';
import { problemCommand } from '../src/commands/problem.js';
import { problemAdminCommand } from '../src/commands/problem-admin.js';
import { qotd } from '../src/commands/qotd.js';
import { qotdAdmin } from '../src/commands/qotd-admin.js';
import { dayTimes } from '../src/qotd/periods.js';
const dir = mkdtempSync(join(tmpdir(), 'problem-tests-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const guild = '111111111111111111', user = '222222222222222222', other = '333333333333333333';
function crop(name: string, color: string) {
  const canvas = createCanvas(80, 40), context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(0, 0, 80, 40);
  const bytes = canvas.toBuffer('image/png'), path = join(dir, name); writeFileSync(path, bytes);
  return { status: 'override' as const, images: [{ path, sha256: hash(bytes), page: 1, rect: null, width: 80, height: 40 }], flags: [] };
}
const questionCrop = crop('question.png', 'white'), solutionCrop = crop('solution.png', 'red');
let file = 0;
function setup(count = 3, path = ':memory:') {
  const source = new QotdStore(path), c = new Competition(source);
  const parsed = parseManual(phimo), template = parsed.questions[1]!;
  parsed.questions = Array.from({ length: count }, (_, i) => ({ ...template, number: i + 1, text: `Original synthetic problem ${i}: calculate ${i}+${i}.`, rawQuestion: `Synthetic ${i}`, officialAnswer: '10', crop: questionCrop }));
  source.import('synthetic', 'private.pdf', '/nonexistent/private.pdf', 3, parsed);
  for (const q of source.list('pending', 1000)) { source.review(q.id, 'approved', 'mod', true, true); c.configure(q.id, { grading: { mode: 'numeric', value: '10' }, solutionCrop }, 'mod'); }
  let now = 1_000_000;
  const store = new ProblemStore(source, () => now, () => .4);
  store.control(guild, true, { ...DEFAULT_RATING, maxAssignmentsPerDay: 100 }, 'mod');
  return { source, store, c, ids: source.list('approved', 1000).map(q => q.id), advance: (ms: number) => { now += ms; } };
}
function bank(t: ReturnType<typeof setup>, mode: 'rated' | 'practice' = 'rated') { for (const id of t.ids) t.store.promote(id, mode, mode === 'rated' ? 1200 : null, 'mod'); }
async function start(t: ReturnType<typeof setup>, who = user) {
  return deliverAttempt(t.store, t.store.start(guild, who), async () => ({ id: 'message' }));
}
test('rating formula, surprising outcomes and repeat weights have no time input', () => {
  assert.equal(expected(1200, 1200), .5);
  assert.equal(rate(1200, 1200, true, 1).delta, 16);
  assert.equal(rate(1200, 1200, false, 1).delta, -16);
  assert.equal(rate(1200, 1200, true, 2).delta, 8);
  assert.equal(rate(1200, 1200, true, 90).delta, 4);
  assert(rate(1600, 1200, false, 1).delta < -29);
  assert(rate(800, 1200, true, 1).delta > 29);
});
test('repeat cooldown is exactly 30 other assignments, not days', () => {
  assert.equal(repeatEligible(10, 39, 30), false);
  assert.equal(repeatEligible(10, 40, 30), true);
  assert.equal(repeatEligible(null, 0, 30), true);
});
test('first encounter calibration only; bounded provisional candidate is not applied live', () => {
  const first = calibrationStep(1200, 1200, 0, 1200, true, 1);
  assert.equal(first.difficulty, 1196); assert.equal(first.count, 1);
  assert.deepEqual(calibrationStep(1200, 1200, 0, 1200, true, 2), { difficulty: 1200, count: 0, provisional: true, uncertainty: 400 });
  assert.equal(calibrationStep(1200, 1200, 0, 1200, false, 1, true).count, 0);
  assert(calibrationStep(1200, 1100, 100, 1200, true, 1).difficulty >= 1100);
});
test('injected random selection explores and empty pool reports exhaustion', () => {
  const pool = [{ difficulty: 800 }, { difficulty: 1200 }, { difficulty: 1600 }];
  assert.equal(chooseProblem(pool, 1200, 300, () => 0), pool[0]);
  assert.equal(chooseProblem(pool, 1200, 300, () => .5), pool[1]);
  assert.equal(chooseProblem([], 1200, 300), undefined);
});
test('MPoTD commands rename while internal imports remain compatible', () => {
  assert.equal(qotd.data.toJSON().name, 'mpotd'); assert.equal(qotdAdmin.data.toJSON().name, 'mpotd-admin');
  assert.equal(problemCommand().data.toJSON().name, 'problem');
});
test('additive migration preserves prior source state and schema version', () => {
  const path = join(dir, `migration-${file++}.sqlite`), t = setup(1, path), id = t.ids[0]!;
  t.source.close(); const reopened = new QotdStore(path);
  assert.equal(reopened.get(id)!.state, 'approved'); assert.equal(reopened.db.prepare('PRAGMA user_version').get()!.user_version, 3);
  assert.equal(reopened.db.prepare('SELECT max(version) v FROM problem_schema').get()!.v, 1); reopened.close();
});
test('bank promotion is explicit, requires grading and isolates daily selection', () => {
  const t = setup(2); try {
    assert.equal(t.store.available(guild, user, DEFAULT_RATING).length, 0);
    t.source.db.prepare('DELETE FROM qotd_question_settings WHERE question=?').run(t.ids[0]!);
    assert.throws(() => t.store.promote(t.ids[0]!, 'rated', 1200, 'mod'), /reviewed/);
    assert.throws(() => t.store.promote(t.ids[1]!, 'rated', null, 'mod'), /difficulty/);
    t.store.promote(t.ids[1]!, 'rated', 1200, 'mod');
    const selected = t.source.claim(guild, 'channel', '2026-09-18'); assert.equal(selected!.question.id, t.ids[0]);
    assert.throws(() => t.store.promote(t.ids[0]!, 'rated', 1200, 'mod'));
  } finally { t.source.close(); }
});
test('successful delivery starts clock at acknowledgement, consumes once and shares bank across users', async () => {
  const t = setup(); bank(t); try {
    const pending = t.store.start(guild, user); assert.equal(pending.deadline, null); assert.equal(t.store.player(guild, user).sequence, 0);
    assert.equal(t.store.start(guild, user).id, pending.id); t.advance(20_000);
    const a = await deliverAttempt(t.store, pending, async () => { t.advance(800); return { id: 'm' }; });
    assert.equal(a.deadline! - a.delivered!, 600_000); assert.equal(a.delivered, 1_020_800);
    assert.equal(t.store.player(guild, user).sequence, 1);
    assert.equal(t.store.delivered(a.id, 'old', 'm').sequence, 1);
    assert.equal(t.store.start(guild, other).question, a.question);
  } finally { t.source.close(); }
});
test('correct finalization is idempotent and unrated/daily scores are untouched', async () => {
  const t = setup(); bank(t); try {
    const a = await start(t);
    assert.equal(t.store.submit(a.id, guild, user, '10').correct, 1);
    assert.equal(t.store.player(guild, user).rating, 1216);
    assert.equal(t.store.submit(a.id, guild, user, 'wrong').correct, 1);
    assert.equal(t.store.player(guild, user).scored, 1);
    assert.equal(t.source.db.prepare('SELECT count(*) n FROM qotd_submissions').get()!.n, 0);
    assert.throws(() => t.source.db.prepare('UPDATE problem_events SET delta=0').run(), /Immutable/);
  } finally { t.source.close(); }
});
test('incorrect is scored but timeout/late is abandoned without calibration or rating changes', async () => {
  const t = setup(); bank(t); try {
    const a = await start(t); t.store.submit(a.id, guild, user, '9'); assert.equal(t.store.player(guild, user).rating, 1184);
    const next = await start(t); t.advance(600_000);
    assert.equal(t.store.submit(next.id, guild, user, '10').state, 'expired');
    assert.equal(t.store.player(guild, user).rating, 1184); assert.equal(t.store.player(guild, user).sequence, 2);
    assert.equal(t.store.history(guild, user).length, 1);
  } finally { t.source.close(); }
});
test('delivery failure retries the same assignment without clock or consumption', async () => {
  const t = setup(); bank(t); try {
    const pending = t.store.start(guild, user);
    await assert.rejects(deliverAttempt(t.store, pending, async () => { throw Object.assign(new Error('Discord rejected send'), {status: 403}); }));
    assert.equal(t.store.start(guild, user).id, pending.id); assert.equal(t.store.get(pending.id)!.deadline, null);
    assert.equal(t.store.player(guild, user).sequence, 0);
    const a = await start(t); assert.equal(a.id, pending.id); assert.equal(a.state, 'active');
  } finally { t.source.close(); }
});
test('DB write failure after successful delivery retries the original acknowledgement', async () => {
  const t = setup(); bank(t); try {
    const original = t.store.delivered.bind(t.store); let calls = 0;
    t.store.delivered = (...args) => { calls++; if (calls === 1) { t.advance(5000); throw new Error('busy'); } return original(...args); };
    const a = await start(t); assert.equal(calls, 2); assert.equal(a.delivered, 1_000_000); assert.equal(a.deadline, 1_600_000);
  } finally { t.source.close(); }
});
test('transaction failure during score rolls back both event and player; retry succeeds once', async () => {
  const t = setup(); bank(t); try {
    const a = await start(t);
    t.source.db.exec("CREATE TRIGGER fail_score BEFORE UPDATE ON problem_players BEGIN SELECT RAISE(ABORT,'injected failure'); END;");
    assert.throws(() => t.store.submit(a.id, guild, user, '10'), /injected failure/);
    assert.equal(t.store.history(guild, user).length, 0); assert.equal(t.store.get(a.id)!.state, 'active');
    t.source.db.exec('DROP TRIGGER fail_score'); t.store.submit(a.id, guild, user, '10'); assert.equal(t.store.player(guild, user).scored, 1);
  } finally { t.source.close(); }
});
test('restart and separate DB connections retain deadline and prevent duplicate scoring', async () => {
  const path = join(dir, `restart-${file++}.sqlite`), t = setup(2, path); bank(t);
  const a = await start(t); t.source.close();
  const one = new QotdStore(path), two = new QotdStore(path);
  try {
    const s1 = new ProblemStore(one, () => 1_100_000), s2 = new ProblemStore(two, () => 1_100_001);
    assert.equal(s1.resume(guild, user).deadline, a.deadline);
    assert.equal(s2.start(guild, user).id, a.id);
    await Promise.all([Promise.resolve().then(() => s1.submit(a.id, guild, user, '10')), Promise.resolve().then(() => s2.submit(a.id, guild, user, '9'))]);
    assert.equal(s1.player(guild, user).scored, 1); assert.equal(s1.history(guild, user).length, 1);
  } finally { one.close(); two.close(); }
});
test('ownership prevents answer, result and source access by another user', async () => {
  const t = setup(); bank(t); try {
    const a = await start(t);
    assert.throws(() => t.store.solution(a.id, guild, user), /after/);
    assert.throws(() => t.store.owned(a.id, guild, other), /unavailable/);
    assert.throws(() => t.store.submit(a.id, guild, other, '10'), /unavailable/);
    t.store.submit(a.id, guild, user, '10'); assert.throws(() => t.store.solution(a.id, guild, other), /unavailable/);
  } finally { t.source.close(); }
});
test('unrated is untimed, allows repeated answers and cannot reveal future daily or rated bank', () => {
  const t = setup(2); try {
    assert.throws(() => t.store.practice(guild, user), /No revealed/);
    t.store.promote(t.ids[0]!, 'practice', null, 'mod'); t.store.promote(t.ids[1]!, 'rated', 1200, 'mod');
    const a = t.store.practice(guild, user); assert.equal(a.question, t.ids[0]);
    t.advance(1_000_000); assert.equal(t.store.submit(a.id, guild, user, '9').correct, 0);
    assert.equal(t.store.submit(a.id, guild, user, '10').correct, 1);
    assert.equal(t.store.player(guild, user).scored, 0); assert.equal(t.store.player(guild, user).rating, 1200);
    assert.equal(t.store.solution(a.id, guild, user).snapshot.expectedAnswer, '10');
  } finally { t.source.close(); }
});
test('revealed daily archive is available only after reveal and no outstanding reservation', () => {
  const t = setup(1); try {
    const day = '2026-09-18', selected = t.source.claim(guild, 'channel', day)!;
    t.c.create(selected.claim.id, selected.question, dayTimes(day).opensAt); t.source.finish(selected.claim.id, 'message');
    assert.throws(() => t.store.practice(guild, user));
    t.source.db.prepare("UPDATE qotd_sessions SET state='revealed',revealedAt=1 WHERE id=?").run(selected.claim.id);
    assert.equal(t.store.practice(guild, user).question, selected.question.id);
    assert.throws(() => t.store.promote(selected.question.id, 'rated', 1200, 'mod'), /Daily/);
  } finally { t.source.close(); }
});
test('invalid disables assignment and current score; ordinary difficulty edits never rewrite history', async () => {
  const t = setup(1); bank(t); try {
    const a = await start(t);
    assert.throws(() => t.store.updateProblem(a.question, true, false, 'mod', 'new estimate', 1300), /locked/);
    t.store.updateProblem(a.question, false, true, 'mod', 'bad answer');
    assert.equal(t.store.submit(a.id, guild, user, '10').state, 'cancelled');
    assert.equal(t.store.player(guild, user).scored, 0); assert.throws(() => t.store.start(guild, user), /No eligible/);
  } finally { t.source.close(); }
});
test('small bank exhausts, repeat requires thirty others and second encounter has half weight', async () => {
  const t = setup(31); bank(t); try {
    const first = await start(t); t.store.submit(first.id, guild, user, '10');
    assert.equal(t.store.available(guild, user, DEFAULT_RATING).length, 30);
    for (let i = 0; i < 30; i++) { const a = await start(t); assert.notEqual(a.question, first.question); t.store.submit(a.id, guild, user, '10'); }
    const repeated = await start(t); assert.equal(repeated.question, first.question); assert.equal(repeated.encounter, 2);
    t.store.submit(repeated.id, guild, user, '10'); assert.equal(t.store.history(guild, user)[0]!.weight, .5);
  } finally { t.source.close(); }
});
test('single-problem bank does not relax cooldown after time passes', async () => {
  const t = setup(1); bank(t); try {
    const a = await start(t); t.store.submit(a.id, guild, user, '10'); t.advance(99 * 86_400_000);
    assert.throws(() => t.store.start(guild, user), /No eligible/);
  } finally { t.source.close(); }
});
test('abandonment limit stops rapid rerolls without counting an incorrect answer', async () => {
  const t = setup(6); bank(t); try {
    for (let i = 0; i < 3; i++) { await start(t); t.advance(600_000); t.store.resume(guild, user); }
    assert.throws(() => t.store.start(guild, user), /24-hour/); assert.equal(t.store.player(guild, user).scored, 0);
    t.advance(86_400_000); assert.equal(t.store.start(guild, user).state, 'pending');
  } finally { t.source.close(); }
});
test('correction appends history and replays downstream ratings without mutating original events', async () => {
  const t = setup(); bank(t); try {
    const first = await start(t); t.store.submit(first.id, guild, user, '10'); const second = await start(t); t.store.submit(second.id, guild, user, '10');
    const original = JSON.stringify(t.store.history(guild, user));
    t.store.correct(first.id, null, 'mod', 'ambiguous official key', 'correction-1');
    assert.equal(t.store.player(guild, user).rating, 1216); assert.equal(t.store.player(guild, user).scored, 1);
    assert.equal(JSON.stringify(t.store.history(guild, user)), original);
    t.store.correct(first.id, null, 'mod', 'retry', 'correction-1');
    assert.equal(t.source.db.prepare('SELECT count(*) n FROM problem_revisions').get()!.n, 1);
    t.store.correct(first.id, false, 'mod', 'reviewed answer', 'correction-2');
    assert.equal(t.store.player(guild, user).scored, 2);
    assert.equal(t.store.player(guild, user).correct, 1);
  } finally { t.source.close(); }
});
test('solution images reuse source renderer; normal answer and page citation stay present', async () => {
  const t = setup(); bank(t); try {
    const a = await start(t); t.store.submit(a.id, guild, user, '10');
    const payload = await resultPayload(t.store, t.store.solution(a.id, guild, user));
    assert.match(String(payload.content), /Answer: 10/); assert.match(String(payload.content), /Source:/); assert.match(String(payload.content), /Solution: page 2/);
    assert.equal(payload.files!.length, 1); assert.equal((payload.files![0] as any).name, 'solution-1.png');
    assert.equal((questionPayload(a).files![0] as any).attachment, questionCrop.images[0]!.path);
  } finally { t.source.close(); }
});
test('crop failure is safe after scoring and produces the preserved official text', async () => {
  const t = setup(); bank(t); try {
    const a = await start(t); t.store.submit(a.id, guild, user, '10');
    const ended = t.store.solution(a.id, guild, user); delete ended.snapshot.solutionCrop;
    const payload = await resultPayload(t.store, ended); assert.equal((payload.files![0] as any).name, 'official-solution.txt');
    assert.equal(t.store.player(guild, user).rating, 1216);
  } finally { t.source.close(); }
});
test('expired interaction response cannot roll back scoring; new result command is owner-authenticated', async () => {
  const t = setup(); bank(t); try {
    const a = await start(t);
    const i: any = { guildId: guild, user: { id: user }, customId: `problem:submit:${a.id}`, deferred: false,
      isButton: () => false, isModalSubmit: () => true, fields: { getTextInputValue: () => '10' },
      deferReply: async () => { i.deferred = true; }, editReply: async () => { throw new Error('expired token'); } };
    await handleProblemComponent(i, t.store, guild);
    assert.equal(t.store.player(guild, user).scored, 1);
    let result: any;
    const command: any = { guildId: guild, user: { id: user }, options: { getSubcommand: () => 'result', getString: () => a.id },
      deferReply: async () => {}, editReply: async (p: any) => { result = p; } };
    await problemCommand(() => t.store).execute(command); assert.match(result.content, /Correct/);
  } finally { t.source.close(); }
});
test('unauthorized admin requests are private, denied at execution and do not access the store', async () => {
  let flags: unknown, text = '', calls = 0;
  const i: any = { guildId: guild, inGuild: () => true, user: { id: user }, member: { roles: [] }, memberPermissions: { has: () => false },
    deferReply: async (p: any) => { flags = p.flags; }, editReply: async (p: string) => { text = p; } };
  await problemAdminCommand({ store: () => { calls++; throw Error(); }, audit: () => { throw Error(); } }).execute(i);
  assert.equal(flags, 64); assert.match(text, /moderator/); assert.equal(calls, 0);
});
test('interrupted delivery after restart recovers explicitly without a rating penalty or a stuck active attempt', () => {
  const path = join(dir, `delivery-recovery-${file++}.sqlite`), t = setup(2, path); bank(t);
  const a = t.store.start(guild, user); t.store.beginDelivery(a.id, guild, user); t.source.close();
  const source = new QotdStore(path), recovered = new ProblemStore(source, () => 1_060_001);
  try {
    const ended = recovered.resume(guild, user);
    assert.equal(ended.state, 'cancelled'); assert.equal(ended.deadline, null);
    assert.equal(recovered.player(guild, user).rating, 1200); assert.equal(recovered.player(guild, user).scored, 0);
    assert.equal(recovered.player(guild, user).sequence, 1);
    assert.notEqual(recovered.start(guild, user).question, ended.question);
  } finally { source.close(); }
});
test('deadline boundary is closed, resumed result expires even with an explicit attempt ID', async () => {
  const t = setup(); bank(t); try {
    const a = await start(t); t.advance(600_000);
    assert.equal(t.store.solution(a.id, guild, user).state, 'expired');
    assert.equal(t.store.submit(a.id, guild, user, '10').state, 'expired');
    assert.equal(t.store.history(guild, user).length, 0);
  } finally { t.source.close(); }
});
test('new daily scores ignore legacy bonus while previously finalized scores are preserved', () => {
  const t = setup(2); try {
    const day = '2026-09-18', times = dayTimes(day), first = t.source.claim(guild, 'channel', day)!;
    t.c.create(first.claim.id, first.question, times.opensAt); t.source.finish(first.claim.id, 'message');
    const token = t.c.openModal(first.claim.id, guild, 'channel', 'message', user, times.opensAt + 1000);
    t.c.submit(token, guild, 'channel', user, '10', times.opensAt + 1000);
    t.source.db.prepare("UPDATE qotd_sessions SET snapshot=json_set(snapshot,'$.scoring.speedBonus',99) WHERE id=?").run(first.claim.id);
    t.c.score(first.claim.id, times.revealAt); assert.equal(t.c.results(first.claim.id)[0]!.points, 10);
    t.source.db.prepare('UPDATE qotd_submissions SET points=11.99 WHERE qotd=?').run(first.claim.id);
    t.c.score(first.claim.id, times.revealAt + 1000); assert.equal(t.c.results(first.claim.id)[0]!.points, 11.99);
  } finally { t.source.close(); }
});
test('two independent Bun processes racing to finalize create exactly one event', async () => {
  const path = join(dir, `parallel-${file++}.sqlite`), t = setup(2, path); bank(t);
  const a = await start(t);
  const worker = join(dir, `race-${file++}.ts`);
  const sourceUrl = new URL('../src/qotd/store.ts', import.meta.url).href;
  const problemUrl = new URL('../src/problems/store.ts', import.meta.url).href;
  writeFileSync(worker, `import {QotdStore} from ${JSON.stringify(sourceUrl)};\nimport {ProblemStore} from ${JSON.stringify(problemUrl)};\nconst db=new QotdStore(Bun.argv[2]); const store=new ProblemStore(db,()=>1100000); console.log('ready'); await Bun.stdin.text(); store.submit(Bun.argv[3],Bun.argv[4],Bun.argv[5],Bun.argv[6]); db.close();`);
  const workers = ['10', '9'].map(answer => Bun.spawn([process.execPath, worker, path, a.id, guild, user, answer], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }));
  try {
    await Promise.all(workers.map(async p => { const reader = p.stdout.getReader(); const ready = await reader.read(); reader.releaseLock(); assert.match(new TextDecoder().decode(ready.value), /ready/); }));
    for (const p of workers) { p.stdin.write('go'); p.stdin.end(); }
    assert.deepEqual(await Promise.all(workers.map(p => p.exited)), [0, 0]);
    assert.equal(t.store.history(guild, user).length, 1); assert.equal(t.store.player(guild, user).scored, 1);
  } finally { for (const p of workers) p.kill(); t.source.close(); }
});
test('owner administration reuses audit and keeps configuration changes private', async () => {
  const t = setup(1), audit = new AdminStore(':memory:');
  try {
    let result: any, flags: unknown;
    const i: any = { id: 'operation', guildId: guild, inGuild: () => true, user: { id: CREATOR_ID }, member: { roles: [] },
      memberPermissions: { has: () => false }, options: { getSubcommand: () => 'configure', getString: () => null, getBoolean: () => true },
      deferReply: async (p: any) => { flags = p.flags; }, editReply: async (p: any) => { result = p; } };
    await problemAdminCommand({ store: () => t.store, audit: () => audit }).execute(i);
    assert.equal(flags, 64); assert.match(result.content, /Experimental/);
    assert.equal(audit.db.prepare('SELECT count(*) n FROM admin_audit').get()!.n, 2);
    assert(t.source.db.prepare("SELECT 1 FROM problem_audit WHERE action='control' AND actor=?").get(CREATOR_ID));
  } finally { audit.close(); t.source.close(); }
});
test('persistent confirmation-write failure is unscored and later recovers without resetting a timer', async () => {
  const t = setup(2); bank(t); try {
    const pending = t.store.start(guild, user), original = t.store.delivered.bind(t.store);
    t.store.delivered = () => { throw new Error('persistent write failure'); };
    await assert.rejects(deliverAttempt(t.store, pending, async () => ({ id: 'visible' })));
    assert.equal(t.store.get(pending.id)!.state, 'delivering'); assert.equal(t.store.history(guild, user).length, 0);
    t.store.delivered = original; t.advance(60_001);
    assert.equal(t.store.resume(guild, user).state, 'cancelled'); assert.equal(t.store.player(guild, user).rating, 1200);
  } finally { t.source.close(); }
});
test('corrected downstream result reports its effective replay delta and practice bank does not calibrate', async () => {
  const t = setup(3); bank(t); try {
    const a = await start(t); t.store.submit(a.id, guild, user, '10'); const b = await start(t); t.store.submit(b.id, guild, user, '10');
    const original = t.store.effectiveEvent(b.id)!.delta;
    t.store.correct(a.id, null, 'mod', 'void bad problem', 'void-first');
    assert.equal(t.store.effectiveEvent(b.id)!.delta, 16); assert.notEqual(original, 16);
    assert.match(String((await resultPayload(t.store, t.store.solution(b.id, guild, user))).content), /Rating change: 16.00/);
    assert.equal(t.store.inspect(a.question)[0]!.valid_first_encounters, 0);
  } finally { t.source.close(); }
});
test('ambiguous Discord send stays leased and cannot silently reroll or start a timer', async () => {
  const t = setup(2); bank(t); try {
    const a = t.store.start(guild, user);
    await assert.rejects(deliverAttempt(t.store, a, async () => { throw new Error('network timeout'); }));
    assert.equal(t.store.start(guild, user).id, a.id); assert.equal(t.store.get(a.id)!.deadline, null);
    t.advance(60_001); assert.equal(t.store.resume(guild, user).state, 'cancelled');
    assert.equal(t.store.player(guild, user).scored, 0); assert.equal(t.store.player(guild, user).sequence, 1);
  } finally { t.source.close(); }
});
test('long answer with ten solution pages is split privately without losing the final page', async () => {
  const t = setup(); bank(t); try {
    const a = await start(t); t.store.submit(a.id, guild, user, '10');
    const ended = t.store.solution(a.id, guild, user);
    ended.snapshot.expectedAnswer = 'official answer '.repeat(180);
    ended.snapshot.solutionCrop = { ...solutionCrop, images: Array.from({ length: 10 }, () => ({ ...solutionCrop.images[0]! })) };
    const messages: any[] = [];
    await sendResult(t.store, ended, async p => { messages.push(p); }, async p => { messages.push(p); });
    assert.equal(messages.length, 2); assert.equal(messages[0].files.length, 10); assert.equal(messages[1].files.length, 1);
    assert.equal(messages[0].files[9].name, 'solution-10.png'); assert.equal(messages[1].files[0].name, 'answer-and-source.txt');
  } finally { t.source.close(); }
});
