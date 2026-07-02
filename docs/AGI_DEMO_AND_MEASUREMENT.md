# Andrea AGI Demo and Measurement

Andrea's edge proof is a repeatable scorecard plus a short demo script. The
scorecard measures bounded assistant readiness across reasoning, planning,
tool use, memory, grounding, safety, robustness, provider routing, and task
completion. It is deliberately not a claim of general intelligence.

## Commands

- `npm run agi:scorecard` runs the deterministic CI-safe scorecard and writes
  `scorecard.json` plus `scorecard.md` under `~/.andrea/evals/<run-id>/`.
- `npm run agi:scorecard -- --fail-on-any-failure` uses the same
  deterministic harness but exits nonzero for any measured weakness, not just
  safety regressions or a low overall score.
- `npm run agi:scorecard:live` uses the same scorecard wrapper in live mode.
  Use this after provider and Telegram credentials are configured.
- `npm run agi:readiness -- --json --no-live-probe` merges scorecard,
  doctor checks, integration status, live-proof debt, and publish blockers into
  one operator-facing launch report without making live provider calls.
- `npm run agi:readiness -- --write --no-live-probe` writes
  `readiness.json` plus `readiness.md` under `~/.andrea/evals/<run-id>/`.
- `npm run agi:demo` generates an operator demo packet with exact CLI prompts,
  Telegram canary prompts, deterministic replay output, live-readiness notes,
  scorecard highlights, readiness highlights, and the latest scorecard snapshot.

## Demo Flow

1. Run `npm run agi:doctor` and fix missing required local state.
2. Run `npm run agi:scorecard`.
3. Run `npm run agi:readiness -- --write --no-live-probe`.
4. Run `npm run agi:demo`.
5. Open the generated demo packet and readiness report in `~/.andrea/evals/`.
6. If Telegram is configured, send the packet's canary prompts to the bot with
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
availability.
