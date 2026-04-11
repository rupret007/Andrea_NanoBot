# Andrea Command Surface Reference

This is the formal reference for Andrea's current command and feature surface.

Use it when you need the full inventory of:

- public-safe Telegram slash commands
- operator-only slash command families
- hidden/internal button-backing commands
- natural-language discovery surfaces
- operator status and proof scripts

For day-to-day user help, stay with `/start`, `/help`, `/commands`, `/features`, and [USER_GUIDE.md](USER_GUIDE.md).

## Truth Model

Andrea separates surface truth this way:

- `user-facing`
  - normal conversation and the small public-safe Telegram command set
- `operator-facing`
  - setup, validation, troubleshooting, work cockpit, shopping approvals, and deeper control surfaces
- `internal`
  - button-backing commands and inline action ids that support the product but are not part of normal slash help

Andrea also separates capability truth this way:

- `live_proven`
  - the capability has passed the real proof bar on this host
- `near_live_only`
  - repo-side behavior is ready, but one fresh live proof leg is still missing
- `degraded_but_usable`
  - a bounded real path is usable, but the full live-proof bar is not yet met
- `externally_blocked`
  - repo-side behavior is not the problem; an external dependency or human-only step is still blocking proof
- `bounded`
  - intentionally narrower or confirmation-first behavior
- `operator_only`
  - available only in the main Telegram control chat or operator docs
- `disabled`
  - accepted for compatibility but intentionally turned off

For launch-readiness specifically, operator surfaces also expose an overlay:

- `core_ready`
- `core_ready_with_manual_surface_sync`
- `provider_blocked_but_core_usable`
- `near_live_only`
- `externally_blocked`

Static docs should not overrule live host truth. When proof state matters, use:

1. `npm run services:status`
2. `npm run setup -- --step verify`
3. `npm run debug:status`

## Public-Safe Telegram Slash Commands

These are the only slash commands normal users should see in Telegram help and menus.

| Command | Audience | Truth | Purpose |
| --- | --- | --- | --- |
| `/start` | User | `live_proven` | Quick onboarding and first-step orientation |
| `/help` | User | `live_proven` | Short in-chat guide with channel boundaries |
| `/commands` | User | `live_proven` | Safe Telegram command list |
| `/features` | User | `live_proven` | Short capability guide and channel map |
| `/ping` | User | `live_proven` | Basic bot health check |
| `/chatid` | User | `live_proven` | Show current Telegram chat id and type |
| `/registermain` | User | `live_proven` | Register this DM as Andrea's main control chat |
| `/cursor_status` | User | `live_proven` | Safe readiness check for coding and work help |

Important boundary:

- `/cursor_status` is the only public-safe Cursor command.
- Deeper operator/admin controls do not belong in `/commands` or public Telegram menus.

## Channel Surface Roles

| Surface | Truth | Best for | Important boundary |
| --- | --- | --- | --- |
| Telegram | `live_proven` | Richest companion use for schedule, reminders, planning, review, research, messaging review, and operator work | Public-safe commands stay small; deeper control lives in the main control chat |
| Alexa | `live_proven` proof on this host, with model sync tracked separately | Short voice help for calendar, reminders, planning, review, and quick reply help | Real proof must come from the Andrea custom skill, and latest model changes should be confirmed with `setup -- --step alexa-model-sync` |
| BlueBubbles | `degraded_but_usable` on this host | Bounded personal messaging companion in the active thread | Mention-required, messaging-first, and still needs a fresh same-thread message-action proof leg before it counts as `live_proven` |

## Natural-Language Discovery Surfaces

These are discoverable by normal language rather than slash commands.

