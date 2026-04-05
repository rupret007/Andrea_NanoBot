# Andrea OpenAI Backend Lane

`Andrea_NanoBot` now treats `Andrea_OpenAI_Bot` as a local loopback execution backend for the Codex/OpenAI runtime lane.

This repo is the orchestration shell. The backend repo is the execution truth.

## Ownership Split

`Andrea_NanoBot` owns:

- Telegram and operator UX
- text-card rendering plus local reply-card and current-selection UX state
- current control context
- backend detection on loopback
- operator command parsing
- stable `jobId` handling on the frontend side

`Andrea_OpenAI_Bot` owns:

- runtime execution
- provider routing
- durable job lifecycle
- thread reuse
- backend logs
- stop/cancel behavior
- truthful runtime and provider errors

## Loopback Contract

The current local backend contract is:

- `GET /meta`
- `POST /jobs`
- `POST /jobs/:jobId/followup`
- `GET /jobs`
- `GET /jobs/:jobId`
- `GET /jobs/:jobId/logs`
- `POST /jobs/:jobId/stop`

`jobId` is the primary opaque backend handle.

`threadId` is secondary continuity metadata returned by the backend when a real reusable runtime thread exists.

Live behavior note:

- long `codex_local` turns can remain `running` while `latestOutputText` already contains useful output
- `GET /jobs/:jobId/logs` can return an honest empty result until the backend finishes the container run and writes the terminal log file

## NanoBot Command Surface

In the current checkout, NanoBot uses an explicit fallback surface for this lane:

- `/runtime-status`
- `/runtime-create TEXT`
- `/runtime-jobs [LIMIT] [BEFORE_JOB_ID]`
- `/runtime-job [JOB_ID]`
- `/runtime-followup JOB_ID TEXT`
- `/runtime-logs [JOB_ID] [LINES]`
- `/runtime-stop [JOB_ID]`

These commands are main-control-only.

The shared `/cursor` cockpit is now the primary taught operator shell:

- `Current Work` shows the selected work item for this chat, regardless of whether it lives in Cursor or the Codex/OpenAI runtime lane
- explicit backend ids still win whenever you provide one
- `/runtime-*` remains the lane-honest fallback when you want direct runtime control

NanoBot does not re-sort backend job lists. It uses the backend ordering directly:

- newest first
- stable ordering
- `beforeJobId` pagination

## Runtime Lane V1 Inventory

- `/runtime-status`
  - reads backend readiness from `GET /meta`
  - shows backend identity, state, version, transport, and current `group.folder`
- `/runtime-create TEXT`
  - submits a new backend job with the current chat's `group.folder`
  - silently self-heals missing backend group registration when local bootstrap succeeds
- `/runtime-jobs [LIMIT] [BEFORE_JOB_ID]`
  - lists backend jobs for the current `group.folder`
  - preserves backend ordering and exposes `nextBeforeJobId` directly
- `/runtime-job [JOB_ID]`
  - refreshes one backend job
  - with no `JOB_ID`, refreshes the current runtime selection for that chat
  - shows `jobId`, status, backend, group folder, selected runtime, thread id, prompt, and output summary
  - if `current` points at a dead task, Andrea clears the stale current-work selection and tells the operator exactly what happened
- `/runtime-followup JOB_ID TEXT`
  - sends a follow-up against the backend `jobId`
  - preserves continuity through backend thread reuse when available
- reply-linked runtime card follow-up
  - replying naturally to a fresh runtime card routes to backend `POST /jobs/:jobId/followup`
  - stale or missing reply context fails honestly and points back to `Current Work` or `/runtime-followup JOB_ID TEXT`
- `/runtime-logs [JOB_ID] [LINES]`
  - reads backend logs for a job
  - with no `JOB_ID`, uses the current runtime selection for that chat
  - stays honest when logs are not written yet by falling back to current job state and latest useful output
- `/runtime-stop [JOB_ID]`
  - requests a live stop for the backend job when possible
  - with no `JOB_ID`, uses the current runtime selection for that chat
  - distinguishes live stop accepted vs already finished vs no longer stoppable

Direct-command parity note:

- `/runtime-*` replies now use the same richer single-task structure as the shared cockpit
- responses keep the authoritative backend `jobId` visible
- next-step guidance always includes exact-id fallbacks such as `/runtime-job <jobId>`, `/runtime-logs <jobId>`, `/runtime-followup <jobId> <text>`, and `/runtime-stop <jobId>`

## Group Folder Strategy

For this pass, NanoBot uses the current registered chat context as the authoritative workspace mapping:

- create/list uses `registeredGroups[chatJid].folder`
- refresh/follow-up/logs/stop validate the backend job against that same current context

This keeps `groupFolder` deterministic without inventing a second context model in this repo.

## Backend Readiness

NanoBot maps the backend into four local states:

- `not_enabled`
- `unavailable`
- `not_ready`
- `available`

`/runtime-status` is the operator-facing check for this.

## First-Run Bootstrap

If the backend reports:

`No registered group found for folder "..."`

NanoBot first treats that as a local bootstrap step, not an immediate hard failure.

Current behavior:

- NanoBot uses its own registered chat context as the source of truth for the backend payload
- NanoBot calls local-only `PUT /groups/:groupFolder`
- if registration succeeds, NanoBot retries the original `POST /jobs` or `GET /jobs` request once
- if that retry succeeds, normal job flow continues with no extra setup step

`bootstrap_required` is now the narrower legacy/degraded case:

- the backend is reachable
- the group is missing
- but the backend does not expose or accept the local registration route

`bootstrap_failed` is the registration-specific failure case:

- NanoBot reached the backend
- NanoBot attempted registration
- the backend rejected the registration or the post-registration create retry still failed

This keeps the ownership split clean:

- NanoBot owns chat/group context truth
- `Andrea_OpenAI_Bot` owns execution truth once the group is registered

## Current Acceptance Status

The runtime lane is complete enough for a command-first v1 operator shell.

What is complete now:

- local loopback backend detection
- self-healing first-run backend group bootstrap
- create, list, refresh, follow-up, logs, and stop through backend `jobId`
- reply-linked runtime card follow-up from Telegram runtime cards
- chat-scoped current work selection through the shared Andrea shell, with runtime selection mirrored only for compatibility
- unified `/cursor` cockpit plus direct `/runtime-*` fallback controls
- stale current runtime selections are cleared honestly when direct commands discover the selected task is gone
- scripted Telegram runtime validation via `npm run telegram:user:runtime`

What is still conditional on this checkout:

- real Telegram acceptance requires:
  - `TELEGRAM_TEST_TARGET` or `TELEGRAM_BOT_USERNAME`
  - `TELEGRAM_USER_API_ID`
  - `TELEGRAM_USER_API_HASH`
  - an authenticated `store/telegram-user.session`

Without those, Telegram acceptance is honestly blocked even though the runtime lane itself is wired.

## Still Out Of Scope

This v1 closeout does not add:

- dashboard state or button-first menus
- new backend routes
- broader UI systems beyond the current runtime cards plus `/runtime-*` shell
