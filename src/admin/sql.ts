import { resolve } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { config as dotenv } from 'dotenv';
import { loadConfig } from '../config.js';
import { qotdSettings } from '../qotd/config.js';
import { subprocess } from '../service/tools.js';

export type DatabaseRegistry = Readonly<Record<string, string>>;
export interface SqlResult { ok: boolean; columns?: string[]; rows?: unknown[][]; shown?: number; truncated?: boolean; changes?: number; error?: string }
export function databaseRegistry(): DatabaseRegistry {
  const config = loadConfig(), env: NodeJS.ProcessEnv = {};
  dotenv({path:`.env.ai.${config.mode}`, processEnv:env, quiet:true});
  const candidates = {qotd:qotdSettings().database, reminders:config.reminderDatabase, ai:env.AI_DATABASE || `data/${config.mode}.sqlite`};
  const canonical = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
  const admin = canonical(config.adminDatabase);
  if (Object.values(candidates).some(path => canonical(path) === admin)) throw new Error('Admin storage must be separate from SQL databases.');
  return candidates;
}
export async function runSQL(registry: DatabaseRegistry, name: string, sql: string, python = 'python3'): Promise<SqlResult> {
  if (!Object.hasOwn(registry, name)) return {ok:false,error:'UNKNOWN_DATABASE'};
  if (!sql.trim() || sql.length > 4000) return {ok:false,error:'INVALID_STATEMENT_LENGTH'};
  try {
    const path = realpathSync(registry[name]!);
    if (!statSync(path).isFile()) return {ok:false,error:'DATABASE_UNAVAILABLE'};
    const result = await subprocess(python, [resolve('python/admin_sql_worker.py')], JSON.stringify({path,sql}), new AbortController().signal, 6000);
    return JSON.parse(result) as SqlResult;
  } catch { return {ok:false,error:'DATABASE_UNAVAILABLE_OR_LIMIT_EXCEEDED'}; }
}
export function bounded(value: unknown, limit = 1800) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > limit ? text.slice(0,limit-35)+'\n… output truncated; narrow the query.' : text;
}
export function sqlText(result: SqlResult) {
  if (!result.ok) return `SQL failed: ${result.error}. SQLite execution errors roll back. If the worker was interrupted, inspect records before retrying: completion may be uncertain. Check syntax, constraints and the documented limits.`;
  return bounded(`success · ${result.changes ?? 0} affected rows · ${result.shown ?? 0} rows shown${result.truncated?' (truncated)':''}\n${JSON.stringify({columns:result.columns,rows:result.rows},null,2)}`);
}
