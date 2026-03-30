# Andrea Admin Guide

This guide is for operators who own uptime, security, and release quality.
It is intentionally practical: runbook first, theory second.

## 1) Your Job As Admin

You are responsible for:

- one public assistant identity (`Andrea`)
- safe configuration of model credentials and external integrations
- service lifecycle (`start`, `stop`, `restart`, startup policy)
- release validation before users feel changes
- keeping docs aligned with actual behavior

## 2) Baseline Requirements

Required:

- Node.js 22.x
- one healthy container runtime (`docker`, `podman`, or `apple-container`)
- at least one configured channel (usually Telegram first)
- valid model credentials (Anthropic-compatible endpoint + key flow)

Run these checks:

```bash
node --version
npm --version
docker info
podman info
npm run setup -- --step verify
```

On Windows PowerShell, use `npm.cmd` / `npx.cmd` when policy blocks `npm.ps1` / `npx.ps1`.

## 3) First Deployment Checklist

1. Copy env template:
   - `Copy-Item .env.example .env`
2. Configure model and channel credentials.
3. Run setup in Claude Code (`/setup`, `/add-telegram`).
4. Register main Telegram control chat via `/registermain` in DM.
5. Verify runtime:
   - `npm run setup -- --step verify`
6. Start services:
   - `npm run services:start`
7. Validate in chat:
   - `/ping`
   - `/help`
   - `/cursor_status`

## 4) Security Defaults You Should Keep

Keep these principles:

- one public bot identity only
- isolate chat workspaces by group folder
- explicit approvals for purchases
- least-privilege enablement for community skills
- no secrets in prompts, logs, or responses

Critical controls:

- `ALEXA_VERIFY_SIGNATURE=true` in real environments
- `ALEXA_ALLOWED_USER_IDS=...` for private Alexa rollout
- `AMAZON_BUSINESS_ORDER_MODE=trial` until you validate purchase flow
- `CURSOR_MAX_ACTIVE_JOBS_PER_CHAT` to prevent job flood

## 5) Service Operations

Primary commands:

```bash
npm run services:start
npm run services:stop
npm run services:restart
```

Validation after restart:

```bash
npm run setup -- --step verify
```

Expected result:

- `STATUS: success`
- configured channel auth
- container runtime healthy
- credential probe healthy

## 6) Feature-Specific Admin Checks

Cursor:

- `/cursor_status`
- `/cursor_test`
- `/cursor_models`
- `/cursor_jobs`
- `/cursor_terminal <agent_id> <command>`
- `/cursor_terminal_status <agent_id>`
- `/cursor_terminal_log <agent_id> [limit]`
- `/cursor_terminal_stop <agent_id>`
- [CURSOR_API_KEYS.md](CURSOR_API_KEYS.md) when you need a real `CURSOR_API_KEY` from Cursor Cloud
- [CURSOR_DESKTOP_BRIDGE.md](CURSOR_DESKTOP_BRIDGE.md) when Andrea should drive your normal Cursor machine instead of only cloud jobs
- if Cursor Cloud auth behaves differently than expected, set `CURSOR_API_AUTH_MODE=auto|bearer|basic`; default `auto` tries Bearer first and falls back to Basic

Before using deeper Cursor workflows, confirm `/cursor_status` shows the split you expect:

- `Cloud coding jobs: ready` means Andrea can run queued heavy-lift Cursor Cloud jobs
- `Desktop bridge terminal control: ready` means Andrea can inspect bridge-known sessions and run line-oriented shell commands on your normal machine
- `Desktop bridge agent jobs: validated|conditional|unavailable` tells you whether local desktop agent execution is fully proven on that machine
- if `Cloud coding jobs: unavailable`, keep `/cursor_create`, `/cursor_followup`, `/cursor_stop`, `/cursor_artifacts`, and `/cursor_artifact_link` out of the operational path until `CURSOR_API_KEY` is configured

