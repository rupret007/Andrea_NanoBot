# Andrea Setup And Features Guide

This is the practical operator guide for Andrea_NanoBot.
Use it when you need to install, configure, verify, or operate Andrea on a real machine.

For the in-chat user journey and command reference, also see:

- [CHANNEL_COMMANDS_AND_ONBOARDING.md](CHANNEL_COMMANDS_AND_ONBOARDING.md)
- [USER_GUIDE.md](USER_GUIDE.md)
- [ADMIN_GUIDE.md](ADMIN_GUIDE.md)

## What This Package Includes

- `nanoclaw` runtime and isolation model as the base.
- Container runtime abstraction across Docker, Podman, and Apple Container.
- Channel integration through skills (`/add-whatsapp`, `/add-telegram`, and others).
- OpenClaw community marketplace integration:
  - bundled discovery catalog
  - global cache
  - explicit per-chat enable/disable
- Anthropic-compatible model routing with OpenAI-key-backed gateway support.
- Optional operator-enabled integrations such as Amazon Business shopping and Alexa voice.

For demo use, keep the default public surface smaller than the full operator feature set.
The safest baseline is Telegram + direct assistance + fast quick replies for simple asks + reminders/tasks + `/cursor_status` + clean startup/health checks.

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

Cursor Cloud Agents API (for direct Cursor job lifecycle control):

```bash
CURSOR_API_KEY=cursor_api_...
# Optional:
# CURSOR_API_BASE_URL=https://api.cursor.com
# CURSOR_API_AUTH_MODE=auto
# CURSOR_API_TIMEOUT_MS=20000
# CURSOR_API_MAX_RETRIES=2
# CURSOR_API_RETRY_BASE_MS=800
# CURSOR_MAX_ACTIVE_JOBS_PER_CHAT=4
```

`CURSOR_API_AUTH_MODE` accepts `auto`, `bearer`, or `basic`. Default `auto` tries Bearer first and falls back to Basic, which matches the mixed real-world Cursor Cloud auth behavior seen across tools and docs.

Cursor Desktop Bridge (for using your own Cursor machine remotely):

```bash
CURSOR_DESKTOP_BRIDGE_URL=https://your-mac-bridge.example.com
CURSOR_DESKTOP_BRIDGE_TOKEN=replace-with-random-secret
# Optional:
# CURSOR_DESKTOP_BRIDGE_TIMEOUT_MS=30000
# CURSOR_DESKTOP_BRIDGE_LABEL=Jeff MacBook Pro
```

Use this mode when you want Andrea to reach the Cursor machine you normally use, such as your Mac while you are away from your desk.

Important notes:

- the bridge runs on the machine that has your normal Cursor setup
- it uses the local `cursor-agent` CLI there instead of the hosted Cursor API
- if your main model runtime points at a remote 9router endpoint, set:
  - `CURSOR_GATEWAY_HINT=9router`
- see [CURSOR_DESKTOP_BRIDGE.md](CURSOR_DESKTOP_BRIDGE.md) for the full bridge setup
- after restart, use `/cursor_status` and confirm the `Cursor Capability Summary` says `Job backend: desktop bridge` or `Job backend: cloud agents` before relying on deeper Cursor job commands

When this mode is active:

- `scripts/start-openai-gateway.ps1` runs LiteLLM as container `litellm-gateway`
- it creates/uses Podman network `nanoclaw-openai`
- agent containers automatically bind to that network and use `http://litellm-gateway:4000`

Important compatibility note:

- The core runtime uses Claude Agent SDK semantics.
- Native OpenAI endpoints (`https://api.openai.com/v1`) are not direct drop-ins unless exposed through an Anthropic-compatible layer.
- If your gateway does not yet accept the newest Claude default alias, set:
  - `NANOCLAW_AGENT_MODEL=claude-3-5-sonnet-latest`

### Option C: Amazon Business Shopping

Andrea can search Amazon Business and prepare approval-gated purchase requests.

Recommended first rollout:

```bash
AMAZON_BUSINESS_ORDER_MODE=trial
AMAZON_PURCHASE_APPROVAL_TTL_MINUTES=30
```

Required for search:

```bash
AMAZON_BUSINESS_API_BASE_URL=https://na.business-api.amazon.com
AMAZON_BUSINESS_AWS_REGION=us-east-1
AMAZON_BUSINESS_LWA_CLIENT_ID=...
AMAZON_BUSINESS_LWA_CLIENT_SECRET=...
AMAZON_BUSINESS_LWA_REFRESH_TOKEN=...
AMAZON_BUSINESS_AWS_ACCESS_KEY_ID=...
AMAZON_BUSINESS_AWS_SECRET_ACCESS_KEY=...
AMAZON_BUSINESS_USER_EMAIL=buyer@example.com
```

Required for purchase submission or trial validation:

```bash
AMAZON_BUSINESS_SHIPPING_FULL_NAME=Andrea Buyer
AMAZON_BUSINESS_SHIPPING_PHONE_NUMBER=555-123-4567
AMAZON_BUSINESS_SHIPPING_ADDRESS_LINE1=123 Main St
AMAZON_BUSINESS_SHIPPING_CITY=Chicago
AMAZON_BUSINESS_SHIPPING_STATE_OR_REGION=IL
AMAZON_BUSINESS_SHIPPING_POSTAL_CODE=60601
AMAZON_BUSINESS_SHIPPING_COUNTRY_CODE=US
```

