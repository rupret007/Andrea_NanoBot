# Andrea Current Status

Local operator and repository snapshot updated 2026-07-15. Runtime and integration
proof is time-sensitive; rerun `npm run debug:status`,
`npm run services:status`, and `npm run integrations:status -- --json` before a
release or demo. The release facts below describe their recorded tree; they do
not replace current Git, hosted-check, or runtime provenance.

## Repository And Release

- Release state is intentionally time-sensitive. Before a release or demo,
  treat `git status --branch`, `npm run services:status`, and
  `npm run integrations:status -- --json` as the authoritative source for the
  active commit and runtime provenance; this document does not pin a serving
  SHA that will become stale after the next release.
- Verified Production Apprenticeship application commit
  `3dbfae9c9165be73a5cf06eaed4040d3e68b7457` is published on `main` and
  includes Verified Capability Acquisition and Commitment Intelligence. A
  documentation-only closure may advance `main`; source presence still does
  not substitute for the status commands above.
- Exact-SHA CI run `29434979875`, AGI/CodeQL run `29434979968`, and Security run
  `29435006959` passed Ubuntu, Windows, container, AGI, CodeQL,
  dependency-audit, verified-secret-scan, and Semgrep gates.
- A clean 2,308-file Mac artifact was built from `3dbfae9c` with SHA-256
  `43b62d4457b0e316e525acc8c70e93df98b80ee1fb0b4d0f4a031be14f97da61`.
  OpenClaw restarted from PID 11235 to 36162, and Andrea restarted from PID
  23216 to 36929 with boot ID `host-76461-1780389249797`; serving, build, and
  workspace SHAs aligned with zero dirty paths. The bounded 2026-07-15 cleanup
  removed about 3 GiB of regenerable npm, pnpm,
  Homebrew, Node, and TypeScript caches while preserving Docker volumes and
  images, Codex state, model data, messages, sessions, repository dependencies,
  build output, and Andrea's live database.
- Post-restart OpenClaw connectivity, 11/11 bridge tools, direct-send exclusion,
  local Alexa health/OAuth endpoints, BlueBubbles transport/webhook, Telegram
  transport, Google Calendar, research, image generation, cached provider
  health, and Brave Search status all passed. No new error-class log entry or
  false Brave-down transition was found.

## Verified Repository Gates

- Primary suite: 249 files / 3,006 tests, plus a successful production build.
- AGI suite: 28 files / 286 tests.
- Deterministic sweep: 97/97 selected commands passed from an inventory of 112;
  the other 15 are explicitly excluded live, interactive, aggregate, or
  state-writing commands, not silent passes. Its nested three-round stability
  gate passed in 260.8 seconds; the full sweep completed in 348.0 seconds.
- Offline scorecard: 100% A+, isolated storage, network denied, zero live cost.
- Production-apprenticeship certification passed 22/22 scenarios and its gate
  rejected 120 mutations; the real process-death suite passed all four
  `SIGKILL` boundaries without replay or residue.
- Container runner typecheck/build, 13 runner tests, 132 host contract tests,
  pinned image canary, nested read-only mount canary, signature flows, 72-file
  documentation checks, and root/runner production and full dependency audits
  passed on the released application tree.

## Verified Production Apprenticeship — Released Implementation

The released application implements the canonical production bridge above Verified
Capability Acquisition: bounded canary staging, consumption of a separately
approved exact canary packet, durable read-only execution, independent
postcondition verification, canonical outcome, exact private owner verdict,
separate activation proposal and approval, monitored active reuse, and owner
pause/revoke/retire controls. Disconnected identifiers, stale heads, scope or
version mismatches, stale health, approval/lease mismatches, negative evidence,
and authority violations fail closed.

