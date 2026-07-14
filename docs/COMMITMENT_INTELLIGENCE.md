# Andrea Commitment Intelligence

This document is the authoritative product and engineering contract for how
Andrea represents a human commitment inside a life thread. It describes the
locally verified release-candidate implementation. Publication, exact-SHA
hosted CI, runtime, and live-channel proof remain separate until the release
steps pass the gates in
[TESTING_AND_RELEASE_RUNBOOK.md](TESTING_AND_RELEASE_RUNBOOK.md).

## Why This Exists

An open topic is not automatically an obligation. Andrea must distinguish:

- something the user is merely considering;
- a tentative or intended action;
- a firm commitment;
- an explicit request for Andrea to remind or help;
- work owned by another person;
- work that is waiting, blocked, delegated, or deferred;
- work that is completed, cancelled, or superseded.

Without those distinctions, a personal assistant repeats completed actions,
turns ideas into overdue tasks, nags about impossible work, or silently changes
who owns an obligation. Commitment Intelligence keeps that reasoning in one
canonical state on the existing life thread rather than creating another task
system.

## Canonical Model

Every current life thread can resolve to a versioned
`LifeThreadCommitmentState`. New records store that state directly; older
records receive a conservative compatibility projection when the database is
opened.

| Dimension         | Values                                                                                                                                                                  | Meaning                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Strength          | `speculative`, `tentative`, `intended`, `committed`, `explicitly_requested`                                                                                             | How strongly the evidence supports treating the matter as an obligation                   |
| Operational state | `proposed`, `active`, `waiting`, `blocked`, `delegated`, `deferred`, `completed`, `cancelled`, `superseded`                                                             | The current lifecycle truth                                                               |
| Readiness         | `actionable_now`, `actionable_at_time`, `waiting_on_person`, `waiting_on_external_event`, `blocked_known_dependency`, `blocked_unresolved_dependency`, `non_actionable` | Whether a useful action is possible now and, if not, why                                  |
| Importance        | `normal`, `important`, `critical`                                                                                                                                       | A coarse band recorded only from explicit priority language                               |
| Owner             | `self`, `subject`, `shared`, `andrea`, `unknown`                                                                                                                        | Who owns the next action; named subjects retain stable profile identifiers when available |
| Dependency        | person response/delivery, approval, document, external event, or unresolved                                                                                             | What must happen before the downstream action is possible                                 |
| Evidence          | direct language, conversation context, reminder request, owner, dependency, temporal signal, correction, negation, or state transition                                  | Why the current classification exists                                                     |

The state also retains a bounded objective, current and downstream actions,
deadline, reactivation time or condition, conditional follow-up, confidence,
revision, last transition identity, and source provenance. Evidence is bounded
and reviewable: one derived summary records the typed evidence reasons for each
event, and its source identity is opaque. Raw message text and raw channel
identifiers remain in their existing transport stores; the commitment ledger
does not copy them into a second message archive.

### Strength Is Not Just Future Tense

- `I might submit it Friday` stays speculative or tentative.
- `I am planning to submit it Friday` records intent without overstating a
  firm promise.
- `I will submit it Friday` is a stronger user-owned commitment.
- `I committed to submitting it Friday` is explicit committed evidence.
- `Remind me Friday to submit it` is an explicitly requested Andrea
  follow-through, but it does not grant Andrea authority to submit anything.

A later statement can strengthen or weaken the same commitment. Weakening an
item to an idea makes it non-actionable rather than deleting its provenance.

### Ownership And Authority Are Separate

Ownership says who currently owes the next step. It does not grant execution
authority.

- Delegating to Brandon transfers the current action to Brandon and keeps the
  thread open.
- `Actually, I will handle it` can return ownership to the user when the target
  is unambiguous.
- Shared ownership is represented explicitly.
- Andrea becomes the owner only for an explicit requested action that Andrea
  is allowed to perform, such as a reminder or local save.
- Sends, calendar writes, purchases, repository changes, deployments,
  migrations, and deletions keep their existing fresh-approval requirements.

## State-Transition Rules

Transitions replace all active reasoning fields together. The previous state
remains historical evidence but cannot continue driving snapshots, ranking, or
proactive recall.

