import { resolve, extname } from 'node:path';
import { copyFileSync, mkdirSync, statSync, realpathSync } from 'node:fs';
import { QotdStore } from '../qotd/store.js';
const [action = 'list', id = '', ...options] = process.argv.slice(2);
const store = new QotdStore(resolve(process.env.QOTD_DB_PATH ?? 'data/qotd.sqlite'));
try {
  const actor = process.env.USER ?? process.env.USERNAME ?? 'local-operator';
  if (action === 'list') console.log(JSON.stringify(store.list(id || 'pending', 1000), null, 2));
  else if (action === 'show') console.log(JSON.stringify({ question:store.get(id), sources:store.occurrences(id) }, null, 2));
  else if (action === 'approve' || action === 'reject') {
    if (!store.get(id)) throw new Error('Unknown question ID.');
    let asset: string | null = null;
    const at = options.indexOf('--image');
    if (at >= 0) {
      const path = resolve(options[at + 1] ?? '');
      if (!/\.(png|jpe?g)$/i.test(path) || statSync(path).size > 8_000_000) throw new Error('Use a question-only PNG/JPEG under 8 MB.');
      const dir = resolve(process.env.QOTD_ASSET_DIR ?? 'data/qotd-assets', 'approved'); mkdirSync(dir,{recursive:true});
      asset = resolve(realpathSync(dir), id + extname(path).toLowerCase()); copyFileSync(path,asset);
    }
    store.review(id, action === 'approve' ? 'approved' : 'rejected', actor, options.includes('--ack-source-review'), asset);
    console.log(`${action}: ${id}`);
  } else throw new Error('Usage: bun run qotd:review list [pending|approved|rejected] | show ID | approve ID --ack-source-review [--image question-only.png] | reject ID');
} catch (e) { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }
finally { store.close(); }
