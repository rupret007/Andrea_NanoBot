# Changelog

Notable Andrea_NanoBot changes are documented here. Older entries retain the
upstream NanoClaw names that were current when those changes shipped.

## [Unreleased]

- Named iMessage/SMS who-do-I-owe now uses the same thread-grounded gist as
  leftover #31 (`You owe Bob a reply. Bob told you: Practice at eight tonight.`)
  so Jeff can ask `what's still open with Bob` or continue `what do I owe people`
  after `summarize Bob`. `draft Bob` after that still drafts Jeff's reply and
  does not send. Generic `what do I owe people` does not crawl unnamed inbox
  threads. Karen and other non-owner surfaces cannot read those Messages
  bodies or authorize a send. Suggested replies stay unsent. Questions still
  withhold a canned answer. Send-path source blobs stay SHA-256-identical to
  leftover #29 unless a later leftover proves the exact Bob fence is still
  `send it` / `send it now` / `send now`. Bare `yes` / `ok` never authorize.
  Private API stays off. AppleScript is the only send path. Telegram stays Bot
  the Bot. No merge and no live send in this leftover.
- Named iMessage/SMS summarize now gives Jeff a useful thread-grounded gist
  (`Bob told you: Practice at eight tonight. You haven't replied yet.`)
  instead of repeating the same inbound quote. Suggested replies stay unsent.
  `draft Bob` still drafts Jeff's reply to Bob and does not send. Questions
  and requests still withhold a canned answer. Send-path source blobs stay
  SHA-256-identical to leftover #29 unless a later leftover proves the exact
  Bob fence is still `send it` / `send it now` / `send now`. Bare `yes` / `ok`
  never authorize. Private API stays off. AppleScript is the only send path.
  QA and Karen still cannot authorize a send. Telegram stays Bot the Bot.
  No merge and no live send in this leftover.
- Closed the post-#29 Texts leftover: named-person routing stays in place,
  and summarize/draft wording is now person- and thread-grounded for
  informational updates (`Dinner at seven tonight`, `Load-in at six tonight`)
  instead of generic `Thanks for the update.` / `Got it.` / `circle back`.
  Questions, requests, and automated notices still withhold a canned answer.
  Send-path source blobs stay SHA-256-identical to leftover #29 unless a later
  leftover proves the exact Bob fence is still `send it` / `send it now` /
  `send now`. Bare `yes` / `ok` never authorize. Private API stays off.
  AppleScript is the only send path. QA and Karen still cannot authorize a
  send. Telegram stays Bot the Bot. No merge and no live send in this leftover.
- Closed the Windows CI honesty leftover without weakening the product
  invariant: the durable-work SQLite fixture hooks now have a bounded 30-second
  budget under the full hosted suite, while the assertions still run once with
  no retry or skip. Send-path docs now name the exact `send it` / `send it now`
  / `send now` fence and the AppleScript-only, no-Private-API, no-group path.
- Closed the post-#25 Texts leftover: named-thread `yesterday` freshness
  now matches the owner-timezone recap window instead of silently including
  later turns, and named/all-synced model transcripts use the configured
  owner timezone instead of hardcoded UTC. Operator docs now describe those
  windows and the AppleScript-only send path honestly.
- Closed the post-#24 Texts leftover: named-thread and recent-text
  `today` / `yesterday` / `this week` windows now use the configured owner
  timezone instead of host-local midnight, so recaps stay honest when the
  process TZ differs from Andrea's `TIMEZONE`.
- Closed the post-#23 send-again leftover: leftover Telegram `Send again`
  chrome and `send it again` copy cannot authorize a resend. Typed approval
  stays `send it`, `send it now`, or `Send now`. Bare `yes`/`ok` remain
  non-authorizing.
- Closed the post-#22 send-fence leftover: typed message-action approval now
  accepts only `send it`, `send it now`, or `Send now`; provider, recipient,
  resend, and rewrite-and-send wording cannot authorize dispatch. Bare
  `yes`/`ok` remain non-authorizing.
