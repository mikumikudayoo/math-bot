import { resolve } from 'node:path';
import { QotdStore } from '../qotd/store.js';
import { importFolder } from '../qotd/importer.js';
const store = new QotdStore(resolve(process.env.QOTD_DB_PATH ?? 'data/qotd.sqlite'));
try {
  const result = await importFolder(store, process.argv[2] ?? './solmans', process.env.QOTD_ASSET_DIR ?? 'data/qotd-assets');
  if (result.failed || result.needsManualExtraction) process.exitCode = 1;
} catch (e) { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }
finally { store.close(); }
