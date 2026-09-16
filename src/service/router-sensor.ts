import type { RoutingSignals } from './router.js';

export interface RouterSensorOptions {
  url?: string;
  timeoutMs?: number;
}

interface SensorResponse {
  signals: RoutingSignals[];
}

function validSignal(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

function validRoutingSignals(value: unknown): value is RoutingSignals {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const s = value as Record<string, unknown>;

  return (
    validSignal(s.reasoning) &&
    validSignal(s.freshness) &&
    validSignal(s.externalKnowledge) &&
    validSignal(s.ambiguity) &&
    validSignal(s.verificationNeed) &&
    validSignal(s.calculation)
  );
}

export async function routerSignals(
  clauses: string[],
  options: RouterSensorOptions = {},
): Promise<RoutingSignals[]> {
  if (clauses.length === 0) {
    return [];
  }

  const url = options.url ?? 'http://127.0.0.1:8789/signals';
  const timeoutMs = options.timeoutMs ?? 1_000;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ clauses }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Router sensor returned HTTP ${response.status}.`);
  }

  const body = (await response.json()) as Partial<SensorResponse>;

  if (
    !Array.isArray(body.signals) ||
    body.signals.length !== clauses.length ||
    !body.signals.every(validRoutingSignals)
  ) {
    throw new Error('Router sensor returned invalid signals.');
  }

  return body.signals;
}
