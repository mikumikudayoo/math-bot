/** Versioned experimental defaults. No time or speed enters the rating formula. */
export interface RatingConfig {
  version: string; initial: number; k: number; repeatWeights: number[];
  cooldown: number; durationMs: number; maxAbandonedPerDay: number; maxAssignmentsPerDay: number;
  provisionalUntil: number; selectionSpread: number;
}
export const DEFAULT_RATING: RatingConfig = {
  version: 'experimental-1', initial: 1200, k: 32, repeatWeights: [1, .5, .25],
  cooldown: 30, durationMs: 600_000, maxAbandonedPerDay: 3, maxAssignmentsPerDay: 20,
  provisionalUntil: 20, selectionSpread: 300,
};
export function validateConfig(c: RatingConfig) {
  if (!c.version || c.durationMs !== 600_000 || c.initial !== 1200 || !(c.k > 0 && c.k <= 100) ||
      !c.repeatWeights.length || c.repeatWeights.some(w => !Number.isFinite(w) || w < 0 || w > 1) ||
      c.repeatWeights[0] !== 1 || c.repeatWeights.some((w, i) => i > 0 && w > c.repeatWeights[i - 1]!) ||
      ![c.cooldown, c.durationMs, c.maxAbandonedPerDay, c.maxAssignmentsPerDay, c.provisionalUntil, c.selectionSpread]
        .every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('Invalid experimental rating configuration.');
}
export const expected = (rating: number, difficulty: number) => 1 / (1 + 10 ** ((difficulty - rating) / 400));
export function rate(rating: number, difficulty: number, correct: boolean, encounter: number, config = DEFAULT_RATING) {
  validateConfig(config);
  if (![rating, difficulty].every(Number.isFinite) || !Number.isSafeInteger(encounter) || encounter < 1) throw new Error('Invalid rating input.');
  const probability = expected(rating, difficulty);
  const weight = config.repeatWeights[Math.min(encounter - 1, config.repeatWeights.length - 1)]!;
  const delta = config.k * weight * (Number(correct) - probability);
  return { before: rating, after: rating + delta, difficulty, probability, correct, encounter, weight, delta, configVersion: config.version };
}
export function repeatEligible(lastSequence: number | null, sequence: number, cooldown: number) {
  return lastSequence === null || sequence - lastSequence >= cooldown;
}
export function chooseProblem<T extends { difficulty: number }>(pool: T[], rating: number, spread: number, rng = Math.random): T | undefined {
  if (!pool.length) return;
  // A small exploration floor avoids starving distant provisional problems.
  const weights = pool.map(p => .02 + Math.exp(-Math.abs(p.difficulty - rating) / spread));
  const random = rng();
  if (!(random >= 0 && random < 1)) throw new Error('Random source must return [0,1).');
  let target = random * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < pool.length; i++) { target -= weights[i]!; if (target < 0) return pool[i]!; }
  return pool[pool.length - 1]!;
}
