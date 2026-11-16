import { randomUUID } from 'node:crypto';
import { announcementAISettings, announcementProvider, installAnnouncementAI } from '../announcements/provider.js';
import { extractFacts } from '../announcements/extraction.js';
import { digest } from '../announcements/model.js';

// Exercises the production extractor and public-fact validation using synthetic text alone.
// No Gmail client, announcement store or Discord connection is opened.
if (!process.argv.includes('--confirm')) {
  console.error('Use --confirm for a paid synthetic extraction (estimated ceiling $0.01).');
  process.exitCode = 2;
} else {
  try {
    const {config, database} = announcementAISettings(process.env.BOT_ENV ?? 'development');
    const system = Math.min(0.01, config.requestBudgetUsd.system);
    const close = installAnnouncementAI({...config, maxRetries: 0, requestBudgetUsd: {...config.requestBudgetUsd, system}}, database);
    try {
      const text = 'VTAMPS V.30.0 Senior Secondary training Session 1 takes place on January 2, 2030 from 8 AM to 10 AM (Asia/Manila).';
      const provider = {...announcementProvider({AI_PROVIDER: 'openai'}), model: config.models.luna};
      const result = await extractFacts(provider,
        {evidence: [{id: 'body', text}], blocked: [], sensitive: false, sourceTime: Date.UTC(2029, 11, 1)},
        {account: 'synthetic', messageId: randomUUID(), sha256: digest(text), attachment: null, locator: 'body'},
        AbortSignal.timeout(60_000));
      const event = result.events.find(c => c.event.type === 'training-session' && c.event.slot === '1');
      if (result.disposition !== 'public' || event?.event.start !== Date.UTC(2030, 0, 2) ||
          event.event.end !== Date.UTC(2030, 0, 2, 2) || !event.evidenceIds?.includes('body'))
        throw new Error('Synthetic schedule failed validation.');
      console.log('Synthetic OpenAI extraction passed strict schema, schedule and evidence checks.');
    } finally { close(); }
  } catch {
    console.error('Synthetic OpenAI extraction failed. Check private provider configuration, estimated budget, model compatibility and extracted facts before rollout.');
    process.exitCode = 1;
  }
}
