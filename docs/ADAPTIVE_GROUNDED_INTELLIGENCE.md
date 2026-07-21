# Adaptive Grounded Intelligence and Safe Activation v1

## Integration architecture

This feature extends the Unified Grounded Cognitive Loop. It is not another
executive, planner, memory system, or action authority.

The existing `UnifiedGroundedCognitiveFrame` remains the canonical per-turn
view of intent clauses, evidence, goals, commitments, response requirements,
response evaluation, and advisory posture. Adaptive grounded intelligence adds
three bounded functions around that frame:

1. **Outcome reconciliation** appends redacted observations to a cognitive
   episode and deterministically derives current response, tool, provider,
   requested-outcome, and goal truth without rewriting earlier observations.
2. **Reviewed learning** converts verified response/outcome/owner-feedback
   patterns into scoped candidates in the existing grounded-learning store.
   A separate append-only event journal records evidence accumulation, explicit
   owner review, rejection, expiry, supersession, application, and rollback.
3. **Activation governance** evaluates frozen quality, safety, privacy,
   calibration, latency, boundedness, learning precision, rollback readiness,
   sample size, critical failures, and explicit owner approval. It can describe
   a canary candidate but cannot change the live mode.

The integrated lifecycle is:

```text
inbound turn
  -> UnifiedGroundedCognitiveFrame
  -> existing grounded executive + response intelligence
  -> response evaluation
  -> existing tool / provider / completion evidence
  -> append-only episode observation
  -> deterministic reconciled outcome
  -> bounded learning candidates
  -> owner-reviewed learning lifecycle
  -> accepted response/planning guidance only
  -> deterministic assistive-readiness assessment
```

## Existing surfaces reused

| Concern                             | Authoritative existing surface              | Adaptive extension                           |
| ----------------------------------- | ------------------------------------------- | -------------------------------------------- |
| Intent, context, goals, commitments | `UnifiedGroundedCognitiveFrame`             | Stable episode links and bounded diagnostics |
| Response contract and evaluation    | Grounded Response Intelligence              | Candidate signals and accepted guidance      |
| Tool/action truth                   | Runtime, durable work, action policy        | Observation only                             |
| Provider truth                      | Provider receipts                           | Observation and late reconciliation only     |
| Goal truth                          | Grounded goals and completion-claim gate    | Reconciled projection only                   |
| Owner feedback                      | Response feedback and owner-review surfaces | Explicit evidence and lifecycle events       |
| Episode retention                   | Existing `cognitive_episodes` store         | Additive unified links and outcome metadata  |
| Learning records                    | Existing `grounded_learning_records` store  | Additive lifecycle and evidence metadata     |
| Durable review history              | Existing grounded journals                  | Append-only learning lifecycle events        |

The older outcome-review and response-feedback paths are inputs to
reconciliation; they are not replaced. Existing grounded-learning records stay
read-compatible. Legacy `accepted` lessons continue to load for planning, while
new adaptive candidates use the richer conservative lifecycle.

## Structural authority boundary

The adaptive layer has no execution, approval, delivery, scheduling,
credential, policy, or learning-promotion authority. Outcome reconciliation can
observe that a tool returned successfully, but requested-outcome verification
requires authoritative evidence, and goal success additionally requires an
explicit verified goal signal. Provider acceptance never implies either.

All candidates require explicit owner acceptance before use. Automatic logic
may only accumulate evidence, mark a candidate ready for review, expire it, or
identify a mandatory pause/rollback condition. Accepted lessons can add bounded
response/planning guidance; they cannot call a tool, consume approval, mutate a
provider, create durable work, enable BlueBubbles outbound, or authorize a
completion claim.

## Privacy, retention, and compatibility

Episode and learning persistence stores stable IDs, classifications, bounded
redacted summaries, evidence references, counts, and lifecycle decisions. It
does not duplicate raw user or assistant message bodies and never stores hidden
reasoning. Synthetic and replay observations are marked at their source and are
ineligible for production promotion.

The schema migration is additive. Existing cognitive episodes and grounded
learning rows remain readable. Episode history and learning-event journals have
per-record and global bounds, retention windows, and pruning. Pinned owner
decisions retain only bounded metadata; expired episode detail and old events
are removed without changing current accepted/rejected/rolled-back state.

## Learning lifecycle and thresholds

New observations start as `proposed`. Deterministic recurrence and confidence
may move a production-eligible candidate through `accumulating_evidence` to
`ready_for_review`; they can never move it to `accepted`. Explicit canonical
owner review is the only acceptance path. Terminal or protective states are
`rejected`, `expired`, `superseded`, and `rolled_back`.

Promotion readiness requires three consistent occurrences, confidence of at
least 0.72, bounded supporting evidence, no unresolved counter-evidence, live
provenance, and no privacy, secret, authority, messaging, external-instruction,
or unverified-outcome blocker. Rejected duplicates remain suppressed until
materially new evidence appears. A late authoritative recovery supersedes an
earlier failure-oriented lesson rather than leaving obsolete advice active.

Accepted lessons retain their original conversation, group, channel, task,
subject, and route scope. At most eight bounded guidance statements are
projected into response planning. Every application is journaled; no lesson can
change action policy, approval requirements, tool selection authority, delivery,
or completion truth.

## Operator diagnostics and owner review

The diagnostic command is read-only unless all explicit review flags are
present:

```bash
npm run debug:adaptive-grounded-intelligence
npm run debug:adaptive-grounded-intelligence -- --turn <turn-id>
npm run debug:adaptive-grounded-intelligence -- --episode <episode-id>
npm run debug:adaptive-grounded-intelligence -- --candidate <candidate-id>
```

