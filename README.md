<p align="center">
  <img src="assets/andrea-banner.svg" alt="Andrea hero banner" width="1100">
</p>

<p align="center">
  Andrea_NanoBot is the merged home for Andrea's Telegram-first orchestration shell, built on NanoClaw isolation and expanded with curated OpenClaw skills.
</p>

<p align="center">
  Andrea is designed to be practically useful every day: tasks, reminders, research, coding help, guarded shopping approvals, and secure chat-based automation across multiple backend lanes.
</p>

<p align="center">
  <a href="docs/USER_GUIDE.md">User Guide</a>&nbsp; | &nbsp;
  <a href="docs/ADMIN_GUIDE.md">Admin Guide</a>&nbsp; | &nbsp;
  <a href="docs/ANDREA_OPENAI_BACKEND.md">OpenAI Backend</a>&nbsp; | &nbsp;
  <a href="docs/SETUP_AND_FEATURES_GUIDE.md">Setup Guide</a>&nbsp; | &nbsp;
  <a href="docs/CHANNEL_COMMANDS_AND_ONBOARDING.md">Chat Commands</a>&nbsp; | &nbsp;
  <a href="docs/BACKEND_LANES_ARCHITECTURE.md">Backend Lanes</a>&nbsp; | &nbsp;
  <a href="docs/DEMO_CHECKLIST.md">Demo Checklist</a>&nbsp; | &nbsp;
  <a href="docs/ADDONS_AND_FEATURE_MATRIX.md">Add-On Matrix</a>&nbsp; | &nbsp;
  <a href="docs/CURSOR_API_KEYS.md">Cursor API Keys</a>&nbsp; | &nbsp;
  <a href="docs/TESTING_AND_RELEASE_RUNBOOK.md">Testing Runbook</a>&nbsp; | &nbsp;
  <a href="PRIVACY.md">Privacy Policy</a>
</p>

---

## What Andrea Is

Andrea is one public assistant identity built on a secure NanoClaw runtime.
The product is conversation-first in Telegram, with deeper operator tooling behind a narrower admin surface.

What normal users should expect:

- reminders, follow-ups, and simple task help
- research, summaries, and project help
- fast direct replies for simple questions, playful prompts, and basic math
- a small safe Telegram command set
- `/cursor_status` as the only public-safe Cursor command

What operators should expect:

- setup, restart, verify, and troubleshooting
- Cursor Cloud job workflows through the primary `/cursor` dashboard
- a secondary `andrea_runtime` lane for Codex/OpenAI execution truth
- desktop bridge session and terminal workflows
- live `/debug-*` troubleshooting controls plus host-side `npm run debug:*` fallbacks
- a loopback-backed Codex/OpenAI runtime lane with reply-linked follow-up and current-task selection
- optional integrations only after same-day validation

The runtime is still based on NanoClaw, which means the security model matters:

- agents run in isolated containers
- each registered chat keeps its own context and files
- community skills are cached globally but enabled explicitly per chat
- model access can run through OneCLI or an Anthropic-compatible gateway
- shopping credentials stay on the host behind a narrow approval-aware boundary

## Why This Repo Exists

The upstream NanoClaw project provides a strong secure runtime.
This fork turns that foundation into Andrea: a more opinionated, more polished personal assistant with stronger Telegram UX, better operator docs, reliable direct replies, and a more intentional day-to-day assistant experience.

In short:

- NanoClaw gives Andrea the safety model
- OpenClaw skills give Andrea breadth
- this repo focuses on making the whole package feel usable, personal, and reliable

## Quick Start

Clone this repo, install dependencies, and open Claude Code:

```bash
git clone https://github.com/rupret007/Andrea_NanoBot.git
cd Andrea_NanoBot
npm install
claude
```

If you are on Windows PowerShell, create `.env` like this:

```powershell
Copy-Item .env.example .env
```

Then use this setup flow:

