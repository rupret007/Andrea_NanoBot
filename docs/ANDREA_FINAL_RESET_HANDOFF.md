# Andrea Final Reset Handoff

Snapshot date: 2026-07-14. Use `git rev-parse origin/main` and
`npm run services:status` for the current release SHA and serving provenance;
the sections below retain the exact baseline SHA for each bounded pass.

## Commitment Intelligence Handoff — Repository Evidence Complete

This is the current candidate above released baseline
`0a71d4bcb4308d49ae057473356af03c0d0465fb`. The older temporal and
life-thread sections below remain historical before-state evidence. They must
not be read as proof of the new commitment model.

The candidate introduces one canonical versioned state for commitment
strength, operational state, readiness, typed ownership, dependencies,
conditional follow-up, bounded evidence, confidence, revision, and transition
identity. Atomic state transitions synchronize the compatibility projection
while retaining append-only provenance. Deterministic ranking favors useful
actionable work; speculative/tentative, unresolved waiting/blocked/delegated,
prematurely deferred, terminal, low-confidence, manual-only, disabled, and
snoozed work is suppressed from automatic recall. Duplicate replay is
idempotent, older evidence cannot revive superseded truth, and ambiguous target
or ownership changes mutate nothing.

The full model, migration, privacy, authority, consumer, and certification
contract is in
[COMMITMENT_INTELLIGENCE.md](COMMITMENT_INTELLIGENCE.md). The authoritative
work checklist is the first section of [MODERNIZATION_PLAN.md](../MODERNIZATION_PLAN.md).

| Evidence                                  | Current state                                                                                                                                              |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline broader life-thread matrix       | 6 `PASS`, 2 `PARTIAL`, 2 `FAIL`; retained as historical before-state evidence                                                                              |
| Commitment primary / held-out matrix      | 24/24 primary, 15/15 held-out, 3/3 boundary invariants                                                                                                     |
| Durable restart/replay/cleanup            | 18/18 durable reopens; exact/stale replay covered; 0 isolated and 0 production residue; final run `ANDREA-COMMITMENT-B8A5438A-BC9C-448B-BB02-5C5EB164800D` |
| Temporal durable truth                    | 13/13, two restarts, zero production residue; run `ANDREA-TEMPORAL-20260714T202649623Z-5D75F95B`                                                           |
| Root/AGI/build/stability                  | 231 files / 2,790 tests; 28 AGI files / 282 tests; three complete stability rounds                                                                         |
| Scorecard/signatures/docs/audits          | 100% A+ and $0; 6/6; 70/70; zero root or runner vulnerabilities                                                                                            |
| Container proof                           | Runner install/typecheck/build/contracts, image canary, and nested read-only mount canary passed                                                           |
| Deterministic sweep                       | 94/94 selected from 109 total with 15 exclusions, 271.6 seconds; nested three-round stability passed in 204.0 seconds                                      |
| Final commit/hosted CI/restart/provenance | Pending release steps; never infer them from the local tree                                                                                                |
| Live Telegram/BlueBubbles/Alexa proof     | Pending or explicit operator debt; never synthetic                                                                                                         |

Repository proof is not a deployment claim. Publication, exact-SHA hosted
checks, clean rebuild, service restart, serving provenance, and passive live
checks remain explicit release steps.

The final audit also closed two defects before publication: legacy
compatibility fields are redacted transactionally during sentinel migration
and sanitized again on read, and suppressed/non-actionable commitments cannot
be selected as automatic Cognitive Executive focus. Explicit owner lookup is
unchanged.

## Temporal truth and durable restart certification

Label: `ANDREA TEMPORAL TRUTH AND DURABLE RESTART CERTIFICATION`

The round began from clean, synchronized, and serving `main` at
`4b8571f64230fabaf1ea0b74f346c1f1afecc224`. Before implementation,
`npm run certify:life-thread` reproduced both selected defects: temporal
supersession was `FAIL` because Northstar's summary said Friday noon while its
active `nextAction` still said Thursday at 5:00 PM, and restart recovery was
`FAIL` because a real disposable SQLite close/reopen preserved that stale
active value.

The final isolated run was
`ANDREA-TEMPORAL-20260714T202649623Z-5D75F95B`: 13 `PASS`, 0 `FAIL`, cleanup
entries removed, zero production residue, and no retained database, WAL, SHM,
directory, or manifest. The companion broader lifecycle run was
`ANDREA-LIFETHREAD-20260714T202651604Z-B88DB9A8`: 6 `PASS`, 2 `PARTIAL`, 2 `FAIL`;
the two remaining failures are the explicitly out-of-scope tentative-state and
multi-target-forget scenarios.

