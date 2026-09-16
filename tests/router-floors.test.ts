import { describe, expect, test } from 'bun:test';

import {
  applyRoutingFloors,
  routingFloors,
} from '../src/service/router-floors.js';
import type { RouteDecision } from '../src/service/router.js';

function route(
  reasoning: RouteDecision['reasoning'],
  knowledge: RouteDecision['knowledge'] = 'internal',
): RouteDecision {
  return {
    reasoning,
    knowledge,
    tool: 'none',
    scores: {
      web: 0,
      online: 0,
      calculate: 0,
    },
  };
}

describe('routingFloors', () => {
  test('proof requests require at least standard reasoning', () => {
    expect(routingFloors('prove this theorem').reasoning)
      .toBe('standard');
  });

  test('derivation requests require at least standard reasoning', () => {
    expect(
      routingFloors(
        'derive the formula instead of just giving it to me',
      ).reasoning,
    ).toBe('standard');
  });

  test('debugging requests require at least standard reasoning', () => {
    expect(
      routingFloors(
        'can you debug why this socket event fires twice',
      ).reasoning,
    ).toBe('standard');
  });

  test('current outages require web', () => {
    expect(routingFloors('is Discord down rn').knowledge)
      .toBe('web_required');
  });

  test('current versions require web', () => {
    expect(
      routingFloors('what version of Bun is current right now')
        .knowledge,
    ).toBe('web_required');
  });

  test('ordinary timeless version questions are not forced online', () => {
    expect(
      routingFloors('what does semantic versioning mean').knowledge,
    ).toBeUndefined();
  });

  test('floors raise fast to standard', () => {
    const result = applyRoutingFloors(
      route('fast'),
      { reasoning: 'standard', reasons: [] },
    );

    expect(result.reasoning).toBe('standard');
  });

  test('floors never lower deep reasoning', () => {
    const result = applyRoutingFloors(
      route('deep'),
      { reasoning: 'standard', reasons: [] },
    );

    expect(result.reasoning).toBe('deep');
  });
});
