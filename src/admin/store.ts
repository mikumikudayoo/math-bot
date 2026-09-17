import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { discordId } from './auth.js';
import { CREATOR_ID } from '../discord-context.js';

export interface AuditEntry { actor: string; username?: string; guild?: string; action: string; target: string; phase: 'attempt' | 'success' | 'failure'; details?: unknown }
/** Deliberately excluded from the raw SQL registry. No update/delete audit API. */
export class AdminStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(resolve(path)), { recursive: true, mode:0o700 });
      try { closeSync(openSync(path,'ax',0o600)); }
      catch(error) { if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error; }
    }
    this.db = new DatabaseSync(path);
    if(this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('testers','admin_audit') LIMIT 1").get() || Number(this.db.prepare('PRAGMA user_version').get()?.user_version)>1) {
      this.db.close();throw new Error('Use a separate supported admin database.');
    }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS testers(user TEXT PRIMARY KEY, actor TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_audit(id INTEGER PRIMARY KEY, created INTEGER NOT NULL, actor TEXT NOT NULL,
        username TEXT NOT NULL, guild TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, phase TEXT NOT NULL, details TEXT NOT NULL);
      PRAGMA user_version=1;`);
  }
  audit(entry: AuditEntry) {
    this.db.prepare('INSERT INTO admin_audit(created,actor,username,guild,action,target,phase,details) VALUES(?,?,?,?,?,?,?,?)')
      .run(Date.now(), entry.actor, entry.username ?? '', entry.guild ?? '', entry.action, entry.target, entry.phase, JSON.stringify(entry.details ?? null));
  }
  recent(guild: string) { return this.db.prepare('SELECT * FROM admin_audit WHERE guild=? ORDER BY id DESC LIMIT 10').all(guild); }
  has(user: string) { return Boolean(this.db.prepare('SELECT 1 FROM testers WHERE user=?').get(user)); }
  testers() { return this.db.prepare('SELECT user FROM testers ORDER BY user').all().map(r => String(r.user)); }
  changeTester(actor: string, target: string, add: boolean, guild = '', username = '') {
    if (actor !== CREATOR_ID) throw new Error('Only emu can manage testers.');
    discordId(target);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const before = this.has(target);
      if (add) this.db.prepare('INSERT OR IGNORE INTO testers VALUES(?,?,?)').run(target, actor, Date.now());
      else this.db.prepare('DELETE FROM testers WHERE user=?').run(target);
      const after = this.has(target);
      this.audit({actor,username,guild,action:add?'tester.add':'tester.remove',target,phase:'success',details:{before,after,changed:before!==after}});
      this.db.exec('COMMIT'); return before !== after;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
const stores = new Map<string, AdminStore>();
export function adminStore(path: string) {
  const key = resolve(path);
  let store = stores.get(key);
  if (!store) { store = new AdminStore(key); stores.set(key, store); }
  return store;
}