Full details:

- [AMAZON_SHOPPING_AND_APPROVALS.md](AMAZON_SHOPPING_AND_APPROVALS.md)

### Option D: Alexa Voice

Andrea can expose a custom Alexa skill endpoint so you can talk to the same assistant out loud.
Treat this as an optional operator-enabled extra, not part of the default baseline or default demo path, unless it has been validated end to end in the current environment.

Minimum:

```bash
ALEXA_SKILL_ID=amzn1.ask.skill.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

Recommended first rollout:

```bash
ALEXA_HOST=127.0.0.1
ALEXA_PORT=4300
ALEXA_PATH=/alexa
ALEXA_VERIFY_SIGNATURE=true
ALEXA_ALLOWED_USER_IDS=amzn1.ask.account.your-user-id
ALEXA_TARGET_GROUP_FOLDER=main
```

Practical notes:

- Alexa requires an HTTPS endpoint, so local dev usually sits behind a tunnel or reverse proxy.
- `ALEXA_ALLOWED_USER_IDS` is the easiest security rail for a private skill rollout.
- `ALEXA_TARGET_GROUP_FOLDER=main` lets Alexa share the same core Andrea context as your Telegram main chat.
- Use `/alexa_status` in Telegram to confirm that the listener actually started.

Full details:

- [ALEXA_VOICE_INTEGRATION.md](ALEXA_VOICE_INTEGRATION.md)

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
Use your real Telegram bot username when demonstrating mention-based group prompts.

Typical commands:

- ask for regular assistance in any registered chat
- ask for recurring tasks:
  - `@your_bot_username every weekday at 9am send me a sales summary`
- use the in-chat discovery layer:
  - `/start`
  - `/help`
  - `/commands`
  - `/features`
- Amazon shopping commands for operators in the main control chat:
  - `/amazon_status`
  - `/amazon_search <keywords>`
  - `/purchase_request <asin> <offer_id> [quantity]`
  - `/purchase_requests`
  - `/purchase_approve <request_id> <approval_code>`
  - `/purchase_cancel <request_id>`
- Cursor-focused control commands:
  - `/cursor_status` (safe public status check for Cloud, desktop bridge, and route readiness)
  - `/cursor_models [filter]` (main control chat only; Cursor Cloud only)
  - `/cursor_test` (main control chat only; live 9router/Cursor smoke request)
  - `/cursor_jobs` (main control chat only; list tracked Cursor jobs for this chat)
  - `/cursor_create [options] <prompt>` (main control chat only; starts a Cursor job through Cloud or the desktop bridge)
  - `/cursor_create --repo <url> --ref <branch> --model <id> <prompt>` (target a specific repo/ref/model)
  - `/cursor_sync <agent_id>` (main control chat only; refresh Cursor job status/artifacts)
  - `/cursor_stop <agent_id>` (main control chat only; request stop for a Cursor job)
  - `/cursor_followup <agent_id> <text>` (main control chat only; send follow-up instructions)
  - `/cursor_conversation <agent_id> [limit]` (main control chat only; show recent Cursor job conversation)
  - `/cursor_artifacts <agent_id>` (main control chat only; list tracked Cursor job artifacts)
  - `/cursor_artifact_link <agent_id> <absolute_path>` (main control chat only; generate a temporary artifact download link)

Important scope rule:

- `/cursor_status` is safe to keep visible in the narrower public product surface
- the deeper Cursor, Amazon, and Alexa slash commands are operator-facing controls and should be run from Andrea's registered main control chat only
- for Cursor specifically, those deeper job commands are only operational when `/cursor_status` shows a real job backend instead of `Job backend: not configured`
- marketplace skill discovery and enablement still exist in the operator/runtime layer, but they are not part of the default Telegram command surface

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
- [AMAZON_SHOPPING_AND_APPROVALS.md](AMAZON_SHOPPING_AND_APPROVALS.md)

## 10) Operations And Maintenance

Useful commands:

```bash
npm run build
npm run test
npm run test:major
npm run test:major:ci
npm run test:stability
npm run setup -- --step verify
npm run services:start
npm run services:stop
npm run services:restart
```

Validation runner note:

- `npm run test:major`, `npm run test:major:ci`, and `npm run test:stability` run their internal checks on Node 22 via `npx -p node@22`, which keeps results consistent on hosts where the default Node version is newer.

Windows service lifecycle helpers:

- `npm run services:start` starts the OpenAI gateway (when configured) and NanoClaw runtime.
- `npm run services:stop` stops NanoClaw runtime processes and the gateway container.
- `npm run services:restart` runs stop then start in one command.

Startup behavior:

- `npm run setup -- --step service` configures platform-native startup.
- On Windows this creates a scheduled task (`NanoClaw`) or Startup-folder fallback.
- On macOS this uses launchd.
- On Linux this uses systemd (or nohup fallback).
- So startup is not only a container setting; it is handled by host service manager policy plus runtime startup wrapper logic.

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
   - optional immediate restart check: `npm run services:restart`
7. Optional same-day operator validation only:
   - if you plan to use marketplace skills, search one skill, enable it in one chat, confirm it appears on the next response, then disable it again
   - if you plan to use Alexa, validate the live HTTPS endpoint and one real voice request
   - if you plan to use Amazon, keep `AMAZON_BUSINESS_ORDER_MODE=trial` and validate one full approval flow before treating it as real