### Root cause and production correction

The save/update path treated a newer temporal correction as another historical
signal and summary, while deliberately retaining `existing.nextAction`. It had
no canonical temporal parser, no synchronized mutation of active planning
fields, no supersession provenance, and no correction-ingestion identity.

The bounded correction now:

- interprets explicit dates, relative dates, weekday changes, date-only,
  time-only, date-and-time, earlier/later, and one-week extensions with a
  deterministic reference clock and the subject's accepted timezone;
- resolves only a unique lexical target, one sufficiently context-bound target,
  or the sole active obligation; two plausible targets produce an explicit
  clarification result and no write;
- atomically sets the sole active temporal value in `nextFollowupAt` and
  synchronizes the current `summary` and `nextAction` so stale text cannot drive
  snapshots, urgency, follow-through, retrieval, or daily output;
- stores the old value only in an explicit `temporal_supersession` signal, and
  uses a deterministic correction-signal ID so exact replay is idempotent;
- preserves completion, cancellation, privacy, and one-thread deduplication
  behavior without adding a second temporal store or changing authority.

### Before-and-after matrix

| Scenario                    | Baseline      | Post-change | Machine evidence                                                                                                                                      |
| --------------------------- | ------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deadline supersession       | `FAIL`        | `PASS`      | Friday 3:00 PM became Monday noon in `nextFollowupAt`, `summary`, and `nextAction`; the old timestamp exists only in an explicitly superseded signal. |
| Restart recovery            | `FAIL`        | `PASS`      | Monday noon survived a full close/reopen; a post-restart Tuesday-morning correction survived a second close/reopen.                                   |
| Multiple corrections        | Not certified | `PASS`      | A became B and B became C on one thread with three total lifecycle signals.                                                                           |
| Duplicate ingestion         | Not certified | `PASS`      | Replaying the exact correction returned `duplicate`, did not change `lastUpdatedAt`, and did not add a signal.                                        |
| Ambiguous correction        | Not certified | `PASS`      | `Move it to Tuesday` with two plausible active obligations requested clarification and changed neither.                                               |
| Active-consumer convergence | `FAIL`        | `PASS`      | One thread, one active snapshot record, no stale current text, and zero scheduled-task duplicates after restart.                                      |

The isolated held-out matrix also passes ordinal `19th, not the 16th`, `another
week`, a mixed meeting/application sentence, a past deadline, a time-only
change, a relative-date change, and `Push that to Tuesday morning`. These tests
assert timestamps and stored state rather than response wording.

### Certification and cleanup contract

`npm run certify:temporal-truth` creates a manifest before seeding, creates one
synthetic profile subject with an accepted `America/Chicago` timezone, uses a
unique group/chat namespace and disposable SQLite file, and never writes a real
user, Calendar, contact, message provider, or production database. It performs
two durable close/reopen cycles through `_initTestDatabaseAtPath`. Cleanup
unlinks the database directory, WAL/SHM, and manifest, then independently opens
the production database read-only and requires zero run-ID, namespace, or
created-ID residue. A scenario or cleanup failure makes the command fail.

At the time of this historical temporal round, structured tentative/waiting
states, scoped multi-item forgetting, and general proactive-recall paraphrase
expansion were intentionally unimplemented. The current candidate above adds
structured commitment/waiting state and its repository certification passes;
publication and runtime proof remain separate. Scoped destructive multi-item
forgetting remains intentionally unimplemented.

### Repository validation

- Focused affected-consumer pass: 8 files / 106 tests; final focused temporal,
  life-thread, chief-of-staff, and daily-companion rerun: 4 files / 56 tests.
- Full primary gate: 230 files / 2,727 tests, root typecheck, formatting,
  production build, and lint with zero errors. The unchanged repository warning
  backlog is 649; touched temporal code adds no warning.
- AGI gate: typecheck plus 28 files / 282 tests.
- Hermetic deterministic sweep: 93/93 selected commands passed, including the
  189.5-second three-round stability gate.
- Offline scorecard: 100.0% A+, all nine dimensions at 100%, no merge-blocking
  regression, network denial active, 2,453 ms, and $0.0000 cost.
