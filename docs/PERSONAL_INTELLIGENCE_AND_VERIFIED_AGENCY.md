# Personal Intelligence and Verified Agency

Andrea's personal-intelligence loop is deliberately bounded:

1. compile relevant local context with provenance;
2. propose the smallest useful next action;
3. require fresh approval for external or irreversible effects;
4. verify the resulting state;
5. record a redacted outcome signal and compare it with a saved baseline.

## Personal context

`PersonalContextPacket` combines bounded context-graph items with accepted
derived facts. Telegram, BlueBubbles, calendar, and saved-material memory are
opt-in per source and default off. The derived-fact store does not duplicate raw
messages. Facts carry an opaque source citation, confidence, observation and
expiry timestamps, review status, and a subject key used to surface conflicts.

Disabling a source immediately revokes its derived facts. A user can accept,
revoke, forget, or allow a fact to expire. Retrieval combines exact lexical
matches with a deterministic local concept scorer and can additionally combine
an injected semantic scorer; every returned item retains a citation. The local
fallback recognizes bounded assistant concepts such as agenda/calendar,
texts/messages, goals/priorities, and reminders/tasks without a provider call.
Profile memory, the Knowledge Library, and episodic/context-graph state remain
separate stores even though the packet presents one bounded view.

Meaningful production turns now compile one packet and reuse it across the turn
harness and Cognitive Executive. Remote deliberation receives counts, conflict
state, and citation coverage only. Local planning receives the bounded cited
summaries; conflicting items are confidence-capped and clarification-only.

Before daily guidance, planning, or coding work, bounded active perception
classifies the required calendar, open-loop, goal, message, repository, and tool
signals as fresh, aging, stale, missing, or conflicted. It requests at most three
targeted refreshes and records the gap metadata; it does not create another
memory store or expand channel consent.

## Delegated routines

Only reversible actions such as local saves, drafts, references, and reminders
can be promoted. External sends and all other fresh-approval actions never
auto-apply. Promotion requires all of the following:

- explicit user confirmation;
- a passing deterministic fixture;
- one user-approved canary that is verified or honestly blocked;
- fewer than two failures or overrides in the previous 30 days.

Two recent failures or overrides pause the rule and switch it to always ask.
The existing rule explanation remains visible when a rule fires.

## Verified deep work

`VerifiedDeepWorkPacket` persists the flow `plan -> inspect -> approval ->
execute -> verify -> record outcome`. Approval evidence is mandatory when the
packet is marked approval-required. Degraded providers or tools block execution,
failed or unresolved runtime results block completion, and a later approval turn
must rebind the pending packet before execution is assessed. Research and coding
packets retain sources, bounded artifact or evidence references, checks,
unresolved risks, and the next user-readable decision.

Execution-intent coding and operator turns create V2 packets automatically. A
later approval turn binds to the pending packet, but post-send reflection only
assesses answer quality and never advances execution. Completion requires
strictly validated evidence from the packet's bound turn, a complete result for
a task-relevant runtime action, and an answer evaluation without a major or
blocked evidence gap. Repository writes additionally require before/after state
fingerprints and a successful verification observed after the final write.
Terminal runtime errors and unclassified actions fail closed even when an
individual receipt claims success. Stale-session retry preserves evidence from
the suppressed attempt so a fresh session cannot erase earlier failure or
uncertainty. An aggregate `external_side_effect` observation cannot complete a
packet—even with approval—until a dedicated receipt binds the exact approved
action. Coding packets remain blocked on `runtime_repository_scope_unbound`
until repository actions are bound to one inspected target. Operator packets
remain blocked on `runtime_operator_scope_unbound` until the exact target,
action, and postcondition are bound. The current aggregate evidence proves
action classes, counts, ordering, outcomes, recovery, and state fingerprints;
it does not prove the contents of a named artifact or semantic postcondition.

### Canonical durable recovery

