import { describe, expect, test } from 'bun:test';

import { routePrompt } from '../src/service/route-prompt.js';
import type { RoutingSignals } from '../src/service/router.js';

const signals = (
  values: Partial<RoutingSignals> = {},
): RoutingSignals => ({
  reasoning: 0,
  freshness: 0,
  externalKnowledge: 0,
  ambiguity: 0,
  verificationNeed: 0,
  calculation: 0,
  ...values,
});

describe('routePrompt', () => {
  test('fast final routes bypass the semantic sensor', async () => {
    let called = false;

    const decision = await routePrompt('hello', {
      signals: async () => {
        called = true;
        return [];
      },
    });

    expect(called).toBe(false);
    expect(decision.reasoning).toBe('fast');
    expect(decision.knowledge).toBe('internal');
    expect(decision.tool).toBe('none');
  });

  test('semantic prompts use sensor signals', async () => {
    const decision = await routePrompt(
      'explain this difficult argument',
      {
        signals: async () => [
          signals({
            reasoning: 0.9,
          }),
        ],
      },
    );

    expect(decision.reasoning).toBe('deep');
  });

  test('compound prompts aggregate clause requirements', async () => {
    const seen: string[][] = [];

    const decision = await routePrompt(
      'what version is current? also explain why upgrading could break this',
      {
        signals: async (clauses) => {
          seen.push(clauses);

          return clauses.map((_, index) =>
            index === 0
              ? signals({
                  freshness: 0.95,
                  externalKnowledge: 0.9,
                  verificationNeed: 0.9,
                })
              : signals({
                  reasoning: 0.9,
                }),
          );
        },
      },
    );

    expect(seen[0]?.length).toBeGreaterThan(1);
    expect(decision.knowledge).toBe('web_required');
    expect(decision.reasoning).toBe('deep');
  });

  test('explicit no-web constraint wins after semantic routing', async () => {
    const decision = await routePrompt(
      "prove this but don't look anything up",
      {
        signals: async (clauses) =>
          clauses.map(() =>
            signals({
              reasoning: 0.9,
              freshness: 0.95,
              externalKnowledge: 0.95,
              verificationNeed: 0.95,
            }),
          ),
      },
    );

    expect(decision.reasoning).toBe('deep');
    expect(decision.knowledge).toBe('internal');
  });

  test('explicit web request wins after semantic routing', async () => {
    const decision = await routePrompt(
      'search this obscure claim',
      {
        signals: async () => [
          signals({
            reasoning: 0.2,
          }),
        ],
      },
    );

    expect(decision.knowledge).toBe('web_required');
  });

  test('sensor failure is not silently downgraded', async () => {
    await expect(
      routePrompt('prove this theorem', {
        signals: async () => {
          throw new Error('sensor exploded');
        },
      }),
    ).rejects.toThrow('sensor exploded');
  });

  test('wrong sensor result count is rejected', async () => {
    await expect(
      routePrompt('explain this argument', {
        signals: async () => [],
      }),
    ).rejects.toThrow(
      'Router sensor returned the wrong number of signal sets.',
    );
  });

  test('reasoning floor never lowers a deep fuzzy route', async () => {
    const decision = await routePrompt(
      'prove this theorem',
      {
        signals: async () => [
          signals({
            reasoning: 0.95,
          }),
        ],
      },
    );

    expect(decision.reasoning).toBe('deep');
  });

  test('explicit no-web constraint beats freshness floor', async () => {
    const decision = await routePrompt(
      "is Discord down rn? don't search",
      {
        signals: async (clauses) =>
          clauses.map(() =>
            signals({
              freshness: 0.95,
              externalKnowledge: 0.95,
              verificationNeed: 0.95,
            }),
          ),
      },
    );

    expect(decision.knowledge).toBe('internal');
  });

});