The only guided executable contract is the bundled zero-egress Andrea
Release-Readiness Brief. `npm run capability:prepare-release-readiness` creates
or reuses only synthetic preproduction acquisition evidence; it creates no live
canary, approval, owner verdict, provider call, external effect, or activation.
`npm run capability:canary` is a multi-invocation operator guide. It never
approves a packet or records an owner verdict. Reviews come only from the
registered main Telegram chat, configured Messages self-thread, or authenticated
owner cockpit; activation requires a new exact approval after a verified
verdict. Runtime semantic reuse is deliberately limited to narrow read-only
release-readiness questions on the same trusted owner chat and scope.

Local deterministic proof passed all 22/22 A-V scenarios. It was offline,
network-denied, provider-suppressed, disposable, metadata-only, and explicitly
`certification_synthetic`, with zero provider calls, cost, external effects,
production writes, genuine owner evidence, privacy leaks, or cleanup residue.
The companion gate rejected 120 mutations across all 22 failure codes. That is
repository certification only. No real release-readiness canary, owner verdict,
activation, or active reuse is recorded or claimed here. The guarded
post-release preparation created only a labeled synthetic
`owner_review_required` record. Local, hosted, rebuild, restart, and runtime-
provenance gates passed; genuine owner evidence remains the next separate step.

## Verified Capability Acquisition

The tree containing this section adds a group-scoped transition ledger, a
resource broker, metadata-only explicit-turn observation, declared identity/
version-digest-pinned independent executor/evaluator bindings, canonical durable-work
sandbox receipts and checkpoints, negative-evaluation quarantine, and a strict
offline certification with ten primary and fifteen held-out scenarios. External
documentation remains untrusted data, synthetic evidence stops at
`sandbox_verified`, and acquisition grants no new authority. The certification
uses trusted test-authored adapters and is not an OS isolation boundary.
The released acquisition foundation's caller-asserted live canary, activation,
and production-outcome paths fail closed. The released Verified Production
Apprenticeship implementation adds the required canonical durable-work,
outcome, owner-review, health, approval, lease, and receipt joins; its presence
is still not evidence that any genuine canary or activation occurred.

Application commit `48aaf2dc` is published and was rebuilt and restarted on the
canonical Mac host; source presence alone is still not deployment evidence. The local
round passed 238 primary files / 2,881 tests, 28 AGI files / 286 tests, 96/96
selected deterministic commands from 111 total with 15 explicit exclusions,
three stability rounds, a 100% A+ zero-cost offline scorecard, 6/6 signature
flows, 71/71 documentation files, dependency audits with zero vulnerabilities,
and the strict 10-primary/15-held-out certification plus all 88 policy
mutations across 31 failure classes. The current acceptance checklist is the
first section of
[MODERNIZATION_PLAN.md](../MODERNIZATION_PLAN.md); the lifecycle and boundaries
are in
[VERIFIED_CAPABILITY_ACQUISITION.md](VERIFIED_CAPABILITY_ACQUISITION.md).

## Commitment Intelligence — Published And Serving

Commitment Intelligence is published on `main` in application-bearing commit
`ac72ede1`. Its repository gates, exact-SHA hosted checks, clean rebuild,
dependency-ordered service restart, serving provenance, and passive integration
checks passed. A later documentation-only closure commit may advance `main`;
use the commands above for current identity rather than treating a PID or short
SHA in this snapshot as permanent.

Implemented and locally verified:

- one versioned canonical commitment state per life thread, with strength,
  operational state, readiness, coarse explicit importance, typed owner,
  dependencies, conditional follow-up, confidence, derived evidence, revision,
  and transition identity;
- append-only commitment-transition provenance alongside atomic compatibility
  projection for released life-thread consumers;
- structured waiting, blocking, delegation, deferral, strengthening,
  weakening, completion, cancellation, reactivation, and supersession;
- deterministic coarse ranking and conservative proactive-surfacing rules;
- idempotent exact replay, stale-evidence refusal, and ambiguity-safe targeting;
- additive sentinel-only legacy migration that fails closed on nonempty invalid
  canonical bytes, plus commitment-aware snapshots, daily guidance, rituals,
  context, cognitive, communication, outcome, and cockpit consumers;