| From                               | Signal                                  | To               | Current behavior                                                                               |
| ---------------------------------- | --------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------- |
| Proposed                           | stronger commitment language            | Active           | Strength, owner, action, readiness, time, and evidence update together                         |
| Active                             | completed action plus expected response | Waiting          | The completed action is suppressed; the awaited party or event owns the current dependency     |
| Active                             | named prerequisite                      | Blocked          | The objective and downstream action remain; impossible work is not recommended                 |
| Active                             | clear ownership transfer                | Delegated        | The named person owns the current action; user oversight may remain as a conditional follow-up |
| Any nonterminal                    | explicit deferral                       | Deferred         | Current urgency is suppressed until a known time or condition                                  |
| Waiting/blocked/delegated/deferred | qualifying resolution or take-back      | Active           | The valid downstream action is restored; unresolved dependencies remain unresolved             |
| Any nonterminal                    | credible completion                     | Completed        | Active action, reminder pressure, and follow-through are suppressed                            |
| Any nonterminal                    | credible cancellation                   | Cancelled        | Active action and follow-through are suppressed without claiming completion                    |
| Active value                       | correction                              | Superseded value | Stale date/action evidence remains provenance only                                             |

The transition store uses a stable event identity and monotonic revision. An
exact replay is idempotent. Evidence older than the current revision is
classified as stale rather than reactivating superseded truth. A vague
reference that matches multiple obligations is ambiguous and mutates nothing.

## Waiting, Blocking, Delegation, And Deferral

### Waiting

`I sent Brandon the file and I am waiting for his response` means the send is
done. Andrea must not keep saying `send Brandon the file`. The thread remains
open in `waiting`, Brandon owns the awaited external step, and a conditional
user follow-up may become actionable later.

### Blocking

`I cannot finish the deck until Luke sends the numbers` preserves `finish the
deck` as the downstream objective and records Luke's delivery as the blocker.
Andrea can explain the blocker, but it must not present the impossible
downstream action as executable now. A dependency is satisfied only by
matching evidence; Andrea does not guess.

Multiple dependencies state whether `all` or `any` must resolve. Satisfying one
dependency cannot accidentally unblock an `all` requirement.

### Delegation

Delegation is neither completion nor cancellation. The thread stays open, the
named person owns the next action, and any appropriate user follow-up remains
attached to the same thread. Ownership returns only through clear evidence.

### Deferral

Deferral pauses current surfacing and retains a reactivation time or condition
when one is known. A deferred item is not cancelled. At a valid elapsed horizon,
the snapshot path records a new reactivation transition before treating the
item as active again.

## Conditional Follow-Up

A waiting commitment can carry one connected follow-up rather than creating an
unrelated duplicate obligation. For example:

> I emailed them today. If I do not hear back by Friday, I need to follow up.

The email action is complete, the thread is waiting, and the follow-up becomes
the current user action only if its condition is still unresolved at the
specified time. Evidence that the awaited event occurred suppresses the
unnecessary follow-up.

Business-day windows are calculated using the accepted profile timezone.
Calendar-day and business-day windows remain distinct.

## Ranking And Proactive Recall

Ranking uses coarse, deterministic bands rather than invented precision:

1. current actionability;
2. explicitly stated importance;
3. time urgency;
4. commitment strength;
5. confidence;
6. stable recency and thread identity tie-breakers.

This normally puts an actionable explicit request or firm commitment above a
speculative idea. Waiting, delegated, blocked, and deferred items cannot win
merely because their final deadline is close. A low-confidence overdue
inference cannot outrank a clear current request.

Automatic surfacing is suppressed when the item is:

- speculative or tentative;
- terminal;
- deferred before its horizon;
- waiting, blocked, or delegated without a due follow-up;
- low-confidence without an explicit request;
- manually hidden, disabled, or still snoozed.

User-facing summaries explain the current truth in natural language—for
example, who owns the action, what is blocking it, or when a follow-up becomes
useful—without dumping internal enum names.

## Ambiguity And Privacy

Commitment state is not silently changed when ownership, target, or reference
is unclear. If `that` could name two active obligations, Andrea asks one short
clarifying question and preserves both records. Ambiguity is never resolved by
creating a duplicate thread.

Privacy remains scoped to the life thread's existing group, subject links,
source kind, sensitivity, and surfacing controls. Transition evidence stores a
derived transition reason and one-way-hashed source reference. Credential-like
values are redacted at interpretation, persistence, compatibility projection,
router-state, and response boundaries. The ledger does not authorize passive
message ingestion, copy a full conversation, cross group boundaries, or make a
sensitive inferred topic durable without confirmation.

Outbound communication drafts never receive life-thread support merely because
the same person appears in both records. Support requires an explicitly carried
thread, topical overlap, recipient-safe subject scope, normal sensitivity, and
an actionable non-suppressed commitment. Persisted command-only summaries that
are linked to sensitive, manual, disabled, waiting, or otherwise unsafe planning
state are not trusted. Profile facts may select only a closed local style label;
their text never becomes draft support, a conversation title, or a provider
hint. The optional Messages cloud-review prompt receives only the review item's
bounded message evidence, not unrelated profile or life-thread memory.

