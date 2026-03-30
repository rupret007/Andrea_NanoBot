# Current Runtime Spec

This document describes the current standalone Codex-first Andrea runtime, not the upstream NanoClaw shape.

## Goals

- Andrea-first surface
- provider-neutral runtime layer
- `codex_local` as the primary local path
- `openai_cloud` as a conditional fallback
- Podman as the default local container runtime
- per-group isolation and scheduler behavior preserved
- operator controls available but secondary

## Persisted Runtime Types

- runtime thread state
- legacy session compatibility state
- scheduled task state
- registered group state

## Routes

- `local_required`
  - local files, local shell, local mounts, host-only behavior

- `cloud_allowed`
  - cloud-safe assistant work

- `cloud_preferred`
  - explicitly cloud-preferred requests

## Runtime Adapters

- `codex_local`
  - local containerized Codex path
  - primary path

- `openai_cloud`
  - secondary path
  - limited text fallback today

- `claude_legacy`
  - compatibility only

## Operator Surface

- `/runtime-status`
- `/runtime-jobs`
- `/runtime-followup`
- `/runtime-stop`
- `/runtime-logs`

Not included:

- `/runtime-artifacts`
- Claude remote-control bridge

## Validation State

As of March 30, 2026:

- architecture exists and is wired through the real container runner
- Podman behavior is live-validated
- Codex auth seeding is live-validated
- successful local Codex completion is blocked by runtime account usage limits in this environment
- successful cloud fallback is blocked by missing configured OpenAI credentials in this environment
