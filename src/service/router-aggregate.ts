import type { RoutingSignals } from './router.js';

export function aggregateRoutingSignals(
  signals: RoutingSignals[],
): RoutingSignals {
  if (signals.length === 0) {
    return {
      reasoning: 0,
      freshness: 0,
      externalKnowledge: 0,
      ambiguity: 0,
      verificationNeed: 0,
      calculation: 0,
    };
  }

  return {
    reasoning: Math.max(...signals.map((s) => s.reasoning)),
    freshness: Math.max(...signals.map((s) => s.freshness)),
    externalKnowledge: Math.max(
      ...signals.map((s) => s.externalKnowledge),
    ),
    ambiguity: Math.max(...signals.map((s) => s.ambiguity)),
    verificationNeed: Math.max(
      ...signals.map((s) => s.verificationNeed),
    ),
    calculation: Math.max(...signals.map((s) => s.calculation)),
  };
}