| Surface | Channel | Truth | Typical asks |
| --- | --- | --- | --- |
| Ordinary chat and simple local asks | Telegram, Alexa, BlueBubbles | `live_proven` | `hi`, `what's up`, `what time is it`, `what day is it`, `thanks` |
| Calendar and schedule | Telegram, Alexa | `live_proven` | `what's on my calendar tomorrow`, `what's next on my calendar`, `move that to 7` |
| Reminders and save-for-later | Telegram, Alexa, BlueBubbles | `live_proven` | `remind me later`, `save that for later`, `send me the fuller version` |
| Planning and next steps | Telegram, Alexa | `live_proven` | `what am I forgetting`, `what matters today`, `help me plan tonight` |
| Communication and reply help | Telegram, Alexa, BlueBubbles | `bounded` | `what should I say back`, `what do I owe people`, `summarize this message` |
| Compare, explain, and saved context | Telegram, Alexa | `bounded` | `what should I know before deciding`, `compare these options`, `tell me something interesting` |
| Open follow-through and people | Telegram, Alexa, BlueBubbles | `live_proven` | `what's still open`, `what still needs attention`, `what about Candace` |
| Coding and work help | Telegram | `live_proven` | natural-language project help plus `/cursor_status` |

## Operator-Only Telegram Slash Families

These are formal command families, but they belong in the main control chat and operator docs only.

| Preferred alias | Accepted alias family | Truth | Purpose |
| --- | --- | --- | --- |
| `/cursor` | `/cursor` | `operator_only` | Open the main work cockpit |
| `/cursor-models` | `/cursor-models`, `/cursor_models`, `/cursor-model`, `/cursor_model` | `operator_only` | Model discovery for Cursor Cloud |
| `/cursor-test` | `/cursor-test`, `/cursor_test`, `/cursor-smoke`, `/cursor_smoke` | `operator_only` | Troubleshooting smoke only |
| `/cursor-jobs` | `/cursor-jobs`, `/cursor_jobs` | `operator_only` | Browse tracked Cursor jobs |
| `/cursor-create` | `/cursor-create`, `/cursor_create` | `operator_only` | Start a Cursor Cloud job |
| `/cursor-sync` | `/cursor-sync`, `/cursor_sync` | `operator_only` | Attach or refresh current work |
| `/cursor-select` | `/cursor-select`, `/cursor_select` | `operator_only` | Hidden current-work selector helper |
| `/cursor-ui` | `/cursor-ui`, `/cursor_ui` | `operator_only` | Internal button-backing entrypoint |
| `/cursor-stop` | `/cursor-stop`, `/cursor_stop` | `operator_only` | Stop the current Cursor job |
| `/cursor-followup` | `/cursor-followup`, `/cursor_followup` | `operator_only` | Follow-up instructions for a Cursor job |
| `/cursor-terminal` | `/cursor-terminal`, `/cursor_terminal` | `operator_only` | Desktop bridge terminal command |
| `/cursor-terminal-help` | `/cursor-terminal-help`, `/cursor_terminal_help` | `operator_only` | Desktop bridge terminal help |
| `/cursor-terminal-status` | `/cursor-terminal-status`, `/cursor_terminal_status` | `operator_only` | Desktop bridge terminal state |
| `/cursor-terminal-log` | `/cursor-terminal-log`, `/cursor_terminal_log` | `operator_only` | Desktop bridge terminal output |
| `/cursor-terminal-stop` | `/cursor-terminal-stop`, `/cursor_terminal_stop` | `operator_only` | Stop desktop bridge terminal command |
| `/cursor-conversation` | `/cursor-conversation`, `/cursor_conversation`, `/cursor-log`, `/cursor_log` | `operator_only` | Text trail for current work |
| `/cursor-results` | `/cursor-results`, `/cursor-artifacts`, `/cursor_artifacts` | `operator_only` | List tracked output files |
| `/cursor-download` | `/cursor-download`, `/cursor_download`, `/cursor-artifact-link`, `/cursor_artifact_link` | `operator_only` | Generate one result-file link |
| `/runtime-status` | `/runtime-status`, `/runtime_status`, `/codex-status`, `/codex_status` | `operator_only` | Explicit runtime-lane status |
| `/runtime-jobs` | `/runtime-jobs`, `/runtime_jobs`, `/codex-jobs`, `/codex_jobs` | `operator_only` | Runtime-lane jobs |
| `/runtime-create` | `/runtime-create`, `/runtime_create`, `/codex-create`, `/codex_create` | `operator_only` | Runtime-lane work creation |
| `/runtime-job` | `/runtime-job`, `/runtime_job`, `/codex-job`, `/codex_job` | `operator_only` | Runtime-lane job inspection |
| `/runtime-followup` | `/runtime-followup`, `/runtime_followup`, `/codex-followup`, `/codex_followup` | `operator_only` | Runtime-lane follow-up |
| `/runtime-stop` | `/runtime-stop`, `/runtime_stop`, `/codex-stop`, `/codex_stop` | `operator_only` | Runtime-lane stop |
| `/runtime-logs` | `/runtime-logs`, `/runtime_logs`, `/codex-logs`, `/codex_logs` | `operator_only` | Runtime-lane logs |
| `/debug-status` | `/debug-status`, `/debug_status` | `operator_only` | Live troubleshooting state |
| `/debug-level` | `/debug-level`, `/debug_level` | `operator_only` | Temporary debug override |
| `/debug-reset` | `/debug-reset`, `/debug_reset` | `operator_only` | Reset debug overrides |
| `/debug-logs` | `/debug-logs`, `/debug_logs` | `operator_only` | Recent sanitized logs |
| `/alexa-status` | `/alexa`, `/alexa-status`, `/alexa_status` | `operator_only` | Alexa status, proof, and model-sync truth |
| `/amazon-status` | `/amazon-status`, `/amazon_status` | `bounded` | Amazon integration status |
| `/amazon-search` | `/amazon-search`, `/amazon_search` | `bounded` | Amazon Business search |
| `/purchase-request` | `/purchase-request`, `/purchase_request` | `bounded` | Open a purchase request |
| `/purchase-requests` | `/purchase-requests`, `/purchase_requests` | `bounded` | List purchase requests |
| `/purchase-approve` | `/purchase-approve`, `/purchase_approve` | `bounded` | Approve a purchase request |
| `/purchase-cancel` | `/purchase-cancel`, `/purchase_cancel` | `bounded` | Cancel a purchase request |
| `/remote-control` | `/remote-control`, `/remote_control`, `/cursor-remote`, `/cursor_remote` | `disabled` | Disabled compatibility alias |
| `/remote-control-end` | `/remote-control-end`, `/remote_control_end`, `/cursor-remote-end`, `/cursor_remote_end` | `disabled` | Disabled compatibility alias |

