import type { RoutingSignals } from './router.js';

export interface FastRouteResult {
  confident: boolean;
  signals?: RoutingSignals;
  reason?: string;
}

const signals = (
  values: Partial<RoutingSignals>,
): RoutingSignals => ({
  reasoning: 0,
  freshness: 0,
  externalKnowledge: 0,
  ambiguity: 0,
  verificationNeed: 0,
  calculation: 0,
  ...values,
});

export function fastSignals(prompt: string): FastRouteResult {
  const p = prompt.trim();

  // Explicit requests for web verification are unambiguous.
  if (/\b(search|look up|fact[- ]?check|verify|sources?|citations?)\b/i.test(p)) {
    return {
      confident: true,
      reason: 'explicit web request',
      signals: signals({
        externalKnowledge: .9,
        verificationNeed: 1,
      }),
    };
  }

  // Strongly time-sensitive requests.
  if (/\b(latest|today|currently|current|recent|news|weather)\b/i.test(p)) {
    return {
      confident: true,
      reason: 'explicitly current information',
      signals: signals({
        freshness: 1,
        externalKnowledge: .9,
        verificationNeed: .85,
      }),
    };
  }

  // Very simple symbolic arithmetic.
  if (/^[\d\s()+*/.^%=-]+$/.test(p)) {
    return {
      confident: true,
      reason: 'simple calculation',
      signals: signals({ calculation: 1 }),
    };
  }

  // Direct configured Aleph-Zero identity/persona questions.
  if (/^(?:who are you|what are you|what(?:'s| is) your (?:name|dream)|who (?:made|created) you|tell me about yourself)[?.!]*$/i.test(p)) {
    return {
      confident: true,
      reason: 'internal assistant identity',
      signals: signals({ ambiguity: .05 }),
    };
  }

  // Obvious greetings only. Do NOT classify arbitrary statements here.
  if (/^(?:hi|hello|hey|thanks|thank you|good morning|good evening)[!?. ]*$/i.test(p)) {
    return {
      confident: true,
      reason: 'simple conversation',
      signals: signals({ ambiguity: .02 }),
    };
  }

  return {
    confident: false,
    reason: 'needs semantic classification',
  };
}