Meaningful coding, research, operator, mission, and approval-required turns now
link their existing projections to one `DurableWorkUnit`. The record is bound
to hashed owner/chat/group/target scopes plus channel, work and plan versions,
checkpoint head, executor scope, bounded node IDs, receipts, verification
requirements, retry budget, and next safe action. Ordinary direct-assistant
questions stay off this path.

Checkpoints commit with compare-and-set semantics. A resume grant is random,
expiring, single-use, scope-bound, and stored only as a token hash. Grant
consumption and lease acquisition are atomic; exactly one concurrent consumer
can win. The current work version, plan version, checkpoint, owner, chat, group,
channel, target, action class, inbound-message binding when present, and fresh
approval all revalidate before execution. Legacy Runtime Spine and Agent OS
resume identifiers are revoked as executable capabilities and remain
projection-only history.

Fresh-approval action classes need a staged cognitive approval that survives an
exact database compare-and-set over its stored summary, version, and scope
digest. Staging is one transaction: Andrea writes the immutable packet, creates
a new approval checkpoint, links it to the durable work, and moves that work to
`awaiting_approval` together. The approved packet must bind the same durable
work ID, current durable checkpoint ID, plan version, target-scope digest, and
action class. This keeps approval separate from observation, checkpoint
existence, resume possession, model confidence, and skill promotion.

The one-node orchestrator revalidates dependencies and target state, records a
`started` receipt before invocation, executes through an injected bounded
adapter, verifies the result, and either commits verified progress, preserves
an uncertain node for verification-only recovery, or replans while retaining
completed steps. A crash or callback error never turns an attempted effect into
success. Unresolved repository or external effects are inspected rather than
blindly replayed; an external unknown remains `delivery_unverified`. A new
repository-write or external-effect receipt must retain the consumed grant ID
and exact approval packet ID, version, scope digest, and action class for that
same work/checkpoint/plan/target; a receipt cannot borrow another action's
authority.

Repository proof is host-bound to the canonical non-symlinked Git worktree and
allowed root. It binds repository/Git/worktree fingerprints, branch, HEAD,
dirty-state digest, plan/checkpoint/invocation/turn identity, action class, and
postcondition evidence. Traversal, symlinks, scope drift, stale state, action-ID
reuse, cross-work receipts, and verification failure are rejected. Durable
storage receives only opaque IDs and fingerprints, not raw paths, commands,
tool output, prompts, replies, or secrets.

Startup reconciliation expires leases from prior process generations and
classifies the surviving truth before new work proceeds. Unknown local effects
return to verification; uncertain external effects stay delivery-unverified;
otherwise the work becomes interrupted at the committed checkpoint. Recovery
reports fail closed on malformed checkpoint arrays and can answer natural
questions about what survived, what is verified, what remains, and what still
needs approval without consuming a grant or inventing completion.

Final exact-tree adversarial proof remains a release gate. It must demonstrate
per-completed-node verified receipts, expiry and process-generation lease
enforcement through receipt persistence, monotonic completed/uncertain
checkpoint truth, proof-gated pending-to-completed transitions, and bounded
non-leaking behavior for malformed stored checkpoint JSON.

### Container capability and context isolation

Container-backed assistance keeps transcript and session continuity within one
of four capability lanes: `direct-assistant`, `protected`, `control`, or
`execution`. Advanced and code work intentionally share only the execution
lane; no other route pair reuses a transcript, storage key, or Claude home.
Legacy shared tool-bearing session rows remain preserved but inert.

Every run receives a fresh host-created inbox scoped to its group, lane, and
run ID. Host follow-ups use HMAC-SHA256 `provenance:host` envelopes tied to that
run and a redacted per-run token. The inbox is read-only inside the runner, and
unsigned, altered, cross-run, or replayed messages fail closed. Direct,
protected, and control guidance is host-constant; only execution may consume
the mutable group `CLAUDE.md`. Runner source, settings, enabled skills, and
plugins remain read-only trusted views. Final real-container and full-suite
validation, the exact-SHA hosted gates, and release publication are complete.
Production currently serves the preceding application commit because the final
`main` commit changed CI workflow/test code only; that running/workspace SHA
mismatch remains explicit rather than being treated as deployed proof.

