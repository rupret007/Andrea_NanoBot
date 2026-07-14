# Andrea Current Status

Local operator and repository snapshot from 2026-07-14. Runtime and integration
proof is time-sensitive; rerun `npm run debug:status`,
`npm run services:status`, and `npm run integrations:status -- --json` before a
release or demo. The release facts below describe the published tree at
snapshot capture; they are not a claim that a later development worktree has no
uncommitted candidate changes.

## Repository And Release

- Release state is intentionally time-sensitive. Before a release or demo,
  treat `git status --branch`, `npm run services:status`, and
  `npm run integrations:status -- --json` as the authoritative source for the
  active commit and runtime provenance; this document does not pin a serving
  SHA that will become stale after the next release.
- Pull request #6 and its release-closure changes are on `main`.
- Exact-SHA Ubuntu, Windows, container, AGI, CodeQL, dependency-audit,
  verified-secret-scan, and Semgrep checks are green.
- The Mac host reports `running_ready` and healthy disk pressure. The latest
  checked status had 18 GiB available (7.97% free), restoring enough headroom
  for the normal build and restart sequence. Recheck before a disk-heavy
  container build because this value is deliberately not treated as durable
  release evidence.
- OpenClaw is live and all 11/11 Andrea bridge tools are available.

## Verified Repository Gates

- Primary suite: 638 suites / 2,720 tests.
- AGI suite: 28 files / 282 tests.
- Deterministic sweep: 93/93 selected commands passed from an inventory of 108;
  the other 15 are explicitly excluded live, interactive, aggregate, or
  state-writing commands, not silent passes.
- Offline scorecard: 100% A+, isolated storage, network denied, zero live cost.
- Container runner install, typecheck, build, policy contracts, image canary,
  nested read-only mount canary, signature flows, documentation checks, and
  root/runner dependency audits passed on the released tree.

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
- all 13 cleanup-manifest entries were removed, the isolated database/WAL/SHM
  and manifest no longer exist, and independent production searches found zero
  run-bound residue.

Measured limitations intentionally left for later rounds:

- a corrected deadline updates the summary but not the stale active
  `nextAction`;
- waiting and tentative intent are not structured life-thread states;
- urgent, scheduled, low-urgency, and tentative items are not ranked strongly
  enough;
- a scoped multi-item forget request and the held-out phrasing `Is there
  anything important I'm dropping?` are not handled by the local path.

Run `npm run certify:life-thread` for a fresh isolated lifecycle. The command
creates its cleanup manifest before seeding and exits nonzero if independent
cleanup verification fails. Full evidence and scenario details are retained in
`docs/ANDREA_FINAL_RESET_HANDOFF.md`.

## Live Transport Certification — 2026-07-14

This pass began from clean, synchronized `main` at
`24371f1139504bde57df536f8af4139ee1c8c28f`. The BlueBubbles remediation was
then rebuilt and exercised from serving SHA `3a02430c`. A later documentation
commit can change repository `HEAD`; use `git rev-parse origin/main` and
`npm run services:status` for the final published and serving SHA.

| Channel | Scenario | Result | Timestamp (UTC) | Correlation / receipt | Evidence | Limitation |
| --- | --- | --- | --- | --- | --- | --- |
| Telegram | Production `/ping` user-session roundtrip | `VERIFIED` | `2026-07-14T15:10:07.618Z` | sent `11709`, reply `11710` | `data/runtime/telegram-roundtrip-health.json` | This was the canonical harmless `/ping` probe, not a mutating task. |
| BlueBubbles + OpenClaw | Canonical self-thread request for exactly one read-only `bluebubbles_status` call | `FAILED` | `2026-07-14T15:42:27.262Z` | `BB-CERT-20260714T154100Z-3A02430C`; request `bb:37AD510B-7645-447C-A299-75A9C7787F1A`; observed reply `bb:01EE530B-943F-4FDB-BC00-73A884AA846C` | `$HOME/.openclaw/agents/main/sessions/d8236900-084d-40f1-91e2-d546f6789721.jsonl` and `abfecee0-3436-4d3f-b927-e2afe3e19d3a.jsonl`; local message ledger | Transport, same physical thread, tool grounding, and delivery worked, but phone/email aliases produced two read-only calls and more than one response path. No mutation occurred. The defect is patched and deterministically tested, but was not re-probed to avoid another provider send in this pass. |
| Alexa | Fresh signed `IntentRequest` through a real device or authenticated simulator | `BLOCKED` (prior proof `STALE`) | assessed `2026-07-14` | none | `data/runtime/alexa-last-signed-request.json`; `npm run services:status` | This environment has no authenticated simulator/device client. The last handled signed `WhatAmIForgettingIntent` remains `2026-06-03T13:57:39.518Z`; an unsigned local request is not equivalent. |

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

- Telegram: transport and the production user-session `/ping` roundtrip are
  freshly verified at `2026-07-14T15:10:07.618Z`.
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

1. Before rebuilding or restarting a newer candidate, rerun
   `npm run services:status` and require healthy disk pressure; never delete
   owner data or evidence automatically.
2. After the release restart, require exact serving-SHA alignment.
3. Refresh Telegram, BlueBubbles same-thread message-action, Alexa signed
   intent, and life-thread proofs through genuine user interactions.
4. Collect five distinct owner reviews before presenting a baseline, and
   complete the ten-working-day reviewed dogfood sequence.
5. Provision OneCLI only through an explicit operator decision, and rotate any
   credential previously pasted into chat, logs, issues, or diagnostics,
   including the previously exposed Brave credential.
6. Obtain native Windows host/service proof when a Windows machine is
   available; hosted Windows CI proves the shared artifact and launcher
   contract, not a native restart.

## Guardrail

Do not convert stale proof, missing external configuration, disk pressure, or
provider-account limits into repository success or an automatic code repair.
Fix repository defects when evidence identifies one; otherwise preserve the
operator/external classification and require the corresponding real proof.
