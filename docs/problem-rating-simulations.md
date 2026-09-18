# Experimental rating simulations

Deterministic synthetic run, seed 20260918. Reproduce with `bun run problems:simulate`. No member data, Discord calls or production database access.

| Scenario | Assignments | Scored | Abandoned | Final rating | Last-100 mean | Last-100 SD |
|---|---:|---:|---:|---:|---:|---:|
| Equal ability and difficulty | 1000 | 1000 | 0 | 1180.91 | 1199.72 | 24.91 |
| Strong player / easy problems | 1000 | 1000 | 0 | 1727.67 | 1713.52 | 8.48 |
| Weak player / difficult problems | 1000 | 1000 | 0 | 820.96 | 839.98 | 11.51 |
| Repeat bank (31 problems) | 1000 | 1000 | 0 | 1232.61 | 1230.02 | 8.16 |
| Memorized bank farming | 1000 | 1000 | 0 | 1876.19 | 1868.02 | 4.84 |
| Initial difficulty overestimated by 400 | 1000 | 1000 | 0 | 1546.88 | 1523.41 | 54.08 |
| High solve rate | 1000 | 1000 | 0 | 1866.85 | 1871.93 | 10.73 |
| Abandon every incorrect attempt | 1000 | 499 | 501 | 1979.34 | 1960.35 | 11.48 |
| Sparse activity: 5 attempts | 5 | 5 | 0 | 1213.32 | 1214.32 | 10.81 |
| Moderate activity: 50 attempts | 50 | 50 | 0 | 1425.83 | 1355.57 | 64.83 |
| Frequent activity: 500 attempts | 500 | 500 | 0 | 1552.89 | 1548.02 | 21.99 |

## Findings and limits

- Memorized answers continue to earn positive rating at the permanent quarter weight. The 30-other-assignment cooldown delays farming; it does not eliminate it. A 31-problem bank is a minimum for continuous rotation, not enough to establish rating validity.
- Zero-penalty abandonment permits selective-answer inflation. Three abandoned attempts per rolling day and a daily assignment cap slow this but cannot remove the incentive. The abandonment scenario shows long-run exposure with no daily time model, not a claim that 1,000 immediate assignments are allowed.
- Inaccurate fixed difficulty shifts player estimates. Automatic calibration is disabled; provisional estimates and small samples must not be presented as measured skill.
- Speed never appears in scoring. Surprising strong-player wrong delta: -31.68; weak-player correct delta: 31.68.
- In 970 synthetic selections across 97 players and 62 problems, per-problem selections ranged 3–29; 0 were untouched. Difficulty matching deliberately produces unequal exposure. This exercise measures the weighted selector, not full cooldown enforcement (covered by transactional tests).
- Five first encounters left candidate difficulty 1390.55, uncertainty proxy 163.30, provisional=true. That proxy is a heuristic, not a calibrated confidence interval. Candidate updates are bounded to ±100 from the moderator estimate and can retain substantial initial bias.
- Five-player/sparse-population runs and varied activity are in the accompanying JSON. Low-activity ratings remain noisy; high activity is not evidence of higher ability.
- These simulations test behavior under specified assumptions. They do not demonstrate empirical validity for a server of approximately 97 members. Private questions can still be shared, and source manuals may already be public.

## Review decisions

Keep rated practice disabled until the owner reviews farming, abandonment incentives, pool size, source rights and grading. Public rated leaderboards and automatic calibration remain disabled in code. Review K=32, repeat weights [1,0.5,0.25], 30-other cooldown, 20 assignments/day and 3 abandoned/day before any manual enablement.
