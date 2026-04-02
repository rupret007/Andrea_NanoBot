# Andrea OpenAI Backend Lane

`Andrea_NanoBot` now treats `Andrea_OpenAI_Bot` as a local loopback execution backend for the Codex/OpenAI runtime lane.

This repo is the orchestration shell. The backend repo is the execution truth.

## Ownership Split

`Andrea_NanoBot` owns:

- Telegram and operator UX
- text-card rendering and later reply/card/dashboard state
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

In the current checkout, NanoBot uses a command-first fallback surface for this lane:

- `/runtime-status`
- `/runtime-create TEXT`
- `/runtime-jobs [LIMIT] [BEFORE_JOB_ID]`
- `/runtime-job JOB_ID`
- `/runtime-followup JOB_ID TEXT`
- `/runtime-logs JOB_ID [LINES]`
- `/runtime-stop JOB_ID`

These commands are main-control-only.

NanoBot does not re-sort backend job lists. It uses the backend ordering directly:

- newest first
- stable ordering
- `beforeJobId` pagination

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
