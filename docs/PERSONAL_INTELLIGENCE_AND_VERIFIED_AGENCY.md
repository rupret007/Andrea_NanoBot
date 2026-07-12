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
failed postconditions block completion, and resumed packets must revalidate
stale tool snapshots. Research and coding packets retain sources, artifacts,
checks, unresolved risks, and the next user-readable decision.

Research, operator, repair, and explicitly deep planning turns now create these
packets automatically. A later approval turn binds to the pending packet, and
post-send reflection advances the packet to a verified completion or records an
honest blocker.

## Evaluation and improvement

Deterministic scorecards use isolated database state, an injected synthetic
platform fixture, provider-env suppression, and a process fetch guard that
rejects every non-loopback request. Live evaluation is opt-in and requires an
explicit positive `--max-cost-usd` value.

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
needed, and a deterministic test/replay signal. The review is bridged into one
Agent OS trajectory evaluation, stable skill proposal, cognitive skill card, and
runtime manifest. Two negative outcomes block promotion and quarantine every
linked representation. Promotion never expands authority:
commit, push, deploy, migration, dependency changes, deletion, and other
irreversible actions continue to require fresh approval.

The packet also retains the originating live cognitive-run ID. A mission
verdict therefore updates the same cognitive trajectory instead of creating a
parallel learning record. `verified` is accepted evidence; `corrected` and
`rejected` are negative evidence; `partial` and honestly `blocked` use a neutral
review signal. Neutral reviews count as reviewed outcomes but never inflate the
accepted-run total required for skill promotion. Re-reviewing one packet
updates its stable signal rather than creating duplicate samples.

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

`npm run debug:grounded-agency` prints the metadata-only capability registry and
twelve redacted routing cases without provider calls. Live comparison is opt-in:

```bash
npm run debug:grounded-agency -- --live --max-cost-usd=25
```

The live runner fails closed without a positive cap, stops before exceeding the
cap, rotates across configured providers, stores only provider/model/latency/cost
and structural outcome metadata, and never stores raw provider output or user
conversation text. Its final registry is derived from those same capped calls:
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
npm test -- --run src/evaluation-execution.test.ts src/container-runner.credentials.test.ts src/council-quality.test.ts src/personal-context-packet.test.ts src/routine-promotion.test.ts src/verified-deep-work.test.ts src/personal-assistant-metrics.test.ts
npm run typecheck
npm run agi:scorecard -- --no-write --no-dogfood
```

Live evaluation is never part of the deterministic gate. When explicitly
approved and budgeted, use:

```bash
npm run agi:scorecard:live -- --max-cost-usd=1
```
