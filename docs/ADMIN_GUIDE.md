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
- the integrated Codex/OpenAI runtime lane and its optional local loopback backend
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
- `/runtime-*` remains the explicit runtime fallback shell
- does **not** replace `/cursor` as the taught operator flow
- `codex_local` is the intended primary runtime for this lane
- `openai_cloud` remains conditional on `OPENAI_API_KEY` or a compatible gateway
- host execution stays disabled until `ANDREA_RUNTIME_EXECUTION_ENABLED=true`
- operators should think in terms of one chat-scoped current work item with lane-specific capabilities, not two separate task systems

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
For login-start repair on Windows, `npm run setup -- --step service` now bootstraps the pinned Node 22.22.2 runtime even when the host `node.exe` is newer.

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
- `/runtime-*` remains the explicit fallback shell, but runtime cards now also support reply-linked follow-up when you reply to a real runtime card
- the current selected runtime job is now a compatibility mirror of the shared current-work selection used by `/cursor` and the runtime shell

## First Deployment Checklist

1. Copy the template:
   - `Copy-Item .env.example .env`
2. Configure model credentials and at least one channel.
3. Run setup in Claude Code:
   - `/setup`
   - `/add-telegram`
4. Register the main Telegram control chat with `/registermain` in the exact DM you want to use for operator work.
   - After that, `npm run services:status` should show `assistant_name=Andrea` and `registered_main_chat_jid` set to that same Telegram DM.
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
npm run services:ensure
npm run services:status
```

Windows startup truth:

- The canonical Windows launcher is `scripts/nanoclaw-host.ps1`.
- `npm run setup -- --step service` installs the preferred user-logon Scheduled Task when allowed.
- If Windows policy blocks task creation, the installer writes a repo-owned Startup-folder launcher instead.
- On this machine, the validated login path is the Startup-folder launcher because Scheduled Task creation is denied.
- The host launcher now keeps a repo-owned watchdog running in the background and calls `ensure` periodically so a stale or degraded assistant can be restarted without waiting for the next manual intervention.
- Telegram is only considered truly responsive once a real round-trip succeeds. The watchdog now drives a real `/ping` roundtrip probe against the main operator chat every 30 minutes when there has not been a more recent successful Telegram exchange.
- If the first due probe fails, the watchdog retries once after a short backoff and then restarts Andrea automatically if Telegram still does not reply.
- If Telegram itself is degraded but the operator-side roundtrip harness is still unconfigured, `services:ensure` now reports `degraded` plus `telegram_roundtrip=unconfigured` instead of pretending Telegram is healthy or thrashing Andrea with blind restart loops.
- `npm run services:status` now includes `assistant_health`, local Alexa listener and OAuth health when Alexa is configured, `telegram_roundtrip_health`, `telegram_roundtrip_last_ok_at`, `telegram_roundtrip_last_probe_at`, `telegram_roundtrip_next_due_at`, `watchdog_running`, plus the active repo root, branch, commit, DB path, assistant name source, and the currently registered main Telegram chat so runtime/state drift is visible immediately instead of looking falsely healthy.

Quick recovery steps after a failed login bring-up:

1. Run `npm run services:status`.
2. Check `logs/nanoclaw.host.log`.
3. If `assistant_health` is degraded or stale, run `npm run services:ensure` first, then `npm run services:restart` if it does not recover.
4. If `telegram_roundtrip_health` is degraded, run `npm run telegram:user:smoke` to prove the real `/ping` path and capture the exact failing stage.
5. If the login hook itself needs repair, rerun `npm run setup -- --step service`.

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

Task continuity rule:

- replying to a fresh task card always continues that exact task
- otherwise Andrea uses the current work selected in the lane you opened
- stale or missing work-card replies now fail honestly and point back to the lane-specific explicit fallback command

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
- tap `Current Work` or `Current Job`
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

Keep these in the registered main control chat shown by `registered_main_chat_jid` in `npm run services:status`:

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
- `/runtime-*` is the explicit runtime fallback shell for the `andrea_runtime` lane, not a second primary shell
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
3. Tap `Current Work`, `Jobs`, `New Cloud Job`, or `Codex/OpenAI`
4. Tap a task tile to make it current
5. Tap `Refresh`, `View Output`, `Results`, or `Continue`, or reply with `/cursor-sync`, `/cursor-conversation`, or `/cursor-results` without repeating the id
6. Reply with plain text to **Current Work**, the **Current Job** dashboard, or a fresh stored Cloud card when you want to continue that exact Cloud job
7. Use `/cursor-download <absolute_path>` as a reply to the current job dashboard or a result card when you want one file
8. Use `/cursor-terminal*` only for desktop bridge sessions

Important behavior:

- `/cursor` is now the main operator control panel
- `/cursor-jobs` now opens the Jobs browser view inside that control panel
- `Current Work` keeps the selected task visible across Cursor and runtime without hiding lane-specific backend truth
- the `Codex/OpenAI` tile keeps the integrated runtime lane inside the same operator shell without turning `/runtime-*` into a second primary UX
- Telegram inline buttons, in-place dashboard edits, and reply-linked output are operator UX improvements; explicit ids still work everywhere
- plain-text replies only turn into follow-up prompts when you reply to **Current Work**, the **Current Job** dashboard, or a stored **Cloud** Cursor card in the main control chat
- plain-text replies do **not** continue desktop sessions; desktop sessions still use `/cursor-sync`, `/cursor-conversation`, and `/cursor-terminal*`

## Telegram Live Validation

Use [TELEGRAM_OPERATOR_LIVE_TESTING.md](TELEGRAM_OPERATOR_LIVE_TESTING.md) when you want this machine to send real inbound Telegram test messages from your own operator account.

Recommended flow:

1. `npm run telegram:user:auth`
2. `npm run telegram:user:smoke`
2. `npm run telegram:user:send -- "<message>"`
3. `npm run telegram:user:tap -- <message_id> <button>`
4. `npm run telegram:user:send -- --reply-to <message_id> "<message>"`
5. `npm run telegram:user:batch`
6. `npm run telegram:user:runtime`

Keep this tooling operator-only and pointed at your own DM or a dedicated test chat only.

Important truth:

- `npm run telegram:user:smoke` is now the canonical operator proof that Telegram is actually working end to end.
- It sends a real `/ping` from the operator Telegram user session, waits for the real bot reply, exits non-zero on failure, and writes the same roundtrip state the watchdog uses.
- Normal unit tests and the default full test suite remain offline; the live Telegram smoke check is credentialed and explicit on purpose.

If `npm run telegram:user:runtime` fails immediately, check these in order:

1. `TELEGRAM_TEST_TARGET` or `TELEGRAM_BOT_USERNAME`
2. `TELEGRAM_USER_API_ID`
3. `TELEGRAM_USER_API_HASH`
4. authenticated `store/telegram-user.session`

Security note:

- The current bot token was exposed in operator chat history during debugging. Rotate it before treating Telegram production validation as fully trustworthy again.

For merged-shell architecture details, see:

- [BACKEND_LANES_ARCHITECTURE.md](BACKEND_LANES_ARCHITECTURE.md)

## Alexa Operator Validation

Treat Alexa as an optional private channel, not part of the baseline rollout.

Alexa is only **live-ready** when all of these are true:

- Node `22.22.2` is the active runtime on the host
- `ALEXA_SKILL_ID` is configured
- the Alexa listener is enabled locally
- an HTTPS tunnel or reverse proxy is forwarding the public Alexa endpoint
- the Alexa Developer Console skill is using that endpoint and the same skill ID
- account linking is configured in the Alexa console for Authorization Code Grant
- the local Andrea OAuth config is present:
  - `ALEXA_OAUTH_CLIENT_ID`
  - `ALEXA_OAUTH_CLIENT_SECRET`
  - `ALEXA_OAUTH_SCOPE`
- the OAuth target `groupFolder` already exists in Andrea

If any of those are missing, classify Alexa as **code-ready but setup-blocked** and do not present it as live-validated.

Current truthful closeout language:

- repo-side and near-live proof are strong
- the remaining live gap is one real signed Alexa utterance unless you re-prove it on the current host today

Final live acceptance order:

1. `/alexa-status`
2. local `GET /alexa/oauth/health`
3. public `GET /alexa/oauth/health`
4. unlinked launch
5. unlinked help
6. one unlinked personal-data request that should return a link-account style response
7. linked `my day`
8. linked `anything else`
9. linked `what about Candace` or `what about Travis`
10. linked `remind me before that`
11. one preference or explainability turn

What to verify:

- concise spoken replies
- one clarification at a time
- short follow-ups stay grounded in the immediate Alexa context
- daily guidance sounds measured and useful rather than generic
- explicit personalization controls stay consent-based and inspectable
- no Telegram/operator wording
- no personal data without linking
- no fake calendar/reminder output

## Security Defaults To Keep

- one public assistant identity only
- per-chat isolation
- least-privilege add-on enablement
- explicit purchase approvals
- no secrets in prompts, logs, or user-visible replies

Useful controls:

- `CURSOR_MAX_ACTIVE_JOBS_PER_CHAT`
- `ALEXA_VERIFY_SIGNATURE=true`
- `ALEXA_REQUIRE_ACCOUNT_LINKING=true`
- `ALEXA_ALLOWED_USER_IDS=...`
- `ALEXA_LINKED_ACCOUNT_GROUP_FOLDER=main`
- `AMAZON_BUSINESS_ORDER_MODE=trial`

## Incident Short Path

1. Capture the failing symptom and time.
2. Run `/debug-status` or `npm run debug:status`.
3. If service state looks stale, run `npm run services:restart` and wait for it to finish.
4. Run `npm run setup -- --step verify` after restart completes. Do not overlap restart and verify.
5. Turn logging up only where needed:
   - `/debug-level debug chat 60m`
   - `/debug-level verbose component:container 30m`
6. Reproduce with the smallest failing command or chat turn.
7. Tail `/debug-logs current 120` and `/debug-logs stderr 120` (or the host-side equivalents).
8. Reset debug overrides with `/debug-reset all`.
9. Update docs if behavior changed.

Quick interpretation:

- no reply: restart first, then verify, then reproduce and inspect `current`
- delayed reply: add `verbose` on `component:container`, reproduce, then inspect `current` and `stderr`
- `ASSISTANT_EXECUTION_PROBE=failed` with `initial_output_timeout`: treat it as a runtime-startup/output issue first, not a plain credential miss

## Documentation Rule

If behavior or wording changes, update docs in the same change set:

- `README.md`
- `docs/README.md`
- user/admin/setup docs touched by the change
- testing/runbook docs if validation changed

If a flow is conditional, say exactly what it depends on.
If a flow is operator-only, say that clearly.
