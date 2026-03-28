# NanoClaw Setup And Features Guide

This is the practical operator guide for this combined package.
It focuses on real local setup, runtime behavior, and how to use the major add-ons.

For the in-chat user journey and command reference, also see:

- [CHANNEL_COMMANDS_AND_ONBOARDING.md](CHANNEL_COMMANDS_AND_ONBOARDING.md)

## What This Package Includes

- `nanoclaw` runtime and isolation model as the base.
- Container runtime abstraction across Docker, Podman, and Apple Container.
- Channel integration through skills (`/add-whatsapp`, `/add-telegram`, and others).
- OpenClaw community marketplace integration:
  - bundled discovery catalog
  - global cache
  - explicit per-chat enable/disable
- Anthropic-compatible model routing with OpenAI-key-backed gateway support.

## 1) Quick Start (Recommended Path)

From repo root:

```bash
npm install
```

Windows PowerShell note:

- If script execution policy blocks `npx.ps1`, use `npx.cmd`/`npm.cmd` in commands instead of `npx`/`npm`.

Create local env file:

```powershell
Copy-Item .env.example .env
```

Open Claude Code and run setup:

```bash
claude
```

Then inside Claude Code:

1. Run `/setup`.
2. Add at least one channel (`/add-whatsapp`, `/add-telegram`, `/add-discord`, `/add-slack`, or `/add-gmail`).
3. For Telegram-first setups, send `/registermain` to the bot in your direct chat to bootstrap the main control chat.
4. If you want OneCLI vault mode, run `/init-onecli`.
5. Verify install health:
   - `npm run setup -- --step verify`

## 2) Prerequisites And Baseline Checks

Required baseline:

- Node.js `22.x` (`>=22 <23`)
- Claude Code
- One container runtime:
  - Docker (Windows/macOS/Linux)
  - Podman (Windows/Linux)
  - Apple Container (macOS)

Suggested quick checks:

```bash
node --version
npm --version
docker info
podman info
container --help
claude --version
```

Only one runtime must be healthy.

## 3) Container Runtime Selection

Default resolution when `CONTAINER_RUNTIME` is not set:

- Windows: Docker, then Podman
- macOS: Apple Container, then Docker
- Linux: Docker, then Podman

Force a runtime in `.env`:

```bash
CONTAINER_RUNTIME=docker
# or podman
# or apple-container
```

If Docker is installed and running on Windows, Docker is selected by default.

## 4) Model Credentials (Anthropic And OpenAI-Compatible)

### Option A (Recommended): OneCLI Agent Vault

Run `/init-onecli` in Claude Code.
This keeps raw credentials out of container environments and routes auth through OneCLI.

### Option B: `.env` Credentials

Use one of these patterns:

Anthropic-native:

```bash
ANTHROPIC_AUTH_TOKEN=...
# or ANTHROPIC_API_KEY=...
# or CLAUDE_CODE_OAUTH_TOKEN=...
```

OpenAI key through an Anthropic-compatible gateway:

```bash
ANTHROPIC_BASE_URL=https://your-anthropic-compatible-endpoint
# or OPENAI_BASE_URL=https://your-anthropic-compatible-endpoint
OPENAI_API_KEY=...
```

9Router (Cursor-backed routing path):

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:20128/v1
ANTHROPIC_AUTH_TOKEN=your-9router-api-key
NANOCLAW_AGENT_MODEL=cu/default
```

This lets NanoClaw use 9Router as the Anthropic-compatible runtime endpoint while 9Router handles provider routing (including Cursor-connected models).
When this endpoint is set to `localhost`/`127.0.0.1`, NanoClaw rewrites it to
the active runtime host alias inside containers.

Windows + Podman local gateway (auto-managed by service wrapper):

```bash
ANTHROPIC_BASE_URL=http://host.containers.internal:4000
OPENAI_API_KEY=...
```

When this mode is active:

- `scripts/start-openai-gateway.ps1` runs LiteLLM as container `litellm-gateway`
- it creates/uses Podman network `nanoclaw-openai`
- agent containers automatically bind to that network and use `http://litellm-gateway:4000`

Important compatibility note:

- The core runtime uses Claude Agent SDK semantics.
- Native OpenAI endpoints (`https://api.openai.com/v1`) are not direct drop-ins unless exposed through an Anthropic-compatible layer.
- If your gateway does not yet accept the newest Claude default alias, set:
  - `NANOCLAW_AGENT_MODEL=claude-3-5-sonnet-latest`

## 5) Channel Setup And Main-Chat Responsibilities

Install one or more channels with skills:

- `/add-whatsapp`
- `/add-telegram`
- `/add-discord`
- `/add-slack`
- `/add-gmail`