- Six signature flows, 69-file documentation check, root and container-runner
  production/full dependency audits, formatting, and whitespace checks passed.

Implementation commit `6d14ebf3c0682e179d8cecc4be43ff2f31f71f10`
was pushed directly to `main`. Its exact-SHA Ubuntu, Windows, container, AGI,
and CodeQL jobs passed. The clean release artifact was rebuilt with zero dirty
paths; OpenClaw restarted at PID 49107 with a healthy control API and 11/11
required bridge tools, and Andrea restarted at PID 49652 with boot ID
`host-76461-1780389249797` serving that implementation commit. A documentation-
only forward commit may advance repository and serving SHA; use the commands at
the top of this handoff for current identity rather than treating these process
IDs as durable health evidence.

## Synthetic life-thread certification

Label: `SYNTHETIC LIFE-THREAD CERTIFICATION`

The pass began from clean, synchronized `main` at
`41304345970b67e619de36ce59592a40c2d0993d`. Run ID
`ANDREA-LIFETHREAD-20260714T160100Z-A7C4D2E1` used a disposable SQLite file
opened through `_initTestDatabaseAtPath`, a unique synthetic group/chat
namespace, an offline Calendar fake, and no external provider destination.
It did not open Jeff's production database for writes.

The fixture represented Maya Ellis, an independent operations consultant in
`America/Chicago`, using an isolated profile subject and two accepted profile
facts. It created bounded life-thread records for the Northstar proposal, air filters, a tentative
pottery idea, insurance paperwork waiting on another person, a plumbing
inspection, an expense report, a cancelled repair meeting, and a fictional
verification phrase. Later turns corrected and paraphrased Northstar, completed
the expense report, cancelled the repair meeting, reloaded the durable test
database, and attempted selective forgetting. Every stored summary included
the run ID.

### Scenario results

| #   | Scenario                   | Baseline  | Post-change | Machine evidence                                                                                                                                            |
| --- | -------------------------- | --------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Initial proactive recall   | `PARTIAL` | `PARTIAL`   | Eight active items; concise three-line response; no verification-phrase leak, but recency chose the repair meeting instead of the urgent proposal.          |
| 2   | Completion suppression     | `FAIL`    | `PASS`      | Natural completion changed the expense thread from active to closed, cleared follow-through fields, and added one explicit terminal signal.                 |
| 3   | Cancellation suppression   | `FAIL`    | `PASS`      | Natural cancellation changed the repair-meeting thread from active to closed and added one explicit cancellation signal.                                    |
| 4   | Temporal supersession      | `FAIL`    | `FAIL`      | The latest summary says Friday at noon, but `nextAction` still contains Thursday at 5:00 PM.                                                                |
| 5   | Semantic deduplication     | `PASS`    | `PASS`      | Three Northstar signals remain attached to one underlying thread.                                                                                           |
| 6   | Waiting state              | `PARTIAL` | `PARTIAL`   | The Jordan blocker text is retained, but waiting is not a structured life-thread state.                                                                     |
| 7   | Tentative versus committed | `FAIL`    | `FAIL`      | A tentative idea is still stored as an active obligation.                                                                                                   |
| 8   | Privacy and relevance      | `PASS`    | `PASS`      | Proactive recall stayed concise and did not expose `ORCHID-LANTERN`.                                                                                        |
| 9   | Restart recovery           | `FAIL`    | `FAIL`      | Durable reopen now preserves completion/cancellation suppression and one deduplicated Northstar thread, but the stale deadline still controls `nextAction`. |
| 10  | Selective forgetting       | `FAIL`    | `FAIL`      | One multi-target natural forget request is not handled; unrelated active state remains intact.                                                              |

Aggregate lifecycle evidence moved from 2 `PASS`, 2 `PARTIAL`, and 6 `FAIL`
to 4 `PASS`, 2 `PARTIAL`, and 4 `FAIL`. This is synthetic certification, not
real adoption, an owner review, or a learning baseline.

### Selected defect and correction

The one selected defect was terminal life-thread state loss: natural reports
that an obligation was completed or cancelled did not reach the life-thread
state machine, so finished work remained active and resurfaced after context
reload. The underlying handler only supported explicit close/archive commands.

The correction recognizes bounded completion/cancellation language, resolves
the target from a unique lexical match or sufficient prior thread context,
fails open to the normal assistant path when the target is ambiguous, closes
the matching thread, clears active follow-through fields, and retains an
explicit historical terminal signal. It contains no synthetic names or fixture
phrases in production logic.

