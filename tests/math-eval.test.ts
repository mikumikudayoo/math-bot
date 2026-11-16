import {test} from 'node:test';
import assert from 'node:assert/strict';
import {grade, extractFinalNumber, type Check} from '../src/scripts/math-eval-grade.js';
import {CATEGORIES, dryRun, loadProblems, parseCli, LIVE_MAX_USD_CAP} from '../src/scripts/math-eval.js';

const num = (answer: number, tolerance?: number): Check => ({type: 'numeric', answer, ...(tolerance !== undefined ? {tolerance} : {})});

test('numeric grader accepts correct answers and rejects wrong ones', () => {
  assert.equal(grade(num(385), 'adding the squares gives 385.').pass, true);
  assert.equal(grade(num(385), 'adding the squares gives 384.').pass, false);
  assert.equal(grade(num(6), 'squaring: x + 3 = x^2 - 6x + 9\nso x = 1 or x = 6, and x = 1 is extraneous\nAnswer: 6 (x = 1 is extraneous)').pass, true);
  assert.equal(grade(num(14), '').pass, false);
  assert.equal(grade(num(14), 'no idea, sorry').pass, false);
});

test('numeric grader parses comma, fraction, LaTeX, negative, decimal and x = forms', () => {
  assert.equal(grade(num(34650), '11!/(4!4!2!)\n**Final answer:** 34,650').pass, true);
  assert.equal(grade(num(1000), 'answer: 1,000 ways').pass, true);
  assert.equal(grade(num(0.75), 'Final answer: 3/4').pass, true);
  assert.equal(grade(num(11 / 12), 'the sum is \\frac{11}{12}').pass, true);
  assert.equal(grade(num(11 / 30), 'P = 44/120 = \\boxed{\\dfrac{11}{30}}').pass, true);
  assert.equal(grade(num(-0.75), 'answer: -\\frac{3}{4}').pass, true);
  assert.equal(grade(num(-5), 'so x = −5').pass, true, 'unicode minus');
  assert.equal(grade(num(5), 'so x = −5').pass, false);
  assert.equal(grade(num(1.5), 'the limit is about 1.5').pass, true);
  assert.equal(grade(num(3), 'f(x) = x + 1 works, so\nf(2) = 3').pass, true);
  assert.equal(grade(num(2), 'Answer: 2^{100} mod 7 is 2').pass, true, 'exponents are not answers');
  assert.equal(grade(num(3), 'Answer: p = 3, since 3² + 2 = 11 is prime and p² + 2 ≡ 0 (mod 3) otherwise\n').pass, false,
    'documents the limitation: the last relation on the answer line wins');
  assert.equal(grade(num(3), 'Answer: p = 3 (3² + 2 = 11 is prime)').pass, true, 'parenthetical asides are ignored');
  assert.equal(grade(num(Math.PI, 1e-5), 'answer: 3.14159').pass, true);
  assert.equal(grade(num(Math.PI), 'answer: 3.14159').pass, false, 'default tolerance is tight');
  assert.equal(extractFinalNumber('2^{100} mod 7')?.value, 7);
});

test('exact grader normalizes whitespace, case, unicode minus and trailing period', () => {
  const check: Check = {type: 'exact', answers: ['(x-3)(x+3)', '(x+3)(x-3)']};
  assert.equal(grade(check, 'difference of squares:\n(x − 3)(x + 3).').pass, true);
  assert.equal(grade(check, 'x^2 - 9 = (X+3)(X-3)').pass, true);
  assert.equal(grade(check, 'Final answer: **(x - 3)(x + 3)**').pass, true);
  assert.equal(grade(check, 'Answer: (x-9)(x+1)').pass, false);
});

test('contains-all grader requires every key proof step', () => {
  const check: Check = {type: 'contains-all', terms: ['even', 'contradiction|impossible', 'lowest terms|coprime']};
  const good = 'Suppose √2 = p/q in lowest terms. Then p² = 2q², so p is even; then q is even too. Contradiction.';
  assert.equal(grade(check, good).pass, true);
  const missing = 'Suppose √2 = p/q in lowest terms. Then p² = 2q², so p is even and q is even.';
  const verdict = grade(check, missing);
  assert.equal(verdict.pass, false);
  assert.match(verdict.detail, /contradiction/);
  assert.equal(grade({type: 'contains-all', terms: ['even']}, 'seven eleven').pass, false, 'terms match at word starts');
  assert.equal(grade({type: 'contains-all', terms: ['(k+1)^2']}, 'so the sum is (k + 1)²').pass, true, 'superscripts and spacing');
  assert.equal(grade({type: 'contains-all', terms: ['+1']}, 'consider N = p1 p2 ... pn + 1').pass, true);
  assert.equal(grade({type: 'contains-all', terms: ['+1']}, 'consider N = p1 p2 ... pn + 10').pass, false);
});