It reports the reconciled outcome, why goal success is or is not verified,
candidate status and blockers, owner-review state, affected modules, application
counts, lifecycle events, readiness, and structural no-authority invariants. It
does not emit raw private message bodies.

An owner review is a separate deliberate write:

```bash
npm run debug:adaptive-grounded-intelligence -- \
  --candidate <candidate-id> \
  --review accept \
  --explicit-owner-review \
  --reviewer owner \
  --note "Accepted for this exact response-planning scope"
```

`--review` also accepts `reject`, `supersede`, or `rollback`. Supersession may
name `--replacement <candidate-id>`. The reviewer must be the canonical `owner`
identity (or an `owner:<id>` identity), and the candidate must be in a legal
lifecycle state. None of these decisions approves an external action.

## Evaluation and measured repository evidence

Run the isolated deterministic suite and focused unit/migration/integration
checks with:

```bash
npm run test:adaptive-grounded-intelligence:unit
npm run test:adaptive-grounded-intelligence
```

The frozen v1 counterfactual suite has 68 scenarios across 34 categories and
runs every fixture three times. The implementation record for this version is:

| Measure                            | Result                    |
| ---------------------------------- | ------------------------- |
| Frozen pre-unified baseline        | 74.06                     |
| Unified shadow                     | 89.22                     |
| Learned shadow                     | 100.00                    |
| Simulated response-only canary     | 100.00                    |
| Learning-relevant improvement      | +13.58 percentage points  |
| Promotion precision                | 100%                      |
| Authority/privacy violations       | 0 / 0                     |
| Unsupported completion claims      | 0                         |
| Lost clauses or targets            | 0                         |
| Fixture p95 adaptive overhead      | 3.21 ms (300 ms gate)     |
| Maximum bounded context            | 2,259 characters          |
| Maximum persisted metadata fixture | 818 characters            |
| Repeated-run digests               | identical (`db1c9d0d` x3) |
| Deterministic readiness            | `shadow_ready`            |

These are repository fixture results, not production activation evidence,
live-provider proof, real owner usefulness, or an AGI claim. Genuine dogfood
and time-based evidence cannot be simulated or backfilled.

## Assistive canary, pause, and rollback

Production remains shadow by default. Merely requesting assistive mode is not
enough: the activation governor deterministically fails the turn back to shadow
unless all of the following are present together:

- a fresh readiness result of `canary_candidate`
- an explicit owner approval identifier
- the exact `response_planning_only` scope
- canary mode, not simulation mode
- a percentage from 1 through 10
- a deterministic turn bucket inside that percentage

The configuration surface is deliberately narrow:

```text
UNIFIED_GROUNDED_COGNITION_MODE=assistive
ADAPTIVE_ASSISTIVE_CANARY_MODE=disabled|simulate|canary
ADAPTIVE_ASSISTIVE_READINESS_STATUS=not_ready|shadow_ready|canary_candidate|canary_paused|rollback_required
ADAPTIVE_ASSISTIVE_OWNER_APPROVAL_ID=owner:<review-id>
ADAPTIVE_ASSISTIVE_SCOPE=response_planning_only
ADAPTIVE_ASSISTIVE_MAX_PERCENT=1..10
```

Replay and synthetic runs may select response-only assistive behavior as an
explicit simulation without any canary environment settings. They remain
non-live, cannot promote production learning, and never change production
configuration. Live turns always pass through the full fail-closed governor.

Do not set these from a test result alone. First inspect representative
episodes and accepted lessons, collect genuine owner-reviewed dogfood, record a
separate activation decision, and begin with simulation. A noncritical gate
failure while canarying yields `canary_paused`; any authority, privacy,
unsupported-completion, intent/target-loss, or other critical failure yields
`rollback_required`.

Pause or rollback by changing the unified mode to `shadow` (or `off`) and the
adaptive canary mode to `disabled`, then restarting through the normal
owner-authorized release procedure. Roll back an unsafe lesson explicitly with
the review command. No schema downgrade is required. The existing approval,
outbound-pause, provider-receipt, durable-work, privacy, and completion-claim
systems continue to govern independently.

## Migration and compatibility verification

The database change is additive. Existing `cognitive_episodes` and
`grounded_learning_records` rows are preserved; missing adaptive fields are
added with fail-closed defaults, and the append-only
`grounded_learning_lifecycle_events` table is created. Legacy learning rows do
not become production-eligible merely because the schema was upgraded.

The focused migration fixture creates an actual pre-adaptive schema, preserves
legacy rows, reopens it through the current migration, and verifies column/table
creation and fail-closed defaults. Back up the production database through the
normal release process before any future deployment; this feature does not
require or authorize a live migration in its repository test task.

## Known limitations and remaining activation evidence

- The candidate generator recognizes bounded evidence patterns; it is not an
  unrestricted learner and does not invent new tools or policies.
- Sparse, ambiguous, sensitive, synthetic, replayed, maliciously retrieved, or
  contradicted evidence stays blocked or uncertain.
- Technical success and provider acceptance never establish requested-outcome
  or goal success without the corresponding authoritative evidence.
- Owner review quality, longer-term usefulness, recurrence stability, and
  canary rollback behavior still need genuine dogfood evidence.
- The ten-day dogfood gate remains separate and cannot be satisfied by fixtures.
- Response-planning guidance may improve wording and continuity only; it has no
  execution, approval, messaging, or learning-promotion authority.

Production configuration was intentionally unchanged by this implementation.
No production restart, deployment, provider mutation, outbound message, or live
assistive activation is part of the repository release evidence above.