1. In Claude Code, run `/setup`
2. In Claude Code, add Telegram with `/add-telegram`
3. Optionally run `/init-onecli` for safer credential handling
4. Start the bot and open a DM with Andrea in Telegram
5. In Telegram, run `/start`
6. In Telegram, run `/registermain`
7. In Telegram, run `/help`

After `/registermain`, that exact DM should become Andrea's main control chat.
If operator-only surfaces later feel flat or unavailable, run `npm run services:status`
and confirm `registered_main_chat_jid` matches the real Telegram DM you use.

## Pick Your Guide

If you only read one doc, use the one that matches your role:

- User: [docs/USER_GUIDE.md](docs/USER_GUIDE.md)
- Operator/Admin: [docs/ADMIN_GUIDE.md](docs/ADMIN_GUIDE.md)
- Full setup and runtime details: [docs/SETUP_AND_FEATURES_GUIDE.md](docs/SETUP_AND_FEATURES_GUIDE.md)

## Cursor In One Minute

Andrea now documents Cursor as three separate surfaces:

- **Cursor Cloud**
  - requires `CURSOR_API_KEY`
  - current validated heavy-lift queued coding path
- **Cursor desktop bridge**
  - requires `CURSOR_DESKTOP_BRIDGE_URL` and `CURSOR_DESKTOP_BRIDGE_TOKEN`
  - operator-only session recovery plus line-oriented terminal control on your own machine
  - does not automatically mean queued desktop-agent execution is validated on Windows
- **Cursor-backed runtime route**
  - optional diagnostic/runtime-routing surface
  - separate from both Cloud jobs and desktop bridge readiness

## Backend Lanes

Andrea_NanoBot now owns the shared shell while backend lanes own execution truth.

- **Shell ownership stays here**
  - Telegram UX
  - `/cursor` tile dashboard
  - selection state, wizard state, and reply-linked operator behavior
- **Cursor lane stays first-class**
  - current rich operator lane
  - primary taught dashboard and job workflow
- **`andrea_runtime` is now integrated as a secondary lane**
  - brings Codex/OpenAI runtime orchestration into this repo
  - now has a small `Codex/OpenAI` surface inside the primary `/cursor` work panel
  - `/runtime-*` remains secondary transitional scaffolding
  - does not replace Cursor or the `/cursor` dashboard
  - the shell increasingly presents one task model with lane-specific capabilities, not two separate operator products

Shared shell handles now resolve as `{ laneId, jobId }`.
The imported `imported/andrea_openai_bot` subtree is temporary staging plus history preservation, not the long-term runtime home.

Under the hood, the current Codex/OpenAI lane can still delegate execution truth to the local `Andrea_OpenAI_Bot` loopback backend when that lane is enabled. See [docs/ANDREA_OPENAI_BACKEND.md](docs/ANDREA_OPENAI_BACKEND.md) for the ownership split and the one-time local bootstrap-and-retry flow.

## Alexa Companion Mode

Alexa is now a bounded companion channel for Andrea rather than a novelty skill.

- it reuses the same Andrea core, account-linking, and trust boundaries
- it is shorter, warmer, and more spoken-first than Telegram
- it supports daily guidance like morning brief, what matters most today, anything important, what am I forgetting, evening reset, and family-upcoming flows
- it keeps short-lived conversational continuity for turns like `anything else`, `what about Candace`, `what about Travis`, `make that shorter`, and `remind me before that`
- personalization remains explicit and consent-based
- use Node `22.22.2` for truthful Alexa validation on the operator host

Repo-side and near-live Alexa proof are strong on this host. The one remaining live gap is still one exact external step unless you re-prove it during the current session: one real signed Alexa utterance from the app, a device, or an authenticated simulator session.

For day-to-day operator checks, use `/alexa-status` inside the registered main control chat and `npm run services:status` for the local Alexa listener and OAuth health on the host. Public HTTPS ingress and live signed utterances remain separate acceptance checks.

