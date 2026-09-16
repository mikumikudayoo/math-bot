import type { RouteDecision } from './router.js';
import {
  routingConstraints,
  type RoutingConstraints,
} from './router-constraints.js';

export interface RouteOverrides {
  knowledge?: RouteDecision['knowledge'];
  tool?: RouteDecision['tool'];
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

function constraintOverride(
  constraints: RoutingConstraints,
): FastRouteResult | undefined {
  if (!constraints.knowledge && !constraints.tool) {
    return undefined;
  }

  const overrides: RouteOverrides = {};

  if (constraints.knowledge) {
    overrides.knowledge = constraints.knowledge;
  }

  if (constraints.tool) {
    overrides.tool = constraints.tool;
  }

  return {
    kind: 'override',
    reason:
      constraints.reasons.join(', ') ||
      'deterministic routing constraint',
    overrides,
  };
}

export function fastRoute(prompt: string): FastRouteResult {
  const p = prompt.trim();

  // User instructions and deterministic policy constraints come first.
  const constrained = constraintOverride(
    routingConstraints(p),
  );

  if (constrained) {
    return constrained;
  }

  // Pure raw arithmetic can finish immediately.
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

  // Internal assistant identity.
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

  // Extremely simple conversation.
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
