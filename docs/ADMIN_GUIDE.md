# Andrea Admin Guide

This guide is for operators who own uptime, setup, security, and release quality.
It is intentionally practical: product shape first, runbook second, theory last.

## Product Model

Andrea has one public assistant identity and one narrow public chat surface.

### User-safe surface

Normal users should experience:

- plain-language conversation
- reminders, recurring follow-ups, and simple task help
- fast direct replies for simple asks
- summaries, research, and project help
- the small public-safe Telegram command set
- `/cursor_status` as the only public-safe Cursor command

### Operator-only surface

Operators own:

- environment variables and credential setup
- service lifecycle
- Cloud versus desktop bridge setup
- deeper Cursor workflows
- the local `Andrea_OpenAI_Bot` backend lane when Codex/OpenAI execution is delegated out of this repo
- startup, restart, verify, and troubleshooting
- release validation and docs accuracy

## What The Cursor Surfaces Mean

Andrea now treats Cursor as three separate surfaces:

### 1. Cursor Cloud

- requires `CURSOR_API_KEY`
- current validated heavy-lift queued coding path
- supports:
  - `/cursor_create`
  - `/cursor_sync` for Cloud jobs
  - `/cursor_conversation` for Cloud jobs
  - `/cursor_followup`
  - `/cursor_stop`
  - `/cursor_models`
  - `/cursor_artifacts`
  - `/cursor_artifact_link`

### 2. Cursor Desktop Bridge

- requires `CURSOR_DESKTOP_BRIDGE_URL`
- requires `CURSOR_DESKTOP_BRIDGE_TOKEN`
- may also require `CURSOR_DESKTOP_CLI_PATH` on the bridge machine
- supports operator-only session recovery plus line-oriented terminal control
- does **not** automatically mean local queued desktop-agent execution is validated on Windows

### 3. Cursor-Backed Runtime Route

- optional diagnostic/runtime-routing surface
- separate from Cursor Cloud job readiness
- separate from desktop bridge terminal readiness

## Status Terms

Use these meanings consistently:

- **configured** = required environment variables are present
- **ready** = configured and validated enough for intended use now
- **conditional** = partially wired or environment-dependent; not the baseline promise
- **unavailable** = missing config, unreachable dependency, or unsupported on this machine

## Baseline Requirements

- Node.js 22.x
- one healthy container runtime
- at least one configured channel
- valid model credentials
- optional local `Andrea_OpenAI_Bot` process if you want the loopback OpenAI/Codex backend lane

Quick checks:

```bash
node --version
npm --version
docker info
podman info
npm run setup -- --step verify
```

On Windows PowerShell, use `npm.cmd` and `npx.cmd` if policy blocks `npm.ps1` or `npx.ps1`.

## Andrea OpenAI Backend Lane

This repo can call a local `Andrea_OpenAI_Bot` process over loopback HTTP.

Required NanoBot env:

```bash
ANDREA_OPENAI_BACKEND_ENABLED=true
ANDREA_OPENAI_BACKEND_URL=http://127.0.0.1:3210
ANDREA_OPENAI_BACKEND_TIMEOUT_MS=15000
```

Operator commands for this lane:

- `/runtime-status`
- `/runtime-create TEXT`
- `/runtime-jobs [LIMIT] [BEFORE_JOB_ID]`
- `/runtime-job JOB_ID`
- `/runtime-followup JOB_ID TEXT`
- `/runtime-logs JOB_ID [LINES]`
- `/runtime-stop JOB_ID`

Important truth:

- `jobId` is the primary backend handle in NanoBot
- `threadId` is metadata returned by the backend
- NanoBot uses the current registered chat's `group.folder` as the backend `groupFolder`
- if the backend says `No registered group found for folder "..."`, NanoBot now calls local `PUT /groups/:groupFolder` and retries the original request once
- `bootstrap_required` now means the backend is reachable but does not support or accept the local bootstrap route
- `bootstrap_failed` means NanoBot reached the backend, attempted registration, and the registration or immediate retry still failed

## First Deployment Checklist

1. Copy the template:
   - `Copy-Item .env.example .env`
2. Configure model credentials and at least one channel.
3. Run setup in Claude Code:
   - `/setup`
   - `/add-telegram`
4. Register the main Telegram control chat with `/registermain` in DM.
5. Run:
   - `npm run setup -- --step verify`
6. Start services:
   - `npm run services:start`
7. Validate in chat:
   - `/ping`
   - `/help`
   - `/cursor_status`

## Service Operations

```bash
npm run services:start
npm run services:stop
npm run services:restart
```

After restart:

