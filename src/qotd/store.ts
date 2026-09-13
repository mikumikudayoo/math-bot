import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fingerprint, normalize } from './parser.js';
import { failedCrop, validateCrop } from './crops.js';
import type { QuestionCrop, ParsedManual, ParsedQuestion } from './types.js';

export interface Question extends ParsedQuestion { id: string; state: string; flags: string[]; crop: QuestionCrop; cropReviewed: boolean }
export interface Claim { id: number; guild: string; day: string; question: string; channel: string; state: string; message: string | null }
export class QotdStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new DatabaseSync(path);
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    const existing = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='qotd_questions'").get();
    if ((existing && version !== 2) || version > 2) { this.db.close(); throw new Error('Legacy QOTD database: run the explicit local development reset. No automatic migration is supported.'); }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS qotd_sources(id TEXT PRIMARY KEY, metadata TEXT NOT NULL, asset TEXT NOT NULL, warnings TEXT NOT NULL, pages INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS qotd_files(source TEXT NOT NULL REFERENCES qotd_sources(id), filename TEXT NOT NULL, PRIMARY KEY(source,filename));
      CREATE TABLE IF NOT EXISTS qotd_questions(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, payload TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','rejected')), flags TEXT NOT NULL, crop TEXT NOT NULL, crop_reviewed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS qotd_occurrences(source TEXT NOT NULL REFERENCES qotd_sources(id), number INTEGER NOT NULL,
        question TEXT NOT NULL REFERENCES qotd_questions(id), payload TEXT NOT NULL, PRIMARY KEY(source,number));
      CREATE TABLE IF NOT EXISTS qotd_near(a TEXT NOT NULL REFERENCES qotd_questions(id), b TEXT NOT NULL REFERENCES qotd_questions(id), score REAL NOT NULL, PRIMARY KEY(a,b));
      CREATE TABLE IF NOT EXISTS qotd_history(id INTEGER PRIMARY KEY, guild TEXT NOT NULL, day TEXT NOT NULL,
        question TEXT NOT NULL REFERENCES qotd_questions(id), channel TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('reserved','posted','uncertain')),
        message TEXT, posted_at INTEGER, created INTEGER NOT NULL, UNIQUE(guild,day));
      CREATE TABLE IF NOT EXISTS qotd_used(guild TEXT NOT NULL, question TEXT NOT NULL REFERENCES qotd_questions(id), PRIMARY KEY(guild,question));
      CREATE TABLE IF NOT EXISTS qotd_audit(id INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS qotd_schedule(guild TEXT PRIMARY KEY, channel TEXT NOT NULL, hour INTEGER NOT NULL CHECK(hour BETWEEN 0 AND 23), role TEXT);
      CREATE TABLE IF NOT EXISTS qotd_reveals(history INTEGER PRIMARY KEY REFERENCES qotd_history(id), state TEXT NOT NULL, message TEXT);
      PRAGMA user_version=2;`);
  }
  close() { this.db.close(); }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  audit(actor: string, action: string) { this.db.prepare('INSERT INTO qotd_audit(actor,action,created) VALUES(?,?,?)').run(actor, action, Date.now()); }
  source(id: string) { return this.db.prepare('SELECT * FROM qotd_sources WHERE id=?').get(id); }
  addFilename(source: string, filename: string) { this.db.prepare('INSERT OR IGNORE INTO qotd_files VALUES(?,?)').run(source, filename); }
  get(id: string): Question | undefined {
    const row = this.db.prepare('SELECT * FROM qotd_questions WHERE id=?').get(id);
    return row ? { ...JSON.parse(String(row.payload)), id: String(row.id), state: String(row.state), flags: JSON.parse(String(row.flags)), crop: JSON.parse(String(row.crop)), cropReviewed: Boolean(row.crop_reviewed) } : undefined;
  }
  list(state = 'pending', limit = 25): Question[] {
    return this.db.prepare('SELECT id FROM qotd_questions WHERE state=? ORDER BY rowid LIMIT ?').all(state, limit).map(r => this.get(String(r.id))!);
  }
  occurrences(id: string) {
    return this.db.prepare(`SELECT o.*,s.metadata,s.asset,s.warnings FROM qotd_occurrences o JOIN qotd_sources s ON s.id=o.source WHERE o.question=?`).all(id);
  }
  import(source: string, filename: string, asset: string, pages: number, parsed: ParsedManual) {
    return this.transaction(() => {
      const summary = { added: 0, duplicates: 0, near: 0, conflicts: 0 };
      if (this.source(source)) { this.addFilename(source, filename); return summary; }
      this.db.prepare('INSERT INTO qotd_sources VALUES(?,?,?,?,?)').run(source, JSON.stringify(parsed.metadata), asset, JSON.stringify(parsed.warnings), pages);
      this.addFilename(source, filename);
      for (const q of parsed.questions) {
        const id = fingerprint(q);
        const existing = this.get(id);
        if (existing) {
          summary.duplicates++;
          if (normalize(q.officialAnswer) !== normalize(existing.officialAnswer) || normalize(q.officialSolution) !== normalize(existing.officialSolution)) {
            summary.conflicts++;
            this.db.prepare("UPDATE qotd_questions SET state='pending',crop_reviewed=0,flags=? WHERE id=?").run(JSON.stringify([...new Set([...existing.flags, 'source-answer-or-solution-conflict'])]), id);
          }
        } else {
          const flags = [...q.flags, ...parsed.warnings.map(w => `manual: ${w}`)];
          this.db.prepare('INSERT INTO qotd_questions(id,fingerprint,payload,flags,crop) VALUES(?,?,?,?,?)').run(id, id, JSON.stringify(q), JSON.stringify(flags), JSON.stringify(q.crop ?? failedCrop('crop:not-generated')));
          const words = new Set(normalize(q.text).toLowerCase().split(/\s+/));
          for (const row of this.db.prepare('SELECT id,payload FROM qotd_questions WHERE id<>?').all(id)) {
            const other: ParsedQuestion = JSON.parse(String(row.payload));
            const theirs = new Set(normalize(other.text).toLowerCase().split(/\s+/));
            const overlap = [...words].filter(w => theirs.has(w)).length;
            const score = overlap / (words.size + theirs.size - overlap || 1);
            if (words.size >= 8 && score >= 0.82) {
              this.db.prepare('INSERT OR IGNORE INTO qotd_near VALUES(?,?,?)').run(id, String(row.id), score);
              flags.push(`near-duplicate:${row.id}`); summary.near++;
            }
          }
          // Same manual identity/number with changed extracted content also needs review.
          const same = this.db.prepare(`SELECT o.question FROM qotd_occurrences o JOIN qotd_sources s ON s.id=o.source WHERE o.number=? AND s.metadata=?`).all(q.number, JSON.stringify(parsed.metadata));
          if (same.some(r => r.question !== id)) flags.push('same-manual-number-different-content');
          this.db.prepare('UPDATE qotd_questions SET flags=? WHERE id=?').run(JSON.stringify(flags), id);
          summary.added++;
        }
        this.db.prepare('INSERT INTO qotd_occurrences VALUES(?,?,?,?)').run(source, q.number, id, JSON.stringify(q));
      }
      return summary;
    });
  }
  review(id: string, state: 'approved' | 'rejected', actor: string, acknowledge: boolean, acknowledgeCrop = false) {
    this.transaction(() => {
      const q = this.get(id); if (!q) throw new Error('Unknown question ID.');
      if (state === 'approved') {
        if (!acknowledgeCrop) throw new Error('Confirm every crop is complete and contains no answer/solution; pass --ack-crop-review.');
        validateCrop(q.crop);
        if (!acknowledge) throw new Error('Inspect source pages, choices, official solution and duplicate flags; pass --ack-source-review.');
        if (!q.officialAnswer.trim() || !q.officialSolution.trim()) throw new Error('Missing official answer/solution: repair the import before approval.');
        if (q.flags.includes('choices-unreadable')) throw new Error('Unreadable source choices: repair extraction before approval.');
      }
      this.db.prepare('UPDATE qotd_questions SET state=?,crop_reviewed=? WHERE id=?').run(state, Number(state === 'approved' && acknowledgeCrop), id);
      this.audit(actor, `${state} ${id}; source/duplicates reviewed=${acknowledge}; crop-reviewed=${acknowledgeCrop}; image-hashes=${q.crop.images.map(i=>i.sha256).join(',')}`);
    });
  }
  replaceCrop(id: string, crop: QuestionCrop, actor: string) {
    validateCrop(crop);
    this.transaction(() => {
      if (!this.get(id)) throw new Error('Unknown question ID.');
      this.db.prepare("UPDATE qotd_questions SET crop=?,crop_reviewed=0,state='pending' WHERE id=?").run(JSON.stringify(crop),id);
      this.audit(actor,`crop replaced ${id}; image-hashes=${crop.images.map(i=>i.sha256).join(',')}; approval revoked`);
    });
  }
  claim(guild: string, channel: string, day: string): { claim: Claim; question: Question } | null {
    return this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM qotd_history WHERE guild=? AND day=?').get(guild, day)) return null;
      const row = this.db.prepare(`SELECT id FROM qotd_questions q WHERE state='approved' AND crop_reviewed=1
        AND NOT EXISTS(SELECT 1 FROM qotd_used u WHERE u.guild=? AND u.question=q.id) ORDER BY random() LIMIT 1`).get(guild);
      if (!row) return null;
      const id = String(row.id);
      validateCrop(this.get(id)!.crop);
      this.db.prepare('INSERT INTO qotd_used VALUES(?,?)').run(guild, id);
      const result = this.db.prepare("INSERT INTO qotd_history(guild,day,question,channel,state,created) VALUES(?,?,?,?,'reserved',?)").run(guild, day, id, channel, Date.now());
      return { claim: this.db.prepare('SELECT * FROM qotd_history WHERE id=?').get(result.lastInsertRowid) as unknown as Claim, question: this.get(id)! };
    });
  }
  finish(id: number, message: string | null) {
    this.db.prepare('UPDATE qotd_history SET state=?,message=?,posted_at=? WHERE id=?').run(message ? 'posted' : 'uncertain', message, message ? Date.now() : null, id);
  }
  historyEntry(guild:string,id:number) { return this.db.prepare('SELECT * FROM qotd_history WHERE guild=? AND id=?').get(guild,id); }
  claimReveal(guild:string,id:number,actor:string,now=Date.now()) {
    return this.transaction(()=>{
      const row=this.historyEntry(guild,id);
      if(!row || row.state!=='posted' || !row.posted_at || Number(row.posted_at)+24*60*60*1000>now)throw new Error('Reveal is available only 24 hours after a confirmed post, after its poll closes.');
      if(this.db.prepare('SELECT 1 FROM qotd_reveals WHERE history=?').get(id))throw new Error('This reveal is already reserved or sent. Check the channel before taking further action.');
      this.db.prepare("INSERT INTO qotd_reveals VALUES(?,'reserved',NULL)").run(id);
      this.audit(actor,`official answer reveal reserved history=${id} guild=${guild}`);
      return this.get(String(row.question))!;
    });
  }
  finishReveal(id:number,message:string|null) {this.db.prepare('UPDATE qotd_reveals SET state=?,message=? WHERE history=?').run(message?'posted':'uncertain',message,id);}
  history(guild: string) { return this.db.prepare('SELECT * FROM qotd_history WHERE guild=? ORDER BY id DESC LIMIT 25').all(guild); }
  reset(guild: string, question: string, actor: string) {
    this.transaction(() => {
      if (!this.get(question)) throw new Error('Unknown question ID.');
      this.db.prepare('DELETE FROM qotd_used WHERE guild=? AND question=?').run(guild, question);
      this.audit(actor, `explicit no-repeat reset guild=${guild} question=${question}`);
    });
  }
}
