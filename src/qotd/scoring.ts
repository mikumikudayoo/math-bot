export type ScoringConfig =
  | { strategy: "linear-time"; version: 1; basePoints: number; speedBonus: number; bonusWindowSeconds: number }
  | { strategy: "first-correct-to-reveal"; version: 2; basePoints: number; speedBonus: number };

export interface ScoreContext {
  correct: boolean;
  openedAt: number;
  submittedAt: number;
  elapsedSeconds: number;
  placement: number | null;
  participantCount: number;
  correctCount: number;
  questionType: string;
  difficulty?: string;
  firstCorrectAt?: number | null;
  revealAt?: number;
}

export const LEGACY_SCORING: ScoringConfig = {
  strategy: "linear-time", version: 1,
  basePoints: 10, speedBonus: 2, bonusWindowSeconds: 3600
};

export const FLAT_SCORING: ScoringConfig = {
  ...LEGACY_SCORING, speedBonus: 0
};

export const DEFAULT_SCORING: ScoringConfig = {
  strategy: "first-correct-to-reveal", version: 2,
  basePoints: 10, speedBonus: 5
};

export function validateScoring(c: ScoringConfig) {
  if (!Number.isFinite(c.basePoints) || c.basePoints < 0 ||
      !Number.isFinite(c.speedBonus) || c.speedBonus < 0 ||
      !Number.isFinite((c.basePoints + c.speedBonus) * 1000)) {
    throw new Error("Invalid scoring configuration.");
  }

  if (c.strategy === "linear-time") {
    if (c.version !== 1 || !Number.isFinite(c.bonusWindowSeconds) ||
        c.bonusWindowSeconds <= 0) {
      throw new Error("Invalid scoring configuration.");
    }
  } else if (c.strategy !== "first-correct-to-reveal" || c.version !== 2) {
    throw new Error("Invalid scoring configuration.");
  }
}

export function scoreSubmission(
  context: ScoreContext,
  config: ScoringConfig = DEFAULT_SCORING
): number {
  validateScoring(config);
  if (!context.correct) return 0;

  if (config.strategy === "linear-time") {
    const bonus = config.speedBonus *
      Math.max(0, 1 - Math.max(0, context.elapsedSeconds) / config.bonusWindowSeconds);
    return Math.round((config.basePoints + bonus) * 1000) / 1000;
  }

  const first = context.firstCorrectAt;
  const reveal = context.revealAt;
  if (first == null || reveal == null ||
      !Number.isFinite(first) || !Number.isFinite(reveal) ||
      reveal <= first || !Number.isFinite(context.submittedAt)) {
    throw new Error("Invalid first-correct scoring window.");
  }

  const fraction = Math.max(0, Math.min(1,
    (reveal - context.submittedAt) / (reveal - first)
  ));
  return Math.round((config.basePoints + config.speedBonus * fraction) * 1000) / 1000;
}
