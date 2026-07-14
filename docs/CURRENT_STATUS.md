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
  checked status had 21 GiB available (9.36% free), restoring enough headroom
  for the normal build and restart sequence. Recheck before a disk-heavy
  container build because this value is deliberately not treated as durable
  release evidence.
- OpenClaw is live and all 11/11 Andrea bridge tools are available.

## Verified Repository Gates

- Primary suite: 225 files / 2,608 tests.
- AGI suite: 28 files / 282 tests.
- Deterministic sweep: 93/93 selected commands passed from an inventory of 108;
  the other 15 are explicitly excluded live, interactive, aggregate, or
  state-writing commands, not silent passes.
- Offline scorecard: 100% A+, isolated storage, network denied, zero live cost.
- Container runner install, typecheck, build, policy contracts, image canary,
  nested read-only mount canary, signature flows, documentation checks, and
  root/runner dependency audits passed on the released tree.

## Current Integration Proof

Treat a configured transport as different from a fresh user-path proof. Use the
status commands above instead of carrying these point-in-time states forward.

- Telegram: transport is healthy; the end-to-end user-session proof is overdue.
- BlueBubbles: transport is reachable and usable; current readiness is degraded
  because a fresh canonical same-thread `message_action` proof is missing.
- Alexa: listener/public setup may be available, but the signed
  `IntentRequest` proof is stale and requires a fresh real-device or
  authenticated-simulator turn.
- Life threads: one genuine save/thread-control interaction is still missing.
- Google Calendar, research, and image generation report live proof in their
  current dedicated commands. Recheck before relying on them.
- OpenAI, Anthropic, Gemini, MiniMax, and Brave are configured provider lanes;
  configuration alone is not blanket live-provider proof. Their config-only
  health state is currently unknown until an explicitly authorized live probe.

## Learning Evidence

- One genuine owner-reviewed outcome exists; the five-outcome minimum for the
  first reviewed baseline has not been met, and no baseline has been saved.
- The latency ledger has three valid comparable samples: average 24,004 ms,
  p50 35,596 ms, and p95 35,616 ms. Three legacy and three invalid samples are
  excluded from that comparison.
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