Run advanced Cursor, Amazon, and Alexa slash commands from the registered main control chat only. `/cursor_status` is the safe exception that can stay visible in the narrower public surface.

Useful operator truth:

- `/cursor_jobs` now separates tracked and recoverable Cursor Cloud jobs from tracked and recoverable desktop bridge sessions
- `/cursor_models` is a Cursor Cloud query, but some accounts currently return no model list even when Cloud jobs work. If that happens, omit `--model` and let Cursor use the account default, or pass a known model id directly.
- `/cursor_create` through Cursor Cloud needs either `--repo <url>` on the command or a default repository configured in Cursor settings
- `/cursor_sync <agent_id>` can attach a recoverable Cursor Cloud job or desktop bridge session to the current workspace
- `/cursor_followup`, `/cursor_stop`, `/cursor_artifacts`, and `/cursor_artifact_link` are Cloud-oriented workflows in the current product
- Cursor desktop bridge can now run line-oriented shell commands for tracked bridge sessions through `/cursor_terminal ...`
- terminal control stays operator-only and tied to bridge-known sessions; it is not a live PTY, arbitrary shell attach, or remote desktop surface

Telegram live testing:

- use [TELEGRAM_OPERATOR_LIVE_TESTING.md](TELEGRAM_OPERATOR_LIVE_TESTING.md) when you want this machine to send real inbound Telegram test messages from your own operator account
- run `npm run telegram:user:auth` once to store a local MTProto session; QR auth is the recommended default
- run `npm run telegram:user:send -- "<message>"` or `npm run telegram:user:batch`
- run one harness command at a time; concurrent live-test sends can cross-capture replies and are blocked by the operator lock now
- keep this tooling operator-only and pointed at your own DM or dedicated test chat only

Alexa:

- `/alexa_status`
- validate HTTPS endpoint and ASK skill configuration
- see [ALEXA_VOICE_INTEGRATION.md](ALEXA_VOICE_INTEGRATION.md)

Amazon:

- `/amazon_status`
- `/amazon_search <keywords>`
- `/purchase_request ...`
- `/purchase_requests`
- see [AMAZON_SHOPPING_AND_APPROVALS.md](AMAZON_SHOPPING_AND_APPROVALS.md)

## 7) Release Gate (Do Not Skip)

Use this minimum gate before pushing operational changes:

```bash
npm run test:major:ci
npm run test:stability
```

`test:stability` runs three full validation rounds by design.
Treat failures as release blockers until fixed or explicitly waived.

## 8) Incident Response Short Path

1. Capture symptom and time.
2. Run `npm run setup -- --step verify`.
3. Check runtime logs in `logs/`.
4. Reproduce with the smallest failing command.
5. Restart services if state appears stale.
6. Re-run failing command and compare behavior.
7. Document the root cause and fix in PR/commit notes.

For deeper triage, use [DEBUG_CHECKLIST.md](DEBUG_CHECKLIST.md).

## 9) Documentation Hygiene Rule

Any time behavior changes, update docs in the same change set:

- root `README.md`
- `docs/README.md`
- feature docs touched by the change
- user/admin guidance if workflow changed

If a command or flow is no longer true, remove or rewrite it immediately.

## 10) Useful References

- [SETUP_AND_FEATURES_GUIDE.md](SETUP_AND_FEATURES_GUIDE.md)
- [CHANNEL_COMMANDS_AND_ONBOARDING.md](CHANNEL_COMMANDS_AND_ONBOARDING.md)
- [TELEGRAM_OPERATOR_LIVE_TESTING.md](TELEGRAM_OPERATOR_LIVE_TESTING.md)
- [ALEXA_VOICE_INTEGRATION.md](ALEXA_VOICE_INTEGRATION.md)
- [AMAZON_SHOPPING_AND_APPROVALS.md](AMAZON_SHOPPING_AND_APPROVALS.md)
- [TESTING_AND_RELEASE_RUNBOOK.md](TESTING_AND_RELEASE_RUNBOOK.md)
- [SECURITY.md](SECURITY.md)