Held-out completion (`That task is taken care of now`) and cancellation (`We
are not doing the Friday contractor meeting anymore`) both pass. Ambiguous
`I finished it` without context closes nothing. The held-out Northstar deadline
correction, tentative photography idea, and alternate recall query remain
failing; the held-out duplicate remains one thread. Those failures were not
folded into a second production change.

### Validation and cleanup

- Focused life-thread/context suite: 7 files / 166 tests passed.
- AGI memory, episodic, knowledge-graph, and deterministic-replay subset:
  4 files / 20 tests passed.
- Full primary suite: 638 suites / 2,720 tests passed.
- Root and AGI typechecks, formatting, lint (zero errors; 649 existing
  warnings), and production build passed.
- The certification harness created a cleanup manifest before seeding. Its 16
  entries covered the isolated database, manifest, profile subject/facts, and
  all life threads with cascading signals. Threads/signals were deleted, the database/WAL/SHM and
  manifest were unlinked, and an independent read-only production search found
  zero run-ID, namespace, or created-ID residue.
- Independent generic-name searches found zero production observations for
  Maya Ellis, Northstar, Priya, Jordan, and `ORCHID-LANTERN`. One uncorrelated
  pre-existing `Leo` observation remains in real state; it has no certification
  run ID, namespace, or created artifact ID and was not read, changed, or
  deleted by this pass.
- No synthetic messages, provider sends, scheduled jobs, pending actions,
  conversations, or runtime files remain. No real user state was changed.
- Intentionally retained immutable evidence is limited to the generalized
  certification harness, sanitized regression fixtures, and this summary; no
  synthetic runtime database or transcript was retained.

### Next full-reset priorities

1. Add bounded structured `waiting` and `tentative` semantics, then rank urgent
   obligations above scheduled facts and low-urgency ideas.
2. Support scoped multi-item forgetting and route held-out proactive-recall
   paraphrases through the same local loose-ends behavior.
3. Collect one genuine owner-reviewed life-thread outcome after release; do not
   convert synthetic certification into a learning-baseline sample.

## Latest live transport pass

- Telegram is `VERIFIED`. The production user-session `/ping` sent message
  `11709`, received exactly one expected reply `11710`, and persisted the fresh
  marker at `2026-07-14T15:10:07.618Z` in
  `data/runtime/telegram-roundtrip-health.json`.
- BlueBubbles transport is ready and OpenClaw is live with 11/11 bridge tools,
  but the exactly-once certification is `FAILED`. Correlation
  `BB-CERT-20260714T154100Z-3A02430C` reached the correct read-only
  `andrea-bluebubbles__bluebubbles_status` tool and produced grounded replies,
  but the same physical self-thread request was mirrored under phone and email
  aliases with different provider IDs. OpenClaw therefore recorded two
  read-only calls. No send tool, message-action execution, calendar write, or
  other mutation occurred.
- Alexa is `BLOCKED` for this pass and its prior proof is `STALE`. There is no
  authenticated Alexa simulator/device client in this environment. The last
  qualifying handled signed request remains `WhatAmIForgettingIntent` at
  `2026-06-03T13:57:39.518Z`. No unsigned local call was substituted for signed
  proof.

BlueBubbles evidence is retained in the local message ledger and in these
OpenClaw transcripts:

- `$HOME/.openclaw/agents/main/sessions/d8236900-084d-40f1-91e2-d546f6789721.jsonl`
- `$HOME/.openclaw/agents/main/sessions/abfecee0-3436-4d3f-b927-e2afe3e19d3a.jsonl`

The repository now recognizes the configured Messages self-thread as an
OpenClaw owner surface, routes direct and durable asks through the same
connector, uses a fast gateway health preflight, and suppresses a physical
self-thread message mirrored across aliases even when BlueBubbles changes the
message ID and timestamp slightly. The regression test also proves the guard
does not swallow an intentional repeat outside the two-second mirror window.
Focused transport tests and root typechecking pass. No further BlueBubbles live
probe was sent after the final dedupe correction, so the fix is repository
verified but not yet live recertified.

Exact remaining proof steps:

```bash
npm run services:status
npm run debug:bluebubbles -- --live
npm run openclaw:bridge:status -- --json
```

