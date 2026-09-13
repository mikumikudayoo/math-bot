import { createReviewServer } from '../qotd/review-ui.js';
import { QotdStore } from '../qotd/store.js';
import { qotdSettings } from '../qotd/config.js';

const settings = qotdSettings();
const store = new QotdStore(settings.database);

const fallbackReviewer =
  process.env.QOTD_REVIEW_ACTOR ??
  process.env.USER ??
  process.env.USERNAME ??
  'local-reviewer';

const reviewers = (
  process.env.QOTD_REVIEWERS ??
  fallbackReviewer
)
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const host =
  process.env.QOTD_REVIEW_HOST ??
  '127.0.0.1';

const port = Number(
  process.env.QOTD_REVIEW_PORT ??
  8790,
);

const claimTtlMs = Number(
  process.env.QOTD_REVIEW_CLAIM_MINUTES ??
  15,
) * 60 * 1000;

const server = createReviewServer(
  store,
  settings.assets,
  {
    host,
    port,
    reviewers,
    claimTtlMs,
  },
);

console.log(
  [
    `QOTD crop review: http://${host}:${server.port}`,
    `Database: ${settings.database}`,
    `Reviewers: ${reviewers.join(', ')}`,
    `Claim expiry: ${claimTtlMs / 60_000} minutes`,
    '',
    'This reviewer picker is identification, not authentication.',
    'Keep this service private unless you add real authentication.',
    'Ctrl+C to stop.',
  ].join('\n'),
);

for (
  const signal of [
    'SIGINT',
    'SIGTERM',
  ] as const
) {
  process.once(signal, () => {
    server.stop(true);
    store.close();
  });
}