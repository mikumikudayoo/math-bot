import type { OpenAIConfig, ReasoningEffort, Tier } from './openai-config.js';
import { UserError } from './types.js';

/**
 * Deterministic, conservative model routing. No extra model call is spent on
 * classification. Mathematical notation alone never makes a request "difficult".
 */
export type Directive = 'quick' | 'deep' | 'max';
export interface OpenAIRoute {
  tier: Tier; model: string; effort: ReasoningEffort; maxOutputTokens: number;
  reason: string; directive?: Directive;
}

// The word must end at whitespace, ':' / ',' or end of text, so "!max-flow" is not a directive.
const DIRECTIVE = /^\s*!(quick|luna|deep|sol|max)(?=$|[\s:,])[:,]?\s*/i;
/** Strips a leading `!quick` / `!deep` / `!max` (aliases `!luna`, `!sol`) from the prompt. */
export function parseDirective(prompt: string): {prompt: string; directive?: Directive} {
  const match = prompt.match(DIRECTIVE);
  if (!match) return {prompt};
  const word = match[1]!.toLowerCase();
  const directive: Directive = word === 'quick' || word === 'luna' ? 'quick' : word === 'max' ? 'max' : 'deep';
  const rest = prompt.slice(match[0].length).trim();
  return {prompt: rest || prompt.trim(), directive};
}

/** Proof/olympiad intent. Any one of these is enough. */
const STRONG = [
  /\b(?:prove|proof|disprove)\b/i,
  /\bshow that\b/i,
  /\b(?:olympiad|imo|usamo|usajmo|jbmo|apmo|egmo|putnam|shortlist|isl|tst)\b/i,
  /\bfunctional equations?\b/i,
  // "find all real x such that ..." is routine algebra, so bare "find all real" is not a signal.
  /\bfind all (?:functions|integers?|positive integers|pairs|triples|ordered|primes|polynomials|n\b)/i,
];
/** Competition-flavoured signals. Several must co-occur. */
const MEDIUM: RegExp[] = [
  /\bhow many\b|\bnumber of (?:ways|integers|subsets|arrangements|paths|solutions)\b/i,
  /\bprobability\b/i,
  /\bremainder when\b|\bmod(?:ulo)?\s*\d|\\p?mod\b|≡/i,
  /\bdivisible by\b|\bdivisors?\b|\bgcd\b|\blcm\b/i,
  /\b(?:positive|nonnegative|distinct) integers?\b|\binteger solutions?\b|\bprimes?\b/i,
  /\binequalit(?:y|ies)\b|\bmaxim(?:um|ize|ise)\b|\bminim(?:um|ize|ise)\b|\b(?:greatest|largest|smallest|least) (?:possible |positive )?(?:integer|value|number)\b/i,
  /\b(?:circumcircle|incircle|incenter|circumcenter|orthocenter|cyclic|concurrent|collinear|tangent)\b/i,
  /\b(?:polynomial|roots?)\b/i,
  /\b(?:sequence|recurrence|recursive)\b/i,
  /\b(?:pigeonhole|invariant|colou?r(?:ing|ings|ed)|lattice|bijection|graph|up to rotation|rotations?)\b/i,
  /\b(?:aime|amc ?1[02]|hmmt|cmimc|bmo|smo|pmo|mpotd)\b/i,
];

export function difficultySignals(prompt: string): {strong: boolean; medium: number} {
  const strong = STRONG.some(r => r.test(prompt));
  const medium = MEDIUM.filter(r => r.test(prompt)).length;
  return {strong, medium};
}

export interface RouteInput {
  prompt: string;
  coach: boolean;
  directive?: Directive;
  /** Existing service router output; only one weak signal, never sufficient alone. */
  routeReasoning?: 'fast' | 'standard' | 'deep';
  /** Tier used by the previous turn of this reply chain, if it was an OpenAI turn. */
  parentTier?: Tier;
}

export function buildRoute(config: OpenAIConfig, tier: Tier, reason: string, directive?: Directive): OpenAIRoute {
  const model = tier === 'light' ? config.lightModel : config.advancedModel;
  let effort = config.efforts[tier];
  // Admin effort override applies to automatic tiers only; !max keeps its configured effort.
  if (config.forceEffort && tier !== 'max' && config.models[model]!.efforts.includes(config.forceEffort)) effort = config.forceEffort;
  return {tier, model, effort, maxOutputTokens: config.maxOutputTokens[tier], reason, ...(directive ? {directive} : {})};
}

export function chooseOpenAIRoute(config: OpenAIConfig, input: RouteInput): OpenAIRoute {
  const build = (tier: Tier, reason: string) => buildRoute(config, tier, reason, input.directive);

  if (input.directive === 'max') {
    // Premium escalation is deliberately not available to ordinary members.
    if (!input.coach) throw new UserError('!max is limited to coaches. try !deep instead.');
    return build('max', 'explicit !max');
  }
  if (config.forceTier) return build(config.forceTier, `admin override (${config.forceTier})`);
  if (input.directive === 'deep') return build('advanced', 'explicit !deep');
  if (input.directive === 'quick') return build('light', 'explicit !quick');
  if (!config.routing) return build('light', 'routing disabled');

  const {strong, medium} = difficultySignals(input.prompt);
  if (strong) return build('advanced', 'proof/olympiad signal');
  const followUp = input.parentTier && input.parentTier !== 'light';
  if (followUp) return build('advanced', 'follow-up to an advanced answer');
  const score = medium + (input.routeReasoning === 'deep' ? 1 : 0) + (input.prompt.length > 400 ? 1 : 0);
  if (score >= 3) return build('advanced', `competition signals (${score})`);
  return build('light', 'routine');
}
