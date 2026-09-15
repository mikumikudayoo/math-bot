import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { QotdStore, Question } from './store.js';
import type { QuestionCrop, ManualMetadata } from './types.js';
import { validateCrop } from './crops.js';
import { grade, validateGrading, type GradingConfig } from './grading.js';
import { DEFAULT_SCORING, scoreSubmission, validateScoring, type ScoringConfig, type ScoreContext } from './scoring.js';
import { dayTimes, periods, manilaDay } from './periods.js';

export const CLOSED = "Submissions for today's QOTD are closed.";
export interface PublicSource { competition?: string; edition?: string; year?: number; level?: string; set?: string; number: number; questionPage: number; solutionPage: number | null }
export interface QuestionSettings { grading: GradingConfig; scoring?: ScoringConfig; difficulty?: string; solutionCrop?: QuestionCrop; publicSource?: PublicSource }
export interface Snapshot { questionType: string; expectedAnswer: string; solution: string; questionCrop: QuestionCrop; solutionCrop?: QuestionCrop; source: PublicSource; grading: GradingConfig; scoring: ScoringConfig; difficulty?: string }
export interface Session { id: number; guild: string; channel: string; day: string; message: string | null; historyState: string; openedAt: number; closesAt: number; revealAt: number; revealedAt: number | null; thread: string | null; state: string; disabled: number; scoredAt: number | null; snapshot: Snapshot; notices: string[] }
export interface Result { user: string; answer: string; submittedAt: number; correct: number | null; placement: number | null; points: number | null; context: string | null }

