import { describe, expect, test } from 'bun:test';
import { fuzzyRoute } from '../src/service/router.js';

describe('fuzzy router', () => {
  test('casual conversation stays local', () => {
    const route = fuzzyRoute({
      reasoning: .02,
      freshness: 0,
      externalKnowledge: .03,
      ambiguity: .02,
      verificationNeed: 0,
      calculation: 0,
    });

    expect(route.reasoning).toBe('fast');
    expect(route.knowledge).toBe('internal');
    expect(route.tool).toBe('none');
  });

  test('simple arithmetic selects calculator', () => {
    const route = fuzzyRoute({
      reasoning: .08,
      freshness: 0,
      externalKnowledge: 0,
      ambiguity: 0,
      verificationNeed: 0,
      calculation: .98,
    });

    expect(route.knowledge).toBe('internal');
    expect(route.tool).toBe('calculate');
  });

  test('fresh external information requires web', () => {
    const route = fuzzyRoute({
      reasoning: .3,
      freshness: .95,
      externalKnowledge: .9,
      ambiguity: .2,
      verificationNeed: .8,
      calculation: 0,
    });

    expect(route.knowledge).toBe('web_required');
  });

  test('hard timeless reasoning selects deep reasoning without web', () => {
    const route = fuzzyRoute({
      reasoning: .95,
      freshness: 0,
      externalKnowledge: .05,
      ambiguity: .2,
      verificationNeed: .05,
      calculation: .1,
    });

    expect(route.reasoning).toBe('deep');
    expect(route.knowledge).toBe('internal');
  });
});
