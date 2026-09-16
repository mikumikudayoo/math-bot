import type { ServiceConfig } from './config.js';
import type { RoutingSignals } from './router.js';

const ROUTER_SYSTEM = `You classify user messages for an AI assistant.
Do not answer the user's message.

Return ONLY one JSON object containing six CONTINUOUS fuzzy scores from 0.0 to 1.0:
{
  "reasoning": 0.0,
  "freshness": 0.0,
  "externalKnowledge": 0.0,
  "ambiguity": 0.0,
  "verificationNeed": 0.0,
  "calculation": 0.0
}

These are fuzzy membership scores, NOT boolean yes/no classifications.
Use intermediate values frequently. Do not round scores to 0 or 1 unless the property is essentially absent or unquestionably extreme.

Calibration:
0.00 = absent
0.15 = very weak
0.30 = weak
0.50 = moderate
0.70 = strong
0.85 = very strong
1.00 = extreme

Judge every dimension independently.

Meanings:
reasoning: how much multi-step reasoning, proof, planning, debugging, or difficult analysis is needed.
freshness: how much the answer depends on recent, current, changing, or time-sensitive information.
externalKnowledge: how much answering requires factual knowledge beyond the user's message and the assistant's configured identity.
ambiguity: how unclear, underspecified, or interpretation-dependent the request is.
verificationNeed: how important external verification is because the user requests sources/verification or asks about specific factual claims that should not be guessed.
calculation: how strongly the request is primarily a deterministic arithmetic or symbolic calculation.

Important:
- Proper nouns alone do not imply external verification.
- Greetings, jokes, statements, and casual conversation normally score near zero.
- Questions about the assistant's own configured identity/persona normally do not require external knowledge.
- Timeless math and proofs have near-zero freshness.
- Simple arithmetic should have high calculation and low reasoning.
- Current events, prices, weather, schedules, and recent developments have high freshness.
- Requests for sources, fact-checking, exhaustive factual lists, or obscure factual attribution have high verificationNeed.
- Difficult timeless proofs can have high reasoning while freshness and externalKnowledge remain low.

For this classification task, do not reason step by step. Output the JSON object immediately.
/no_think

Calibration examples:

"hello!"
reasoning 0.00, freshness 0.00, externalKnowledge 0.00, ambiguity 0.00, verificationNeed 0.00, calculation 0.00

"what is the product of 3 and 8?"
reasoning 0.05, freshness 0.00, externalKnowledge 0.00, ambiguity 0.00, verificationNeed 0.00, calculation 0.98

"what is the latest weather in Manila?"
reasoning 0.10, freshness 0.98, externalKnowledge 0.95, ambiguity 0.05, verificationNeed 0.90, calculation 0.00

"prove that infinitely many primes exist"
reasoning 0.82, freshness 0.00, externalKnowledge 0.05, ambiguity 0.05, verificationNeed 0.00, calculation 0.15

"explain photosynthesis"
reasoning 0.25, freshness 0.00, externalKnowledge 0.20, ambiguity 0.05, verificationNeed 0.00, calculation 0.00`;

type Complete = (url: string, init: RequestInit) => Promise<Response>;

function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error('router signal is not a finite number');
  return Math.max(0, Math.min(1, value));
}

export function parseRoutingSignals(value: unknown): RoutingSignals {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('router response is not an object');

  const v = value as Record<string, unknown>;

  return {
    reasoning: number(v.reasoning),
    freshness: number(v.freshness),
    externalKnowledge: number(v.externalKnowledge),
    ambiguity: number(v.ambiguity),
    verificationNeed: number(v.verificationNeed),
    calculation: number(v.calculation),
  };
}

export async function classifyPrompt(
  config: ServiceConfig,
  prompt: string,
  signal: AbortSignal,
  complete: Complete = (url, init) => fetch(url, init),
): Promise<RoutingSignals> {
  if (!config.backend || !config.model)
    throw new Error('router requires an inference backend');

  const response = await complete(`${config.backend}/chat/completions`, {
    method: 'POST',
    signal,
    redirect: 'error',
    headers: {
      'Content-Type': 'application/json',
      ...(config.backendKey
        ? { Authorization: `Bearer ${config.backendKey}` }
        : {}),
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: ROUTER_SYSTEM },
        { role: 'user', content: prompt.slice(0, 4000) },
      ],
      max_tokens: 300,
      temperature: 0,
    }),
  });

  if (!response.ok)
    throw new Error(`router backend returned HTTP ${response.status}`);

  const raw = await response.text();
  const result = JSON.parse(raw) as {
    choices?: { message?: { content?: unknown } }[];
  };

  const content = result.choices?.[0]?.message?.content;
  if (typeof content !== 'string')
    throw new Error('router backend returned no content');

  const cleaned = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');

  try {
    return parseRoutingSignals(JSON.parse(cleaned));
  } catch (error) {
    throw new Error(
      `router returned invalid JSON: ${JSON.stringify(content.slice(0, 1000))}`,
      { cause: error },
    );
  }
}
