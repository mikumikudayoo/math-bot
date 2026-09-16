import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import { routePrompt } from '../src/service/route-prompt.js';
import type { RouteDecision } from '../src/service/router.js';

interface EvalRow {
  category: string;
  prompt: string;
  reasoning: RouteDecision['reasoning'][];
  knowledge: RouteDecision['knowledge'][];
  tool: RouteDecision['tool'][];
}

interface CategoryStats {
  passed: number;
  total: number;
}

const path =
  process.argv[2] ?? 'data/router-holdout-v1.jsonl';

const text = await readFile(path, 'utf8');

const rows = text
  .split(/\r?\n/)
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line) as EvalRow);

const categories = new Map<string, CategoryStats>();

let fullPass = 0;
let reasoningPass = 0;
let knowledgePass = 0;
let toolPass = 0;

const times: number[] = [];

const failures: {
  row: EvalRow;
  actual: RouteDecision;
}[] = [];

for (const row of rows) {
  const start = performance.now();

  const actual = await routePrompt(row.prompt);

  times.push(performance.now() - start);

  const reasoningOk = row.reasoning.includes(actual.reasoning);
  const knowledgeOk = row.knowledge.includes(actual.knowledge);
  const toolOk = row.tool.includes(actual.tool);

  if (reasoningOk) reasoningPass++;
  if (knowledgeOk) knowledgePass++;
  if (toolOk) toolPass++;

  const fullOk =
    reasoningOk &&
    knowledgeOk &&
    toolOk;

  if (fullOk) {
    fullPass++;
  } else {
    failures.push({
      row,
      actual,
    });
  }

  const stats =
    categories.get(row.category) ??
    { passed: 0, total: 0 };

  stats.total++;

  if (fullOk) {
    stats.passed++;
  }

  categories.set(row.category, stats);
}

function percent(
  passed: number,
  total: number,
): string {
  if (total === 0) return '0.0';

  return ((passed / total) * 100).toFixed(1);
}

function percentile(
  values: number[],
  fraction: number,
): number {
  if (values.length === 0) return 0;

  const sorted = [...values].sort((a, b) => a - b);

  const index = Math.min(
    sorted.length - 1,
    Math.ceil(sorted.length * fraction) - 1,
  );

  return sorted[Math.max(0, index)] ?? 0;
}

const average =
  times.length === 0
    ? 0
    : times.reduce((a, b) => a + b, 0) / times.length;

console.log('='.repeat(72));
console.log('AUTHORITATIVE ROUTER REGRESSION');
console.log(`dataset: ${path}`);
console.log(`prompts: ${rows.length}`);

console.log('\nRESULTS');

console.log(
  `full route: ${fullPass}/${rows.length} (${percent(fullPass, rows.length)}%)`,
);

console.log(
  `reasoning : ${reasoningPass}/${rows.length} (${percent(reasoningPass, rows.length)}%)`,
);

console.log(
  `knowledge : ${knowledgePass}/${rows.length} (${percent(knowledgePass, rows.length)}%)`,
);

console.log(
  `tool      : ${toolPass}/${rows.length} (${percent(toolPass, rows.length)}%)`,
);

console.log('\nCATEGORY RESULTS');

for (
  const [category, stats]
  of [...categories.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  )
) {
  console.log(
    `${category.padEnd(20)} ${String(stats.passed).padStart(2)}/${String(stats.total).padStart(2)}  ${percent(stats.passed, stats.total).padStart(5)}%`,
  );
}

console.log('\nLATENCY');

console.log(`average: ${average.toFixed(2)} ms`);
console.log(
  `median:  ${percentile(times, 0.5).toFixed(2)} ms`,
);
console.log(
  `p95:     ${percentile(times, 0.95).toFixed(2)} ms`,
);
console.log(
  `max:     ${Math.max(0, ...times).toFixed(2)} ms`,
);

console.log('\nFAILURES');

if (failures.length === 0) {
  console.log('none 🎉');
}

for (const { row, actual } of failures) {
  console.log('-'.repeat(72));
  console.log(`[${row.category}] ${row.prompt}`);

  console.log({
    expected: {
      reasoning: row.reasoning,
      knowledge: row.knowledge,
      tool: row.tool,
    },
    actual: {
      reasoning: actual.reasoning,
      knowledge: actual.knowledge,
      tool: actual.tool,
    },
    scores: actual.scores,
  });
}