## Two Command Surfaces

This is one of the easiest places for new users to get confused, so the split is important:

### Claude Code Skills

These run inside the `claude` terminal session while you are operating the repo:

- `/setup`
- `/add-telegram`
- `/add-whatsapp`
- `/add-discord`
- `/init-onecli`
- `/debug`
- `/update-nanoclaw`
- `/update-skills`

### Telegram Bot Commands

These run inside Telegram after the bot is live:

- `/start`
- `/help`
- `/commands`
- `/features`
- `/ping`
- `/chatid`
- `/registermain`
- `/cursor_status`

Advanced operator workflows still exist, but they are operator-only, live in the admin guide, and should stay out of the default demo unless they were validated the same day.

Preferred operator command style:

- public-safe commands stay documented exactly as shown above
- deeper operator examples use hyphen aliases in Telegram, such as `/cursor`, `/cursor-jobs`, and `/cursor-create`
- operator examples use `/cursor-results` for output files and `/cursor-download` for one-file retrieval
- the normal Telegram operator flow is now `/cursor` -> `Jobs`/`Current Job`/`New Cloud Job` or `Codex/OpenAI` tiles -> tap a task/action -> reply with plain text only when you are supplying a follow-up prompt or a new-job prompt
- replying to a task card always continues that task; otherwise Andrea uses the current task in the lane you opened
- underscore aliases still work for compatibility, but the docs now standardize on the hyphen form for operator workflows
- older `/cursor-artifacts` and `/cursor-artifact-link` aliases still work for compatibility, but they are no longer the preferred operator examples

## Demo-Ready Surface

For a reliable demo, keep the story tight:

- Telegram onboarding and `/registermain`
- direct questions, fast quick replies for simple asks, reminders, and light research
- stable health checks, `/help`, and `/cursor_status`
- secure per-chat isolation and clean user-facing replies

Optional integrations such as Cursor Cloud job control, desktop bridge control, Alexa, shopping flows, marketplace skills, and calendar-oriented skills exist, but they should be treated as operator-enabled extras unless they were validated the same day. Alexa in particular is now code-complete as a bounded personal-assistant channel, but live use still depends on Node 22, HTTPS ingress, Alexa console setup, and account linking being configured on that host.

## Calendar Integration

Andrea now has a local fast path for plain-language calendar reads such as:

- `What's on my calendar tomorrow?`
- `What's on my schedule this week?`
- `Am I free Friday afternoon?`
- `Do I have anything at 3pm tomorrow?`

Supported provider paths:

- Google Calendar with an access token or refresh token plus explicit calendar ids
- Apple Calendar directly on a Mac running Andrea
- Apple/iCloud-style CalDAV using calendar collection URLs plus credentials
- Outlook calendars through Microsoft Graph

These are optional operator-enabled integrations. Google Calendar is the best first setup when your real family events already live there, and Andrea answers truthfully when no provider is configured instead of pretending a calendar is connected.

Google Calendar now supports two practical operator flows on a configured host:

- read real events from explicit selected calendars such as `primary` plus family/shared calendars
- create simple one-time Google Calendar events after a clear confirmation in chat

Use the Google setup flow on the host instead of trying to give Andrea your Google account password:

```powershell
npm run setup -- --step google-calendar auth --client-secret-json "C:\path\to\client_secret.json"
npm run setup -- --step google-calendar discover --select all
npm run setup -- --step google-calendar validate
```

Notes:

- while the Google OAuth app stays in Testing, the Google account must be listed as a test user
- `GOOGLE_CALENDAR_IDS` should stay explicit so Andrea only reads the calendars you selected
- reminder phrasing still creates reminders, not Google Calendar events

## What Andrea Can Do

### Personal Assistant Work

- track tasks and simple to-do lists
- set reminders and recurring follow-ups
- summarize conversations and notes
- run lightweight personal workflow automation