## Evaluation and improvement

Deterministic scorecards use isolated database state, an injected synthetic
platform fixture, provider-env suppression, and a process fetch guard that
rejects every non-loopback request. Live evaluation is opt-in and requires an
explicit positive `--max-cost-usd` threshold for the harness estimate; this is
not an enforceable provider-billing maximum.

Council ledger rows carry `synthetic`, `replay`, or `live` origin. Only live
runs influence provider reliability and route promotion. Feedback can be
converted to a traceable regression fixture without raw user or assistant text.
Outcome metrics cover recommendation acceptance, verified completion,
corrections and overrides, false proactive suggestions, memory precision,
citation coverage, tool reliability, latency, and live-evaluation cost.
Memory, citation, and tool-reliability rates count only events explicitly tagged
as real `assistant_interaction` work. Provider evaluation events are tagged
`live_evaluation`, and legacy events without provenance fail closed as
unclassified telemetry. Both remain auditable in the event ledger, but neither
can be presented as real-assistant reliability evidence or trigger a baseline
regression when there is no comparable current sample.
Recommendation acceptance, verified completion, corrections, overrides, and
the five-sample baseline gate similarly require explicit `owner_review`
provenance. Feedback controls, conservative natural verdicts, message-action
decisions, deep-work reviews, and explicit action-bundle decisions emit that
provenance. Multiple actions decided in one bundle retain action-level metrics
but share one bundle identity, so a single owner interaction cannot masquerade
as several reviewed outcomes. Evaluation, internal reward, routine-canary, and
legacy unclassified events remain auditable but cannot advance the gate.
Response feedback linked to a deep-work packet uses that packet as the same
canonical outcome identity. A later explicit mission verdict supersedes the
earlier Helpful/Not helpful disposition for quality rates, and repeated
completion, correction, or override signals retain their audit rows without
giving one task more than one outcome's weight.
Memory precision is not inferred from retrieval activity or generic
helpfulness. It requires an explicit packet-linked phrase such as `that memory
was correct` or `that memory was incorrect`; a later correction replaces the
prior judgment instead of adding a second sample. Citation coverage includes
only retrievals that returned at least one relevant result, so an honest
no-match cannot depress the score. Query packets use stopword-safe lexical
matching plus deterministic local concepts and the optional injected semantic
scorer. Items with none of those signals are excluded, preventing confidence or
freshness alone from injecting unrelated personal context. A content-free
topical query such as `who are you?` therefore returns no personal items instead
of failing open. Contradictions are surfaced only when at least one conflicting
item is relevant to the packet.
Intentionally broad daily-guidance requests such as `what am I forgetting`
and explicit memory-review requests such as `what do you know about me?` retain
a bounded cross-source context view; topical queries use the stricter relevance
filter.
Interaction latency means live reply delivery only. Provider evaluations,
deep-work route timing, replay drills, synthetic turns, and post-delivery
reflection are labeled separately and cannot distort the personal UX metric.
The primary evaluated reply path records request-preprocessing, turn-harness,
response-preparation, and channel-delivery stages after the channel attempt has
been classified. A confirmed success requires a non-empty platform receipt for
every response chunk. A confirmed prefix followed by failure is `partial`; a
transport failure whose server-acceptance state cannot be known is `unknown`.
Those two outcomes commit the inbound cursor only to prevent an unsafe full
replay, create bounded `interaction_delivery_degraded` evidence, and skip
feedback and other post-delivery enrichment. They are not successful delivery
samples and do not enter p50/p95. A definite rejection before any receipt, or
an otherwise complete result without a receipt, remains retryable and creates
no delivery metric.
Instrumentation v3 also records time spent waiting behind an earlier turn from
the earliest valid queued inbound timestamp. Invalid timestamps fall back to
dequeue time and future clock skew is clamped. An empty resolved result cannot
become a success sample or an unretryable cursor. Four-stage v2 samples remain
valid historical attribution.
Local controls explicitly opt into two seconds; ordinary replies and missing or
malformed classifications use ten seconds. Andrea never infers the class from
an incidental zero-duration harness. Legacy samples remain auditable and are
excluded from current percentiles once attributed samples exist. Metric or
later post-delivery enrichment errors are logged but cannot turn an already
delivered reply into a retryable send failure. Specialized action
presentations and handoff sends remain excluded from comparable latency until
they carry typed route semantics. When those message workflows advance durable
state, the shared complete-delivery guard rejects partial, unknown, malformed,
or receiptless results before they can be marked delivered, sent, completed,
or posted. Message actions and cross-channel handoffs persist partial/unknown
attempts as terminal `delivery_unverified` evidence, retain confirmed prefix
receipts and the next unknown chunk, remove resend controls, and require target
inspection plus a new draft before any later send. Runtime jobs preserve the
already-created/followed-up/stopped backend job and current selection when the
status card notification is blocked; they never relabel that backend operation
as failed or recreate it. Approval and delegation rules remain independent of
this transport guard.
Each v3 sample may also include aggregate host pressure at dequeue: one-minute
load per CPU, free-memory ratio, and a bounded pressure class. This stores no
process list, command, host identifier, prompt, or response and is diagnostic
correlation only; it never changes routing or excuses a target breach.
Queue wait is attribution, not a claim that the host caused the delay. A busy
container is never interrupted for a new turn. If a fresh turn is pending when
that container explicitly becomes idle, the idle container closes and the
existing per-group queue drains the new turn; an IPC-piped continuation stays
in the active session, and pending tasks retain priority.

