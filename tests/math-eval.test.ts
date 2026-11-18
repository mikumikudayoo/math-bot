import {test} from 'node:test';
import assert from 'node:assert/strict';
import {grade, extractFinalNumber, type Check} from '../src/scripts/math-eval-grade.js';
import {CATEGORIES, evaluate, loadProblems, parseCli, selectProblems} from '../src/scripts/math-eval.js';

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
    else if (c.type === 'proof-rubric') {
      assert.ok(c.required.length > 0, p.id);
      for (const r of [...c.required, ...(c.forbidden ?? [])]) assert.doesNotThrow(() => new RegExp(r.pattern, 'i'), `${p.id}: ${r.label}`);
    }
    else assert.fail(`${p.id}: unknown check type`);
  }
  for (const p of problems.filter(p => p.category === 'proof')) assert.ok(['contains-all', 'proof-rubric'].includes(p.check.type), p.id);
  for (const p of problems.filter(p => p.category === 'ambiguous-unsolvable')) assert.equal(p.check.type, 'flags-ambiguity', p.id);
});

const mockEnv = {OPENAI_API_KEY: 'sk-test' + 'x'.repeat(32)};
const simple = {...loadProblems()[0]!, prompt: 'Find the positive solution and explain your reasoning. Three times a number plus seven equals twenty-five.'};
const response = (output: unknown[]) => ({status: 'completed', output, usage: {input_tokens: 120, output_tokens: 30, output_tokens_details: {reasoning_tokens: 11}}});
const reply = (text: string) => response([{type: 'message', content: [{type: 'output_text', text}]}]);

test('live evaluation requires an explicit small cap and key; invalid filters fail before inference', async () => {
  assert.equal(parseCli([]).live, false);
  assert.equal(parseCli(['--max-usd', '0.2']).live, false);
  for (const cap of ['0', '1.1', 'NaN', 'Infinity', '-1']) assert.throws(() => parseCli(['--live', '--max-usd', cap]));
  assert.throws(() => parseCli(['--live']));
  assert.throws(() => parseCli(['--profiles', 'unknown']));
  assert.throws(() => parseCli(['--limit', '1.5']));
  assert.throws(() => selectProblems(parseCli(['--ids', 'no-such-problem'])));
  const params = parseCli(['--max-usd', '0.1', '--profiles', 'luna,tools,luna', '--limit', '2']);
  assert.deepEqual(params.profiles, ['luna', 'tools']);
  assert.equal(selectProblems(params).length, 2);
  const blocked = {create: async () => { throw new Error('unexpected call'); }};
  await assert.rejects(evaluate(params, [simple], mockEnv, new AbortController().signal, blocked), /live evaluation/);
  await assert.rejects(evaluate({...params, live:true}, [simple], {}, new AbortController().signal, blocked), /valid OPENAI_API_KEY/);
});

test('all four eval profiles run through the normal orchestrator and report actual tool use, specialist cost and tokens', async () => {
  const observedTools: string[][] = [];
  const specialistModels: string[] = [];
  const report = await evaluate(parseCli(['--live', '--max-usd', '0.8']), [simple], mockEnv, AbortSignal.timeout(15000), {
    create: async params => {
      const model = String(params.model);
      if (model !== 'gpt-6-luna') { specialistModels.push(model); return reply('Solving the equation gives x = 6.\nFINAL: 6'); }
      const input = params.input as {type?: string}[];
      if (input.some(item => item.type === 'function_call_output')) return reply('answer: 6');
      const offered = (params.tools as {name:string}[] ?? []).map(t => t.name).sort();
      observedTools.push(offered);
      const name = offered.find(t => t.startsWith('consult') || t === 'regex');
      if (!name) return reply('answer: 6');
      const args = name === 'regex' ? {operation:'count', text:'666666', pattern:'6'} : {task:'Solve 3x + 7 = 25.', reason:'check the algebra'};
      return response([{type:'function_call', call_id:'call_test', name, arguments:JSON.stringify(args)}]);
    },
  });
  assert.equal(report.stoppedReason, '');
  assert.deepEqual(observedTools,[[],['consult_terra'],['consult_sol'],['calculate','plot','regex']]);
  assert.deepEqual(specialistModels,['gpt-6.1-terra','gpt-6.2-sol']);
  assert.deepEqual(report.samples.map(x => x.passed),[true,true,true,true]);
  assert.deepEqual(report.summary.map(x => x.actuallyConsulted),[0,1,1,0]);
  assert.deepEqual(report.samples.map(x=>x.calls.length),[1,3,3,2]);
  assert.deepEqual(report.samples[3]!.toolsCompleted,['regex']);
  assert.equal(report.samples[0]!.calls[0]!.reasoning,11);
  assert.equal(report.samples[0]!.calls[0]!.output,30);
  assert.ok(report.samples[2]!.consultUsd > report.samples[1]!.consultUsd);
  assert.ok(!JSON.stringify(report).includes(mockEnv.OPENAI_API_KEY));
});

