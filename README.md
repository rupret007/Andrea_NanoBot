<p align="center">
  <img src="assets/andrea-banner.svg" alt="Andrea hero banner" width="1100">
</p>

<p align="center">
  Andrea_NanoBot is a Telegram-first personal AI assistant built on NanoClaw isolation and expanded with curated OpenClaw skills.
</p>

<p align="center">
  Andrea is designed to be practically useful every day: tasks, reminders, research, coding help, guarded shopping approvals, and secure chat-based automation.
</p>

<p align="center">
  <a href="docs/USER_GUIDE.md">User Guide</a>&nbsp; | &nbsp;
  <a href="docs/ADMIN_GUIDE.md">Admin Guide</a>&nbsp; | &nbsp;
  <a href="docs/ANDREA_OPENAI_BACKEND.md">OpenAI Backend</a>&nbsp; | &nbsp;
  <a href="docs/SETUP_AND_FEATURES_GUIDE.md">Setup Guide</a>&nbsp; | &nbsp;
  <a href="docs/CHANNEL_COMMANDS_AND_ONBOARDING.md">Chat Commands</a>&nbsp; | &nbsp;
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
- Cursor Cloud job workflows
- desktop bridge session and terminal workflows
- the local `Andrea_OpenAI_Bot` loopback backend lane for Codex/OpenAI execution truth
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

## OpenAI Backend Lane

`Andrea_NanoBot` now has a separate local backend lane for `Andrea_OpenAI_Bot`.

- NanoBot owns the operator shell, current control context, and job handle UX
- `Andrea_OpenAI_Bot` owns execution truth, provider routing, thread reuse, logs, and stop behavior
- the current fallback operator surface is:
  - `/runtime-status`
  - `/runtime-create`
  - `/runtime-jobs`
  - `/runtime-job`
  - `/runtime-followup`
  - `/runtime-logs`
  - `/runtime-stop`

See [docs/ANDREA_OPENAI_BACKEND.md](docs/ANDREA_OPENAI_BACKEND.md) for the ownership split and current bootstrap limitation.

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

## Demo-Ready Surface

For a reliable demo, keep the story tight:

- Telegram onboarding and `/registermain`
- direct questions, fast quick replies for simple asks, reminders, and light research
- stable health checks, `/help`, and `/cursor_status`
- secure per-chat isolation and clean user-facing replies

Optional integrations such as Cursor Cloud job control, desktop bridge control, Alexa, shopping flows, marketplace skills, and calendar-oriented skills exist, but they should be treated as operator-enabled extras unless they were validated the same day.

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
- operators can create, follow up, stop, inspect, and recover **Cursor Cloud** coding jobs from the main control chat
- operators can sync and inspect **desktop bridge sessions**, then run line-oriented terminal commands against tracked bridge sessions on their own machine
- keep optional integrations behind explicit operator setup instead of treating them as default demo features

Important Cursor rule:

- `/cursor_status` now splits Cloud coding jobs, desktop bridge terminal control, desktop agent-job compatibility, and Cursor-backed runtime routing into separate lines
- if it says `Cloud coding jobs: unavailable`, treat `/cursor_create`, `/cursor_followup`, `/cursor_stop`, `/cursor_artifacts`, and `/cursor_artifact_link` as unavailable until `CURSOR_API_KEY` is configured
- if it says `Desktop bridge terminal control: unavailable`, treat `/cursor_terminal*` and desktop session recovery as unavailable until the bridge is configured and reachable
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
```

Useful local validation commands:

```bash
npm run test:major:ci
npm run test:major
npm run test:stability
npm run setup -- --step verify
npm run services:restart
```

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
- [docs/AMAZON_SHOPPING_AND_APPROVALS.md](docs/AMAZON_SHOPPING_AND_APPROVALS.md)
  for Amazon Business setup, safety rails, and shopping commands
- [docs/CURSOR_DESKTOP_BRIDGE.md](docs/CURSOR_DESKTOP_BRIDGE.md)
  for operator-only desktop session recovery and terminal commands on your own machine while Andrea controls it remotely
- [docs/CURSOR_API_KEYS.md](docs/CURSOR_API_KEYS.md)
  for where `CURSOR_API_KEY` comes from, what it enables, and how it differs from the desktop bridge
- [docs/ALEXA_VOICE_INTEGRATION.md](docs/ALEXA_VOICE_INTEGRATION.md)
  for Alexa setup, signed endpoint behavior, and the ready-to-import interaction model
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
