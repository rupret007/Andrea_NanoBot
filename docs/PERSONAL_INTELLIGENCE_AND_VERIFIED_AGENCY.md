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
revoke, forget, or allow a fact to expire. Retrieval uses local lexical scoring
and can combine an injected semantic scorer; every returned item retains a
citation. Profile memory, the Knowledge Library, and episodic/context-graph
state remain separate stores even though the packet presents one bounded view.

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

`npm run debug:grounded-agency` prints the metadata-only capability registry and
twelve redacted routing cases without provider calls. Live comparison is opt-in:

```bash
npm run debug:grounded-agency -- --live --max-cost-usd=25
```

The live runner fails closed without a positive cap, stops before exceeding the
cap, rotates across configured providers, stores only provider/model/latency/cost
and structural outcome metadata, and never stores raw provider output or user
conversation text. A structural pass proves response-contract compliance, not
owner-verified task success. These results inform routing but do not promote a
skill or count toward the dogfood baseline.

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
