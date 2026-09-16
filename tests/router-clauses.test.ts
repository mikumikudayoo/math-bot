import { describe, expect, test } from 'bun:test';

import { routingClauses } from '../src/service/router-clauses.js';

describe('routingClauses', () => {
  test('keeps simple prompts whole', () => {
    expect(routingClauses('explain photosynthesis')).toEqual([
      'explain photosynthesis',
    ]);
  });

  test('splits calculation plus fresh information', () => {
    expect(
      routingClauses('what is 19*43 and is bitcoin up today'),
    ).toEqual([
      'what is 19*43',
      'is bitcoin up today',
    ]);
  });

  test('splits identity plus weather', () => {
    expect(
      routingClauses('who made you btw and whats the weather tomorrow'),
    ).toEqual([
      'who made you btw',
      'whats the weather tomorrow',
    ]);
  });

  test('splits sequential mixed work', () => {
    expect(
      routingClauses(
        'verify this result online and then check whether the argument below is valid',
      ),
    ).toEqual([
      'verify this result online',
      'then check whether the argument below is valid',
    ]);
  });
});
