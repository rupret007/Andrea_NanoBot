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

## Module integration map

| Existing module                             | Unified-loop integration                                                                                                     |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Personal context graph                      | Contributes scoped, redacted context before evidence arbitration                                                             |
| Grounded Memory and Goal Continuity         | Supplies one bounded bundle of accepted memory, active goals, terminal goals, commitments, contradictions, and uncertainties |
| Platform deliberation and cognitive kernel  | Contribute advisory posture recommendations and trace links                                                                  |
| Grounded Cognitive Executive                | Receives the canonical accepted-evidence projection instead of performing a second integrated retrieval                      |
| Grounded Response Intelligence              | Receives the canonical frame and produces the response contract and deterministic response evaluation                        |
| Runtime/tool evidence                       | Supplies technical outcomes without implying provider or goal success                                                        |
| Provider receipts and completion-claim gate | Supply authoritative delivery and completion evidence while retaining their existing authority                               |
| Durable work and approvals                  | Remain independent authorities; the frame records only bounded references and boundaries                                     |

The turn harness constructs the frame once and passes projections downstream.
Standalone module entry points remain supported for tests and compatibility, but
they do not become competing authorities in the integrated turn path.

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

## Outcome and learning-candidate lifecycle

Post-turn observation keeps tool acceptance, tool success, provider receipts,
requested-outcome verification, goal success, and verified goal failure as
separate fields. Response-evaluation failures, missed intents, stale evidence,
owner corrections or feedback, route blockers, unverified technical success,
verified goal failure, repeated clarification failures, and accepted or
rejected recommendations can create bounded candidates. Candidates are
redacted, scoped, evidence-linked, confidence-calibrated, deduplicated, and
limited to 16 per frame.

Candidate creation is not learning promotion. The existing reviewed memory and
learning policy remains the only promotion path. A candidate cannot change tool
routing, approval behavior, execution policy, autonomous capability, or durable
memory on its own. Synthetic and replay outcomes always remain ineligible for
production promotion.

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

The frozen v1 suite has 92 cases across 35 categories. It explicitly compares a
faithfully captured current-main baseline, existing disconnected shadow
cognition, unified shadow cognition, and deterministic simulated assistive
response evaluation. The final baseline comparison scored 83.11 for the
pre-integration path and 100 for the unified candidate, a 16.89-point
improvement. All authority, privacy,
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

## Known limitations and assistive activation criteria

The deterministic fixtures measure bounded integration behavior, not open-ended
intelligence or real-world usefulness. The loop does not resolve every semantic
reference, invent unsupported compound routes, verify a provider outcome without
a receipt, or infer goal success from technical success. It does not automate
learning promotion, approvals, delivery, scheduling, deployment, or any other
mutation. No deterministic score establishes AGI.

Assistive mode requires a separate owner decision after all deterministic gates
remain green, an owner reviews representative diagnostics and repaired replies,
genuine dogfood evidence shows no authority/privacy regression, latency and
context budgets remain bounded, and the ten-day dogfood requirement completes
without simulation or backfill. Model self-grading cannot substitute for owner
feedback. Rollback must remain a tested configuration change to `shadow` or
`off`, with no schema dependency.
