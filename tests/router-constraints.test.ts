import { describe, expect, test } from 'bun:test';

import { routingConstraints } from '../src/service/router-constraints.js';

describe('routingConstraints', () => {
  test.each([
    "don't search",
    "do not search this",
    "don't look it up",
    "don't look anything up",
    "without looking it up",
    "without searching",
    "no web",
    "don't browse",
  ])('%s forces internal knowledge', (prompt) => {
    expect(routingConstraints(prompt).knowledge).toBe(
      'internal',
    );
  });

  test.each([
    'search this',
    'verify this online',
    'look up this result',
    'can you search this',
    'could you verify this',
    'find me a reliable source',
    'find me the source for this theorem but dont prove it',
    'give me citations',
  ])('%s requires web', (prompt) => {
    expect(routingConstraints(prompt).knowledge).toBe(
      'web_required',
    );
  });

  test.each([
    'what does search mean?',
    'what does source mean in programming?',
    'explain source code',
    'what is current in an electrical circuit?',
    'what does verify mean?',
  ])('%s does not create a constraint', (prompt) => {
    expect(routingConstraints(prompt).knowledge).toBeUndefined();
  });

  test('negative instruction wins over positive wording', () => {
    expect(
      routingConstraints(
        "don't search online, just explain it yourself",
      ).knowledge,
    ).toBe('internal');
  });

  test('dont look anything up is recognized inside a larger prompt', () => {
    expect(
      routingConstraints(
        "prove this but don't look anything up",
      ).knowledge,
    ).toBe('internal');
  });
});