export function atomic<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const value = work(); db.exec('COMMIT'); return value; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function migrateCompetition(db: DatabaseSync) {
  atomic(db, () => db.exec(`
    CREATE TABLE IF NOT EXISTS qotd_question_settings(question TEXT PRIMARY KEY REFERENCES qotd_questions(id), config TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS qotd_sessions(
      id INTEGER PRIMARY KEY REFERENCES qotd_history(id), openedAt INTEGER NOT NULL, closesAt INTEGER NOT NULL,
      revealAt INTEGER NOT NULL, revealedAt INTEGER, thread TEXT, state TEXT NOT NULL DEFAULT 'active',
      disabled INTEGER NOT NULL DEFAULT 0, scoredAt INTEGER, snapshot TEXT NOT NULL, notices TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS qotd_submissions(
      qotd INTEGER NOT NULL REFERENCES qotd_sessions(id), user TEXT NOT NULL, answer TEXT NOT NULL,
      submittedAt INTEGER NOT NULL, correct INTEGER, placement INTEGER, points REAL, context TEXT,
      PRIMARY KEY(qotd,user));
    CREATE TABLE IF NOT EXISTS qotd_modal_tokens(
      token TEXT PRIMARY KEY, qotd INTEGER NOT NULL REFERENCES qotd_sessions(id), guild TEXT NOT NULL,
      channel TEXT NOT NULL, message TEXT NOT NULL, user TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS qotd_period_notices(
      guild TEXT NOT NULL, kind TEXT NOT NULL, period TEXT NOT NULL, history INTEGER NOT NULL REFERENCES qotd_history(id),
      PRIMARY KEY(guild,kind,period));
    CREATE TABLE IF NOT EXISTS qotd_delivery(
      qotd INTEGER NOT NULL REFERENCES qotd_sessions(id), part INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
      message TEXT, payload TEXT NOT NULL, PRIMARY KEY(qotd,part));
    CREATE INDEX IF NOT EXISTS qotd_sessions_due ON qotd_sessions(revealAt,state);
    PRAGMA user_version=3;
  `));
}
export function publicSource(q: Question, metadata?: ManualMetadata): PublicSource {
  const source: PublicSource = { number: q.number, questionPage: q.questionPage, solutionPage: q.solutionPage };
  if (metadata) {
    for (const key of ['competition','edition','level','set'] as const) if (metadata[key]) source[key] = metadata[key]!;
    if (metadata.year) source.year = metadata.year;
  }
  return source;
}
export class Competition {
  constructor(readonly store: QotdStore) {}
  get db() { return this.store.db; }
  configure(question: string, config: QuestionSettings, actor: string) {
    const q = this.store.get(question); if (!q) throw new Error('Unknown question.');
    validateGrading(config.grading); if (config.scoring) validateScoring(config.scoring);
    if (config.difficulty !== undefined && (typeof config.difficulty !== 'string' || config.difficulty.length > 100)) throw new Error('Invalid difficulty label.');
    if (config.solutionCrop) {
      validateCrop(config.solutionCrop);
      if (config.solutionCrop.images.some(s => q.crop.images.some(i => i.sha256 === s.sha256))) throw new Error('Solution must not reuse the question crop.');
    }
    // Public fields have an explicit allowlist; private filenames/paths cannot enter the snapshot.
    if (config.publicSource) {
      const allowed = ['competition','edition','year','level','set','number','questionPage','solutionPage'];
      if (Object.keys(config.publicSource).some(k => !allowed.includes(k))) throw new Error('Unknown public source field.');
      for (const value of Object.values(config.publicSource)) if (typeof value === 'string' && (value.length > 150 || /[\\/]|\.pdf\b/i.test(value))) throw new Error('Public source fields must not contain filenames or paths.');
    }
    atomic(this.db, () => {
      const claim=this.store.reviewClaim(question);
      if(claim && claim.actor!==actor)throw new Error('Another moderator holds the review claim. Configure after their review or use the same reviewer identity.');
      this.db.prepare('INSERT INTO qotd_question_settings VALUES(?,?) ON CONFLICT(question) DO UPDATE SET config=excluded.config').run(question, JSON.stringify(config));
      this.store.audit(actor, `grading/solution settings updated ${question}; existing daily snapshots unchanged`);
    });
  }
  create(id: number, q: Question, openedAt: number) {
    return atomic(this.db, () => {
      const history = this.db.prepare('SELECT * FROM qotd_history WHERE id=?').get(id);
      if (!history || history.state !== 'reserved') throw new Error('Missing posting reservation.');
      if (this.session(id)) return this.session(id)!;
      const day = String(history.day), times = dayTimes(day);
      if (openedAt >= times.closesAt) throw new Error(CLOSED);
      const saved = this.db.prepare('SELECT config FROM qotd_question_settings WHERE question=?').get(q.id);
      const config: QuestionSettings = saved ? JSON.parse(String(saved.config)) : { grading: { mode: 'exact_text', answers: [q.officialAnswer.trim()] } };
      validateGrading(config.grading);
      const occurrence = this.store.occurrences(q.id)[0];
      const source = config.publicSource ?? publicSource(q, occurrence ? JSON.parse(String(occurrence.metadata)) as ManualMetadata : undefined);
      const snapshot: Snapshot = { questionType: q.kind, expectedAnswer: q.officialAnswer, solution: q.officialSolution,
        questionCrop: q.crop, source, grading: config.grading, scoring: config.scoring ?? DEFAULT_SCORING,
        ...(config.solutionCrop ? { solutionCrop: config.solutionCrop } : {}), ...(config.difficulty ? { difficulty: config.difficulty } : {}) };
      const p = periods(day), notices: string[] = [];
      for (const [kind, period, text] of [['week', p.week, 'Weekly leaderboard reset.'], ['month', p.month, 'Monthly leaderboard reset.']] as const) {
        if (this.db.prepare('INSERT OR IGNORE INTO qotd_period_notices VALUES(?,?,?,?)').run(history.guild!, kind, period, id).changes) notices.push(text);
      }
      this.db.prepare('INSERT INTO qotd_sessions(id,openedAt,closesAt,revealAt,snapshot,notices) VALUES(?,?,?,?,?,?)')
        .run(id, openedAt, times.closesAt, times.revealAt, JSON.stringify(snapshot), JSON.stringify(notices));
      return this.session(id)!;
    });
  }
  session(id: number): Session | null {
    const row = this.db.prepare('SELECT s.*,h.guild,h.channel,h.day,h.message,h.state historyState FROM qotd_sessions s JOIN qotd_history h ON h.id=s.id WHERE s.id=?').get(id);
    return row ? { ...row, snapshot: JSON.parse(String(row.snapshot)), notices: JSON.parse(String(row.notices)) } as unknown as Session : null;
  }
  active(id: number, guild: string, channel: string, message: string, now: number) {
    const s = this.session(id);
    if (!s || s.guild !== guild || s.channel !== channel || s.message !== message || s.historyState !== 'posted') throw new Error('This is not the active main QOTD message.');
    if (s.state !== 'active' || now < s.openedAt || now >= s.closesAt || this.db.prepare('SELECT 1 FROM qotd_sessions n JOIN qotd_history h ON h.id=n.id WHERE h.guild=? AND n.id>?').get(guild,id)) throw new Error(CLOSED);
    return s;
  }
  openModal(id: number, guild: string, channel: string, message: string, user: string, at?: number) {
    return atomic(this.db, () => {
      const now = at ?? Date.now();
      this.active(id,guild,channel,message,now);
      if (!/^\d{17,20}$/.test(user)) throw new Error('Invalid participant ID.');
      const token = randomBytes(24).toString('hex');
      this.db.prepare('INSERT INTO qotd_modal_tokens VALUES(?,?,?,?,?,?)').run(token,id,guild,channel,message,user);
      return token;
    });
  }
  submit(token: string, guild: string, channel: string, user: string, answer: string, at?: number) {
    return atomic(this.db, () => {
      const now = at ?? Date.now();
      const t = this.db.prepare('SELECT * FROM qotd_modal_tokens WHERE token=?').get(token);
      if (!t || t.guild !== guild || t.channel !== channel || t.user !== user) throw new Error('This answer modal is invalid or already used. Open it from the question again.');
      this.active(Number(t.qotd),guild,channel,String(t.message),now);
      if (!answer.trim() || answer.length > 1000) throw new Error('Enter an answer of 1–1000 characters.');
      const existing = this.db.prepare('SELECT submittedAt FROM qotd_submissions WHERE qotd=? AND user=?').get(t.qotd!,user);
      if (existing && Number(existing.submittedAt) > now) throw new Error('A newer answer is already recorded.');
      this.db.prepare(`INSERT INTO qotd_submissions(qotd,user,answer,submittedAt) VALUES(?,?,?,?)
        ON CONFLICT(qotd,user) DO UPDATE SET answer=excluded.answer,submittedAt=excluded.submittedAt`).run(t.qotd!,user,answer,now);
      this.db.prepare('DELETE FROM qotd_modal_tokens WHERE token=?').run(token);
      return Boolean(existing);
    });
  }
  closeDue(now = Date.now()) {
    this.db.prepare("UPDATE qotd_sessions SET state='closed' WHERE state='active' AND closesAt<=?").run(now);
  }
  isDiscussion(guild: string, channel: string) {
    // Discord threads created from a message share that message's snowflake.
    return Boolean(this.db.prepare(`SELECT 1 FROM qotd_history h LEFT JOIN qotd_sessions s ON s.id=h.id WHERE h.guild=? AND (s.thread=? OR h.message=?)`).get(guild,channel,channel));
  }
  results(id: number): Result[] { return this.db.prepare('SELECT * FROM qotd_submissions WHERE qotd=? ORDER BY correct DESC,placement,user').all(id) as unknown as Result[]; }
  score(id: number, now = Date.now()) {
    return atomic(this.db, () => {
      const s = this.session(id); if (!s || s.historyState !== 'posted' || now < s.revealAt) throw new Error('Reveal is not due.');
      if (s.scoredAt !== null) return this.results(id);
      const rows = this.results(id).sort((a,b) => a.submittedAt - b.submittedAt || (a.user < b.user ? -1 : a.user > b.user ? 1 : 0));
      const graded = rows.map(r => ({ ...r, correct: grade(r.answer,s.snapshot.grading) }));
      const correctCount = graded.filter(r => r.correct).length; let placement = 0;
      for (const r of graded) {
        const context: ScoreContext = { correct: r.correct, openedAt: s.openedAt, submittedAt: r.submittedAt,
          elapsedSeconds: Math.max(0,(r.submittedAt-s.openedAt)/1000), placement: r.correct ? ++placement : null,
          participantCount: rows.length, correctCount, questionType: s.snapshot.questionType,
          ...(s.snapshot.difficulty ? { difficulty: s.snapshot.difficulty } : {}) };
        this.db.prepare('UPDATE qotd_submissions SET correct=?,placement=?,points=?,context=? WHERE qotd=? AND user=?')
          .run(Number(r.correct), context.placement, scoreSubmission(context,s.snapshot.scoring), JSON.stringify(context), id, r.user);
      }
      this.db.prepare("UPDATE qotd_sessions SET state='closed',scoredAt=? WHERE id=?").run(now,id);
      return this.results(id);
    });
  }
  leaderboard(guild: string, scope: 'total' | 'month' | 'week', day = manilaDay()) {
    const p = periods(day);
    const start = scope === 'month' ? p.month+'-01' : p.week;
    const end = scope === 'month' ? p.month+'-31' : p.weekEnd;
    return this.db.prepare(`SELECT r.user,round(sum(r.points),3) points,sum(r.correct) correct,count(*) submitted,
      sum(CASE WHEN r.placement=1 THEN 1 ELSE 0 END) firsts,sum(CASE WHEN r.placement=2 THEN 1 ELSE 0 END) seconds,
      sum(CASE WHEN r.placement=3 THEN 1 ELSE 0 END) thirds
      FROM qotd_submissions r JOIN qotd_sessions s ON s.id=r.qotd JOIN qotd_history h ON h.id=s.id
      WHERE h.guild=? AND s.scoredAt IS NOT NULL AND (?='total' OR h.day BETWEEN ? AND ?)
      GROUP BY r.user ORDER BY points DESC,correct DESC,r.user ASC`).all(guild,scope,start,end) as unknown as Array<{user:string;points:number;correct:number;submitted:number;firsts:number;seconds:number;thirds:number}>;
  }
  stats(guild: string, user: string, day = manilaDay()) {
    const scopes = (['total','month','week'] as const).map(scope => {
      const rows = this.leaderboard(guild,scope,day), index = rows.findIndex(r => r.user === user);
      return { scope, rank: index < 0 ? null : index+1, points: rows[index]?.points ?? 0, result: rows[index] };
    });
    return scopes;
  }
}
