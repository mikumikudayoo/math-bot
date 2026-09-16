import { describe, expect, test } from 'bun:test';
import { parseRoutingSignals } from '../src/service/router-classifier.js';

describe('router classifier', () => {
  test('accepts valid signals', () => {
    expect(parseRoutingSignals({
      reasoning: .2,
      freshness: .1,
      externalKnowledge: .3,
      ambiguity: .4,
      verificationNeed: .5,
      calculation: .9,
    })).toEqual({
      reasoning: .2,
      freshness: .1,
      externalKnowledge: .3,
      ambiguity: .4,
      verificationNeed: .5,
      calculation: .9,
    });
  });

  test('clamps signals', () => {
    const result = parseRoutingSignals({
      reasoning: -1,
      freshness: 2,
      externalKnowledge: 0,
      ambiguity: 0,
      verificationNeed: 0,
      calculation: 0,
    });

    expect(result.reasoning).toBe(0);
    expect(result.freshness).toBe(1);
  });

  test('rejects missing signals', () => {
    expect(() => parseRoutingSignals({
      reasoning: .5,
    })).toThrow();
  });

  test('rejects non-numeric signals', () => {
    expect(() => parseRoutingSignals({
      reasoning: 'high',
      freshness: 0,
      externalKnowledge: 0,
      ambiguity: 0,
      verificationNeed: 0,
      calculation: 0,
    })).toThrow();
  });
});
