<p align="center">
  <img src="assets/andrea-banner.svg" alt="Andrea hero banner" width="1100">
</p>

<p align="center">
  Andrea_NanoBot is a Telegram-first personal AI assistant built on NanoClaw isolation and expanded with curated OpenClaw skills.
</p>

<p align="center">
  Andrea is designed to be practically useful every day: tasks, reminders, research, coding help, shopping approvals, calendar workflows, and secure chat-based automation.
</p>

<p align="center">
  <a href="docs/USER_GUIDE.md">User Guide</a>&nbsp; | &nbsp;
  <a href="docs/ADMIN_GUIDE.md">Admin Guide</a>&nbsp; | &nbsp;
  <a href="docs/SETUP_AND_FEATURES_GUIDE.md">Setup Guide</a>&nbsp; | &nbsp;
  <a href="docs/CHANNEL_COMMANDS_AND_ONBOARDING.md">Chat Commands</a>&nbsp; | &nbsp;
  <a href="docs/ALEXA_VOICE_INTEGRATION.md">Alexa Voice</a>&nbsp; | &nbsp;
  <a href="docs/AMAZON_SHOPPING_AND_APPROVALS.md">Amazon Shopping</a>&nbsp; | &nbsp;
  <a href="docs/ADDONS_AND_FEATURE_MATRIX.md">Add-On Matrix</a>&nbsp; | &nbsp;
  <a href="docs/TESTING_AND_RELEASE_RUNBOOK.md">Testing Runbook</a>&nbsp; | &nbsp;
  <a href="PRIVACY.md">Privacy Policy</a>
</p>

---

## What Andrea Is

Andrea is not just a chatbot wrapper.
This repo turns a secure containerized agent runtime into a personal assistant that can actually help with real work:

- manage to-do lists and reminders
- run recurring automations and check-ins
- research and summarize information
- talk to Andrea through Alexa without creating a second assistant identity
- search Amazon Business products and require explicit approval before purchase flow
- help with code, repos, and technical tasks
- use approved community skills without exposing every chat to every capability

The runtime is still based on NanoClaw, which means the security model matters:

- agents run in isolated containers
- each registered chat keeps its own context and files
- community skills are cached globally but enabled explicitly per chat
- model access can run through OneCLI or an Anthropic-compatible gateway
- shopping credentials stay on the host behind a narrow approval-aware boundary

## Why This Repo Exists

The upstream NanoClaw project provides a strong secure runtime.
This fork turns that foundation into Andrea: a more opinionated, more polished personal assistant with stronger Telegram UX, Cursor/9router awareness, guarded Amazon shopping, better operator docs, and a more intentional day-to-day assistant experience.

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
8. Optionally add Alexa voice with [docs/ALEXA_VOICE_INTEGRATION.md](docs/ALEXA_VOICE_INTEGRATION.md)

## Pick Your Guide

If you only read one doc, use the one that matches your role:

- User: [docs/USER_GUIDE.md](docs/USER_GUIDE.md)
- Operator/Admin: [docs/ADMIN_GUIDE.md](docs/ADMIN_GUIDE.md)
- Full setup and runtime details: [docs/SETUP_AND_FEATURES_GUIDE.md](docs/SETUP_AND_FEATURES_GUIDE.md)

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
- `/cursor_models [filter]`
- `/cursor_test`
- `/cursor_jobs`
- `/cursor_create [options] <prompt>`
- `/cursor_sync <agent_id>`
- `/cursor_stop <agent_id>`
- `/cursor_followup <agent_id> <text>`
- `/cursor_conversation <agent_id> [limit]`
- `/cursor_artifacts <agent_id>`
- `/cursor_artifact_link <agent_id> <absolute_path>`
- `/alexa_status`
- `/amazon_status`
- `/amazon_search <keywords>`
- `/purchase_request <asin> <offer_id> [quantity]`
- `/purchase_requests`
- `/purchase_approve <request_id> <approval_code>`
- `/purchase_cancel <request_id>`
- `/cursor_remote`
- `/cursor_remote_end`

## What Andrea Can Do

### Personal Assistant Work

- track tasks and simple to-do lists
- set reminders and recurring follow-ups
- use Alexa voice while keeping Andrea as the one public assistant personality
- search Amazon Business and prepare approval-gated purchase requests
- summarize conversations and notes
- run lightweight personal workflow automation

### Research And Knowledge Work

- research a topic and summarize the result
- monitor or re-check information through scheduled tasks
- organize output per chat or group context

### Coding And Operator Work

- help with repos, debugging, and code tasks
- use Cursor/9router-aware routing checks with `/cursor_status` and `/cursor_test`
- create, follow up, sync, and inspect Cursor cloud coding jobs directly from Telegram
- expose approved community skills per chat without making them global by default

### Calendar Support

Calendar support is possible today, but it is currently skill-driven rather than a built-in first-party core subsystem.

The curated marketplace already includes calendar-oriented skills for:

- Apple Calendar
- Google Calendar
- Outlook / Microsoft 365
- CalDAV-based setups

That means Andrea can support calendar workflows now, while the runtime remains conservative about what becomes a built-in core feature.

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
@Andrea add "renew passport" to my to-do list
@Andrea remind me every Monday at 9am to send updates
@Andrea research the best Apple Calendar and Outlook sync options for families
@Andrea search for a community skill that can help with GitHub Actions debugging
@Andrea find a good ergonomic keyboard on Amazon and prepare an approval request
```

## Model And Runtime Support

Andrea currently supports:

- Node.js 22.x
- Docker, Podman, and Apple Container
- Alexa custom-skill voice ingress through a secure HTTPS endpoint
- Anthropic-compatible model endpoints
- OpenAI-key-backed gateways exposed through Anthropic-compatible APIs
- 9router / Cursor-backed routing paths
- optional Cursor Cloud Agents API control via `CURSOR_API_KEY`
- optional Amazon Business search and guarded order submission

Useful runtime validation commands:

```text
/cursor_status
/cursor_models cu/
/cursor_test
/cursor_jobs
/cursor_create --model cu/default --repo https://github.com/owner/repo --ref main Fix flaky tests in this repo and open a PR
/cursor_artifact_link bc_123 "/opt/cursor/out/summary.md"
/alexa_status
/amazon_status
/amazon_search ergonomic keyboard
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