Text delivery truth does not remove the remaining ambiguity for file or media
artifacts. Those are single transport operations rather than chunk-classified
primary replies, and a transport timeout can still leave server acceptance
unknowable. A thrown artifact send is therefore unconfirmed—not evidence that
nothing arrived—and an operator should inspect the target thread before a
manual resend. No durable workflow should infer artifact success without a
confirmed receipt.
Fresh provider probes are reconciled into route reliability through the
existing redacted live-health cache. The cache is owner-only, stores no raw
credential or provider response, expires after 30 minutes, and cannot override
a current missing-configuration or quota blocker. Provider health satisfies
only the dependency edge; cited verified task usage remains the stronger
evidence required for end-to-end route learning. A cached probe also cannot
overwrite newer verified-use evidence, whether that newer request succeeded or
failed.
The capability self-model, cognitive blackboard, tool-reliability doctor, and
live cognitive kernel compile that same bounded observation. Explicit injected
snapshots still control deterministic and config-only evaluation. When a
dependency changes an effective route state, the explanation updates health,
score, confidence cap, and next action together; a surface cannot claim a route
is healthy while displaying its obsolete unknown-state cap.
Feedback and same-thread message-action state is persisted at that delivery
boundary; slower reflection may enrich its evidence links afterward, but cannot
delay creation of the owner-facing control record or hold the conversation
queue. The detached task persists pending/completed/failed state, records its
own duration, merges around concurrent owner review, and stores only a redacted
error class if reflection fails.
Each task carries a process-generation identifier. Graceful shutdown drains
active work for up to five seconds; the next canonical process marks any prior-
generation pending task as interrupted rather than leaving false in-progress
evidence or trying to reconstruct private turn context. The assistant-
intelligence report exposes pending/completed/failed counts directly.

In the registered Telegram owner chat and configured BlueBubbles self-thread,
fresh standalone phrases such as `that worked`, `that was helpful`, `that
didn't work`, and `not helpful` bind to only the immediately latest unreviewed
response. `That worked` and `that solved it` also record explicit owner-verified
completion. The binder uses a 30-minute creation-time window, records the
review source as provenance, and refuses questions, vague sentiment, stale
records, already-reviewed records, and any phrase containing an action or
approval request. Natural feedback therefore improves learning evidence but
cannot authorize a send, calendar write, purchase, deployment, commit, push,
deletion, or other side effect.

