import { expected } from './rating.js';
/** Simulation-only candidate. Production collects evidence but never applies this automatically. */
export function calibrationStep(initial: number, current: number, count: number, playerRating: number, correct: boolean, encounter: number, abandoned = false) {
  if (encounter !== 1 || abandoned) return { difficulty: current, count, provisional: count < 30, uncertainty: 400 / Math.sqrt(count + 1) };
  const change = 8 * (expected(playerRating, current) - Number(correct));
  const difficulty = Math.max(initial - 100, Math.min(initial + 100, current + change));
  return { difficulty, count: count + 1, provisional: count + 1 < 30, uncertainty: 400 / Math.sqrt(count + 2) };
}
