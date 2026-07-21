# Unified Grounded Cognitive Loop v1

## Purpose

Andrea has several mature cognition paths, but before this integration they did
not share one complete evidence view. In particular, the grounded executive and
Grounded Response Intelligence independently loaded durable memory during the
same turn. Their conclusions were safe and observe-only, but they could be based
on different bounded selections.

The unified loop is a coordinator, not a new executive. It creates one bounded
`UnifiedGroundedCognitiveFrame`, projects its accepted evidence into the
existing grounded executive, derives the existing response contract from the
same frame, and then records response and outcome evaluation back into the
frame.

The lifecycle is:

1. **Observe** — record the current user statement and bounded evidence refs.
2. **Orient** — apply privacy, scope, freshness, relevance, and source budgets.
3. **Deliberate** — arbitrate contradictions and compose existing module advice.
4. **Advise** — project a response contract; never authorize an action.
5. **Verify** — attach response, tool, receipt, and outcome truth separately.
6. **Learn** — create review-required candidates with no promotion authority.

No hidden chain-of-thought is stored. Durable metadata contains identifiers,
counts, statuses, concise reasons, and bounded evidence links—not raw messages.

## Before and after

Before:

```text
turn -> personal context -> platform/cognitive paths
     -> grounded executive -> its own durable-memory retrieval
     -> response intelligence -> a second durable-memory retrieval
     -> response evaluation -> separate grounded outcome journal
```

After:

```text
turn -> existing platform/cognitive paths
     -> one bounded evidence/context selection
     -> UnifiedGroundedCognitiveFrame
          -> evidence projection -> existing grounded executive
          -> response projection -> Grounded Response Intelligence
          <- response evaluation
          <- runtime/tool/provider/goal outcome distinctions
          -> review-required learning candidates
```

## Authority matrix

| Decision              | Authoritative system                                              | Unified-loop role                                                  |
| --------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| Intent interpretation | Grounded Response Intelligence clause decomposition               | Retain the canonical clauses and targets                           |
| Evidence selection    | Unified bounded selector and arbitration                          | Authoritative context projection for integrated grounded cognition |
| Durable memory truth  | Grounded Memory and Goal Continuity                               | Consume accepted records; never rewrite memory truth               |
| Goal state            | Grounded goal store and verified goal transitions                 | Project active and terminal state; never execute a proposed step   |
| Response posture      | Unified deterministic arbitration informed by existing executives | Advisory only                                                      |
| Tool-selection advice | Existing cognitive executive/runtime spine                        | Record a bounded recommendation                                    |
| Action authorization  | Existing action-specific policy and capability bindings           | None                                                               |
| Approval consumption  | Existing approval subsystem                                       | None                                                               |
| Completion claims     | Truth engine, provider receipts, and completion-claim gate        | Preserve required distinctions and prohibit unsupported claims     |
| Provider success      | Provider receipt subsystem                                        | Observe linked receipt IDs                                         |
| Goal success          | Verified outcome and grounded goal transition                     | Never infer it from tool success                                   |
| Learning promotion    | Existing reviewed memory/learning policy                          | Propose reversible review candidates only                          |
| Outbound delivery     | Channel adapter plus outbound pause                               | None                                                               |

The frame structurally pins execution, approval, delivery, and learning-promotion
authority to `false`.

## Evidence model and arbitration

Each evidence reference carries a stable ID, source class, record provenance,
subject, scope, redacted claim, normalized value, epistemic status, confidence,
freshness, contradiction/supersession links, sensitivity, permitted uses, and
what would change it.

Priority is deterministic:

1. current direct user statement;
2. recent direct observation or verified provider/goal outcome;
3. accepted durable memory and commitments/goals;
4. reviewed inference;
5. unresolved assumption as uncertainty only.

Equal-authority contradictions remain unresolved and require disclosure or one
clarification. Secret, cross-scope, expired, stale, superseded, irrelevant, and
insufficient evidence is excluded with a reason.

## Modes

`UNIFIED_GROUNDED_COGNITION_MODE=off|shadow|assistive` controls the loop and
defaults to `shadow`. The unified mode is authoritative for the grounded
response projection. Startup/turn validation rejects combinations where an old
response flag attempts to be more permissive than the unified mode.

During migration, `GROUNDED_ADVISORY_MODE` is used only when the unified setting
is absent. An explicit unified value always wins. This keeps existing test and
operator workflows compatible without maintaining two independent authorities.

Production configuration is not changed by this feature. Assistive mode remains
owner-reviewed and disabled by default. At most one text-only response repair is
allowed; no repair may call a tool, retry an action, consume approval, alter a
route, or create durable work.

## Storage, privacy, and migration

The frame is in-memory. Existing turn metadata and grounded learning journals
receive bounded redacted projections and stable links. Existing grounded tables
remain authoritative, so v1 requires no database schema migration. Goal context
projection is additively extended with bounded terminal-goal history to prevent
completed or cancelled work from being resurrected. Reads remain compatible
with older bundles where that optional field is absent.

Synthetic and replay frames cannot create production-eligible learning. Every
candidate remains `proposed`, reversible, review-required, and carries
`executionAuthority=false`.

## Evaluation boundary

The whole-loop suite is deterministic, isolated, and network-denied. It compares
the pre-integration behavior with unified shadow and simulated assistive paths.
It measures integration invariants and does not establish AGI, live provider
quality, or owner usefulness. Synthetic evidence is not genuine owner evidence;
model self-grading cannot replace owner review; and the ten-day dogfood gate
cannot be simulated or backfilled.

Run the isolated whole-loop checks with:

```bash
npm run test:unified-grounded-cognition:unit
npm run test:unified-grounded-cognition
```

The frozen v1 suite has 84 cases across 32 categories. The first passing
baseline comparison scored 82.98 for the pre-integration path and 100 for the
unified candidate, a 17.02-point improvement. All authority, privacy,
unsupported-completion, clause/target, synthetic-learning, stale-approval,
terminal-goal, and provider-versus-goal gates passed. Fixture p95 was below 1
ms, compared with the 350 ms acceptance ceiling; the largest context was 3,435
characters and the largest persisted metadata projection was 1,124 characters.

Read-only local explanation is available with:

```bash
npm run debug:unified-grounded-cognition -- --request "Explain the active plan and remaining risks"
```

## Activation and rollback

Keep the production mode at its default `shadow` value until the deterministic
gates, owner review, and genuine dogfood evidence are complete. Rollback is a
configuration change to `off` or a code rollback; no schema downgrade is needed.
Existing approval, action, receipt, truth, durable-work, and outbound systems
continue to operate independently of this advisory frame.