- Added conservative calendar-plus-research decomposition: only the calendar
  clause becomes the approval-bound event draft, while a separately traced,
  read-only research leg can run promptly and report its own result or blocker
  without being repeated by calendar confirmation. Explicit maximum-effort
  wording selects the bounded deep-research route.
- Refreshed the README and operator, security, evaluation, roadmap, setup,
  status, privacy, and release documentation against the published repository
  and current host evidence; documentation validation now covers every
  canonical Markdown file.
- Removed deployment-specific owner identifiers from examples and the
  BlueBubbles self-thread fallback so an unconfigured clone cannot inherit a
  real person's destination.

## [1.2.42] - 2026-07-13

- Published durable cognitive continuity for bounded coding, research,
  operator, mission, and approval-gated work, including scope-bound single-use
  resume grants, crash-safe receipts, exact approvals, and verified recovery.
- Enforced route-specific container capabilities: ordinary direct assistance
  is tool-free; trusted runner, settings, skills, plugins, and guidance are
  read-only; host Codex profiles and credentials are not mounted or copied.
- Added deterministic offline evaluation with network denial, isolated state,
  explicit live-evaluation budgets, and provenance-aware council evidence.
- Expanded personal context, verified agency, outcome review, owner cockpit,
  BlueBubbles, Telegram, Alexa, calendar, and deep-work validation without
  weakening fresh-approval boundaries.
- Repaired Windows deterministic preload handling and split exact-SHA security
  gates for dependency audit, secret scanning, Semgrep, AGI, CodeQL, container,
  Ubuntu, and Windows validation.
- Published the release on `main`; operator-host proof and integration freshness
  remain status-led and are not implied by repository publication.