Then send one new uniquely correlated `@OpenClaw` request in the configured
canonical Messages self-thread that requires exactly one read-only
`bluebubbles_status` call. Confirm one request session, one tool call, and one
same-thread reply before changing the result to `VERIFIED`. Do not repeat the
probe if provider outcome is indeterminate.

For Alexa, use a real device or authenticated Alexa Developer Console
simulator, say `Open Andrea Assistant`, then `What am I forgetting?`, and run
`npm run services:status`. Success requires a fresh handled signed
`IntentRequest` with `WhatAmIForgettingIntent`; local HTTP is diagnosis only.

### Next full-reset priorities

1. Run one BlueBubbles/OpenClaw recertification after the alias-dedupe release
   and require exactly one read-only tool call and one same-thread reply.
2. Complete the fresh signed Alexa device/simulator turn and confirm the
   request type, intent, handled response source, and freshness marker.
3. Complete one genuine BlueBubbles `message_action` continuation and one
   life-thread save/retrieval turn without manufacturing evidence.

## Prior release handoff (preserved history)

The pushed baseline inspected for the prior pass was
`9dd2b1e7` on `main`, aligned with `origin/main` before the change below.
The completed code-bearing pass was pushed as `d74b8191` (`Require Alexa
calendar confirmation`). A later handoff-only commit may contain this line;
use `git rev-parse origin/main` for the repository's current documentary HEAD.

## Surgical improvement

Alexa calendar creation bypassed the shared confirmation contract. A request
with one writable calendar wrote immediately, and choosing a calendar from a
multi-calendar draft also wrote instead of advancing to `confirm_create`.

The Alexa adapter now persists every create draft, asks for fresh confirmation,
and lets the shared `advancePendingGoogleCalendarCreate` state machine decide
whether `AMAZON.YesIntent` authorizes the write. Calendar selection only
selects. Existing stable provider identity remains attached to the persisted
draft, so the subsequent confirmed write retains retry reconciliation.

Changed implementation and proof:

- `src/alexa.ts`
- `src/alexa.test.ts`

## Executed verification

- Focused: `src/alexa.test.ts`, `src/google-calendar-create.test.ts`,
  `src/calendar-research-coordinator.test.ts`, and
  `src/calendar-research-sequencing.test.ts`: 4 files / 183 tests passed.
- Full root suite: 229 files / 2,712 tests passed.
- `npm run format:check`: passed.
- `npm run lint`: passed with zero errors; the existing warning-only catch-all
  backlog remains.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm run docs:check`: passed for 68 Markdown files.
- `git diff --check`: passed.

The tests prove that natural-language and structured Alexa calendar requests do
not call the provider before confirmation, a calendar choice does not call the
provider, and a subsequent explicit `yes` produces exactly one create call.
Nearby tests also preserve targeted confirmation, provider-idempotency
reconciliation, research-only non-mutation, and compound Calendar/research
sequencing.

## Still unverified

- No real Alexa device or authenticated simulator request was sent. The current
  signed Alexa proof is stale, so voice recognition of the confirmation turn is
  still operator evidence debt.
- No real Google Calendar event was created or deleted for this pass. Provider
  acceptance, response delivery, and restart recovery are covered by isolated
  tests, not a new live destructive canary.
- The compound Calendar + research journey still lacks one genuine
  post-release user turn. No paid research or calendar mutation was
  manufactured for validation.
- Telegram and BlueBubbles were not mutated. Their current transport/proof
  status must be read from `npm run integrations:status -- --json` before a
  live drill.

## Next full-budget objectives

1. Add an Alexa end-to-end interruption fixture that stops after provider
   acceptance but before spoken-response delivery, reloads persisted state,
   and proves the retry reconciles the same event without a second write.
2. With owner approval, run one disposable real-device Alexa canary: request a
   clearly named event, verify no event exists before the confirmation turn,
   say `yes`, verify exactly one matching event, then explicitly approve its
   deletion.
3. Run one genuine Telegram or BlueBubbles compound request using a disposable
   event and bounded research question; verify the event title excludes the
   research clause, research starts only after draft delivery, and mutation
   occurs only after the targeted calendar confirmation.

Operator commands for the remaining proof:

```bash
npm run services:status
npm run integrations:status -- --json
npm run debug:alexa-conversation -- --review
```

For Alexa, use the real device or authenticated simulator. For Telegram or
BlueBubbles, use the existing owner thread. Do not run the mutating canaries
without explicit approval for the exact disposable event and cleanup.