```bash
npm run setup -- --step verify
```

Expected:

- `STATUS: success`
- configured channel auth
- healthy container runtime
- healthy credential probe

## Cursor Setup And Validation

### Cursor Cloud

Required:

```bash
CURSOR_API_KEY=key_...
```

Optional tuning:

```bash
CURSOR_API_AUTH_MODE=auto
CURSOR_API_BASE_URL=https://api.cursor.com
CURSOR_API_TIMEOUT_MS=20000
CURSOR_API_MAX_RETRIES=2
CURSOR_API_RETRY_BASE_MS=800
```

Use Cursor Cloud when you want the current validated queued heavy-lift coding path.

Validate:

- `/cursor_status`
- `/cursor_models`
- `/cursor_jobs`
- `/cursor_create --repo <url> ...`
- `/cursor_sync <agent_id>`
- `/cursor_conversation <agent_id> 5`

If `/cursor_status` says `Cloud coding jobs: unavailable`, treat `/cursor_create`, `/cursor_followup`, `/cursor_stop`, `/cursor_models`, and Cloud artifact commands as unavailable until `CURSOR_API_KEY` is fixed.

### Cursor Desktop Bridge

Required on Andrea's host:

```bash
CURSOR_DESKTOP_BRIDGE_URL=https://your-bridge.example.com
CURSOR_DESKTOP_BRIDGE_TOKEN=replace-with-random-secret
```

Sometimes required on the bridge machine:

```bash
CURSOR_DESKTOP_CLI_PATH=/path/to/cursor-agent
```

Use the desktop bridge when you want operator-only machine-side session recovery or terminal control on your normal machine.

Validate:

- `/cursor_status`
- `/cursor_jobs`
- `/cursor_sync <desktop_session_id>`
- `/cursor_terminal <agent_id> echo operator smoke ok`
- `/cursor_terminal_status <agent_id>`
- `/cursor_terminal_log <agent_id> 20`

Important truth:

- `Desktop bridge terminal control: ready` means session/terminal control is ready.
- `Desktop bridge agent jobs: conditional|unavailable` means local desktop queued-agent execution is still not the baseline promise on that machine.
- Keep Cursor Cloud as the baseline heavy-lift path unless the desktop machine is explicitly validated.

### Runtime Route

Runtime-route readiness is separate.
Only configure it if you specifically want Cursor-backed runtime routing through 9router or an equivalent gateway.

If `/cursor_status` says `Cursor-backed runtime route: not configured`, that does **not** mean Cursor Cloud or desktop bridge are broken.

## Operator-Only Commands

Keep these in the registered main control chat:

- `/cursor_models`
- `/cursor_test`
- `/cursor_jobs`
- `/cursor_create`
- `/cursor_sync`
- `/cursor_conversation`
- `/cursor_followup`
- `/cursor_stop`
- `/cursor_artifacts`
- `/cursor_artifact_link`
- `/cursor_terminal`
- `/cursor_terminal_status`
- `/cursor_terminal_log`
- `/cursor_terminal_stop`

Safe public exception:

- `/cursor_status`

## Telegram Live Validation

Use [TELEGRAM_OPERATOR_LIVE_TESTING.md](TELEGRAM_OPERATOR_LIVE_TESTING.md) when you want this machine to send real inbound Telegram test messages from your own operator account.

Recommended flow:

1. `npm run telegram:user:auth`
2. `npm run telegram:user:send -- "<message>"`
3. `npm run telegram:user:batch`

Keep this tooling operator-only and pointed at your own DM or a dedicated test chat only.

## Security Defaults To Keep

- one public assistant identity only
- per-chat isolation
- least-privilege add-on enablement
- explicit purchase approvals
- no secrets in prompts, logs, or user-visible replies

Useful controls:

- `CURSOR_MAX_ACTIVE_JOBS_PER_CHAT`
- `ALEXA_VERIFY_SIGNATURE=true`
- `ALEXA_ALLOWED_USER_IDS=...`
- `AMAZON_BUSINESS_ORDER_MODE=trial`

## Incident Short Path

1. Capture the failing symptom and time.
2. Run `npm run setup -- --step verify`.
3. Check `logs/`.
4. Reproduce with the smallest failing command.
5. Restart services if state looks stale.
6. Re-run the failing flow.
7. Update docs if behavior changed.

## Documentation Rule

If behavior or wording changes, update docs in the same change set:

- `README.md`
- `docs/README.md`
- user/admin/setup docs touched by the change
- testing/runbook docs if validation changed

If a flow is conditional, say exactly what it depends on.
If a flow is operator-only, say that clearly.