test('consultation success reflects a usable conclusion independently of token metering', async () => {
  const options = parseCli(['--live', '--max-usd', '0.8', '--profiles', 'luna-terra,luna-sol']);
  const report = await evaluate(options, [simple], mockEnv, AbortSignal.timeout(15000), {
    create: async params => {
      if (params.model === 'gpt-6.1-terra') return reply('I was unable to conclude.');
      if (params.model === 'gpt-6.2-sol') {
        return {status: 'completed', output: reply('FINAL: 6').output};
      }
      const input = params.input as {type?: string}[];
      if (input.some(item => item.type === 'function_call_output')) return reply('answer: 6');
      const [tool] = params.tools as {name: string}[];
      return response([{type: 'function_call', call_id: 'consult', name: tool!.name,
        arguments: JSON.stringify({task: 'Solve the equation.', reason: 'Check the algebra.'})}]);
    },
  });
  assert.equal(report.stoppedReason, '');
  assert.deepEqual(report.samples.map(sample => sample.calls.find(call => call.purpose === 'consult')?.status), ['ok', 'unmetered']);
  assert.deepEqual(report.summary.map(summary => summary.actuallyConsulted), [0, 1]);
  assert.ok(report.summary.every(summary => summary.consultUsd > 0));
});

test('direct reasoning profiles grade number theory when tool support is intentionally disabled', async () => {
  const question = {...simple, prompt:'Compute the remainder when 20 is divided by 7.',check:num(6)};
  const report = await evaluate(parseCli(['--live','--max-usd','0.1','--profiles','luna']),[question],mockEnv,AbortSignal.timeout(5000),{
    create:async () => reply('answer: 6'),
  });
  assert.equal(report.samples[0]!.passed,true);
  assert.equal(report.samples[0]!.calls.length,1);
});

test('a ceiling below the first reservation spends zero and stops the run', async () => {
  let calls = 0;
  const report = await evaluate(parseCli(['--live','--max-usd','0.000001']),[simple],mockEnv,AbortSignal.timeout(6000),{
    create: async () => { calls++; return reply('answer: 6'); },
  });
  assert.equal(calls, 0);
  assert.equal(report.stoppedReason, 'run budget exhausted');
  assert.equal(report.samples.length, 1);
  assert.equal(report.samples[0]!.costUsd, 0);
  assert.equal(report.samples[0]!.passed, false);
});

test('separate jobs share a single live-run cap and interruption stops before another sample', async () => {
  const options = parseCli(['--live','--max-usd','0.02','--profiles','luna,tools']);
  let sent = 0;
  const repeated = Array.from({length: 16}, (_, i) => ({...simple, id:'problem-' + i}));
  const report = await evaluate(options, repeated, mockEnv, AbortSignal.timeout(10000), {
    create: async () => { sent++; return {...reply('answer: 6'), usage:{input_tokens:100,output_tokens:3000}}; },
  });
  assert.equal(report.stoppedReason, 'run budget exhausted');
  assert.ok(sent > 1 && sent < repeated.length * 2);
  assert.equal(report.samples.length, sent + 1);
  assert.ok(report.samples.reduce((total,sample) => total + sample.costUsd,0) <= options.maxUsd);
  const cancelled = await evaluate(options, repeated, mockEnv, AbortSignal.abort(), {
    create: async () => { throw new Error('already cancelled'); },
  });
  assert.equal(cancelled.stoppedReason, 'cancelled');
  assert.equal(cancelled.samples.length, 0);
});
