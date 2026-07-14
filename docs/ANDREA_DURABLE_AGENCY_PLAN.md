# Andrea Durable Agency Plan

This is the implementation and acceptance plan for Andrea's durable personal
agency kernel. It complements the product guides; it does not authorize
external action, autonomous deployment, or a second task/memory system.

## Product Contract

Andrea should make an ordinary request feel continuous: identify the person and
conversation that made it, preserve an actionable intent, ask only for the
approval that is actually required, verify the result, and explain what is
still uncertain after a restart. It must never turn a recovered or inferred
intent into permission for a new external effect.

The canonical path is:

```text
request -> durable intent -> clarify/plan -> explicit approval -> attempt
        -> receipt + verification -> delivered outcome -> review/learning
```

Research is read-only and may run after its primary response has been
delivered. Calendar, messaging, purchases, deployments, deletes, migrations,
and other external effects remain fresh-approval-only.

## Current Foundation

- `DurableWorkUnit` is the canonical durable record for meaningful coding,
  research, operator, mission, and approval-gated work. It has scope-bound
  checkpoints, leases, one-time resume grants, effect receipts, recovery, and
  postcondition handling.
- The existing action lifecycle supplies a product-level, metadata-redacted
  view of proposals, attempts, reviews, and outcomes. It must mirror existing
  domain ledgers rather than replace them.
- `PersonalContextPacket`, goals, open loops, the Knowledge Library, and
  episodic context stay separate internally and compile only cited, bounded
  context for a turn.
- Google Calendar uses a same-thread draft and explicit confirmation. The
  current candidate gives every pending approved create a stable private
  provider event identity, records an accepted event before outbound delivery,
  and reconciles a retry instead of creating a second event.
- A compound Calendar + research request splits into an approval-gated calendar
  draft and a read-only research sidecar. The calendar response is delivered
  before research starts; research does not grant calendar authority.

## Non-Negotiable Invariants

1. **Identity and scope.** A durable record is bound to owner, channel, chat,
   group, target scope, and work/plan/checkpoint versions. Cross-channel
   continuity is an explicit handoff, never an identifier guess.
2. **No duplicate or blind effect replay.** An attempted external effect has a
   receipt before it is retried. Unknown effects are inspected or surfaced as
   uncertain. Calendar creates use stable provider identity and conflict
   reconciliation.
3. **Approval is specific and expiring.** Approval binds the exact action,
   target, and current plan/checkpoint. Resume, confidence, memory, and a
   previous approval never substitute for it.
4. **Truth is separate from delivery.** Provider acceptance, verification, and
   user-visible delivery are individually recorded. A failed delivery keeps
   evidence for safe reconciliation instead of fabricating failure or success.
5. **Privacy is local and reviewable.** Durable metadata contains opaque IDs,
   fingerprints, redacted summaries, and citations—not raw secrets, prompts,
   tool output, or a passive message archive.
6. **Learning cannot expand authority.** Outcome evidence can improve routing
   and suggestions only after review gates; it cannot promote a tool or routine
   into new external authority.

## Work Packages And Acceptance

| Package | Scope | Acceptance evidence |
| --- | --- | --- |
| Durable execution | Checkpoint, lease, receipt, recovery, and postcondition invariants | hard-kill and held-out continuity proofs; stale/unknown effects never replay |
| Everyday actions | Calendar, reminders, drafts, and follow-through use stable pending state and preserve approval boundaries | focused domain tests; provider failure and delivery failure recovery tests |
| Context and identity | Explicit opt-in provenance, source isolation, expiry, revoke/forget, contradiction handling, and cited retrieval | deterministic packet/privacy/retrieval tests; no raw message archive |
| Research and deep work | Bounded task packets with sources, artifacts, checks, risks, and next decision | routing and deep-work tests; research cannot block an already-delivered primary response |
| Learning | Owner-reviewed outcomes, routine/skill promotion gates, and regression fixtures | five genuine, distinct owner reviews before baseline review; no synthetic promotion |
| Recovery and operations | Startup reconciliation, health classification, safe retries, and restart proof | service status/provenance checks after a committed release; external proof debt remains explicit |

## Evidence Rules

- Deterministic test evidence is offline, network-denied, isolated, and
  zero-cost. It proves behavior, not current external availability.
- A live integration proof requires an explicit, bounded operator action. It
  records only the minimum outcome metadata and is never fabricated from a
  fixture or telemetry event.
- A routine needs a deterministic fixture and a user-approved canary with a
  verified or honestly blocked outcome before promotion. Two recent
  corrections/overrides pause it.
- A baseline needs five distinct owner-reviewed outcomes. Do not create empty
  baselines or count repeated review, drills, or synthetic work.

## Current Candidate And Next Proof

The current worktree includes a calendar-plus-research correction. Before it
can be described as released, run the full repository validation matrix,
review the complete diff for privacy and approval regressions, then commit and
publish the coherent candidate. A real user turn may later prove the compound
journey; that proof must not be manufactured by creating an event or paid
research solely for testing.

Remaining architectural work is deliberately incremental: migrate ordinary
action surfaces into the existing durable/action ledgers where evidence shows a
recovery or audit gap, define explicit canonical identity links rather than
guessing cross-channel identity, and preserve the existing approval gates. Do
not broad-rewrite the router or introduce a competing workflow engine.