### Research And Knowledge Work

- research a topic and summarize the result
- monitor or re-check information through scheduled tasks
- organize output per chat or group context

### Coding And Operator Work

- help with repos, debugging, and code tasks
- use `/cursor_status` as the safe Cursor readiness check
- operators can create, continue, stop, inspect, and recover **Cursor Cloud** coding tasks from the main control chat
- operators use `Refresh`, `View Output`, and `Results` in `/cursor`, while `/cursor-conversation`, `/cursor-results`, and `/cursor-download` stay available as explicit fallbacks
- operators can sync and inspect **desktop bridge sessions**, then run line-oriented terminal commands against tracked bridge sessions on their own machine
- operators can also open the integrated **Codex/OpenAI runtime** lane from `/cursor` to review or continue runtime tasks when that lane is enabled and validated on the host
- `/runtime-*` remains available as secondary explicit scaffolding for direct runtime control
- keep optional integrations behind explicit operator setup instead of treating them as default demo features

Important Cursor rule:

- `/cursor_status` now splits Cloud coding jobs, desktop bridge terminal control, desktop agent-job compatibility, and Cursor-backed runtime routing into separate lines
- if it says `Cloud coding jobs: unavailable`, treat `/cursor-create`, `/cursor-followup`, `/cursor-stop`, `/cursor-models`, `/cursor-results`, and `/cursor-download` as unavailable until `CURSOR_API_KEY` is configured
- if it says `Desktop bridge terminal control: unavailable`, treat `/cursor-terminal*` and desktop session recovery as unavailable until the bridge is configured and reachable
- if it says `Desktop bridge agent jobs: conditional` or `unavailable`, keep using Cursor Cloud for queued heavy-lift work and treat the bridge as terminal/session control only on that machine
- Cursor desktop bridge control is operator-only. It can inspect bridge-known sessions and run line-oriented shell commands for tracked bridge sessions, but it is not a live PTY or remote desktop surface.

## Using Andrea In Chat

In a direct message:

- use `/start` for quick onboarding
- use `/registermain` to make that DM your main control chat
- ask normal requests in plain English

In a group:

- mention Andrea when you want her to act
- keep high-trust admin tasks in the main control chat when possible

Examples:

```text
@your_bot_username add "renew passport" to my to-do list
@your_bot_username remind me every Monday at 9am to send updates
@your_bot_username research the best standing desks for small apartments
@your_bot_username what's the meaning of life?
```

## Model And Runtime Support

Andrea currently supports:

- Node.js 22.x
- Docker, Podman, and Apple Container
- Anthropic-compatible model endpoints
- OpenAI-key-backed gateways exposed through Anthropic-compatible APIs
- optional 9router / Cursor-backed runtime-routing paths
- optional Cursor Cloud Agents API control via `CURSOR_API_KEY` and optional `CURSOR_API_AUTH_MODE=auto|bearer|basic`
- optional integrations only after operator validation

If you need to create or verify a real Cursor Cloud key, see [docs/CURSOR_API_KEYS.md](docs/CURSOR_API_KEYS.md).

Useful runtime validation commands:

```text
/ping
/cursor_status
/debug-status
/debug-level debug chat 60m
/debug-logs current 120
/debug-reset all
```

Useful local validation commands:

```bash
npm run test:major:ci
npm run test:major
npm run test:stability
npm run services:restart
npm run services:status
npm run setup -- --step verify
npm run debug:status
npm run debug:level -- verbose component:container 30m
npm run debug:logs -- stderr 120
npm run debug:reset -- all
```

## Verify And Troubleshooting

`npm run setup -- --step verify` now checks two different things:

- `CREDENTIAL_RUNTIME_PROBE`
  - endpoint/auth/model reachability
- `ASSISTANT_EXECUTION_PROBE`
  - whether Andrea's main direct-assistant container path can actually start and produce first output

