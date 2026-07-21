# Grounded Memory and Goal Continuity v1

A durable, evidence-backed memory and goal-tracking layer so Andrea
retains useful context across turns and restarts, distinguishes facts
from assumptions, keeps contradictions visible, and tracks goals safely.
It extends the grounded executive
([GROUNDED_COGNITIVE_EXECUTIVE.md](GROUNDED_COGNITIVE_EXECUTIVE.md)) and
follows the same pattern: a pure deterministic core, a durable adapter,
observe-only harness hooks, and a deterministic evaluation harness.

**This is an intelligence upgrade, not an automation upgrade.** Memory,
goals, and proposed next steps are planning/context truth only. Nothing
in this subsystem can send messages, schedule work, execute tools, or
modify safety policy; `grounded_goals.execution_authority` is pinned to
`0` by a schema `CHECK`, and the TypeScript types pin
`executionAuthority: false` as a literal.

## Modules

| File                                       | Role                                                            |
| ------------------------------------------ | --------------------------------------------------------------- |
| `src/grounded-memory.ts`                   | Pure truth maintenance, goals, retrieval ranking, diagnostics   |
| `src/grounded-memory-durable-adapter.ts`   | SQLite persistence, idempotent writes, guarded transitions      |
| `src/turn-agent-harness.ts` (hooks)        | Shadow-turn retrieval and memory-candidate capture              |
| `src/grounded-memory-eval.ts`              | 24-scenario deterministic evaluation                            |
| `scripts/debug-grounded-memory.ts`         | Read-only diagnostics command                                   |

## Data model

Two tables in `store/messages.db` (schema in `src/db.ts`, created by the
idempotent `CREATE TABLE IF NOT EXISTS` migration path):

- **`grounded_memory_records`** — kinds `fact | preference | commitment |
  outcome | constraint | open_question`; normalized `subject_key`;
  bounded `statement` and comparison `value`; `confidence`;
  `source_type` (`direct_observation | user_statement | inference |
  assumption`); provenance refs; `observed_at` plus
  `effective_from`/`effective_until`; stored state `active | uncertain |
  superseded | revoked` with `state_reason`; supersession and conflict
  links; sensitivity (`low | personal | sensitive | secret`). Expiry is a
  *derived* state — history is never rewritten by the clock.
- **`grounded_goals`** — parent link, `state` (`proposed | active |
  blocked | completed | cancelled | stale`) with reason, owner, evidence
  refs, constraints, success criteria, blockers, informational
  `next_proposed_step`, last verified outcome, review deadline, and the
  `CHECK (execution_authority = 0)` guard.

State transitions are guarded twice (adapter and db accessor):
`completed` and `cancelled` goals are terminal; `revoked` memory is
terminal; `superseded` can only move to `revoked`. A disallowed durable
goal transition returns `null` instead of throwing, so a replayed
request can never resurrect a cancelled goal.

### Privacy treatment

Records store bounded, normalized summaries — never raw message bodies.
Every persisted text field passes through `redactStoredCognitiveMetadata`;
sensitivity uses the existing `RealitySensitivity` scale; `secret`
records are never retrievable through the context bundle; retrieval and
diagnostics are read-only.

## Truth maintenance (deterministic, explainable)

`reconcileGroundedMemory` applies ordered rules, each producing a typed
change with a one-sentence explanation — never last-write-wins:

1. Same subject and value → idempotent refresh (no duplicate rows).
2. Changed preference stated by the user → supersedes the old
   preference; the old record survives with a "changed preference"
   reason.
3. Newer direct evidence (observation / user statement) → supersedes
   older inference or assumption.
4. Inference vs existing direct evidence → the inference enters
   `uncertain` with a conflict link; direct evidence stays active.
5. Equal-strength disagreement → both records become `uncertain`, both
   keep conflict links, both lose confidence: the contradiction stays
   visible until fresh evidence resolves it.

Inference or assumption below confidence 0.6 enters `uncertain` and is
excluded from default retrieval. Commitments complete into `outcome`
records (`completeGroundedCommitment`) and revocation
(`revokeGroundedMemory`) is terminal and idempotent.

## Retrieval — `GroundedContextBundle`

`buildGroundedContextBundle` / `loadGroundedContextBundle` return a
bounded, read-only bundle per turn or goal review: relevance-ranked
items (topic match × recency × source strength × confidence, with
deterministic tie-breaks), active/blocked/proposed goal summaries,
visible contradictions (surfaced even when both conflicted records were
excluded as uncertain), uncertainty notes, per-record
inclusion/exclusion reasons (`revoked | superseded | expired |
low_confidence | uncertain_by_default | sensitivity | irrelevant |
budget`), and an item/char budget with truncation reporting.

## Shadow-executive integration (observe-only)

In `turn-agent-harness.ts`, at shadow-turn begin the bundle is
retrieved (topics = task family + sanitized objective) and its items
become shadow evidence with provenance; durable contradictions become
frame unknowns; metadata records `grounded_memory_retrieved/excluded/
contradictions/goals` and `grounded_goal_review_suggested`. At
reflection, beliefs grounded at `likely`/`verified` (never turn-scoped
bookkeeping) are staged as memory candidates through the same
reconciliation. User-facing response behavior is unchanged.

## Diagnostics

```bash
npm run debug:grounded-memory                      # counts overview
npm run debug:grounded-memory -- --topic backup    # why Andrea believes this
npm run debug:grounded-memory -- --bundle backup   # retrieval preview + reasons
npm run debug:grounded-memory -- --since <iso>     # what changed since a turn
```

All read-only, bounded, redacted metadata; no secrets or message bodies.

## Evaluation and tests

```bash
npm run test:grounded-memory        # 24-scenario deterministic eval
npm run test:grounded-memory:unit   # pure + durable adapter vitest suites
```

The eval covers changed preferences, stale facts, contradictory sources,
uncertain inference, completed/cancelled commitments, restart continuity
for memory and goals, cancelled-stays-cancelled, direct-beats-inference,
visible contradictions, blocked goals, never-executing proposed steps,
and bounded retrieval — with a frozen baseline, regression detection,
and a run-to-run determinism assertion. Unit suites additionally cover
migration upgrades from a pre-feature database, duplicate-write
idempotency, and db-layer transition guards.
