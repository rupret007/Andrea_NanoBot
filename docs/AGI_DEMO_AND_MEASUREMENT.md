# Andrea AGI Demo and Measurement

Andrea's edge proof is a repeatable scorecard plus a short demo script. The
scorecard measures bounded assistant readiness across reasoning, planning,
tool use, memory, grounding, safety, robustness, provider routing, and task
completion. It is deliberately not a claim of general intelligence.

Route-only synthetic fixtures measure route selection, not answer usefulness
or task completion. Those outcomes are scored only by the separate isolated,
network-denied executed-capability suite. A 100% deterministic result therefore
means the bounded offline contracts are saturated; it does not replace genuine
reviewed outcomes, fresh integration proof, or an explicitly authorized live
evaluation with an estimated-cost threshold.

Synthetic execution-evidence scenarios likewise prove only the aggregate
runtime action/state evidence and reconciliation contract. They do not prove
that a live tool created a named artifact or satisfied a semantic
postcondition. Repository-write completion requires a successful verification
observed after the final write, and aggregate external-action evidence remains
blocked until a dedicated receipt binds the exact approved action.
Terminal runtime errors remain blocking even if individual receipts claim
success. Suppressed stale-session attempts remain in the retry evidence, and
operator work remains blocked on `runtime_operator_scope_unbound` until its
exact target, action, and postcondition are bound.

The held-out command adds a stronger but still local proof: in a disposable Git
repository it triggers a real write failure, recovers with a real edit, observes
the state transition, and runs a post-write syntax test. The packet correctly
remains blocked on `runtime_repository_scope_unbound`; the proof does not cover
the production container, mount, IPC path, or host-enforced target binding.
The held-out acceptance result is 6/6 execution-truth cases plus this expected
scope-blocked disposable result, with no production-state touch.

## Commands

- `npm run agi:scorecard` runs the deterministic CI-safe scorecard and writes
  `scorecard.json` plus `scorecard.md` under `~/.andrea/evals/<run-id>/`.
- `npm run agi:scorecard -- --fail-on-any-failure` uses the same
  deterministic harness but exits nonzero for any measured weakness, not just
  safety regressions or a low overall score.
- `npm run agi:scorecard:live -- --max-cost-usd=1` uses the same scorecard
  wrapper in live mode. Live mode fails closed unless an explicit positive cost
  threshold is supplied for the harness estimate. It is not reconciled provider
  billing. Use it only after provider and Telegram credentials are configured
  and the run is approved.
- `npm run agi:readiness -- --json --no-live-probe` merges scorecard,
  doctor checks, integration status, live-proof debt, and publish blockers into
  one operator-facing launch report without making live provider calls.
- `npm run agi:readiness -- --write --no-live-probe` writes
  `readiness.json` plus `readiness.md` under `~/.andrea/evals/<run-id>/`.
- `npm run agi:demo` generates an operator demo packet with exact CLI prompts,
  Telegram canary prompts, deterministic replay output, live-readiness notes,
  scorecard highlights, readiness highlights, and the latest scorecard snapshot.
- `npm run debug:assistant-intelligence` reports outcome metrics, routine
  promotion/canary state, redacted feedback fixtures, and the top next
  improvement without exposing conversation text.

## Demo Flow

1. Run `npm run agi:doctor` and fix missing required local state.
2. Run `npm run agi:scorecard`.
3. Run `npm run agi:readiness -- --write --no-live-probe`.
4. Run `npm run agi:demo`.
5. Run `npm run debug:assistant-intelligence`.
6. Open the generated demo packet and readiness report in `~/.andrea/evals/`.
7. If Telegram is configured, send the packet's canary prompts to the bot with
   `ANDREA_USE_AGI=1`.

## What To Show

- Direct reasoning: a concise next action for a packed evening.
- Multi-step planning: a staged Telegram AGI rollout plan.
- Memory-backed answer: answer only from known or newly stated memory.
- Read-tool posture: explain read-only checks before inspection.
- Confirmation gate: external sends and calendar writes become pending actions.
- Prompt-injection resistance: malicious instructions are quarantined.
- Provider fallback: Andrea explains degraded mode instead of bluffing.
- Post-run proof: show the scorecard dimensions, merge-blocking regressions,
  measured weaknesses, live-readiness blockers, and recommendations.

## Interpreting The Score

The overall score is the average of measured dimensions, not a universal IQ
number. A high score means the current bounded assistant scenarios are passing
with good safety and operational posture. Failures should be treated as the next
engineering backlog, with safety failures taking priority over capability
failures.

Live runs are evidence, not merge gates. Deterministic local scorecards are the
CI gate because they are stable, cost-free, and do not depend on external model
availability. Deterministic execution rejects non-loopback network requests and
uses injected synthetic platform responses instead of configured providers. It
also forces production-style database initialization into isolated in-memory
storage, so synthetic evaluation, repair, council, and reliability evidence
cannot alter Andrea's live self-assessment.
