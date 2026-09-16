import { describe, expect, test } from 'bun:test';
import { fastSignals } from '../src/service/fast-router.js';
import { fuzzyRoute } from '../src/service/router.js';

describe('fast routing sensors', () => {
  test('simple arithmetic bypasses AI routing', () => {
    const result = fastSignals('3 * 8');
    expect(result.confident).toBe(true);
    expect(fuzzyRoute(result.signals!).tool).toBe('calculate');
  });

  test('current weather requires web', () => {
    const result = fastSignals('what is the current weather in Manila?');
    expect(result.confident).toBe(true);
    expect(fuzzyRoute(result.signals!).knowledge).toBe('web_required');
  });

  test('explicit search requires web', () => {
    const result = fastSignals('look up Hatsune Miku');
    expect(result.confident).toBe(true);
    expect(fuzzyRoute(result.signals!).knowledge).toBe('web_required');
  });

  test('assistant identity stays internal', () => {
    for (const prompt of [
      'who are you',
      'what is your dream',
      'tell me about yourself',
    ]) {
      const result = fastSignals(prompt);
      expect(result.confident).toBe(true);
      expect(fuzzyRoute(result.signals!).knowledge).toBe('internal');
    }
  });

  test('proper nouns alone do not trigger a confident route', () => {
    expect(
      fastSignals("HELLO! I'm Emu Otori! Emu means SMILE!!").confident
    ).toBe(false);
  });

  test('ambiguous factual requests defer to semantic classifier', () => {
    expect(
      fastSignals("Who provides Hatsune Miku's voice?").confident
    ).toBe(false);

    expect(
      fastSignals(
        'Describe all Eternal Towers of Hell difficulties, including noncanon ones.'
      ).confident
    ).toBe(false);
  });

  test('math wording is not guessed from isolated keywords', () => {
    expect(
      fastSignals('Solve all integer solutions of x + 2 = 3.').confident
    ).toBe(false);
  });
});