For older upstream release notes, see the
[NanoClaw changelog](https://docs.nanoclaw.dev/changelog).

### Earlier 1.2.42 product work carried forward from 2026-04-04

- Added the v32 General Intelligence Control Plane: unified action lifecycle (intents, attempts, reviews with legal status transitions), a ten-check action preflight where the strictest of critic review, autonomy policy, reality/truth state, and tool reliability always wins, a bounded cognitive blackboard, reflective episodic memory with enforced retention and redaction, a capability self-model grounded in live proof and config presence (names only), an explicit autonomy governor (levels 0–7, levels 5+ always approval-gated, level 7 never executed), multi-strategy reasoning evals that feed strategy-learning signals, and a ten-scenario AGI-readiness gauntlet with new `debug:blackboard`, `debug:actions`, `debug:episodes`, `debug:capabilities`, `debug:autonomy`, and `debug:agi-readiness` surfaces. The control plane orchestrates existing systems, executes nothing itself, and is explicitly not an AGI claim.
- Landed Andrea Alexa Companion Mode on the mainline integration path, including daily guidance, stronger follow-ups, household-aware phrasing, and explicit consent-based personalization.
- Aligned the Alexa voice runbooks around the truthful current state: Node `22.22.2`, real OAuth account linking, strong near-live proof, and one remaining real signed Alexa utterance for full live acceptance when it has not been reproven on the host.
- Preserved the merged shared-shell model with `/cursor` as the primary operator surface, reply-linked runtime follow-up, and a clearer runtime/backend-lane ownership story.
- Closed the final live work-cockpit proof gap on the operator host: Telegram now has real end-to-end card proofs for both Cursor Cloud and Codex/OpenAI runtime, including reply-to-card continuation and shared current-work selection.
- Polished repo-facing docs and release guidance so startup, runtime, Telegram operator testing, and Alexa validation all describe the same current behavior.
- Hardened closeout diagnostics by exposing local Alexa listener and OAuth health in `npm run services:status`, tightening Alexa readiness wording, and making the default assistant identity stay explicitly Andrea in new `.env` setups and tests.
- Marked the deeper NanoClaw requirements/spec docs as historical reference where they still describe older trigger examples, and aligned their core naming/runtime examples with current Andrea reality.

## [1.2.35] - 2026-03-26

- [BREAKING] OneCLI Agent Vault replaces the built-in credential proxy. Existing `.env` credentials must be migrated to the vault. Run `/init-onecli` to install OneCLI and migrate credentials.

## [1.2.21] - 2026-03-22

- Added opt-in diagnostics via PostHog with explicit user consent (Yes / No / Never ask again)

## [1.2.20] - 2026-03-21

- Added ESLint configuration with error-handling rules

## [1.2.19] - 2026-03-19

- Reduced `docker stop` timeout for faster container restarts (`-t 1` flag)

## [1.2.18] - 2026-03-19

- User prompt content no longer logged on container errors — only input metadata
- Added Japanese README translation

## [1.2.17] - 2026-03-18

- Added `/capabilities` and `/status` container-agent skills

## [1.2.16] - 2026-03-18

- Tasks snapshot now refreshes immediately after IPC task mutations

## [1.2.15] - 2026-03-16

- Fixed remote-control prompt auto-accept to prevent immediate exit
- Added `KillMode=process` so remote-control survives service restarts

## [1.2.14] - 2026-03-14

- Added `/remote-control` command for host-level Claude Code access from within containers

## [1.2.13] - 2026-03-14

**Breaking:** Skills are now git branches, channels are separate fork repos.

- Skills live as `skill/*` git branches merged via `git merge`
- Added Docker Sandboxes support
- Fixed setup registration to use correct CLI commands

## [1.2.12] - 2026-03-08

- Added `/compact` skill for manual context compaction
- Enhanced container environment isolation via credential proxy

## [1.2.11] - 2026-03-08

- Added PDF reader, image vision, and WhatsApp reactions skills
- Fixed task container to close promptly when agent uses IPC-only messaging

## [1.2.10] - 2026-03-06

- Added `LIMIT` to unbounded message history queries for better performance

## [1.2.9] - 2026-03-06

- Agent prompts now include timezone context for accurate time references

## [1.2.8] - 2026-03-06

- Fixed misleading `send_message` tool description for scheduled tasks

## [1.2.7] - 2026-03-06

- Added `/add-ollama` skill for local model inference
- Added `update_task` tool and return task ID from `schedule_task`

## [1.2.6] - 2026-03-04

- Updated `claude-agent-sdk` to 0.2.68

## [1.2.5] - 2026-03-04

- CI formatting fix

## [1.2.4] - 2026-03-04

- Fixed `_chatJid` rename to `chatJid` in `onMessage` callback

## [1.2.3] - 2026-03-04

- Added sender allowlist for per-chat access control

## [1.2.2] - 2026-03-04

- Added `/use-local-whisper` skill for local voice transcription
- Atomic task claims prevent scheduled tasks from executing twice

## [1.2.1] - 2026-03-02

- Version bump (no functional changes)

## [1.2.0] - 2026-03-02

**Breaking:** WhatsApp removed from core, now a skill. Run `/add-whatsapp` to re-add.

- Channel registry: channels self-register at startup via `registerChannel()` factory pattern
- `isMain` flag replaces folder-name-based main group detection
- `ENABLED_CHANNELS` removed — channels detected by credential presence
- Prevent scheduled tasks from executing twice when container runtime exceeds poll interval

## [1.1.6] - 2026-03-01

- Added CJK font support for Chromium screenshots

## [1.1.5] - 2026-03-01

- Fixed wrapped WhatsApp message normalization

## [1.1.4] - 2026-03-01

- Added third-party model support
- Added `/update-nanoclaw` skill for syncing with upstream

## [1.1.3] - 2026-02-25

- Added `/add-slack` skill
- Restructured Gmail skill for new architecture

## [1.1.2] - 2026-02-24

- Improved error handling for WhatsApp Web version fetch

## [1.1.1] - 2026-02-24

- Added Qodo skills and codebase intelligence
- Fixed WhatsApp 405 connection failures

## [1.1.0] - 2026-02-23

- Added `/update` skill to pull upstream changes from within Claude Code
- Enhanced container environment isolation via credential proxy
