# Cursor API Keys And Andrea

Andrea supports two distinct Cursor backends:

- Cursor Cloud Agents over `https://api.cursor.com`
- the optional desktop bridge that lets Andrea inspect bridge-known sessions and run machine-side terminal commands on your own machine

This guide is about where the keys come from and what they do.

## Two Supported Paths

| Path | What it enables | What Andrea needs |
| --- | --- | --- |
| Cursor Cloud Agents API | Create, follow up, inspect, and stop Cursor Cloud jobs | `CURSOR_API_KEY` plus optional `CURSOR_API_*` tuning |
| Cursor desktop bridge | Recover bridge-known sessions and run line-oriented terminal commands on the Cursor machine you normally use | `CURSOR_DESKTOP_BRIDGE_URL` and `CURSOR_DESKTOP_BRIDGE_TOKEN` |

Important boundary:

- There is no documented public HTTP API for driving the desktop Cursor IDE UI directly.
- If you want "use my Mac while I am away from my desk" behavior, use the desktop bridge path documented in [CURSOR_DESKTOP_BRIDGE.md](CURSOR_DESKTOP_BRIDGE.md).

## Where To Create `CURSOR_API_KEY`

1. Sign in at [cursor.com](https://cursor.com).
2. Open [Dashboard -> Cloud Agents](https://cursor.com/dashboard/cloud-agents).
3. Under `User API Keys`, create a key and copy it once.

Useful references:

- [Cursor API overview](https://cursor.com/docs/api)
- [Cloud Agents API endpoints](https://cursor.com/docs/cloud-agent/api/endpoints.md)
- [Cursor CLI authentication](https://cursor.com/docs/cli/reference/authentication)

The dashboard key often looks like `key_...`. Store it only in secrets such as your local `.env` file. Do not commit it.

## Auth Mode

Andrea accepts:

- `CURSOR_API_AUTH_MODE=auto`
- `CURSOR_API_AUTH_MODE=basic`
- `CURSOR_API_AUTH_MODE=bearer`

Default is `auto`, which tries Bearer first and then falls back to Basic if the endpoint rejects it.

Compatibility alias:

- `CURSOR_AUTH_MODE` is also accepted

## What This Key Is Not

- It is not the same as BYOK model keys you may store inside the Cursor IDE for OpenAI or Anthropic billing.
- It does not expose a live remote-control API for the desktop editor UI.
- It is not required for the desktop bridge path unless the bridge machine itself needs it for local Cursor CLI work.

## Quick Verification

After setting `CURSOR_API_KEY` in `.env`:

1. restart Andrea
2. run `/cursor_status`
3. confirm the `Cursor Capability Summary` reports `Cloud coding jobs: ready`

If `/cursor_status` still shows `Cloud coding jobs: unavailable`, queued Cursor Cloud job commands are not ready yet.
