import { describe, expect, test } from 'bun:test';

import { aggregateRoutingSignals } from '../src/service/router-aggregate.js';

describe('aggregateRoutingSignals', () => {
  test('takes strongest requirement from each clause', () => {
    const result = aggregateRoutingSignals([
      {
        reasoning: .10,
        freshness: .05,
        externalKnowledge: .05,
        ambiguity: .10,
        verificationNeed: .05,
        calculation: .95,
      },
      {
        reasoning: .20,
        freshness: .95,
        externalKnowledge: .90,
        ambiguity: .05,
        verificationNeed: .85,
        calculation: .05,
      },
    ]);

    expect(result).toEqual({
      reasoning: .20,
      freshness: .95,
      externalKnowledge: .90,
      ambiguity: .10,
      verificationNeed: .85,
      calculation: .95,
    });
  });

  test('preserves hard reasoning alongside web need', () => {
    const result = aggregateRoutingSignals([
      {
        reasoning: .80,
        freshness: 0,
        externalKnowledge: .05,
        ambiguity: .05,
        verificationNeed: 0,
        calculation: .10,
      },
      {
        reasoning: .20,
        freshness: .90,
        externalKnowledge: .95,
        ambiguity: .10,
        verificationNeed: .90,
        calculation: 0,
      },
    ]);

    expect(result.reasoning).toBe(.80);
    expect(result.freshness).toBe(.90);
    expect(result.externalKnowledge).toBe(.95);
  });

  test('empty input is safe', () => {
    expect(aggregateRoutingSignals([])).toEqual({
      reasoning: 0,
      freshness: 0,
      externalKnowledge: 0,
      ambiguity: 0,
      verificationNeed: 0,
      calculation: 0,
    });
  });
});
