import { serviceConfig } from '../service/config.js';
import { classifyPrompt } from '../service/router-classifier.js';
import { fuzzyRoute } from '../service/router.js';

const config = serviceConfig();

const prompts = [
  "HELLO!~!☆✧･ﾟ: *✧･ﾟ:* Im Emu Otori! Emu...means SMILE!!",
  "what is the product of 3 and 8",
  "What is the Pax Silica situation in the Philippines?",
  "prove that infinitely many primes exist",
  "explain photosynthesis",
];

for (const prompt of prompts) {
  console.log('\n' + '═'.repeat(70));
  console.log(prompt);

  try {
    const started = performance.now();

    const signals = await classifyPrompt(
      config,
      prompt,
      AbortSignal.timeout(90_000),
    );

    const elapsed = performance.now() - started;
    const route = fuzzyRoute(signals);

    console.log(`\nclassifier: ${(elapsed / 1000).toFixed(2)}s`);

    console.log('\nsignals');
    console.table(signals);

    console.log('route');
    console.log(JSON.stringify(route, null, 2));
  } catch (error) {
    console.error('ROUTER ERROR:', error);
  }
}
