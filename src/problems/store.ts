import { randomUUID } from 'node:crypto';
import { atomic, publicSource, type Snapshot, type QuestionSettings } from '../qotd/competition.js';
import type { QotdStore } from '../qotd/store.js';
import { validateCrop } from '../qotd/crops.js';
import { grade, validateGrading } from '../qotd/grading.js';
import { DEFAULT_SCORING } from '../qotd/scoring.js';
import { bindSolutionSource } from '../qotd/solutions.js';
import { DEFAULT_RATING, chooseProblem, rate, repeatEligible, validateConfig, type RatingConfig } from './rating.js';

export interface Attempt {
  id: string; guild: string; user: string; question: string; mode: 'rated' | 'practice';
  state: 'pending' | 'delivering' | 'active' | 'completed' | 'expired' | 'cancelled';
  created: number; delivery_started: number | null; delivered: number | null; deadline: number | null;
  message: string | null; sequence: number | null; encounter: number | null; difficulty: number | null;
  config: RatingConfig; snapshot: Snapshot; answer: string | null; correct: number | null; finished: number | null; lease: string | null;
}
export interface Player { guild: string; user: string; rating: number; peak: number; scored: number; correct: number; sequence: number }
export class ProblemError extends Error {}
const DAY = 86_400_000;
export class ProblemStore {
  constructor(readonly source: QotdStore, readonly clock = Date.now, readonly rng = Math.random) {}
  get db() { return this.source.db; }
  audit(actor: string, action: string, details: unknown) {
    this.db.prepare('INSERT INTO problem_audit(actor,action,created,details) VALUES(?,?,?,?)').run(actor, action, this.clock(), JSON.stringify(details));
    this.source.audit(actor, `problem.${action}: ${JSON.stringify(details)}`);
  }
  controls(guild: string) {
    const row = this.db.prepare('SELECT * FROM problem_controls WHERE guild=?').get(guild);
    return { enabled: Boolean(row?.enabled), config: row ? JSON.parse(String(row.config)) as RatingConfig : DEFAULT_RATING };
  }
  control(guild: string, enabled: boolean, config: RatingConfig, actor: string) {
    validateConfig(config);
    atomic(this.db, () => {
      if (config.initial !== this.controls(guild).config.initial && this.db.prepare('SELECT 1 FROM problem_players WHERE guild=?').get(guild)) throw new ProblemError('Initial player rating is locked after the first assignment.');
      this.db.prepare('INSERT INTO problem_controls VALUES(?,?,?) ON CONFLICT(guild) DO UPDATE SET enabled=excluded.enabled,config=excluded.config')
        .run(guild, Number(enabled), JSON.stringify(config));
      this.audit(actor, 'control', { guild, enabled, config });
    });
  }
  private snapshot(question: string): Snapshot {
    const q = this.source.get(question);
    const saved = this.db.prepare('SELECT config FROM qotd_question_settings WHERE question=?').get(question);
    if (!q || q.state !== 'approved' || !q.cropReviewed || !saved || !q.officialAnswer.trim()) throw new ProblemError('This problem needs an approved crop and an explicitly reviewed answer-checking rule.');
    validateCrop(q.crop);
    const settings: QuestionSettings = JSON.parse(String(saved.config));
    validateGrading(settings.grading);
    const occurrence = this.source.occurrences(question)[0];
    const solutionSource = bindSolutionSource(occurrence, q.officialAnswer, q.officialSolution);
    return { questionType: q.kind, expectedAnswer: q.officialAnswer, solution: q.officialSolution,
      questionCrop: q.crop, source: settings.publicSource ?? publicSource(q, occurrence ? JSON.parse(String(occurrence.metadata)) : undefined),
      grading: settings.grading, scoring: DEFAULT_SCORING,
      ...(solutionSource ? { solutionSource } : {}), ...(settings.solutionCrop ? { solutionCrop: settings.solutionCrop } : {}) };
  }
  promote(question: string, mode: 'rated' | 'practice', difficulty: number | null, actor: string) {
    return atomic(this.db, () => {
      this.snapshot(question);
      if (this.db.prepare('SELECT 1 FROM qotd_history WHERE question=?').get(question)) throw new ProblemError('Daily reservations and published problems cannot enter a private bank. Use the revealed archive instead.');
      if (mode === 'rated' && (difficulty === null || !Number.isFinite(difficulty) || difficulty < 0 || difficulty > 4000)) throw new ProblemError('Supply an explicit initial difficulty from 0 to 4000.');
      const old = this.db.prepare('SELECT * FROM problem_catalog WHERE question=?').get(question);
      if (old) throw new ProblemError('Problem already belongs to a bank. Inspect it or update its eligibility. Bank transfers are intentionally unavailable.');
      this.db.prepare('INSERT INTO problem_catalog(question,mode,initial_difficulty,difficulty,approved_by,approved_at) VALUES(?,?,?,?,?,?)')
        .run(question, mode, difficulty, difficulty, actor, this.clock());
      this.audit(actor, 'promote', { question, mode, difficulty });
    });
  }
  updateProblem(question: string, enabled: boolean, invalid: boolean, actor: string, reason: string, difficulty?: number) {
    if (!reason.trim()) throw new ProblemError('A reason is required.');
    atomic(this.db, () => {
      const before = this.db.prepare('SELECT * FROM problem_catalog WHERE question=?').get(question);
      if (!before) throw new ProblemError('Unknown practice-bank problem.');
      if (difficulty !== undefined) {
        if (!Number.isFinite(difficulty) || difficulty < 0 || difficulty > 4000) throw new ProblemError('Difficulty must be between 0 and 4000.');
        if (this.db.prepare('SELECT 1 FROM problem_attempts WHERE question=?').get(question)) throw new ProblemError('Initial difficulty is locked after assignment. Historical event difficulty is immutable.');
        this.db.prepare('UPDATE problem_catalog SET initial_difficulty=?,difficulty=? WHERE question=?').run(difficulty, difficulty, question);
      }
      if (enabled && !invalid) this.snapshot(question);
      this.db.prepare('UPDATE problem_catalog SET enabled=?,invalid=? WHERE question=?').run(Number(enabled), Number(invalid), question);
      // Invalid content cannot generate another score, including already-open attempts.
      if (invalid) this.db.prepare("UPDATE problem_attempts SET state='cancelled',finished=? WHERE question=? AND state IN ('pending','delivering','active')").run(this.clock(), question);
      this.audit(actor, 'eligibility', { before, question, enabled, invalid, reason, difficulty });
    });
  }
  inspect(question?: string) {
    return this.db.prepare(`SELECT p.*, (SELECT count(*) FROM problem_attempts a WHERE a.question=p.question) assignments,
      (SELECT count(*) FROM problem_events e WHERE e.question=p.question AND e.encounter=1
       AND NOT EXISTS(SELECT 1 FROM problem_corrections c WHERE c.attempt=e.attempt)) valid_first_encounters,
      1 provisional, 400 uncertainty, 'disabled; evidence only' calibration
      FROM problem_catalog p WHERE (? IS NULL OR p.question=?) ORDER BY p.approved_at LIMIT 100`).all(question ?? null, question ?? null).map(row => {
        const q = this.source.get(String(row.question));
        return {...row, source: this.source.occurrences(String(row.question)).map(o => JSON.parse(String(o.metadata))),
          questionPage: q?.questionPage, solutionPage: q?.solutionPage, sourceReview: q?.state, flags: q?.flags};
      });
  }
  attempts(question: string, offset = 0) {
    return { total: Number(this.db.prepare('SELECT count(*) n FROM problem_attempts WHERE question=?').get(question)!.n), offset,
      records: this.db.prepare('SELECT id,guild,user,state,correct,encounter,created FROM problem_attempts WHERE question=? ORDER BY created DESC,rowid DESC LIMIT 100 OFFSET ?').all(question, offset) };
  }
  get(id: string): Attempt | null {
    const row = this.db.prepare('SELECT * FROM problem_attempts WHERE id=?').get(id);
    return row ? { ...row, config: JSON.parse(String(row.config)), snapshot: JSON.parse(String(row.snapshot)) } as unknown as Attempt : null;
  }
  owned(id: string, guild: string, user: string) {
    const a = this.get(id);
    if (!a || a.guild !== guild || a.user !== user) throw new ProblemError('This attempt is unavailable to your account.');
    return a;
  }
  player(guild: string, user: string): Player {
    return (this.db.prepare('SELECT * FROM problem_players WHERE guild=? AND user=?').get(guild, user) as unknown as Player | undefined)
      ?? { guild, user, rating: this.controls(guild).config.initial, peak: this.controls(guild).config.initial, scored: 0, correct: 0, sequence: 0 };
  }
  private expire(now = this.clock()) {
    this.db.prepare("UPDATE problem_attempts SET state='expired',finished=deadline WHERE mode='rated' AND state='active' AND deadline<=?").run(now);
  }
  available(guild: string, user: string, config: RatingConfig) {
    const player = this.player(guild, user);
    return this.db.prepare(`SELECT p.question,p.difficulty,
      (SELECT max(a.sequence) FROM problem_attempts a WHERE a.guild=? AND a.user=? AND a.question=p.question AND a.mode='rated') last_sequence
      FROM problem_catalog p JOIN qotd_questions q ON q.id=p.question
      WHERE p.mode='rated' AND p.enabled=1 AND p.invalid=0 AND q.state='approved' AND q.crop_reviewed=1
      AND EXISTS(SELECT 1 FROM qotd_question_settings s WHERE s.question=p.question)
      AND NOT EXISTS(SELECT 1 FROM qotd_history h WHERE h.question=p.question)
      AND NOT EXISTS(SELECT 1 FROM problem_attempts a WHERE a.question=p.question AND a.mode='practice')`).all(guild, user)
      .filter(row => repeatEligible(row.last_sequence === null ? null : Number(row.last_sequence), player.sequence, config.cooldown))
      .map(row => ({ question: String(row.question), difficulty: Number(row.difficulty) }));
  }
  start(guild: string, user: string): Attempt {
    return atomic(this.db, () => {
      this.expire();
      const active = this.db.prepare("SELECT id,guild FROM problem_attempts WHERE user=? AND mode='rated' AND state IN ('pending','delivering','active')").get(user);
      if (active) {
        if (active.guild !== guild) throw new ProblemError('Resume your existing rated attempt in its original server.');
        return this.recoverDelivery(this.get(String(active.id))!);
      }
      const { enabled, config } = this.controls(guild);
      if (!enabled) throw new ProblemError('Rated practice is disabled pending moderator review. Unrated practice is available separately.');
      const counts = this.db.prepare(`SELECT count(*) assigned, sum(state IN ('expired','cancelled')) abandoned FROM problem_attempts
        WHERE guild=? AND user=? AND mode='rated' AND created>?`).get(guild, user, this.clock() - DAY)!;
      if (Number(counts.assigned) >= config.maxAssignmentsPerDay || Number(counts.abandoned) >= config.maxAbandonedPerDay)
        throw new ProblemError('Your rolling 24-hour attempt limit has been reached. Please return later; unrated practice remains available.');
      const pool = this.available(guild, user, config);
      const selected = chooseProblem(pool, this.player(guild, user).rating, config.selectionSpread, this.rng);
      if (!selected) throw new ProblemError('No eligible rated problems remain. The bank needs more approved problems; cooldown is never silently relaxed.');
      const id = randomUUID(), snapshot = this.snapshot(selected.question);
      this.db.prepare(`INSERT INTO problem_attempts(id,guild,user,question,mode,state,created,difficulty,config,snapshot)
        VALUES(?,?,?,?,'rated','pending',?,?,?,?)`).run(id, guild, user, selected.question, this.clock(), selected.difficulty, JSON.stringify(config), JSON.stringify(snapshot));
      return this.get(id)!;
    });
  }
  resume(guild: string, user: string) {
    return atomic(this.db, () => {
      this.expire();
      const row = this.db.prepare("SELECT id FROM problem_attempts WHERE guild=? AND user=? AND mode='rated' ORDER BY created DESC,rowid DESC LIMIT 1").get(guild, user);
      if (!row) throw new ProblemError('No rated attempt exists. Use /problem rated to begin.');
      return this.recoverDelivery(this.get(String(row.id))!);
    });
  }
  // Discord and SQLite cannot commit together. A stale unconfirmed send may have
  // exposed the problem: explicitly cancel it with no rating effect, retain its
  // encounter/cooldown, and let the owner start again. Never reset a live timer.
  private recoverDelivery(a: Attempt): Attempt {
    if (a.state !== 'delivering' || this.clock() - a.delivery_started! < 60_000) return a;
    const p = this.player(a.guild, a.user), sequence = p.sequence + 1;
    const encounter = 1 + Number(this.db.prepare("SELECT count(*) n FROM problem_attempts WHERE guild=? AND user=? AND question=? AND mode='rated' AND sequence IS NOT NULL").get(a.guild, a.user, a.question)!.n);
    this.db.prepare(`INSERT INTO problem_players(guild,user,rating,peak,sequence) VALUES(?,?,?,?,?)
      ON CONFLICT(guild,user) DO UPDATE SET sequence=excluded.sequence`).run(a.guild, a.user, p.rating, p.peak, sequence);
    this.db.prepare("UPDATE problem_attempts SET state='cancelled',finished=?,sequence=?,encounter=?,lease=NULL WHERE id=?")
      .run(this.clock(), sequence, encounter, a.id);
    this.audit(a.user, 'unconfirmed-delivery-recovery', { attempt: a.id, sequence, encounter, reason: 'Interrupted delivery; no rating change. Consumed conservatively because the question may have been visible.' });
    return this.get(a.id)!;
  }
  beginDelivery(id: string, guild: string, user: string) {
    return atomic(this.db, () => {
      const a = this.owned(id, guild, user);
      if (a.state === 'active') return a;
      if (a.state === 'delivering') throw new ProblemError('Delivery is being confirmed. Use /problem resume after one minute. Interrupted delivery is cancelled explicitly without scoring; an exposed problem stays on cooldown.');
      if (a.state !== 'pending') throw new ProblemError('This attempt is no longer awaiting delivery.');
      const lease = randomUUID();
      this.db.prepare("UPDATE problem_attempts SET state='delivering',delivery_started=?,lease=? WHERE id=?").run(this.clock(), lease, id);
      return this.get(id)!;
    });
  }
  deliveryFailed(id: string, lease: string) {
    // A failed initial send retains the exact assignment: failure cannot reroll it.
    this.db.prepare("UPDATE problem_attempts SET state='pending',lease=NULL WHERE id=? AND state='delivering' AND lease=?").run(id, lease);
  }
  delivered(id: string, lease: string, message: string, deliveredAt = this.clock()) {
    return atomic(this.db, () => {
      const a = this.get(id);
      if (!a) throw new ProblemError('Unknown delivery.');
      if (a.delivered !== null) return a;
      if (a.state !== 'delivering' || a.lease !== lease) throw new ProblemError('Delivery reservation changed.');
      const p = this.player(a.guild, a.user), sequence = p.sequence + 1;
      const encounter = 1 + Number(this.db.prepare("SELECT count(*) n FROM problem_attempts WHERE guild=? AND user=? AND question=? AND mode='rated' AND sequence IS NOT NULL").get(a.guild, a.user, a.question)!.n);
      this.db.prepare(`INSERT INTO problem_players(guild,user,rating,peak,sequence) VALUES(?,?,?,?,?)
        ON CONFLICT(guild,user) DO UPDATE SET sequence=excluded.sequence`).run(a.guild, a.user, p.rating, p.peak, sequence);
      this.db.prepare("UPDATE problem_attempts SET state='active',delivered=?,deadline=?,message=?,sequence=?,encounter=?,lease=NULL WHERE id=?")
        .run(deliveredAt, deliveredAt + a.config.durationMs, message, sequence, encounter, id);
      return this.get(id)!;
    });
  }
  submit(id: string, guild: string, user: string, answer: string) {
    return atomic(this.db, () => {
      const now = this.clock();
      this.expire(now);
      const a = this.owned(id, guild, user);
      if (a.state === 'completed' && a.mode === 'rated') return a;
      if (a.state !== 'active') return a;
      if (!answer.trim() || answer.length > 1000) throw new ProblemError('Enter an answer of 1–1000 characters.');
      const correct = grade(answer, a.snapshot.grading);
      if (a.mode === 'practice') {
        this.db.prepare('UPDATE problem_attempts SET answer=?,correct=? WHERE id=?').run(answer, Number(correct), id);
        return this.get(id)!;
      }
      const p = this.player(guild, user), event = rate(p.rating, a.difficulty!, correct, a.encounter!, a.config);
      this.db.prepare('INSERT INTO problem_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, guild, user, a.question, now, event.before, event.after, event.difficulty, event.probability,
          Number(correct), event.encounter, event.weight, event.delta, JSON.stringify(a.config));
      this.db.prepare('UPDATE problem_players SET rating=?,peak=max(peak,?),scored=scored+1,correct=correct+? WHERE guild=? AND user=?')
        .run(event.after, event.after, Number(correct), guild, user);
      this.db.prepare("UPDATE problem_attempts SET state='completed',answer=?,correct=?,finished=? WHERE id=?").run(answer, Number(correct), now, id);
      return this.get(id)!;
    });
  }
  practice(guild: string, user: string) {
    return atomic(this.db, () => {
      const rows = this.db.prepare(`SELECT q.id FROM qotd_questions q WHERE q.state='approved' AND q.crop_reviewed=1
        AND NOT EXISTS(SELECT 1 FROM problem_catalog p WHERE p.question=q.id AND (p.mode='rated' OR p.invalid=1 OR p.enabled=0))
        AND NOT EXISTS(SELECT 1 FROM qotd_history h LEFT JOIN qotd_sessions s ON s.id=h.id WHERE h.question=q.id AND (s.revealedAt IS NULL OR s.state!='revealed'))
        AND (EXISTS(SELECT 1 FROM problem_catalog p WHERE p.question=q.id AND p.mode='practice' AND p.enabled=1 AND p.invalid=0)
         OR EXISTS(SELECT 1 FROM qotd_history h JOIN qotd_sessions s ON s.id=h.id WHERE h.question=q.id AND s.state='revealed' AND s.revealedAt IS NOT NULL))
        AND EXISTS(SELECT 1 FROM qotd_question_settings c WHERE c.question=q.id)`).all();
      if (!rows.length) throw new ProblemError('No revealed or explicitly approved practice problems are available yet.');
      const question = String(rows[Math.floor(this.rng() * rows.length)]!.id), id = randomUUID();
      this.db.prepare(`INSERT INTO problem_attempts(id,guild,user,question,mode,state,created,config,snapshot)
        VALUES(?,?,?,?,'practice','active',?,?,?)`).run(id, guild, user, question, this.clock(), JSON.stringify(DEFAULT_RATING), JSON.stringify(this.snapshot(question)));
      return this.get(id)!;
    });
  }
  solution(id: string, guild: string, user: string) {
    this.expire();
    const a = this.owned(id, guild, user);
    if (a.mode === 'rated' && !['completed', 'expired', 'cancelled'].includes(a.state)) throw new ProblemError('The official solution is available after this attempt ends.');
    return a;
  }
  effectiveEvent(id: string) {
    const event = this.db.prepare('SELECT * FROM problem_events WHERE attempt=?').get(id);
    if (!event) return null;
    const revision = this.db.prepare('SELECT events FROM problem_revisions WHERE guild=? AND user=? ORDER BY id DESC LIMIT 1').get(event.guild!, event.user!);
    const corrected = revision ? (JSON.parse(String(revision.events)) as { attempt: string; void?: boolean; delta?: number; before: number; after: number }[]).find(e => e.attempt === id) : undefined;
    return { delta: corrected ? corrected.delta ?? 0 : Number(event.delta), revised: Boolean(corrected), void: Boolean(corrected?.void) };
  }
  history(guild: string, user: string) {
    return this.db.prepare('SELECT * FROM problem_events WHERE guild=? AND user=? ORDER BY created DESC,rowid DESC LIMIT 20').all(guild, user);
  }
  cancelDelivery(id: string, actor: string, reason: string) {
    if (!reason.trim()) throw new ProblemError('A reason is required.');
    atomic(this.db, () => {
      const a = this.get(id);
      if (!a || !['pending', 'delivering'].includes(a.state)) throw new ProblemError('Only an unconfirmed delivery can be cancelled.');
      this.db.prepare("UPDATE problem_attempts SET state='cancelled',finished=? WHERE id=?").run(this.clock(), id);
      this.audit(actor, 'cancel-delivery', { id, reason, before: a.state });
    });
  }
  correct(id: string, result: boolean | null, actor: string, reason: string, operation: string) {
    if (!reason.trim()) throw new ProblemError('A correction reason is required.');
    return atomic(this.db, () => {
      const event = this.db.prepare('SELECT * FROM problem_events WHERE attempt=?').get(id);
      if (!event) throw new ProblemError('Only scored attempts can be corrected.');
      const existing = this.db.prepare('SELECT * FROM problem_corrections WHERE id=?').get(operation);
      if (existing) {
        if (existing.attempt !== id || existing.result !== (result === null ? null : Number(result))) throw new ProblemError('Correction idempotency key was reused.');
        return this.player(String(event.guild), String(event.user));
      }
      this.db.prepare('INSERT INTO problem_corrections VALUES(?,?,?,?,?,?)').run(operation, id, result === null ? null : Number(result), actor, reason, this.clock());
      const events = this.db.prepare('SELECT * FROM problem_events WHERE guild=? AND user=? ORDER BY created,rowid').all(event.guild!, event.user!);
      let rating = (JSON.parse(String(events[0]!.config)) as RatingConfig).initial, peak = rating, scored = 0, correct = 0;
      const replay: unknown[] = [];
      for (const e of events) {
        const correction = this.db.prepare('SELECT * FROM problem_corrections WHERE attempt=? ORDER BY rowid DESC LIMIT 1').get(e.attempt!);
        const outcome = correction ? correction.result : e.result;
        if (outcome === null) { replay.push({ attempt: e.attempt, void: true, before: rating, after: rating }); continue; }
        const next = rate(rating, Number(e.difficulty), Boolean(outcome), Number(e.encounter), JSON.parse(String(e.config)));
        replay.push({ attempt: e.attempt, ...next }); rating = next.after; peak = Math.max(peak, rating); scored++; correct += Number(Boolean(outcome));
      }
      this.db.prepare('UPDATE problem_players SET rating=?,peak=?,scored=?,correct=? WHERE guild=? AND user=?').run(rating, peak, scored, correct, event.guild!, event.user!);
      this.db.prepare('INSERT INTO problem_revisions(correction,guild,user,created,events,rating) VALUES(?,?,?,?,?,?)').run(operation, event.guild!, event.user!, this.clock(), JSON.stringify(replay), rating);
      this.audit(actor, 'correct', { id, result, reason, operation, rating });
      return this.player(String(event.guild), String(event.user));
    });
  }
}