- recipient-safe outbound drafting and policy-enforced council evidence that do
  not expose sensitive/manual/disabled/waiting planning context or raw values
  under metadata/local-only policies;
- transactional legacy-field redaction plus an independent read-boundary
  sanitizer, and Cognitive Executive focus filtering that honors manual-only,
  disabled, snoozed, speculative, and non-actionable state without weakening
  explicit lookup.

Final local evidence from this documentation review:

- primary gate: 231/231 files and 2,790/2,790 tests, with format, root
  typecheck, production build, and zero-error lint; the unchanged configured
  warning backlog is 649;
- AGI gate: typecheck plus 28/28 files and 282/282 tests;
- three-round stability gate: every round repeated format, typecheck, lint,
  2,790 tests, and build without a failure or skipped test;
- deterministic sweep: 94/94 selected commands passed from the 109-command
  inventory in 271.6 seconds; all 15 exclusions were reported, and the nested
  three-round stability gate took 204.0 seconds;
- strict commitment run
  `ANDREA-COMMITMENT-B8A5438A-BC9C-448B-BB02-5C5EB164800D`: 24/24 primary,
  15/15 held-out, 3/3 boundary invariants, 18/18 durable reopens, no provider
  calls or external writes, and zero isolated or production residue;
- temporal run `ANDREA-TEMPORAL-20260714T202649623Z-5D75F95B`: 13/13, two
  durable restarts, and zero production residue. The broader historical harness
  remains 6 `PASS`, 2 `PARTIAL`, and 2 `FAIL` rather than inflating legacy gaps;
- offline scorecard: 100% A+, all nine dimensions at 100%, network denied,
  isolated storage, no regression, and $0 cost;
- 6/6 signature flows, 70/70 documentation files, zero root or runner audit
  vulnerabilities, and passing container runner build/contracts plus image and
  nested read-only mount canaries.

Exact-SHA runs `29366417237`, `29366417072`, and `29366425715` passed Ubuntu,
Windows, container, AGI, CodeQL, dependency audit, verified-secret scan, and
Semgrep for `ac72ede1`. The clean artifact was rebuilt from that commit;
OpenClaw restarted from PID 49107 to 42778, Andrea restarted from PID 52446 to
43464, and the host reported serving/workspace alignment with verified
provenance and zero dirty paths.

Passive status after restart reported 9 healthy integrations. Google Calendar,
research, image generation, configured cloud-provider health, Brave Search,
self-repair, BlueBubbles transport, and OpenClaw were operational. Remaining
truth is proof debt rather than a repository regression: Telegram transport is
healthy but its roundtrip proof is aged; BlueBubbles transport is healthy but
its same-thread action proof is stale/missing; Alexa's signed handled intent is
stale; the life-thread journey still needs a genuine user turn; and host disk
pressure was warning at that restart snapshot. The later bounded cleanup
supersedes that storage observation and restored about 69 GiB available.

The historical `certify:life-thread` results below remain useful before-state
evidence. They do not certify the new model. The authoritative design and new
acceptance contract are in
[COMMITMENT_INTELLIGENCE.md](COMMITMENT_INTELLIGENCE.md).

## Temporal Truth And Durable Restart Certification — 2026-07-14

This is synthetic, isolated repository evidence, not a real user outcome or a
learning-baseline sample. The round began from clean, synchronized, and serving
SHA `4b8571f64230fabaf1ea0b74f346c1f1afecc224`. The original life-thread
certification reproduced both target failures: a Northstar correction changed
the summary to Friday noon while the active `nextAction` remained Thursday at
5:00 PM, and a durable SQLite close/reopen restored that stale planning value.

The production correction now parses a bounded temporal correction using the
accepted profile timezone, resolves only a uniquely named or sufficiently
context-bound active obligation, and updates `summary`, `nextAction`, and
`nextFollowupAt` in one database transaction. The previous value remains in an
explicit `temporal_supersession` signal for provenance but is excluded from
active snapshot, ranking, reminder/follow-through, personal-context, and daily
companion consumers. A deterministic signal identity makes replay of the same
correction a no-op. Ambiguous corrections ask which obligation to update and
mutate nothing.

