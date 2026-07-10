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

Use `npm run debug:assistant-intelligence` for the metadata-only operator view.
Add `-- --save-baseline` only when the current sample is the reviewed baseline.

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