Council `metadata_only` evidence withholds semantic values and emits only
approved non-semantic metadata; `local_only` cards remain unavailable to
providers. A life-thread semantic
snippet additionally requires normal sensitivity, proactive eligibility, an
enabled and unrevoked source-memory policy, and explicit per-request provider-
egress consent; ambiguous source provenance fails closed. Accepted profile
facts remain metadata-only because they do not yet carry a sufficient per-record
sensitivity and provider-consent contract.

## Persistence And Migration

The database migration is additive:

- `life_threads.commitment_state_json` stores canonical current truth;
- `life_thread_signals.commitment_transition_json` stores append-only
  transition provenance.

The active state and its legacy compatibility fields (`status`, `nextAction`,
`nextFollowupAt`, snooze, and follow-through mode) update in one immediate
transaction. Existing consumers can read the compatibility projection while
commitment-aware consumers use the canonical state. Transition-bearing signal
rows cannot be overwritten by the ordinary signal-upsert path.

Legacy rows carrying the exact released `{}`/null sentinel are backfilled
conservatively and idempotently. Terminal and paused records remain terminal or
deferred, and an active legacy row without a real next action becomes
non-actionable rather than receiving an invented task. A nonempty malformed or
unsupported future canonical document is preserved byte-for-byte and startup
fails closed; Andrea does not overwrite newer truth or disguise corruption as a
legacy row. Migration does not delete owner data or reinterpret preserved
session caches. Legacy compatibility titles, summaries, and next actions are
redacted in the same transaction as sentinel backfill, and the read boundary
sanitizes them independently for restored valid-canonical rows. An operator
must preserve the database, diagnose an invalid canonical document, and repair
it through an explicit reviewed recovery—not by deleting or silently
reprojecting it.

## Production Consumers

The candidate updates the shared life-thread snapshot and the major consumers
that present or reason over ongoing matters:

- daily companion and chief-of-staff guidance;
- rituals and follow-through;
- personal-context graph and memory activation;
- Cognitive Executive and council evidence summaries;
- communication companion and session graph;
- outcome reviews and owner-cockpit controls;
- reminder-linked life-thread synchronization.

Those consumers receive the effective current state and human-readable
description. Historical transition states are not independent active tasks.

## Certification

The release gate for this capability is
`npm run certify:commitment-intelligence`. It is expected to:

- use a disposable database, unique synthetic namespace, deterministic clock,
  synthetic identities, and the process network-deny guard;
- exercise all 24 required primary scenarios plus 15 structurally different
  held-out cases;
- close and reopen the database through the production persistence path at
  least twice, including transitions between restarts;
- replay duplicate and stale out-of-order evidence;
- fail the command for every non-`PASS` scenario;
- remove its cleanup manifest, database, WAL, SHM, and all synthetic records;
- run an independent production-database residue search.

The focused unit and integration suite must additionally cover interpretation,
atomic persistence, migration, ranking, ambiguity, reminder/outcome bridging,
temporal truth, completion, cancellation, and privacy. See
[TESTING_AND_RELEASE_RUNBOOK.md](TESTING_AND_RELEASE_RUNBOOK.md) for the full
repository, AGI, deterministic, audit, hosted-CI, build, restart, and runtime
gates.

No scenario count, hosted check, runtime SHA, cleanup result, or live-channel
proof in this document should be treated as passed until
[CURRENT_STATUS.md](CURRENT_STATUS.md) records the final release evidence.

## Intentional Limits

- This is bounded deterministic interpretation, not general mind reading.
- Unknown pronouns, vague ownership, and competing targets require
  clarification.
- Importance is deliberately coarse and explicit-language-only. Andrea does
  not infer a hidden consequence score or numerical user-priority value from
  weak context. Broader trusted context may still shape a recommendation, but
  it cannot silently rewrite the canonical importance band.
- A future condition with no reliable time stays condition-bound.
- The implementation does not create a new autonomous workflow engine or grant
  new execution authority.
- Destructive selective multi-item forgetting remains unimplemented. Stable
  thread, transition, and source identities preserve the basis for a future
  separately authorized design.
- Synthetic certification is repository evidence, not a real user outcome,
  owner-reviewed learning sample, or live integration proof.

## Operator Checklist

Before calling the capability released:

1. Run the focused commitment and life-thread tests.
2. Run the strict commitment certification and inspect its primary, held-out,
   restart, and cleanup reports.
3. Run the complete release matrix and exact-SHA hosted checks.
4. Build from the final clean commit and restart the canonical service.
5. Confirm the serving SHA, process identity, datastore health, bridge tools,
   and passive integration status.
6. Record unavailable Telegram, BlueBubbles, Alexa, or other live proof as
   operator debt; never substitute synthetic evidence.