Run `npm run certify:temporal-truth` for the isolated certification. Run
`ANDREA_TEMPORAL_RUN_ID=... npm run certify:temporal-truth` to provide a fixed
correlation ID. The final pre-release run was
`ANDREA-TEMPORAL-20260714T202649623Z-5D75F95B`. The harness creates its cleanup
manifest before seeding, uses a disposable SQLite datastore through Andrea's
production initialization path, performs two complete close/reopen cycles with
a correction between them, and exits nonzero on a scenario or cleanup failure.

The current certification matrix is 13 `PASS`, 0 `FAIL`: initial parsing,
pre-restart supersession, two durable restarts, sequential correction,
ordinal-date correction, relative one-week extension, a mixed
meeting/application sentence, ambiguous-target refusal, duplicate replay,
move into the past, time-only change, and relative-date change. It proves one
permit thread, three lifecycle signals, zero scheduled-task duplicates, one
active snapshot record, and zero production residue after cleanup.

The existing broader life-thread harness was also rerun as
`ANDREA-LIFETHREAD-20260714T202651604Z-B88DB9A8`. It retained the prior round's
improvement at 6 `PASS`, 2 `PARTIAL`, 2 `FAIL`: temporal
supersession and restart recovery are now passing, while the intentionally
out-of-scope tentative-state and selective-forget cases remain failing. Its
held-out completion, cancellation, temporal correction, and deduplication cases
pass; tentative intent and the broad alternate recall query remain failing.

## Synthetic Life-Thread Certification — 2026-07-14

This is synthetic offline evidence, not real user adoption. The pass began from
clean, synchronized SHA `41304345970b67e619de36ce59592a40c2d0993d` and used
run `ANDREA-LIFETHREAD-20260714T160100Z-A7C4D2E1` in a disposable SQLite
database with an offline Calendar fake. It did not write to live memory,
messages, Calendar, contacts, providers, or Jeff's production state.

The ten-scenario lifecycle improved from 2 `PASS`, 2 `PARTIAL`, and 6 `FAIL`
to 4 `PASS`, 2 `PARTIAL`, and 4 `FAIL`. The single production correction makes
natural completion and cancellation updates close the uniquely identified or
context-bound life thread, clear active follow-through, retain historical
evidence, and remain suppressed after a durable database reopen. Ambiguous
terminal language without a target closes nothing.

Confirmed strengths:

- one underlying Northstar thread retained multiple paraphrased signals;
- proactive recall stayed concise and did not expose the fictional
  verification phrase;
- completion and cancellation suppression survived database close/reopen;
- all 16 cleanup-manifest entries, including the isolated profile subject and
  facts, were removed; the database/WAL/SHM and manifest no longer exist, and
  independent production searches found zero run-bound residue.

Measured limitations from that earlier certification, with later status:

- the stale active deadline and restart-recovery defects are resolved by the
  later temporal-truth certification above;
- waiting, tentative intent, ownership, blockers, delegation, and deferral were
  not structured states in the released baseline. Commitment Intelligence adds
  them and the strict local certification passes; publication and runtime proof
  remain separate;
- the released baseline did not rank urgent, scheduled, low-urgency, and
  tentative items strongly enough. Commitment Intelligence uses deterministic
  actionability, explicit importance, urgency, strength, confidence, recency,
  and identity bands, with focused and strict local ranking evidence passing;
- a scoped multi-item forget request and the held-out phrasing `Is there
anything important I'm dropping?` are not handled by the local path.

Run `npm run certify:life-thread` for a fresh isolated lifecycle. The command
creates its cleanup manifest before seeding and exits nonzero if independent
cleanup verification fails. Full evidence and scenario details are retained in
`docs/ANDREA_FINAL_RESET_HANDOFF.md`.

