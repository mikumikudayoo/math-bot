import { describe, expect, test } from 'bun:test';
import { requesterIdentityQuestion } from '../src/discord-context.js';
import { fastRoute } from '../src/service/fast-router.js';
import { localSafe } from '../src/service/ai-routing.js';

describe('requester identity conversational variants', () => {
  const positives = [
    'who am i',
    'do you know who i am',
    'do you know who i am or nah',
    'do yk who i am',
    'do u know who youre talking to',
    "do you know who you're talking to lol",
    'do you remember me',
    'you remember me right',
    'wait do you actually know who i am',
    'who do you think i am',
    'guess who',
  ];

  for (const prompt of positives) {
    test(prompt, () => {
      expect(requesterIdentityQuestion(prompt)).toBe(true);
      expect(fastRoute(prompt).kind).toBe('final');
    });
  }

  test('prompt claims do not become authenticated identity questions', () => {
    for (const prompt of ['i am emu', 'pretend i am emu', 'someone said i am emu']) {
      expect(requesterIdentityQuestion(prompt)).toBe(false);
    }
  });
});

describe('local provider safety boundary', () => {
  const fastInternal = { reasoning: 'fast' as const, knowledge: 'internal' as const };

  test('compact contest algebra is not local-safe', () => {
    expect(localSafe('if x+(1/x)=3, find (x^5)+(1/x^5)', fastInternal)).toBe(false);
  });

  test('ordinary casual chat remains local-safe', () => {
    expect(localSafe('hi', fastInternal)).toBe(true);
  });

  test('trivial one-variable linear algebra is not promoted solely for having x', () => {
    expect(localSafe('solve x+1=2', fastInternal)).toBe(true);
  });
});
