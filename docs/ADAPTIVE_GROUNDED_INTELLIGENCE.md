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

## Implementation sequence

1. Add pure deterministic episode reconciliation, candidate generation,
   lifecycle, bounded application, diagnostics, and activation-governor types.
2. Extend existing episode and grounded-learning persistence additively and add
   a compact append-only lifecycle-event journal.
3. Integrate construction, accepted-guidance projection, post-turn outcome
   observation, persistence, and diagnostics into the existing turn harness.
4. Add frozen 60+ scenario counterfactual replay with three identical runs and
   focused migration/integration tests.
5. Complete the operational review, canary/pause/rollback procedure, measured
   results, and release-gate record in this guide.

Production configuration is intentionally unchanged. Assistive mode remains
disabled unless a future owner-reviewed canary separately satisfies the
governor and production activation procedure.
