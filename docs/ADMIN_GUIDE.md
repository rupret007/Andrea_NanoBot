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
- startup, restart, verify, and troubleshooting
- release validation and docs accuracy

## What The Cursor Surfaces Mean

Andrea now treats Cursor as three separate surfaces:

### 1. Cursor Cloud

- requires `CURSOR_API_KEY`
- current validated heavy-lift queued coding path
- supports:
  - `/cursor-create`
  - `/cursor-sync` for Cloud jobs
  - `/cursor-conversation` for Cloud jobs
  - `/cursor-followup`
  - `/cursor-stop`
  - `/cursor-models`
  - `/cursor-results`
  - `/cursor-download`

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

Quick checks:

```bash
node --version
npm --version
docker info
podman info
npm run setup -- --step verify
```

On Windows PowerShell, use `npm.cmd` and `npx.cmd` if policy blocks `npm.ps1` or `npx.ps1`.

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
- `/cursor-jobs`
- `/cursor-create --repo <url> ...`
- `/cursor-sync <agent_id>`
- `/cursor-conversation <agent_id> 5`
- `/cursor-results <agent_id>`
- `/cursor-models`

Use `/cursor-conversation` for the text trail and `/cursor-results` for output files. Use `/cursor-download` only when `/cursor-results` shows a file you actually want.

If `/cursor_status` says `Cloud coding jobs: unavailable`, treat `/cursor-create`, `/cursor-followup`, `/cursor-stop`, `/cursor-models`, `/cursor-results`, and `/cursor-download` as unavailable until `CURSOR_API_KEY` is fixed.

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
- `/cursor-jobs`
- `/cursor-sync <desktop_session_id>`
- `/cursor-terminal <agent_id> echo operator smoke ok`
- `/cursor-terminal-status <agent_id>`
- `/cursor-terminal-log <agent_id> 20`

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

- Readiness and reference:
  - `/cursor-models`
- Work creation and control:
  - `/cursor-jobs`
  - `/cursor-create`
  - `/cursor-sync`
  - `/cursor-followup`
  - `/cursor-stop`
- Results:
  - `/cursor-conversation`
  - `/cursor-results`
  - `/cursor-download`
- Desktop machine-control:
  - `/cursor-terminal`
  - `/cursor-terminal-status`
  - `/cursor-terminal-log`
  - `/cursor-terminal-stop`
- Troubleshooting only:
  - `/cursor-test`

Safe public exception:

- `/cursor_status`

Optional operator-only integrations, only when configured:

- Alexa status:
  - `/alexa-status`
- Amazon shopping:
  - `/amazon-status`
  - `/amazon-search <keywords>`
  - `/purchase-request <asin> <offer_id> [quantity]`
  - `/purchase-requests`
  - `/purchase-approve <request_id> <approval_code>`
  - `/purchase-cancel <request_id>`

Compatibility note:

- operator docs use hyphen aliases in Telegram
- underscore aliases are still accepted, but the hyphen form is the preferred operator-facing syntax
- older `/cursor-artifacts` and `/cursor-artifact-link` aliases are still accepted, but `/cursor-results` and `/cursor-download` are the preferred workflow names now

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