Use `npm run debug:assistant-intelligence` for the metadata-only operator view.
Add `-- --save-baseline` only when the current sample is the reviewed baseline.
The command refuses to save fewer than five accepted/rejected owner-reviewed
outcomes. Provider latency, tool, and cost telemetry never satisfy this gate.
Andrea also reports this count after each genuine feedback verdict and in the
conversational `learning status` answer. Reaching five reports that a baseline
is ready for operator review; it never auto-saves or silently promotes one.
Pilot issue and landing status are derived from the linked feedback evidence,
not from a stale issue row alone. Existing regression coverage, recorded
landings, cancellations, and explicit keep-local decisions are removed from the
actionable issue count. A local hotfix is called pending only when the current
repository has a new dirty path beyond the remediation-start baseline.

## Verified deep-work apprenticeship

Repository and coding work can now carry one reviewable packet that links the
mission, goal, cognitive episode, approval packet, outcome, and captured
repository state. The owner cockpit shows the latest mission, artifacts, checks,
risks, next decision, and promotion progress. The same review surface is
available through mission chat requests such as `show today's mission evidence`,
`mark this mission verified`, `mark this mission partial`, `mark this mission
blocked`, or `mark this mission needs correction`.

Andrea creates a candidate coding skill after three owner-reviewed verified
missions. Promotion requires five verified missions, at least 80% acceptance,
and fewer than two corrected or rejected outcomes. Verified promotion evidence
also requires artifacts, passing checks, resolved risks, approval evidence when
needed, and a deterministic test/replay signal. V2 packets additionally require
complete bound runtime evidence; repository writes require a verification after
the final write, and aggregate external-action evidence remains ineligible until
the exact approved action has its own binding. Reply quality and internal trace
IDs never satisfy those execution requirements. The review is bridged into one
Agent OS trajectory evaluation, stable skill proposal, cognitive skill card,
and runtime manifest. Two negative outcomes block promotion and quarantine
every linked representation. Promotion never expands authority:
commit, push, deploy, migration, dependency changes, deletion, and other
irreversible actions continue to require fresh approval.

The packet also retains the originating live cognitive-run ID. A mission
verdict therefore updates the same cognitive trajectory instead of creating a
parallel learning record. `verified` is accepted evidence; `corrected` and
`rejected` are negative evidence; `partial` and honestly `blocked` use a neutral
review signal. Neutral reviews count as reviewed outcomes but never inflate the
accepted-run total required for skill promotion. Re-reviewing one packet
updates its stable signal rather than creating duplicate samples.

Intelligence progress keeps capability presence separate from outcome-led
learning. Reminders, follow-through candidates, and approval-safe workflows
prove that Andrea can support follow-through; they do not prove that the owner
found it useful. The `followthrough learning` dimension therefore combines
that capability evidence with progress toward five distinct genuine
owner-reviewed outcomes. Until the gate is met, the top improvement asks for
Helpful/Not helpful, a Messages tapback, or a fresh standalone success/failure
reply before recommending synthetic score work. The first baseline still
requires explicit operator review and is never saved automatically.

Live repository work must enter this loop through the platform `code` task
family. Repository implementation, refactoring, tests, typechecks, and bounded
technical fixes persist as `coding` packets; runtime status and service-control
work remains `operator`. Only coding packets contribute to the repository
apprenticeship and its Agent OS proposal. Other reviewed deep-work packets can
still improve their originating cognitive trajectory, but are never relabeled
as coding evidence.

The owner cockpit selects the most decision-relevant deep-work packet rather
than merely the newest active one. It favors unreviewed completed or honestly
blocked outcomes and shows a bounded evidence checklist: artifact and source
counts, named check results, unresolved risks, missing verification inputs,
deterministic replay, route/cost, and promotion progress. Raw prompts,
artifacts, private evidence bodies, and hidden reasoning remain absent. The
verified control stays unavailable until the exact missing evidence is cleared;
partial, honestly blocked, corrected, and rejected remain available so the
owner never has to overstate success.

