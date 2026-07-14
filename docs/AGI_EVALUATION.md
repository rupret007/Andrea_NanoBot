# Intelligence Evaluation Boundaries

Andrea's evaluation stack measures specific, testable behavior. It does not
measure or establish AGI. This document explains what each evidence class can
support so that deterministic fixtures, live provider calls, and real owner
reviews are not presented as interchangeable proof.

The authoritative release commands and current command inventory live in
[TESTING_AND_RELEASE_RUNBOOK.md](TESTING_AND_RELEASE_RUNBOOK.md). Outcome and
review semantics live in
[OUTCOME_TRACKING_AND_REVIEWS.md](OUTCOME_TRACKING_AND_REVIEWS.md).

## Evidence Classes

| Evidence class                     | What it uses                                                                                                        | What it can prove                                                                                          | What it cannot prove                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Deterministic repository checks    | Isolated storage, fixed fixtures, injected fakes, provider-environment suppression, and non-loopback network denial | Code paths, invariants, failure handling, reproducibility, and regression behavior covered by the fixtures | Live provider quality, channel delivery, current credentials, real-world latency, or owner usefulness |
| External-benchmark adapter dry run | Four local GAIA-, BFCL-, SWE-lite-, and tau-style proxy scenarios                                                   | Command shape and scoring/reporting plumbing                                                               | Performance on the named external benchmarks                                                          |
| Opt-in live evaluation             | Configured providers, explicit live flags, and a positive estimated-cost budget                                     | Provider/model behavior observed during that specific run, with recorded provenance                        | General production health, future provider behavior, or a provider-enforced billing ceiling           |
| Genuine owner review               | A distinct real interaction and an explicit owner verdict or correction                                             | Whether Andrea helped in the reviewed situation and what should become a regression fixture                | Broad capability from one anecdote or synthetic evidence                                              |

Synthetic fixtures, proof drills, telemetry-only records, and repeated reviews
of one outcome must not be counted as genuine owner outcomes.

## Deterministic And Offline Evaluation

The normal AGI-oriented repository gates are offline and zero-cost:

```bash
npm run typecheck:agi
npm run test:agi
npm run test:strategy-evals
npm run test:agi-gauntlet
npm run test:deterministic:sweep
npm run agi:scorecard -- --no-write --no-dogfood
```

Their scopes are deliberately different:

- `test:agi` runs the AGI module test project under the process network guard.
- `test:strategy-evals` exercises a fixed synthetic strategy-routing suite and
  verifies scoring, safety criteria, and persistence in an initialized test
  database. It does not compare the current branch with `main` automatically.
- `test:agi-gauntlet` exercises fixed synthetic whole-assistant scenarios and
  safety anchors. It is deterministic, not a live or billable model contest.
- `test:deterministic:sweep` checks the repository's current deterministic
  command inventory. Its count changes as scripts change, so the runbook and
  command output are the source of truth.
- `agi:scorecard -- --no-write --no-dogfood` aggregates offline evidence
  without saving a baseline or using real dogfood outcomes.

A passing fixture proves only the behavior asserted by that fixture. Exact
release gates and hosted exact-SHA checks are defined in the runbook rather
than duplicated here.

## External Benchmark Adapter

These commands currently run local proxy scenarios:

```bash
npm run agi:bench:external
npm run agi:bench:gaia
npm run agi:bench:bfcl
npm run agi:bench:swe-lite
npm run agi:bench:tau
```

The dry-run scores in `src/andrea-bench.ts` are fixture values used to verify
the adapter and report format. They are not MMLU, GPQA, HumanEval, GAIA, BFCL,
SWE-bench, tau-bench, ToolBench, or long-context benchmark results.

The adapter accepts `--live` only after evaluation policy validates an
explicit positive `--max-cost-usd` value, but live benchmark execution is not
wired in the current implementation. A live-mode adapter result therefore
must not be cited as live benchmark evidence.

## Opt-In Live Evaluation

Provider-backed scorecards, council proofs, or future benchmark runs are
operator actions, not ordinary CI. They require:

- explicit authorization and a live flag;
- configured credentials and a positive estimated-cost budget;
- provider, model, latency, tool outcome, evidence, and cost metadata; and
- honest classification of timeout, substitution, fallback, or degradation.

The repository budget check compares reported or reserved cost estimates with
the requested ceiling. It is not a provider-side billing control. The operator
must still use a conservative limit and inspect provider billing separately.

Live evidence complements deterministic evidence; it does not replace the
offline release gates. A live proof applies only to the provider, model,
configuration, and time observed in that run.

## Owner Reviews And Baselines

Andrea records real feedback through its canonical response-feedback and
assistant-metric ledgers. Useful evidence includes Helpful/Not helpful
verdicts, corrections, accepted recommendations, verified completion,
delivery latency, citations, and tool outcomes.

The first assistant-metric baseline becomes eligible for owner review only
after five distinct genuine owner-reviewed outcomes. Reaching the threshold
does not save or promote a baseline automatically. Council output does not
grade owner preference, and no replay system automatically decides that a new
answer is "as good or better" or blocks a merge.

When a real answer is corrected, create or update a redacted regression
fixture that preserves the failure shape without copying unnecessary personal
content. Validate the remediation with the narrow fixture and the relevant
release gates.

## Interpreting Results

Introduced failures in a required gate block the affected release. A score by
itself is not a promotion decision: inspect the scenario evidence, provenance,
failure classification, and relevant owner verdict.

The current evaluation stack does not by itself measure:

- usefulness of memory over months;
- live internet or channel behavior when the run is offline;
- provider availability outside the observed run;
- aesthetic and tone preference without owner feedback; or
- general intelligence beyond the covered scenarios.

If measured results and experience disagree, capture the concrete interaction,
obtain an owner verdict, reproduce the failure safely, and add regression
coverage. Do not discard either the measurement or the observed problem.