That distinction matters during incidents:

- a passing credential probe does **not** guarantee the assistant lane can answer
- an `initial_output_timeout` is a runtime-startup/output problem, not automatically a missing-key problem
- `/debug-*` commands are operator-only and let you turn log volume up or down live without restarting the service
- `npm run services:status` now shows the active repo root, branch, commit, DB path, assistant name source, registered main Telegram chat, and the local Alexa listener/OAuth health when Alexa is configured so state drift is visible immediately
- when you need both restart and verify, run `npm run services:restart` first, wait for it to finish, then run `npm run setup -- --step verify`

## Documentation Map

Use the docs based on what you are trying to do:

- [docs/USER_GUIDE.md](docs/USER_GUIDE.md)
  for daily usage, command examples, and what Andrea can do for end users
- [docs/ADMIN_GUIDE.md](docs/ADMIN_GUIDE.md)
  for setup ownership, security rails, service operations, and release steps
- [docs/SETUP_AND_FEATURES_GUIDE.md](docs/SETUP_AND_FEATURES_GUIDE.md)
  for operator setup, runtime config, and day-to-day operations
- [docs/CHANNEL_COMMANDS_AND_ONBOARDING.md](docs/CHANNEL_COMMANDS_AND_ONBOARDING.md)
  for Telegram onboarding, chat UX, and command reference
- [docs/BACKEND_LANES_ARCHITECTURE.md](docs/BACKEND_LANES_ARCHITECTURE.md)
  for shell-versus-lane ownership, the `{ laneId, jobId }` handle model, and the temporary imported subtree boundary
- [docs/AMAZON_SHOPPING_AND_APPROVALS.md](docs/AMAZON_SHOPPING_AND_APPROVALS.md)
  for Amazon Business setup, safety rails, and shopping commands
- [docs/CURSOR_DESKTOP_BRIDGE.md](docs/CURSOR_DESKTOP_BRIDGE.md)
  for operator-only desktop session recovery and terminal commands on your own machine while Andrea controls it remotely
- [docs/CURSOR_API_KEYS.md](docs/CURSOR_API_KEYS.md)
  for where `CURSOR_API_KEY` comes from, what it enables, and how it differs from the desktop bridge
- [docs/ALEXA_VOICE_INTEGRATION.md](docs/ALEXA_VOICE_INTEGRATION.md)
  for Alexa v1 setup, account-linking rules, Node 22 validation requirements, and the final live-acceptance runbook
- [docs/ADDONS_AND_FEATURE_MATRIX.md](docs/ADDONS_AND_FEATURE_MATRIX.md)
  for deciding which skills and add-ons to enable
- [docs/TESTING_AND_RELEASE_RUNBOOK.md](docs/TESTING_AND_RELEASE_RUNBOOK.md)
  for release-quality validation
- [docs/README.md](docs/README.md)
  for the full local docs hub

## Repo Structure

Key areas in this repo:

- `src/` - core runtime, channels, IPC, scheduler, container integration
- `docs/` - local operator, onboarding, testing, and reference docs
- `assets/` - Andrea branding and repo visuals
- `container/skills/openclaw-market/` - bundled marketplace catalog
- `groups/` - per-chat working context and memory
- `data/` - runtime data, cache, and marketplace skill state

## Testing And Release Discipline

This repo is meant to be run methodically.
The standard validation gate is:

```bash
npm run test:major:ci
```

That runs:

1. formatting checks
2. type checking
3. linting
4. unit tests
5. production build

For live operator verification on a real machine, use:

```bash
npm run test:major
```

## Built On

Andrea_NanoBot is built on top of:

- [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw) for the secure runtime base
- [VoltAgent/awesome-openclaw-skills](https://github.com/VoltAgent/awesome-openclaw-skills) for curated skill discovery

This fork is where the Andrea-specific product experience, docs, Telegram UX, and operator workflow improvements live.

## License

MIT
