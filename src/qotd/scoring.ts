export interface ScoringConfig { strategy: 'linear-time'; version: 1; basePoints: number; speedBonus: number; bonusWindowSeconds: number }
export interface ScoreContext { correct: boolean; openedAt: number; submittedAt: number; elapsedSeconds: number; placement: number | null; participantCount: number; correctCount: number; questionType: string; difficulty?: string }
export const DEFAULT_SCORING: ScoringConfig = { strategy: 'linear-time', version: 1, basePoints: 10, speedBonus: 2, bonusWindowSeconds: 3600 };
export function validateScoring(c: ScoringConfig) {
  if (c.strategy !== 'linear-time' || c.version !== 1 || !Number.isFinite(c.basePoints) || c.basePoints < 0 || !Number.isFinite(c.speedBonus) || c.speedBonus < 0 || !Number.isFinite(c.bonusWindowSeconds) || c.bonusWindowSeconds <= 0) throw new Error('Invalid scoring configuration.');
  if (!Number.isFinite((c.basePoints+c.speedBonus)*1000)) throw new Error('Score exceeds supported range.');
}
export function scoreSubmission(context: ScoreContext, config: ScoringConfig = DEFAULT_SCORING): number {
  validateScoring(config);
  if (!context.correct) return 0;
  const bonus = config.speedBonus * Math.max(0, 1 - Math.max(0, context.elapsedSeconds) / config.bonusWindowSeconds);
  return Math.round((config.basePoints + bonus) * 1000) / 1000;
}
