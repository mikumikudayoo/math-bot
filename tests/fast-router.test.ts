import { describe, expect, test } from 'bun:test';

import { fastRoute } from '../src/service/fast-router.js';

describe('fastRoute', () => {
  test('raw arithmetic can bypass semantic routing', () => {
    const result = fastRoute('37 * 14');

    expect(result.kind).toBe('final');

    if (result.kind === 'final') {
      expect(result.decision).toMatchObject({
        reasoning: 'fast',
        knowledge: 'internal',
        tool: 'calculate',
      });
    }
  });

  test('explicit search forces only web knowledge', () => {
    const result = fastRoute(
      'search for a proof that infinitely many primes exist',
    );

    expect(result).toEqual({
      kind: 'override',
      reason: 'explicit web request',
      overrides: {
        knowledge: 'web_required',
      },
    });
  });

  test('verification forces only web knowledge', () => {
    const result = fastRoute(
      'verify whether this theorem is correctly stated and explain its proof',
    );

    expect(result.kind).toBe('override');

    if (result.kind === 'override') {
      expect(result.overrides.knowledge).toBe('web_required');
    }
  });

  test('latest alone is not treated as guaranteed freshness', () => {
    expect(
      fastRoute('what does latest mean in this sentence?').kind,
    ).toBe('semantic');
  });

  test('weather queries defer to semantic routing', () => {
    expect(
      fastRoute("what's the weather tomorrow in Quezon City?").kind,
    ).toBe('semantic');
  });

  test('assistant identity can bypass semantic routing', () => {
    const result = fastRoute('who are you');

    expect(result.kind).toBe('final');

    if (result.kind === 'final') {
      expect(result.decision.knowledge).toBe('internal');
    }
  });

  test('simple conversation can bypass semantic routing', () => {
    expect(fastRoute('hello!').kind).toBe('final');
  });

  test('proper nouns alone do not trigger a shortcut', () => {
    expect(
      fastRoute("Who provides Hatsune Miku's voice?").kind,
    ).toBe('semantic');
  });

  test('mixed reasoning and current wording stays semantic', () => {
    expect(
      fastRoute(
        'explain what current means in an electrical circuit',
      ).kind,
    ).toBe('semantic');
  });
});

describe('explicit routing constraints', () => {
  test('do not search forces internal knowledge', () => {
    const result = fastRoute(
      "i swear this worked yesterday but don't search, just look at the code i sent",
    );

    expect(result.kind).toBe('override');

    if (result.kind === 'override') {
      expect(result.overrides.knowledge).toBe('internal');
    }
  });

  test('without looking it up forces internal knowledge', () => {
    const result = fastRoute(
      "prove this without looking it up",
    );

    expect(result.kind).toBe('override');

    if (result.kind === 'override') {
      expect(result.overrides.knowledge).toBe('internal');
    }
  });

  test('explicit positive search still requires web', () => {
    const result = fastRoute(
      "search for this theorem and explain the proof",
    );

    expect(result.kind).toBe('override');

    if (result.kind === 'override') {
      expect(result.overrides.knowledge).toBe('web_required');
    }
  });

  test('negative web instruction wins even when search word appears', () => {
    const result = fastRoute(
      "don't search online, explain it yourself",
    );

    expect(result.kind).toBe('override');

    if (result.kind === 'override') {
      expect(result.overrides.knowledge).toBe('internal');
    }
  });
});