For this release decision, `npm run certify:commitment-intelligence` is the
strict gate. The final local run passed every required primary, held-out,
boundary, restart, replay, cleanup, and residue assertion listed above.

## Live Transport Certification — 2026-07-14

This pass began from clean, synchronized `main` at
`24371f1139504bde57df536f8af4139ee1c8c28f`. The BlueBubbles remediation was
then rebuilt and exercised from serving SHA `3a02430c`. A later documentation
commit can change repository `HEAD`; use `git rev-parse origin/main` and
`npm run services:status` for the final published and serving SHA.

| Channel                | Scenario                                                                          | Result                          | Timestamp (UTC)            | Correlation / receipt                                                                                                                            | Evidence                                                                                                                                                 | Limitation                                                                                                                                                                                                                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------- | ------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Telegram               | Production `/ping` user-session roundtrip                                         | `VERIFIED`                      | `2026-07-14T15:10:07.618Z` | sent `11709`, reply `11710`                                                                                                                      | `data/runtime/telegram-roundtrip-health.json`                                                                                                            | This was the canonical harmless `/ping` probe, not a mutating task.                                                                                                                                                                                                                                      |
| BlueBubbles + OpenClaw | Canonical self-thread request for exactly one read-only `bluebubbles_status` call | `FAILED`                        | `2026-07-14T15:42:27.262Z` | `BB-CERT-20260714T154100Z-3A02430C`; request `bb:37AD510B-7645-447C-A299-75A9C7787F1A`; observed reply `bb:01EE530B-943F-4FDB-BC00-73A884AA846C` | `$HOME/.openclaw/agents/main/sessions/d8236900-084d-40f1-91e2-d546f6789721.jsonl` and `abfecee0-3436-4d3f-b927-e2afe3e19d3a.jsonl`; local message ledger | Transport, same physical thread, tool grounding, and delivery worked, but phone/email aliases produced two read-only calls and more than one response path. No mutation occurred. The defect is patched and deterministically tested, but was not re-probed to avoid another provider send in this pass. |
| Alexa                  | Fresh signed `IntentRequest` through a real device or authenticated simulator     | `BLOCKED` (prior proof `STALE`) | assessed `2026-07-14`      | none                                                                                                                                             | `data/runtime/alexa-last-signed-request.json`; `npm run services:status`                                                                                 | This environment has no authenticated simulator/device client. The last handled signed `WhatAmIForgettingIntent` remains `2026-06-03T13:57:39.518Z`; an unsigned local request is not equivalent.                                                                                                        |

Historical BlueBubbles attempts are retained rather than rewritten:

- `BB-CERT-20260714T151445Z-376127DE` and
  `BB-CERT-20260714T151900Z-6F261FFB` fell through to a non-OpenClaw helper and
  executed no bridge tool (`FAILED`).
- `BB-CERT-20260714T152400Z-3B0CBCEF` reached the durable route but failed the
  old gateway preflight (`FAILED`).
- `BB-CERT-20260714T153000Z-9474BC94` exposed alias double-processing while the
  agent path still returned unavailable; no bridge tool executed (`FAILED`).
- `BB-CERT-20260714T154100Z-3A02430C` proved the tool and response path but
  recorded two read-only calls, which fails the exactly-once requirement.

The repository correction now routes configured Messages self-thread
`@OpenClaw` asks through the real connector, uses the fast live gateway
preflight, keeps same-chat delivery independent of unsupported reply metadata,
and collapses phone/email aliases by canonical content/direction fingerprint
within a bounded two-second provider timestamp window. The focused suite also
proves an intentional repeat outside that window remains eligible. A fresh
single-probe recertification is still required before this scenario can become
`VERIFIED`.

## Current Integration Proof

Treat a configured transport as different from a fresh user-path proof. Use the
status commands above instead of carrying these point-in-time states forward.

