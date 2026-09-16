import { describe, expect, test } from 'bun:test';

import { routerSignals } from '../src/service/router-sensor.js';

describe('routerSignals', () => {
  test('empty clauses need no sensor request', async () => {
    expect(await routerSignals([])).toEqual([]);
  });

  test('accepts valid sensor signals', async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          signals: [{
            reasoning: 0.5,
            freshness: 0.2,
            externalKnowledge: 0.3,
            ambiguity: 0.1,
            verificationNeed: 0.4,
            calculation: 0.9,
          }],
        });
      },
    });

    try {
      const signals = await routerSignals(['test clause'], {
        url: `${server.url}signals`,
      });

      expect(signals).toHaveLength(1);
      expect(signals[0]?.calculation).toBe(0.9);
    } finally {
      server.stop(true);
    }
  });

  test('rejects malformed sensor output', async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          signals: [{ reasoning: 500 }],
        });
      },
    });

    try {
      await expect(
        routerSignals(['test clause'], {
          url: `${server.url}signals`,
        }),
      ).rejects.toThrow(
        'Router sensor returned invalid signals.',
      );
    } finally {
      server.stop(true);
    }
  });
});
