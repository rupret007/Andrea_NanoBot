# Andrea Admin Guide

This guide is for operators who own uptime, setup, security, and release quality.
It is intentionally practical: product shape first, runbook second, theory last.

## Product Model

Andrea has one public assistant identity and one narrow public chat surface.

Andrea_NanoBot is now also the merged home for Andrea's shared orchestration shell:

- the shell stays here
- Cursor remains the primary rich backend lane
- `andrea_runtime` is integrated as a secondary Codex/OpenAI lane
- the imported `imported/andrea_openai_bot` subtree is temporary staging and history preservation only

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

### 4. Andrea Runtime Lane

- integrated Codex/OpenAI backend lane under the shared shell
- execution truth lives in the lane, not in Telegram command handlers
- surfaced through the `Codex/OpenAI` tile inside `/cursor`
- `/runtime-*` remains temporary secondary scaffolding
- does **not** replace `/cursor` as the taught operator flow
- `codex_local` is the intended primary runtime for this lane
- `openai_cloud` remains conditional on `OPENAI_API_KEY` or a compatible gateway
- host execution stays disabled until `ANDREA_RUNTIME_EXECUTION_ENABLED=true`

Read the architecture note when you need the ownership boundary:

- [BACKEND_LANES_ARCHITECTURE.md](BACKEND_LANES_ARCHITECTURE.md)

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
- healthy assistant execution probe

Important verify truth:

- `CREDENTIAL_RUNTIME_PROBE` answers "can the configured endpoint/auth/model be reached?"
- `ASSISTANT_EXECUTION_PROBE` answers "can Andrea's main assistant runtime actually start and produce first output?"
- a passing credential probe does **not** mean the direct-assistant lane is fully usable

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
- `/cursor`
- tap `Jobs`
- `/cursor-create --repo <url> ...`
- tap/select a job from `Jobs`
- tap `Refresh`, `View Output`, or `Results`
- or reply to the current job dashboard with `/cursor-sync`, `/cursor-conversation`, or `/cursor-results`
- `/cursor-models`

Use `/cursor-conversation` for the text trail and `/cursor-results` for output files. Use `/cursor-download <absolute_path>` as a reply to the current job dashboard or a Cursor result card when `/cursor-results` shows a file you actually want. Raw ids still work, but they are now the fallback path rather than the normal taught path.

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
- `/cursor`
- tap `Jobs`
- tap/select a desktop session
- tap `Refresh`
- `/cursor-terminal <agent_id> echo operator smoke ok`
- tap `Current Job`
- tap `Terminal Status`
- tap `Terminal Log`

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
  - `/cursor`
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
- Codex/OpenAI runtime scaffolding:
  - `/runtime-status`
  - `/runtime-jobs`
  - `/runtime-followup [job_id|list_number|current|group_folder] <text>`
  - `/runtime-stop [job_id|list_number|current|group_folder]`
  - `/runtime-logs [job_id|list_number|current|group_folder] [lines]`
- Live troubleshooting controls:
  - `/debug-status`
  - `/debug-level <normal|debug|verbose> [scope] [duration]`
  - `/debug-reset [scope|all]`
  - `/debug-logs [service|stderr|current|cursor|runtime] [lines]`

Compatibility note:

- operator docs use hyphen aliases in Telegram
- underscore aliases are still accepted, but the hyphen form is the preferred operator-facing syntax
- older `/cursor-artifacts` and `/cursor-artifact-link` aliases are still accepted, but `/cursor-results` and `/cursor-download` are the preferred workflow names now
- `/runtime-*` is temporary secondary scaffolding for the `andrea_runtime` lane, not a second primary shell
- `/debug-*` is troubleshooting-only and operator-only; keep it out of the public command story

## Live Debug Controls

Use these only in Andrea's main control chat when you are actively troubleshooting:

- `/debug-status`
  - show current global level, scoped overrides, and last assistant execution probe
- `/debug-level <normal|debug|verbose> [scope] [duration]`
  - apply a live override without restart
  - Telegram defaults to `60m` when duration is omitted
- `/debug-reset [scope|all]`
  - clear one override or reset everything back to normal
- `/debug-logs [service|stderr|current|cursor|runtime] [lines]`
  - tail recent sanitized logs

Supported scopes:

- `global`
- `chat` or `current`
- `lane:cursor`
- `lane:andrea_runtime`
- `component:assistant`
- `component:container`
- `component:telegram`

Host-side fallback uses the same persisted state:

```bash
npm run debug:status
npm run debug:level -- debug current 60m
npm run debug:level -- verbose component:container 30m
npm run debug:logs -- current 120
npm run debug:reset -- all
```

These changes apply live and survive restart because they are stored in `router_state`.

## Cursor Workflow In Telegram

This is the normal operator flow now:

1. Run `/cursor_status`
2. Run `/cursor`
3. Tap `Jobs`, `Current Job`, `New Cloud Job`, or `Codex/OpenAI`
4. Tap a task tile to make it current
5. Tap `Refresh`, `View Output`, `Results`, or `Continue`, or reply with `/cursor-sync`, `/cursor-conversation`, or `/cursor-results` without repeating the id
6. Reply with plain text to the **Current Job** dashboard when you want to continue a Cloud job
7. Use `/cursor-download <absolute_path>` as a reply to the current job dashboard or a result card when you want one file
8. Use `/cursor-terminal*` only for desktop bridge sessions

Important behavior:

- `/cursor` is now the main operator control panel
- `/cursor-jobs` now opens the Jobs browser view inside that control panel
- the `Codex/OpenAI` tile keeps the integrated runtime lane inside the same operator shell without turning `/runtime-*` into a second primary UX
- Telegram inline buttons, in-place dashboard edits, and reply-linked output are operator UX improvements; explicit ids still work everywhere
- plain-text replies only turn into follow-up prompts when you reply to the **Current Job** dashboard or a stored **Cloud** Cursor card in the main control chat
- plain-text replies do **not** continue desktop sessions; desktop sessions still use `/cursor-sync`, `/cursor-conversation`, and `/cursor-terminal*`

## Telegram Live Validation

Use [TELEGRAM_OPERATOR_LIVE_TESTING.md](TELEGRAM_OPERATOR_LIVE_TESTING.md) when you want this machine to send real inbound Telegram test messages from your own operator account.

Recommended flow:

1. `npm run telegram:user:auth`
2. `npm run telegram:user:send -- "<message>"`
3. `npm run telegram:user:tap -- <message_id> <button>`
4. `npm run telegram:user:send -- --reply-to <message_id> "<message>"`
5. `npm run telegram:user:batch`

Keep this tooling operator-only and pointed at your own DM or a dedicated test chat only.

For merged-shell architecture details, see:

- [BACKEND_LANES_ARCHITECTURE.md](BACKEND_LANES_ARCHITECTURE.md)

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
3. Run `/debug-status` or `npm run debug:status`.
4. Turn logging up only where needed:
   - `/debug-level debug chat 60m`
   - `/debug-level verbose component:container 30m`
5. Reproduce with the smallest failing command or chat turn.
6. Tail `/debug-logs current 120` and `/debug-logs stderr 120` (or the host-side equivalents).
7. Restart services if state looks stale.
8. Re-run the failing flow.
9. Reset debug overrides with `/debug-reset all`.
10. Update docs if behavior changed.

## Documentation Rule

If behavior or wording changes, update docs in the same change set:

- `README.md`
- `docs/README.md`
- user/admin/setup docs touched by the change
- testing/runbook docs if validation changed

If a flow is conditional, say exactly what it depends on.
If a flow is operator-only, say that clearly.
