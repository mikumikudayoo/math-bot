import { fastRoute } from './fast-router.js';
import { routingClauses } from './router-clauses.js';
import { aggregateRoutingSignals } from './router-aggregate.js';
import { routingConstraints } from './router-constraints.js';
import {
  applyRoutingFloors,
  routingFloors,
} from './router-floors.js';
import { routerSignals } from './router-sensor.js';
import {
  fuzzyRoute,
  type RouteDecision,
  type RoutingSignals,
} from './router.js';

export interface RoutePromptDependencies {
  signals?: (clauses: string[]) => Promise<RoutingSignals[]>;
}

function applyConstraints(
  decision: RouteDecision,
  prompt: string,
): RouteDecision {
  const constraints = routingConstraints(prompt);

  return {
    ...decision,
    ...(constraints.knowledge
      ? { knowledge: constraints.knowledge }
      : {}),
    ...(constraints.tool
      ? { tool: constraints.tool }
      : {}),
  };
}

export async function routePrompt(
  prompt: string,
  dependencies: RoutePromptDependencies = {},
): Promise<RouteDecision> {
  const fast = fastRoute(prompt);

  if (fast.kind === 'final') {
    return fast.decision;
  }

  const clauses = routingClauses(prompt);

  if (clauses.length === 0) {
    throw new Error('Cannot route an empty prompt.');
  }

  const semanticInputs = [
    prompt,
    ...clauses.filter((clause) => clause !== prompt),
  ];

  const getSignals = dependencies.signals ?? routerSignals;
  const clauseSignals = await getSignals(semanticInputs);

  if (clauseSignals.length !== semanticInputs.length) {
    throw new Error(
      'Router sensor returned the wrong number of signal sets.',
    );
  }

  const aggregated = aggregateRoutingSignals(clauseSignals);
  const fuzzyDecision = fuzzyRoute(aggregated);
  const flooredDecision = applyRoutingFloors(
    fuzzyDecision,
    routingFloors(prompt),
  );

  return applyConstraints(flooredDecision, prompt);
}
