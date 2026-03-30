# Cursor API Keys And Andrea

Andrea supports two different Cursor paths:

- **Cursor Cloud** for queued heavy-lift coding jobs
- **Cursor desktop bridge** for operator-only session recovery and line-oriented terminal control on your own machine

This guide is about `CURSOR_API_KEY`, what it enables, and how that differs from the desktop bridge.

## What `CURSOR_API_KEY` Is

`CURSOR_API_KEY` is your Cursor Cloud user API key.
Andrea uses it to talk to the hosted Cursor Cloud Agents API at `https://api.cursor.com`.

This key enables the current validated heavy-lift Cursor path in Andrea.

## What `CURSOR_API_KEY` Enables

When `CURSOR_API_KEY` is configured and accepted, Andrea can use Cursor Cloud for:

- `/cursor_create`
- `/cursor_sync` for Cursor Cloud jobs
- `/cursor_conversation` for Cursor Cloud jobs
- `/cursor_followup`
- `/cursor_stop`
- `/cursor_models`
- `/cursor_artifacts`
- `/cursor_artifact_link`

Important boundary:

- `CURSOR_API_KEY` enables hosted Cursor Cloud workflows.
- It does **not** configure the desktop bridge.
- It does **not** expose a live remote-control API for the local Cursor IDE UI.

## How This Differs From The Desktop Bridge

The desktop bridge is a separate operator-only surface.

| Path | Requires | What it is for |
| --- | --- | --- |
| Cursor Cloud | `CURSOR_API_KEY` | Queued heavy-lift coding jobs |
| Cursor desktop bridge | `CURSOR_DESKTOP_BRIDGE_URL`, `CURSOR_DESKTOP_BRIDGE_TOKEN`, and sometimes `CURSOR_DESKTOP_CLI_PATH` on the bridge machine | Session recovery and line-oriented terminal control on your own machine |

Important truth:

- Desktop bridge readiness does not imply Cursor Cloud readiness.
- Cursor Cloud readiness does not imply desktop bridge readiness.
- Cursor-backed runtime routing is a third, separate surface.

## Where To Create `CURSOR_API_KEY`

1. Sign in at [cursor.com](https://cursor.com).
2. Open [Dashboard -> Cloud Agents](https://cursor.com/dashboard/cloud-agents).
3. Under `User API Keys`, create a key and copy it once.

Useful references:

- [Cursor API overview](https://cursor.com/docs/api)
- [Cloud Agents API endpoints](https://cursor.com/docs/cloud-agent/api/endpoints.md)
- [Cursor CLI authentication](https://cursor.com/docs/cli/reference/authentication)

The dashboard key often looks like `key_...`.
Store it in secrets only, such as your local `.env`.
Do not commit it.

## Supported Auth Modes

Andrea accepts:

- `CURSOR_API_AUTH_MODE=auto`
- `CURSOR_API_AUTH_MODE=basic`
- `CURSOR_API_AUTH_MODE=bearer`

Default is `auto`, which tries Bearer first and then falls back to Basic.

Compatibility alias:

- `CURSOR_AUTH_MODE`

## What To Put In `.env`

Minimum Cloud setup:

```bash
CURSOR_API_KEY=key_...
```

Common optional tuning:

```bash
CURSOR_API_BASE_URL=https://api.cursor.com
CURSOR_API_AUTH_MODE=auto
CURSOR_API_TIMEOUT_MS=20000
CURSOR_API_MAX_RETRIES=2
CURSOR_API_RETRY_BASE_MS=800
```

## What Happens When It Is Missing

If `CURSOR_API_KEY` is missing, Cursor Cloud heavy-lift workflows are unavailable.

In practice that means:

- `/cursor_create` will not be ready
- `/cursor_followup` and `/cursor_stop` for Cloud jobs will not be ready
- `/cursor_models` will not be ready
- Cloud artifact lookup will not be ready
- `/cursor_status` should say `Cloud coding jobs: unavailable`

Operator next step:

1. Add `CURSOR_API_KEY` to Andrea's `.env`.
2. Restart Andrea.
3. Run `/cursor_status`.
4. Confirm it says `Cloud coding jobs: ready`.

## Validation Steps

After configuring the key:

1. Restart Andrea.
2. Run `/cursor_status`.
3. Confirm:
   - `Cloud coding jobs: ready`
4. Run a safe Cloud smoke:
   - `/cursor-create --repo https://github.com/rupret007/Andrea_NanoBot Reply with exactly: live cloud smoke ok. Do not modify files, branches, or PRs.`
5. Run:
   - `/cursor-sync <agent_id>`
   - `/cursor-conversation <agent_id> 5`

If `/cursor_models` returns no models, that does not automatically mean Cloud is broken.
Some accounts still return an empty model list even while Cloud jobs work with the default model.

## One-Line Mental Model

Use `CURSOR_API_KEY` when you want Andrea to run validated queued Cursor Cloud jobs.
Use the desktop bridge only when you want operator-only session or terminal access to your own machine.