- Telegram: transport is healthy. The last successful production user-session
  `/ping` roundtrip was recorded at `2026-07-14T15:10:07.618Z`; it is now aged
  and needs a genuine user-path refresh.
- BlueBubbles: transport is reachable and usable; current readiness is degraded
  because a fresh canonical same-thread `message_action` proof is missing. The
  OpenClaw status drill reached the tool path, but its exactly-once
  certification failed on alias duplication; the repo fix is tested and awaits
  one future live recertification.
- Alexa: listener/public setup may be available, but the signed
  `IntentRequest` proof is stale and requires a fresh real-device or
  authenticated-simulator turn.
- Life threads: one genuine save/thread-control interaction is still missing.
- Google Calendar, research, and image generation report live proof in their
  current dedicated commands. Recheck before relying on them.
- OpenAI, Anthropic, Gemini, MiniMax, and Brave are configured provider lanes.
  The latest bounded cached observations report them healthy, but configuration
  alone is not blanket live-provider proof and strict config-only status remains
  unknown.

## Learning Evidence

- One genuine owner-reviewed outcome exists; the five-outcome minimum for the
  first reviewed baseline has not been met, and no baseline has been saved.
- The latency ledger has four valid comparable samples: average 10,994 ms,
  p50 7,328 ms, and p95 26,353 ms. The calendar route currently meets its
  target; one direct-assistant container sample remains over the ten-second
  target. Three legacy and three invalid samples are excluded.
- Synthetic, deterministic, proof-drill, and duplicate outcomes do not count as
  owner reviews, routine canaries, skill promotions, or live mission evidence.
- Ten working days of reviewed deep-work dogfood remain elapsed-use evidence,
  not something repository automation can manufacture.

## Durable And Container Boundaries

- Durable work binds checkpoints, resume grants, approvals, targets, action
  classes, receipts, and postconditions. Resume is not approval, and uncertain
  external effects are verified rather than blindly replayed.
- Repository proof is bound to the canonical Git worktree and exact state;
  commits, pushes, deploys, sends, calendar writes, purchases, migrations,
  dependency changes, and deletions remain fresh-approval-only actions.
- Container sessions are separated into direct-assistant, protected, control,
  and execution lanes. Ordinary direct-assistant turns are tool-free.
- Host Codex home/auth/config is never mounted or copied into containers.
  Runner source and control overlays are read-only; only bounded session and
  workspace state is writable.
- OneCLI remains the preferred credential boundary. The environment fallback
  is explicitly degraded and must keep secret values out of arguments, process
  listings, logs, errors, and diagnostics.

## Open Operator Debt

1. Before rebuilding or restarting a newer release, rerun
   `npm run services:status` and require adequate measured headroom. The latest
   bounded cleanup restored about 69 GiB available, but that value is
   time-sensitive. Never delete owner data or evidence automatically.
2. After every future release restart, require exact serving-SHA alignment.
3. Refresh Telegram, BlueBubbles same-thread message-action, Alexa signed
   intent, and life-thread proofs through genuine user interactions.
4. Collect five distinct owner reviews before presenting a baseline, and
   complete the ten-working-day reviewed dogfood sequence.
5. After releasing the apprenticeship implementation, run one genuine,
   explicitly owner-authorized Release-Readiness Brief canary; record the exact
   owner verdict; obtain a separate activation decision; and prove one later
   same-scope semantic reuse. Do not backfill any of those from the 22/22
   synthetic certification.
6. Provision OneCLI only through an explicit operator decision, and rotate any
   credential previously pasted into chat, logs, issues, or diagnostics,
   including the previously exposed Brave credential.
7. Obtain native Windows host/service proof when a Windows machine is
   available; hosted Windows CI proves the shared artifact and launcher
   contract, not a native restart.

## Guardrail

Do not convert stale proof, missing external configuration, disk pressure, or
provider-account limits into repository success or an automatic code repair.
Fix repository defects when evidence identifies one; otherwise preserve the
operator/external classification and require the corresponding real proof.
