/** Prints the local estimated OpenAI usage ledger (no prompts or answers are stored). Read-only. */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { serviceConfig } from '../service/config.js';
import { UsageLedger, formatUsageSummary } from '../service/openai-budget.js';

const config = serviceConfig();
if (!config.openai) { console.log('AI_PROVIDER is not "openai" for this environment; nothing to report.'); process.exit(0); }
if (!existsSync(config.database)) { console.log(`No database at ${config.database} yet.`); process.exit(0); }
const db = new DatabaseSync(config.database);
try {
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='openai_usage'").get();
  if (!has) { console.log('No OpenAI usage recorded yet.'); process.exit(0); }
  const summary = new UsageLedger(db, config.openai).summary();
  console.log(process.argv.includes('--json') ? JSON.stringify(summary, null, 2) : formatUsageSummary(summary).replace(/\*\*|_|`/g, ''));
} finally { db.close(); }
