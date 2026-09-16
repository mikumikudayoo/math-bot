import type { RouteDecision } from './router.js';

export interface RouteOverrides {
  knowledge?: RouteDecision['knowledge'];
}

export type FastRouteResult =
  | {
      kind: 'final';
      reason: string;
      decision: RouteDecision;
    }
  | {
      kind: 'override';
      reason: string;
      overrides: RouteOverrides;
    }
  | {
      kind: 'semantic';
      reason: string;
    };

const finalRoute = (
  reasoning: RouteDecision['reasoning'],
  knowledge: RouteDecision['knowledge'],
  tool: RouteDecision['tool'],
  scores: RouteDecision['scores'],
): RouteDecision => ({
  reasoning,
  knowledge,
  tool,
  scores,
});

export function fastRoute(prompt: string): FastRouteResult {
  const p = prompt.trim();

  // Explicit requests for external verification/search are guarantees.
  // They force only the knowledge dimension; reasoning is still semantic.
  if (
    /\b(search(?: the web)?|look up|lookup|fact[- ]?check|verify|sources?|citations?|find (?:a |reliable )?source)\b/i.test(p)
  ) {
    return {
      kind: 'override',
      reason: 'explicit web request',
      overrides: {
        knowledge: 'web_required',
      },
    };
  }

  // Extremely obvious raw calculations can skip semantic classification.
  if (/^[\d\s()+*/.^%=-]+$/.test(p)) {
    return {
      kind: 'final',
      reason: 'simple calculation',
      decision: finalRoute(
        'fast',
        'internal',
        'calculate',
        {
          web: 0,
          online: 0,
          calculate: 1,
        },
      ),
    };
  }

  // Internal assistant identity is deterministic.
  if (
    /^(?:who are you|what are you|what(?:'s| is) your (?:name|dream)|who (?:made|created) you|tell me about yourself)[?.!]*$/i.test(p)
  ) {
    return {
      kind: 'final',
      reason: 'internal assistant identity',
      decision: finalRoute(
        'fast',
        'internal',
        'none',
        {
          web: 0,
          online: 0,
          calculate: 0,
        },
      ),
    };
  }

  // Very simple conversation can skip the classifier.
  if (
    /^(?:hi|hello|hey|thanks|thank you|good morning|good afternoon|good evening|good night)[!?. ]*$/i.test(p)
  ) {
    return {
      kind: 'final',
      reason: 'simple conversation',
      decision: finalRoute(
        'fast',
        'internal',
        'none',
        {
          web: 0,
          online: 0,
          calculate: 0,
        },
      ),
    };
  }

  return {
    kind: 'semantic',
    reason: 'needs semantic classification',
  };
}
