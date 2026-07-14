# Memory Ownership And Freshness

## Ownership

- Raw personal memory content lives in the Andrea product layer.
- `Andrea_NanoBot` remains the source of truth for profile facts, life threads, rituals, knowledge-library content, and continuity.
- `andrea_platform` stores only memory metadata, freshness rollups, ritual status, integration health, proof state, and lifecycle/blocker truth.

## Freshness model

- Working memory is live-turn state and should be treated as volatile.
- Semantic memory is durable only when it lands in accepted facts, life threads, or saved knowledge.
- Procedural memory changes rarely and should move only when the user’s rules, rituals, or stable preferences actually change.

## Update triggers

- Profile facts: on accepted preference/person/context updates.
- Life threads: on creation and every canonical commitment transition,
  including strength, owner, waiting, blocker, delegation, deferral,
  reactivation, follow-up, completion, cancellation, or supersession.
- Knowledge library: on save, import, reindex, disable, delete, or last-used updates.
- Rituals: on configuration or execution-state changes.
- Outcome reviews: when a completed loop produces a stable rule worth keeping.

## Platform metadata only

The platform should see:

- memory freshness rollup
- memory index status
- ritual execution status
- proof state for memory-driven journeys

The platform should not store:

- raw private notes
- raw personal facts beyond already-approved product-layer storage
- whole message histories as “memory” just because they were seen once

Commitment-transition evidence remains in the Andrea product layer as bounded,
source-scoped provenance. A historical state is not another active memory item,
and an inferred owner or commitment does not become cross-channel truth without
the life thread's existing scope and confirmation rules. See
[../COMMITMENT_INTELLIGENCE.md](../COMMITMENT_INTELLIGENCE.md).
