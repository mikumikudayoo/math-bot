# math evaluation

run from the repository root with the pinned bun runtime. the corpus contains 39 text problems in eight categories. the grader checks final values, equivalent strings, expected proof terms and recognition of insufficient information.

```sh
bun run eval:math -- --limit 2
bun run check:v2-tests
bun test tests/math-eval.test.ts
```

a dry run lists the selected problems and available tools. it does not open the ledger, instantiate a model client or make requests.

## comparison profiles

| profile | available to luna |
| --- | --- |
| `luna` | direct answer at default low effort |
| `luna-terra` | optional terra consultation |
| `luna-sol` | optional sol consultation |
| `tools` | calculator, plot and regex |

each problem runs under each selected profile before moving to the next problem. each sample enters the production `runner` as a separate synthetic ask job. the evaluator injects an empty competition state and never connects to discord or a production database. seven-agent mode and external tools are disabled for comparable conditions. any production deterministic shortcut still applies and may result in zero calls. the calculator and plot profiles need the project's python math dependencies when luna selects those tools. set `PYTHON_EXECUTABLE` to the appropriate interpreter.

## live evaluation

```sh
bun run eval:math -- --live --max-usd 0.30 --ids aa-linear-equation --profiles luna,luna-sol
```

provide an evaluation project's `OPENAI_API_KEY` in the execution environment. the runner requires both `--live` and an explicit estimated spending ceiling between $0.000001 and $1. the ceiling applies to the entire invocation and all profiles together, including retries. the production runtime reserves the estimated worst-case charge for each attempt before sending it. an unresolved billable attempt retains its reservation. production request ceilings still apply to each synthetic job. the isolated ledger resets on each invocation, so repeated invocations have separate ceilings.

`--ids a,b` selects known problem ids. `--limit k` takes the first k selected problems in corpus order. `--profiles luna,luna-terra,luna-sol,tools` selects profiles in comparison order. ctrl-c cancels outstanding work and saves completed records and the interrupted sample. a run-wide budget denial, interruption or provider configuration error stops the comparison and sets a nonzero exit status.

## reading the results

live runs write timestamped json in `evals/math/results/`, which is git-ignored. the report identifies the corpus hash, profile order, selected problems and any early termination. each row records the final answer, grader explanation, worker latency from invocation to result, completed tools and individual model attempts with effort, purpose, billed-token counters, status and estimated microdollars. both cache-write durations and cached input are reported separately within input. reasoning is included in output. queue wait and discord delivery are outside the benchmark. the totals use the ledger estimates.

the summary gives attempted and passed counts, accuracy, errors, mean latency, total estimated cost, cost of specialist calls, and the number of samples with an actual successful consultation. an available specialist can go unused. inspect the sample ledger to distinguish that from a paid second opinion. compare the same problem ids when a cap cuts a run short. proof keyword grades require human review of the saved argument, and one stochastic run gives limited evidence about differences between models.

the corpus's historical `expectedTier` label describes its old routing target. aleph v2 starts every profile with luna.

## corpus and grader

each record in `problems.json` has `id`, `category`, `difficulty`, `prompt`, the historical `expectedTier` label and a `check` object. use unique, stable ids when adding problems and verify the expected result independently.

| check | passing condition |
| --- | --- |
| `numeric` | the extracted value is within `tolerance × max(1, abs(answer))`. the default tolerance is `1e-9`. the grader prefers a boxed result, then a final-answer line, then the last numerical line. it recognizes fractions, decimals, signs and thousands separators. |
| `exact` | the normalized final-answer line, or the answer after its final label/relation, matches one of the supplied `answers`. case, spacing, unicode minus and trailing punctuation are normalized. |
| `contains-all` | all required `terms` occur. within one term `a|b` accepts either alternative. this checks the presence of expected proof steps. |
| `flags-ambiguity` | at least one supplied ambiguity or impossibility phrase occurs in the answer. |

read `gradeDetail` to audit which number, string or terms determined the verdict. sentences with several numerical results can have misleading final lines. the test suite includes a documented counterexample.