test('flags-ambiguity grader detects underspecified answers', () => {
  const check: Check = {type: 'flags-ambiguity', terms: ['cannot be determined', 'not enough', 'ambiguous']};
  assert.equal(grade(check, 'The area cannot be determined without the included angle.').pass, true);
  assert.equal(grade(check, "there's NOT ENOUGH information here").pass, true);
  assert.equal(grade(check, 'The area is 17.5.').pass, false);
  assert.equal(grade({type: 'flags-ambiguity', terms: ["can't be determined"]}, 'it can’t be determined').pass, true, 'curly apostrophe');
});

test('problems.json schema', () => {
  const problems = loadProblems();
  assert.ok(problems.length >= 32 && problems.length <= 40, `32-40 problems, got ${problems.length}`);
  assert.equal(new Set(problems.map(p => p.id)).size, problems.length, 'unique ids');
  for (const category of CATEGORIES)
    assert.ok(problems.filter(p => p.category === category).length >= 3, `category ${category} has at least 3 problems`);
  for (const p of problems) {
    assert.ok(['routine', 'advanced', 'olympiad'].includes(p.difficulty), p.id);
    assert.ok(p.expectedTier === 'light' || p.expectedTier === 'advanced', p.id);
    assert.ok(p.prompt.trim().length > 0, p.id);
    const c = p.check;
    if (c.type === 'numeric') assert.ok(Number.isFinite(c.answer), `${p.id} numeric answer is finite`);
    else if (c.type === 'exact') assert.ok(c.answers.length > 0, p.id);
    else if (c.type === 'contains-all' || c.type === 'flags-ambiguity') assert.ok(c.terms.length > 0, p.id);
    else assert.fail(`${p.id}: unknown check type`);
  }
  for (const p of problems.filter(p => p.category === 'proof')) assert.equal(p.check.type, 'contains-all', p.id);
  for (const p of problems.filter(p => p.category === 'ambiguous-unsolvable')) assert.equal(p.check.type, 'flags-ambiguity', p.id);
});

test('dry run routes without network and agrees with expected tiers at least 80% of the time', () => {
  const report = dryRun(loadProblems(), {});
  assert.equal(report.total, report.rows.length);
  for (const row of report.rows) assert.ok(Number.isFinite(row.worstCaseUsd) && row.worstCaseUsd > 0, row.id);
  const mismatches = report.rows.filter(r => !r.agrees).map(r => `${r.id}: ${r.expectedTier}->${r.routedTier}`);
  assert.ok(report.agreement >= 0.8, `routing agreement ${(report.agreement * 100).toFixed(1)}%: ${mismatches.join(', ')}`);
});

test('live mode is refused unless every precondition holds', () => {
  const key = {OPENAI_API_KEY: 'sk-test' + 'y'.repeat(30)};
  assert.deepEqual(parseCli([], {}), {mode: 'dry', ignored: []});
  assert.equal((parseCli(['--max-usd', '1'], key) as {mode: string}).mode, 'dry', 'no --live means dry run');
  assert.ok('error' in parseCli(['--live'], key), 'missing --max-usd');
  assert.ok('error' in parseCli(['--live', '--max-usd', String(LIVE_MAX_USD_CAP + 1)], key), 'over the cap');
  assert.ok('error' in parseCli(['--live', '--max-usd', '0'], key));
  assert.ok('error' in parseCli(['--live', '--max-usd', '1'], {}), 'missing key');
  assert.ok('error' in parseCli(['--live', '--max-usd', '1', '--tier', 'max'], key));
  const ok = parseCli(['--live', '--max-usd=2', '--limit', '3', '--ids', 'a,b', '--tier', 'light'], key);
  assert.deepEqual(ok, {mode: 'live', maxUsd: 2, tier: 'light', limit: 3, ids: ['a', 'b']});
  assert.ok(!JSON.stringify(ok).includes(key.OPENAI_API_KEY), 'the key never appears in parsed options');
});