During setup, register a main control chat.
Main chat can:

- manage group registration
- manage cross-group scheduled tasks
- enable/disable marketplace skills for target chats

## 6) Setup CLI Steps (For Manual Or CI-Style Verification)

The setup runner supports these deterministic steps:

- `npm run setup -- --step timezone`
- `npm run setup -- --step environment`
- `npm run setup -- --step container`
- `npm run setup -- --step groups`
- `npm run setup -- --step register` (used by setup flows, normally not manual)
- `npm run setup -- --step mounts`
- `npm run setup -- --step service`
- `npm run setup -- --step verify`

For a full health check, always run:

```bash
npm run setup -- --step verify
```

## 7) Daily Usage

Use your configured trigger in chats.
In many forks this is customized to `@Andrea`, but it is controlled by `ASSISTANT_NAME`.

Typical commands:

- ask for regular assistance in any registered chat
- ask for recurring tasks:
  - `@Andrea every weekday at 9am send me a sales summary`
- manage groups from main chat:
  - `@Andrea join the Family group`
- manage marketplace skills:
  - `@Andrea search OpenClaw skills for GitHub Actions debugging`
  - `@Andrea enable that skill in this chat`
- use the in-chat discovery layer:
  - `/start`
  - `/help`
  - `/commands`
  - `/features`
- Cursor-focused control commands:
  - `/cursor_status` (show 9router/Cursor endpoint readiness)
  - `/cursor_test` (run live 9router/Cursor smoke request)
  - `/cursor_remote` (start remote control bridge; main chat only)
  - `/cursor_remote_end` (end remote control bridge)

## 8) OpenClaw Marketplace Behavior And Security

Discovery catalog:

- `container/skills/openclaw-market/catalog.json`
- generated from `VoltAgent/awesome-openclaw-skills`

Lifecycle model:

- cache once globally at `data/marketplace/skills/<owner>/<slug>/`
- enable per chat by copying into that chat's isolated `.claude/skills`
- disable removes only the chat copy and mapping
- cache remains for reuse

Accepted source URLs:

- `clawskills.sh`
- `clawhub.ai`
- `github.com/openclaw/skills` (official path only)

Security gates before cache/enable:

- reject `Suspicious` or `Malicious` security status
- require `SKILL.md`
- enforce safe relative paths
- enforce file count and file size limits
- never run arbitrary installer code on host

Runtime-exposed marketplace tool surface:

- `search_openclaw_skills`
- `enable_openclaw_skill`
- `disable_openclaw_skill`
- `list_enabled_openclaw_skills`
- `install_openclaw_skill` (compatibility alias)

## 9) Add-Ons And Feature Catalog

For a detailed matrix of major add-ons, prerequisites, and platform scope, see:

- [ADDONS_AND_FEATURE_MATRIX.md](ADDONS_AND_FEATURE_MATRIX.md)

## 10) Operations And Maintenance

Useful commands:

```bash
npm run build
npm run test
npm run test:major
npm run test:major:ci
npm run setup -- --step verify
```

Rebuild bundled marketplace catalog (if `awesome-openclaw-skills` is cloned beside this repo):

```bash
npm run build:openclaw-market -- ../awesome-openclaw-skills/categories
```

Update workflows:

- `/update-nanoclaw` for upstream core updates
- `/update-skills` for installed skill branch updates
- `/debug` for guided incident triage

## 11) Common "Not Live Yet" Causes

- missing model credentials
- model credentials configured but unusable at runtime (for example, OpenAI `insufficient_quota`)
- no authenticated or configured channel
- no registered groups
- runtime binary installed but daemon not running
- wrong Node version (must be `22.x`)

When blocked, start here:

- `/debug`
- `npm run setup -- --step verify`
- [DEBUG_CHECKLIST.md](DEBUG_CHECKLIST.md)
- [SECURITY.md](SECURITY.md)

## 12) Go-Live Checklist (Methodical)

Use this exact order:

1. Verify baseline:
   - `npm run setup -- --step environment`
   - confirm `CONTAINER_RUNTIME_RESOLVED` is healthy
2. Configure model credentials:
   - preferred: `/init-onecli`
   - fallback: `.env` with Anthropic or OpenAI-compatible gateway credentials
3. Configure at least one channel:
   - Telegram/Discord/Slack tokens or WhatsApp auth
4. Register at least one group from the main chat.
5. Run final verify:
   - `npm run setup -- --step verify`
   - expected: `STATUS: success`
6. Start service:
   - `npm run setup -- --step service`
7. Run marketplace smoke in chat:
   - search a skill
   - explicitly enable one skill
   - confirm it appears in the next chat response
   - disable it and confirm removal
