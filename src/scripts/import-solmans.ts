import { qotdSettings } from '../qotd/config.js';
import { resolve } from 'node:path';
import { QotdStore } from '../qotd/store.js';
import { importFolder } from '../qotd/importer.js';
const store = new QotdStore(qotdSettings().database);
try {
  const result = await importFolder(store, process.argv[2] ?? './solmans', qotdSettings().assets);
  if (result.failed || result.needsManualExtraction) process.exitCode = 1;
} catch (e) { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }
finally { store.close(); }