Telegram and BlueBubbles use that same candidate policy and evidence
vocabulary. Chat can show bounded mission status in its registered context, but
only the main private Telegram surface or BlueBubbles self thread may record an
owner verdict; other surfaces receive a calm refusal and create no learning
signal. Asking to mark incomplete work verified returns the exact missing
evidence instead of throwing or silently recording an optimistic outcome.

Response feedback remains deliberately narrower than mission review. Marking a
reply Helpful can improve its cognitive route, but cannot verify the underlying
mission. When that response links to an unreviewed deep-work packet, Andrea's
acknowledgement offers the exact evidence or verdict phrase needed next. Native
BlueBubbles reactions remain silent, and reviewed missions produce no further
invitation.

Debug workflows must declare whether they are read-only, isolated-write, or
live-write. The mission debugger is explicitly isolated-write and uses the
in-memory test database; its realistic fixture output does not create live
missions or skill evidence.

The cockpit tracks the ten-working-day dogfood target, unreviewed missions,
model/provider route, latency, cost, and skill evidence. Real working-day and
owner-review evidence is never backfilled from synthetic fixtures.

## Empirical model routing

The AGI bootstrap compiles its model catalog from pinned defaults plus configured
OpenAI, Anthropic, Gemini, and local model identifiers. Adapter discovery still
determines actual availability; configuration alone is not a health claim.
Provider snapshots now carry an explicit `configuration_only` or `live_probe`
evidence class. The capability registry and model self-description keep a
configured-only provider at `unknown`; an unavailable local model is blocked,
and only an injected or successful live observation becomes healthy.
Live probes also write a bounded owner-only health record for 30 minutes so
subsequent operator reality and readiness checks can reuse recent evidence
without another network call. Cached entries are labeled `cached_live_probe`
and contain only provider ID, state, timestamp, failure class, quota class,
model name, and a bounded repair action. They never contain prompts, responses,
credentials, request IDs, or raw provider errors. Current explicit quota/config
blocks override the cache, expired observations fail back to `unknown`, and
strict configuration-only reporting remains available with
`npm run agi:readiness -- --config-only`.
The council doctor reads the same recent evidence for current provider status
while preserving the recorded participation, failures, and quality of each
historical council run.

Production council routing uses an empirical gate, not task-family breadth as
a proxy for difficulty. Ordinary coding, status, diagnostics, drafting,
calendar, research, approval, and learn-first turns use one capable model.
Council runs only after an explicit deep control, a material disagreement
between viable routes, or planning in a genuinely high-risk production,
security, privacy, credential, deployment, migration, deletion, or payment
domain. Explicit quick mode cannot suppress confirmed high-risk planning
review. Approval enforcement remains independent of model count, and synthetic
or degraded council evidence cannot promote a route.

`npm run debug:grounded-agency` prints the metadata-only capability registry and
twelve redacted routing cases without provider calls. Live comparison is opt-in:

```bash
npm run debug:grounded-agency -- --live --max-cost-usd=25
```

The live runner fails closed without a positive catalog-derived estimate cap,
stops before its estimated next call would exceed that threshold, rotates across
configured providers, stores only provider/model/latency/estimated-cost and
structural outcome metadata, and never stores raw provider output or user
conversation text. It does not reconcile or enforce provider billing. Its final
registry is derived from those same estimate-bounded calls:
any observed failure leaves that provider degraded, while an all-successful
observed provider is healthy. It does not make extra unbudgeted health calls. A
structural pass proves response-contract compliance, not owner-verified task
success. These results inform routing but do not promote a skill or count toward
the dogfood baseline.

