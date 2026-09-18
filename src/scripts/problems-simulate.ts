import { writeFileSync } from 'node:fs';
import { DEFAULT_RATING, chooseProblem, expected, rate } from '../problems/rating.js';
import { calibrationStep } from '../problems/calibration.js';
let seed = 20260918;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
interface Scenario { name: string; ability: number; assigned: number; actual?: number; count: number; repeat?: boolean; memorized?: boolean; abandonWrong?: boolean }
function simulate(s: Scenario) {
  let rating = 1200, scored = 0, abandoned = 0, correct = 0;
  const trace: number[] = [];
  for (let i = 0; i < s.count; i++) {
    const outcome = s.memorized ? true : random() < expected(s.ability, s.actual ?? s.assigned);
    if (!outcome && s.abandonWrong) { abandoned++; continue; }
    const event = rate(rating, s.assigned, outcome, s.repeat ? Math.floor(i / 31) + 1 : 1);
    rating = event.after; scored++; correct += Number(outcome); trace.push(rating);
  }
  const tail = trace.slice(-Math.min(100, trace.length)), average = tail.reduce((a,b) => a+b,0) / (tail.length || 1);
  return { scenario: s.name, assigned: s.count, scored, abandoned, correct, final: +rating.toFixed(2), tailMean: +average.toFixed(2), tailSd: +Math.sqrt(tail.reduce((sum,v) => sum+(v-average)**2,0)/(tail.length || 1)).toFixed(2) };
}
const scenarios: Scenario[] = [
  { name: 'Equal ability and difficulty', ability: 1200, assigned: 1200, count: 1000 },
  { name: 'Strong player / easy problems', ability: 1800, assigned: 900, count: 1000 },
  { name: 'Weak player / difficult problems', ability: 800, assigned: 1600, count: 1000 },
  { name: 'Repeat bank (31 problems)', ability: 1200, assigned: 1200, count: 1000, repeat: true },
  { name: 'Memorized bank farming', ability: 1200, assigned: 1200, count: 1000, repeat: true, memorized: true },
  { name: 'Initial difficulty overestimated by 400', ability: 1200, assigned: 1600, actual: 1200, count: 1000 },
  { name: 'High solve rate', ability: 1800, assigned: 1200, count: 1000 },
  { name: 'Abandon every incorrect attempt', ability: 1200, assigned: 1200, count: 1000, abandonWrong: true },
  { name: 'Sparse activity: 5 attempts', ability: 1500, assigned: 1200, count: 5 },
  { name: 'Moderate activity: 50 attempts', ability: 1500, assigned: 1200, count: 50 },
  { name: 'Frequent activity: 500 attempts', ability: 1500, assigned: 1200, count: 500 },
];
const results = scenarios.map(simulate);
const problems = Array.from({length: 62}, (_, i) => ({ id: i, difficulty: 800 + i * 15, count: 0 }));
for (let u = 0; u < 97; u++) for (let i = 0; i < 10; i++) chooseProblem(problems, 1200 + (u % 5 - 2) * 100, DEFAULT_RATING.selectionSpread, random)!.count++;
const small = Array.from({length: 5}, (_, i) => simulate({ name: `Small population player ${i + 1}`, ability: 1000 + i*100, assigned: 1200, count: 20 }));
let calibration = { difficulty: 1400, count: 0, provisional: true, uncertainty: 400 };
for (let i = 0; i < 5; i++) calibration = calibrationStep(1400, calibration.difficulty, calibration.count, 1600, random() < expected(1600, 1400), 1);
const metrics = { seed: 20260918, results, smallPopulation: small, assignment: { population: 97, assignments: 970, problems: 62, min: Math.min(...problems.map(p=>p.count)), max: Math.max(...problems.map(p=>p.count)), untouched: problems.filter(p=>!p.count).length }, sparseCalibration: calibration,
  surprises: { strongWrong: rate(1800, 1000, false, 1).delta, weakCorrect: rate(800, 1600, true, 1).delta } };
const report = `# Experimental rating simulations\n\nDeterministic synthetic run, seed ${metrics.seed}. Reproduce with \`bun run problems:simulate\`. No member data, Discord calls or production database access.\n\n| Scenario | Assignments | Scored | Abandoned | Final rating | Last-100 mean | Last-100 SD |\n|---|---:|---:|---:|---:|---:|---:|\n`+
  results.map(r=>`| ${r.scenario} | ${r.assigned} | ${r.scored} | ${r.abandoned} | ${r.final} | ${r.tailMean} | ${r.tailSd} |`).join('\n')+
  `\n\n## Findings and limits\n\n- Memorized answers continue to earn positive rating at the permanent quarter weight. The 30-other-assignment cooldown delays farming; it does not eliminate it. A 31-problem bank is a minimum for continuous rotation, not enough to establish rating validity.\n- Zero-penalty abandonment permits selective-answer inflation. Three abandoned attempts per rolling day and a daily assignment cap slow this but cannot remove the incentive. The abandonment scenario shows long-run exposure with no daily time model, not a claim that 1,000 immediate assignments are allowed.\n- Inaccurate fixed difficulty shifts player estimates. Automatic calibration is disabled; provisional estimates and small samples must not be presented as measured skill.\n- Speed never appears in scoring. Surprising strong-player wrong delta: ${metrics.surprises.strongWrong.toFixed(2)}; weak-player correct delta: ${metrics.surprises.weakCorrect.toFixed(2)}.\n- In 970 synthetic selections across 97 players and 62 problems, per-problem selections ranged ${metrics.assignment.min}–${metrics.assignment.max}; ${metrics.assignment.untouched} were untouched. Difficulty matching deliberately produces unequal exposure. This exercise measures the weighted selector, not full cooldown enforcement (covered by transactional tests).\n- Five first encounters left candidate difficulty ${calibration.difficulty.toFixed(2)}, uncertainty proxy ${calibration.uncertainty.toFixed(2)}, provisional=${calibration.provisional}. That proxy is a heuristic, not a calibrated confidence interval. Candidate updates are bounded to ±100 from the moderator estimate and can retain substantial initial bias.\n- Five-player/sparse-population runs and varied activity are in the accompanying JSON. Low-activity ratings remain noisy; high activity is not evidence of higher ability.\n- These simulations test behavior under specified assumptions. They do not demonstrate empirical validity for a server of approximately 97 members. Private questions can still be shared, and source manuals may already be public.\n\n## Review decisions\n\nKeep rated practice disabled until the owner reviews farming, abandonment incentives, pool size, source rights and grading. Public rated leaderboards and automatic calibration remain disabled in code. Review K=32, repeat weights [1,0.5,0.25], 30-other cooldown, 20 assignments/day and 3 abandoned/day before any manual enablement.\n`;
writeFileSync('docs/problem-rating-simulations.md', report);
writeFileSync('docs/problem-rating-simulations.json', JSON.stringify(metrics, null, 2) + '\n');
console.log(report);
