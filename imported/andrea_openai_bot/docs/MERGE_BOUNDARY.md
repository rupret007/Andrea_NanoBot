# Merge Boundary

This repo is now the Codex/OpenAI runtime lane in a two-repo system.

Current directional split:

- `NanoClaw` is becoming the primary Telegram/operator surface
- `Andrea_OpenAI_Bot` is becoming the durable runtime backend NanoClaw can call

This pass does **not** merge the repos. It defines the clean boundary between them.

## What Andrea Owns

- provider-neutral runtime selection
- Podman-first container execution
- per-group thread continuity
- durable runtime orchestration jobs
- job-specific logs and honest runtime failures
- Codex auth seeding into per-group `.codex`

## What NanoClaw Owns

- Telegram dashboard and button UX
- current selection / "current job" UI state
- reply-linked operator workflows
- operator guidance and navigation

## Contract To Preserve

- the orchestration request/response model in [ORCHESTRATION_CONTRACT.md](ORCHESTRATION_CONTRACT.md)
- runtime thread/job persistence shape
- route policy semantics:
  - `local_required`
  - `cloud_allowed`
  - `cloud_preferred`
- the truth that `codex_local` is primary and `openai_cloud` is conditional

## What Is Intentionally Deferred

- HTTP, CLI, stdio, or other transport wrapping
- a shared dashboard/session state layer across repos
- artifact browsing
- a session-browser API separate from job records

## Temporary Standalone Conveniences

These still live here for local validation and development:

- standalone runtime validation script
- runtime-focused README/docs framing
- local bot packaging metadata
- real-world message corpus and optional Telegram sender under `scripts/`
