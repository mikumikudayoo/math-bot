import type { DatabaseSync } from 'node:sqlite';
import { atomic } from '../qotd/competition.js';
/** Additive extension: separate version ledger leaves legacy qotd user_version=3 compatible. */
export function migrateProblems(db: DatabaseSync) {
  atomic(db, () => {
    db.exec(`CREATE TABLE IF NOT EXISTS problem_schema(version INTEGER PRIMARY KEY);`);
    const version = Number(db.prepare('SELECT max(version) version FROM problem_schema').get()?.version ?? 0);
    if (version > 1) throw new Error('Unsupported problem schema.');
    if (version === 1) return;
    db.exec(`
      CREATE TABLE problem_catalog(
        question TEXT PRIMARY KEY REFERENCES qotd_questions(id), mode TEXT NOT NULL CHECK(mode IN ('rated','practice')),
        enabled INTEGER NOT NULL DEFAULT 1, invalid INTEGER NOT NULL DEFAULT 0,
        initial_difficulty REAL, difficulty REAL, approved_by TEXT NOT NULL, approved_at INTEGER NOT NULL,
        CHECK(mode!='rated' OR (initial_difficulty BETWEEN 0 AND 4000 AND difficulty BETWEEN 0 AND 4000)));
      CREATE TABLE problem_controls(guild TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, config TEXT NOT NULL);
      CREATE TABLE problem_players(guild TEXT NOT NULL,user TEXT NOT NULL,rating REAL NOT NULL,peak REAL NOT NULL,
        scored INTEGER NOT NULL DEFAULT 0,correct INTEGER NOT NULL DEFAULT 0,sequence INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(guild,user));
      CREATE TABLE problem_attempts(
        id TEXT PRIMARY KEY,guild TEXT NOT NULL,user TEXT NOT NULL,question TEXT NOT NULL REFERENCES qotd_questions(id),
        mode TEXT NOT NULL CHECK(mode IN ('rated','practice')),state TEXT NOT NULL CHECK(state IN ('pending','delivering','active','completed','expired','cancelled')),
        created INTEGER NOT NULL,delivery_started INTEGER,delivered INTEGER,deadline INTEGER,message TEXT,
        sequence INTEGER,encounter INTEGER,difficulty REAL,config TEXT NOT NULL,snapshot TEXT NOT NULL,
        answer TEXT,correct INTEGER,finished INTEGER,lease TEXT);
      CREATE UNIQUE INDEX problem_one_active ON problem_attempts(user) WHERE mode='rated' AND state IN ('pending','delivering','active');
      CREATE UNIQUE INDEX problem_sequence ON problem_attempts(guild,user,sequence) WHERE mode='rated' AND sequence IS NOT NULL;
      CREATE INDEX problem_history ON problem_attempts(guild,user,question,sequence);
      CREATE TABLE problem_events(attempt TEXT PRIMARY KEY REFERENCES problem_attempts(id),guild TEXT NOT NULL,user TEXT NOT NULL,
        question TEXT NOT NULL,created INTEGER NOT NULL,before REAL NOT NULL,after REAL NOT NULL,difficulty REAL NOT NULL,
        probability REAL NOT NULL,result INTEGER NOT NULL,encounter INTEGER NOT NULL,weight REAL NOT NULL,delta REAL NOT NULL,config TEXT NOT NULL);
      CREATE TABLE problem_corrections(id TEXT PRIMARY KEY,attempt TEXT NOT NULL REFERENCES problem_events(attempt),
        result INTEGER CHECK(result IN (0,1)),actor TEXT NOT NULL,reason TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE problem_revisions(id INTEGER PRIMARY KEY,correction TEXT NOT NULL REFERENCES problem_corrections(id),
        guild TEXT NOT NULL,user TEXT NOT NULL,created INTEGER NOT NULL,events TEXT NOT NULL,rating REAL NOT NULL);
      CREATE TABLE problem_audit(id INTEGER PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,created INTEGER NOT NULL,details TEXT NOT NULL);
      CREATE TRIGGER problem_events_immutable_update BEFORE UPDATE ON problem_events BEGIN SELECT RAISE(ABORT,'Immutable rating event'); END;
      CREATE TRIGGER problem_events_immutable_delete BEFORE DELETE ON problem_events BEGIN SELECT RAISE(ABORT,'Immutable rating event'); END;
      CREATE TRIGGER problem_corrections_immutable_update BEFORE UPDATE ON problem_corrections BEGIN SELECT RAISE(ABORT,'Immutable correction'); END;
      CREATE TRIGGER problem_corrections_immutable_delete BEFORE DELETE ON problem_corrections BEGIN SELECT RAISE(ABORT,'Immutable correction'); END;
      INSERT INTO problem_schema VALUES(1);
    `);
  });
}