## Internal Button-Backing And Inline Actions

These are real product surface, but they should not show up in public slash help.

| Family | Truth | What it backs |
| --- | --- | --- |
| `/cursor-ui *` | `operator_only` | Work-cockpit buttons and tiles such as status, jobs, current work, runtime, wizard, follow-up, and terminal actions |
| `/bundle-*` | `bounded` | Action bundle buttons such as run, skip, show, pick, and defer |
| `/runtime-*` card actions | `operator_only` | Runtime card buttons inside the work cockpit |
| Review controls | `bounded` | `send`, `send later`, `remind later`, `save under thread`, `keep as draft` |

## Operator Scripts Surfaced In Docs

| Script | Purpose |
| --- | --- |
| `npm run services:status` | Canonical host and proof summary |
| `npm run setup -- --step verify` | Canonical setup and external-blocker verifier |
| `npm run setup -- --step alexa-model-sync status` | Show the current Alexa interaction-model hash and local sync marker |
| `npm run setup -- --step alexa-model-sync mark-synced` | Mark the current repo Alexa model as console-synced after import/build |
| `npm run debug:status` | Detailed proof and debug surface |
| `npm run debug:pilot` | Flagship journey proof and pilot review surface |
| `npm run debug:bluebubbles -- --live` | Live BlueBubbles transport and proof view |
| `npm run debug:google-calendar` | Bounded Google Calendar read/write proof harness |
| `npm run debug:signature-flows` | Signature-journey product proof harness |

## Discovery Surface Rules

- `/start`
  - onboarding and first-step orientation only
- `/help`
  - short usage guidance plus channel boundaries
- `/commands`
  - only the stable public-safe Telegram slash commands
- `/features`
  - capability families, flagship journeys, and current channel roles
- Operator docs
  - full slash-command inventory, hidden/internal backing commands, status scripts, and setup/release truth
