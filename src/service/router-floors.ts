import type { RouteDecision } from './router.js';

export interface RoutingFloors {
  reasoning?: 'standard' | 'deep';
  knowledge?: 'web_if_uncertain' | 'web_required';
  reasons: string[];
}

const reasoningRank = {
  fast: 0,
  standard: 1,
  deep: 2,
} as const;
const knowledgeRank = {
  internal: 0,
  web_if_uncertain: 1,
  web_required: 2,
} as const;

export function routingFloors(prompt: string): RoutingFloors {
  const p = prompt.trim();

  const reasons: string[] = [];
  let reasoning: RoutingFloors['reasoning'];
  let knowledge: RoutingFloors['knowledge'];

  // Explicit requests for substantial reasoning.
  const substantialReasoning =
    /\b(?:prove|proof|derive|derivation|debug|diagnose|troubleshoot)\b/i.test(p) ||
    /\b(?:why|how)\s+(?:does|did|would|could)\b/i.test(p) &&
      /\b(?:code|error|bug|break|broke|works?|working|restart|upgrade|update)\b/i.test(p);

  if (substantialReasoning) {
    reasoning = 'standard';
    reasons.push('explicit substantial-reasoning request');
  }

  // Existence claims about an unfamiliar subject may need external verification.
  const uncertainExistence =
    /\b(?:does|do)\s+.+?\s+exist(?:s)?\b/i.test(p) ||
    /\bis\s+there\s+(?:such\s+)?(?:a|an)\s+.+\b/i.test(p);
  if (uncertainExistence) {
    knowledge = 'web_if_uncertain';
    reasons.push('uncertain existence claim');
  }

  // Queries whose answer inherently depends on current external state.
  const currentExternalState =
    /\b(?:down|offline|outage)\s+(?:rn|right\s+now|currently)\b/i.test(p) ||
    /\b(?:current|latest|newest)\s+(?:version|release)\b/i.test(p) ||
    /\b(?:version|release)\b.{0,60}\b(?:current|latest|newest)(?:\s+right\s+now)?\b/i.test(p);

  if (currentExternalState) {
    knowledge = 'web_required';
    reasons.push('current external-state request');
  }

  return {
    ...(reasoning ? { reasoning } : {}),
    ...(knowledge ? { knowledge } : {}),
    reasons,
  };
}

export function applyRoutingFloors(
  decision: RouteDecision,
  floors: RoutingFloors,
): RouteDecision {
  let reasoning = decision.reasoning;

  if (
    floors.reasoning &&
    reasoningRank[reasoning] < reasoningRank[floors.reasoning]
  ) {
    reasoning = floors.reasoning;
  }

  let knowledge = decision.knowledge;
  if (
    floors.knowledge &&
    knowledgeRank[knowledge] < knowledgeRank[floors.knowledge]
  ) {
    knowledge = floors.knowledge;
  }
  return {
    ...decision,
    reasoning,
    knowledge,
  };
}