Integration health uses the same evidence discipline. Configuration, transport
state, and proof freshness remain separate. A ready Telegram transport can stay
healthy while an old roundtrip marker becomes `near_live_only`; the report gives
the last successful timestamp and asks for a fresh proof instead of relabeling
the transport as failed or copying a success sentence into `lastFailure`.

## Validation

Run the focused proof with:

```bash
node scripts/run-with-pinned-node.mjs --import=./scripts/test-network-guard.mjs ./node_modules/vitest/vitest.mjs run src/evaluation-execution.test.ts src/container-runner.credentials.test.ts src/council-quality.test.ts src/personal-context-packet.test.ts src/routine-promotion.test.ts src/runtime-tool-evidence.test.ts src/runtime-tool-evidence-collector.test.ts src/container-runner.test.ts src/turn-runtime-evidence-scope.test.ts src/verified-deep-work.test.ts src/deep-work-apprenticeship.test.ts src/turn-agent-harness.test.ts src/turn-agent-intelligence-boundary.test.ts src/personal-assistant-metrics.test.ts
npm run container:install
npm run typecheck:agent-runner
npm run build:agent-runner
npm run test:agent-runner
npm run check:container-contract
npm run typecheck
npm run test:continuity:hard-kill
npm run test:continuity:heldout
npm run agi:scorecard -- --no-write --no-dogfood
```

The continuity commands are isolated, deterministic, and network-denied. The
hard-kill harness exercises 12 real process-termination boundaries plus an
eight-process single-grant race. The held-out harness exercises ten recovery
scenarios and requires zero duplicate effects, no live provider calls, no
council calls, no production mutations, and no fixture learning-counter
change. Their output is recovery evidence only: it cannot
create an owner review, save a baseline, promote a skill, prove a live channel,
or establish that the current service is running the candidate.

The schema proof kills after initialization, verifies clean reopen and
idempotent migration, preserves unrelated legacy rows, and rejects a malformed
partial durable schema. It does not kill inside an individual DDL statement;
in-DDL termination is explicitly unclaimed.

Live evaluation is never part of the deterministic gate. When explicitly
approved and budgeted, use:

```bash
npm run agi:scorecard:live -- --max-cost-usd=1
```

The real-world intelligence slice also has a network-denied deterministic
fixture comparison:

```bash
npm run test:real-world-intelligence:heldout
```

It compares the superseded harness-duration target heuristic with explicit
route classification on five synthetic latency fixtures, validates current
percentile and breach attribution, exercises a separate synthetic
execution-truth set, and requires council acceptance to carry complete mode,
verifier, provenance, evidence, approval, privacy, and budget semantics. The
execution fixtures inject aggregate evidence objects; they prove fail-closed
reconciliation behavior, not a live tool run, named artifact, or semantic
postcondition.

The same command also creates a disposable local Git repository, observes a
real failed write and recovery, fingerprints the state transition, and runs a
real syntax test after the final write. Its reconciliation is expected to stop
at `runtime_repository_scope_unbound`: the fixture has not proven a
host-enforced binding between the inspected repository and every read, write,
state probe, and verification. This proves the collector and fail-closed
reconciliation boundary, not container/mount/IPC end-to-end execution or
production-target binding.

The current held-out result passes all six injected execution-truth cases. The
disposable proof also passes by reaching its expected blocked state with
`productionStateTouched: false`; blocked is the safe acceptance result here,
not an incomplete test.

The live council diagnostic writes its fixed estimated-cost reservation before
any outbound call and records it separately from other recorded cost estimates;
neither value is reconciled provider billing.
`--max-cost-usd` is an operator threshold for that estimate, not an enforceable
provider billing maximum, because actual billing is unavailable at this
boundary. The command therefore also requires `--ack-estimate-only` and marks
the result `acceptanceEligible: false` with
`actualBillingCapEnforced: false`. It makes live, potentially billable
provider/search calls and writes redacted local health, council, and metric
evidence. It makes no user-facing send or user/world mutation on the current
coordinator-disabled runtime; if the coordinator is enabled it can also POST
council records.
