export interface RoutingSignals {
  reasoning: number;
  freshness: number;
  externalKnowledge: number;
  ambiguity: number;
  verificationNeed: number;
  calculation: number;
}

export interface RouteDecision {
  reasoning: 'fast' | 'standard' | 'deep';
  knowledge: 'internal' | 'web_if_uncertain' | 'web_required';
  tool: 'none' | 'calculate';
  scores: {
    web: number;
    online: number;
    calculate: number;
  };
}

const clamp = (n: number) =>
  Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;

function high(x: number, start = 0.55, full = 0.85) {
  x = clamp(x);
  if (x <= start) return 0;
  if (x >= full) return 1;
  return (x - start) / (full - start);
}

function medium(x: number) {
  x = clamp(x);
  return Math.max(0, 1 - Math.abs(x - 0.5) / 0.35);
}

export function fuzzyRoute(raw: RoutingSignals): RouteDecision {
  const s: RoutingSignals = {
    reasoning: clamp(raw.reasoning),
    freshness: clamp(raw.freshness),
    externalKnowledge: clamp(raw.externalKnowledge),
    ambiguity: clamp(raw.ambiguity),
    verificationNeed: clamp(raw.verificationNeed),
    calculation: clamp(raw.calculation),
  };

  // Fuzzy rule aggregation. Multiple rules may fire simultaneously.
  const web = Math.max(
    high(s.freshness),
    Math.min(high(s.externalKnowledge), high(s.verificationNeed)),
    Math.min(high(s.externalKnowledge), high(s.ambiguity)),
  );

  const online = Math.max(
    high(s.reasoning),
    Math.min(medium(s.reasoning), high(s.ambiguity)),
  );

  const calculate = Math.min(
    high(s.calculation, 0.6, 0.9),
    1 - high(s.reasoning),
  );

  return {
    reasoning:
      online >= 0.8 ? 'deep' :
      online >= 0.35 ? 'standard' :
      'fast',

    knowledge:
      web >= 0.65 ? 'web_required' :
      web >= 0.25 ? 'web_if_uncertain' :
      'internal',

    tool:
      calculate >= 0.65 ? 'calculate' : 'none',

    scores: { web, online, calculate },
  };
}
