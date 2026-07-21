# Grounded Cognitive Executive

See also: [GROUNDED_MEMORY_GOAL_CONTINUITY.md](GROUNDED_MEMORY_GOAL_CONTINUITY.md)
— the durable memory and goal-continuity layer that feeds this loop's
shadow turns with evidence-backed context across restarts.

A closed cognitive loop that turns observations and goals into
evidence-backed beliefs, inspectable plans, verified outcomes, and
reviewable learning records. It composes the pure primitives in
[`src/adaptive-cognition-engine.ts`](../src/adaptive-cognition-engine.ts)
rather than replacing any existing subsystem.

## The loop

```
Observation / Evidence
      │  observeGroundedEvidence (staleness refresh + belief reconciliation)
      ▼
Belief Update ──────────── belief journal: every tier/confidence change
      │                    gets a one-sentence explanation and cause
      ▼
Hypothesis / Plan ──────── AdaptivePlanGraph: preconditions, expected
      │                    observations, verifiers, dependencies, risk,
      │                    fallbacks, stop conditions
      ▼
Precondition & Risk Check
      │  decideGroundedNextStep → act | research | ask | defer | stop_safely
      ▼
Proposed Tool / Action ─── proposal only; execution authority stays with
      │                    the existing approval layer
      ▼
Outcome Verification ───── applyGroundedOutcome → verified | failed |
      │                    partial | blocked | uncertain
      ▼
Learning / Calibration ─── durable journals, calibration samples, and
                           proposed learning records
```

## Modules

| File                                        | Role                                                                       |
| ------------------------------------------- | -------------------------------------------------------------------------- |
| `src/grounded-cognitive-executive.ts`       | Pure, deterministic loop composed from adaptive-cognition-engine           |
| `src/grounded-executive-durable-adapter.ts` | Persistence: journals, learning lifecycle, tool-reliability bridge         |
| `src/turn-agent-harness.ts` (hooks)         | Observe-only shadow state per live turn                                    |
| `src/grounded-executive-eval.ts`            | Deterministic 12-scenario evaluation harness                               |
| `scripts/test-grounded-executive.ts`        | Runner: eval + durable round-trip (`npm run test:grounded-executive`)      |

## Epistemic tiers

`groundedBeliefTier` derives an operator-facing tier from the engine's
belief state — it is a read-only view, not a fifth belief entity:

- **unknown** — no meaningful state (`unknown`/`superseded`).
- **uncertain** — hypothesis, contradicted, or stale. Contradicting
  evidence stays attached to the belief; nothing is silently overwritten.
- **likely** — supported by fresh admissible evidence, confidence < 0.85.
- **verified** — supported, confidence ≥ 0.85, with at least one fresh
  admissible (observed or user-attested, accepted/verified) evidence item.

Inferred, simulated, or model-generated evidence can never produce
`verified`, no matter its confidence — unverified inference is never
promoted to fact. Evidence records carry `disproofConditions` (what would
change Andrea's mind) and `staleAfterMs` (when the evidence stops counting
as current truth).

## Decisions

`decideGroundedNextStep` scores bounded candidates through the engine's
`selectAdaptiveNextAction`, then applies grounding gates:

- unresolved contradictions → never act; research first.
- unmet parsed preconditions (`precond:<subject>/<predicate>/<value>`,
  satisfied only by a belief at `likely` or better) → research.
- blocked tool health → never act.
- steps with external effects below the mutation confidence bar (0.75
  default) → ask.
- approval-required steps → defer to the approval layer.
- blocking ambiguity → ask one concrete question.
- exhausted budget or stop condition → stop safely.

Every decision records `whatWouldChangeMind`, candidate scores, and an
`authorityNote` stating that approval boundaries live elsewhere.

## Outcome verification

`applyGroundedOutcome` compares the observation against the step's
expected outcome. A technically successful tool call with no admissible
evidence for the step's goal criteria is **uncertain**, not verified —
tool success is never goal success. Failures produce a causal explanation
and, when a pre-authorized fallback exists, a bounded replan. Each
verified/failed outcome emits a calibration sample (predicted confidence
vs actual outcome, Brier/ECE via `computeAdaptiveCalibration`).

## Learning boundary

Learning records (`missing_evidence`, `wrong_assumption`,
`tool_reliability`, `plan_pattern`, `calibration`) follow a reviewable
lifecycle: **proposed → accepted → retired**. Only accepted records flow
back into planning, and `applyGroundedLearningToPlanning` may adjust only
planning estimates (success probability, tool health, information gain) —
approval requirements and action identity pass through untouched.

Per [`docs/SECURITY.md`](SECURITY.md) §7, learning changes *planning
truth, never action authority*:

- `grounded_learning_records.applies_to_authority` is pinned to `0` by a
  schema `CHECK` constraint; the insert path hardcodes it.
- The pure module never imports the autonomy governor, outbound pause,
  or delivery authorization surfaces.
- The turn hooks are observe-only: wrapped in try/catch, disabled by
  `GROUNDED_EXECUTIVE_ENABLED=false`, and incapable of changing routing,
  gating, delivery, or approval results.
- Retiring a record (`retireGroundedLearningRecord`) is the reversal
  path; retired records stay visible for audit.

## Durable state

Four tables in `store/messages.db` (schema in `src/db.ts`):

| Table                         | Purpose                                     | Mutability                        |
| ----------------------------- | ------------------------------------------- | --------------------------------- |
| `grounded_learning_records`   | Reviewable lessons                          | status transitions only, guarded  |
| `grounded_belief_journal`     | Why each belief changed                     | append-only                       |
| `grounded_decision_journal`   | Why each decision was chosen                | append-only                       |
| `grounded_calibration_samples`| Predicted confidence vs verified outcome    | append-only (corrections add new) |

All rows are bounded, redacted metadata (`redactStoredCognitiveMetadata`);
no raw message content is stored.

## Operator diagnostics

- `explainGroundedBelief(state, beliefId)` — why Andrea believes this:
  tier, supporting and contradicting evidence with class/source/freshness,
  what would change its mind, and the belief's change history.
- `explainGroundedDecision(state, decisionId)` — why it chose this:
  reason, candidate scores, authority note.
- `formatGroundedDiagnostics(groundedExecutiveDiagnostics(state))` — full
  text report (beliefs by tier, contradictions, decisions, verifications,
  calibration).
- `groundedDurableDiagnostics()` — what has been durably recorded.

## Evaluation

`npm run test:grounded-executive` runs twelve deterministic scenarios
(fixed clocks, synthetic evidence, no network) against a frozen baseline
and an ungrounded act-first comparison policy, asserting zero failures,
zero regressions, and run-to-run determinism. Unit suites:
`npm run test:grounded-executive:unit`.

Current result: **grounded 12/12 correct vs act-first baseline 0/12**,
with calibration improving after attested corrections
(Brier 0.585 → 0.320 in the correction scenario).
