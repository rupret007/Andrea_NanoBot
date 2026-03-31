# Andrea OpenAI Bot

Andrea OpenAI Bot is the standalone Codex/OpenAI-backed Andrea bot. It keeps Andrea as the one assistant identity on the surface, while the runtime underneath stays provider-neutral and Podman-first.

This repo is not the Cursor/design sibling project. `Andrea_NanoBot` remains the separate repo for Cursor-oriented design and infrastructure work. This repo is the Codex/OpenAI lane that can later merge back into Andrea_Nano.

## What This Repo Is

- A standalone Andrea bot with a Codex-first runtime.
- Podman-first local execution with per-group isolation.
- Provider-neutral runtime routing with `codex_local` and `openai_cloud`.
- Internal legacy session compatibility so older imported state is not dropped.
- SQLite-backed thread and job persistence.
- A transport-agnostic orchestration service that external callers can wrap later.
- Operator-only runtime controls that stay secondary to Andrea's normal assistant behavior.

## Current Runtime Truth

Validated on March 30, 2026:

- `codex_local` reaches a real Podman container, seeds per-group `.codex` auth from the host Codex home, and returns structured runtime errors correctly.
- `codex_local` now also returns a successful live one-shot result in this environment.
- Same-thread `codex_local` follow-up was live-validated with the same returned session id.
- Podman image build and smoke run passed on Windows with Podman Desktop.
- Runtime-focused tests passed under Node `22.22.2`.
- Thread/job persistence, routing, Podman selection, scheduler integration, IPC auth, and operator command handling are covered by focused tests.
- A new internal orchestration boundary is in place for external callers such as NanoClaw.

Conditional or blocked:

- `openai_cloud` is implemented as a limited text fallback. It is not yet a full local-tool-parity runtime.
- `openai_cloud` live success is blocked until `OPENAI_API_KEY` or a compatible gateway token is configured.
- End-to-end operator command flows were validated through focused tests, but not through a live Telegram chat in this pass.

Deferred:

- `/runtime-artifacts` is intentionally not exposed yet. This repo does not have a small, truthful cross-runtime artifact model today, and logs are the current operator inspection surface.

## Runtime Model

- `codex_local`
  - Primary runtime.
  - Runs inside per-group Podman containers.
  - Uses the local Codex CLI in the container.
  - Seeds each group's mounted `.codex` home from the host Codex auth files when available.

- `openai_cloud`
  - Secondary fallback lane.
  - Only intended for cloud-safe tasks.
  - Requires `OPENAI_API_KEY` or a compatible gateway token.
  - Currently focused on text responses rather than local-tool parity.

Internal legacy compatibility:

- Older imported session rows are still hydrated internally as `claude_legacy`.
- That compatibility exists to preserve state during migration, not as a supported Andrea runtime lane.

## Product Shape

Andrea should feel like one assistant, not a bag of runtimes.

- Public interactions should stay warm, helpful, and conversation-first.
- Runtime/provider details stay mostly behind the scenes.
- Operator controls exist, but they are gated to the main control chat.
- Existing `CLAUDE.md` files remain the canonical per-group memory input for now. Codex gets an `AGENTS.md` overlay generated automatically.

## Requirements

- Node `22.x`
- Podman Desktop with a working local machine/runtime
- Windows, macOS, or Linux
- Existing Codex host auth in `%USERPROFILE%\.codex` or `CODEX_HOME`, or an `OPENAI_API_KEY`

Important:

- Node `24.x` is not validated for this repo in this pass because `better-sqlite3` failed to load cleanly in this environment.
- Podman is the default local container runtime.

## Quick Start

```powershell
npm install
npm run build
npm run build:agent-runner
podman build -t andrea-openai-agent:latest .\container
```

Optional `.env` values:

```dotenv
ASSISTANT_NAME=Andrea
AGENT_RUNTIME_DEFAULT=codex_local
AGENT_RUNTIME_FALLBACK=openai_cloud
CONTAINER_RUNTIME_BIN=podman
CODEX_LOCAL_ENABLED=true
OPENAI_MODEL_FALLBACK=gpt-5.4
```

If you want `openai_cloud`, add:

```dotenv
OPENAI_API_KEY=...
```

## Local Validation

Focused runtime tests:

```powershell
npm run test:runtime
```

One-off local runtime probe:

```powershell
npm run validate:runtime -- --runtime codex_local
```

One-off cloud fallback probe:

```powershell
npm run validate:runtime -- --runtime openai_cloud --route cloud_allowed
```

What these probes do:

- Build on the real host/container runner path.
- Reuse Podman and the actual container image.
- Mount a per-group workspace.
- Return the structured runtime result directly.

## Operator Commands

Main control chat only:

- `/runtime-status`
- `/runtime-jobs`
- `/runtime-followup GROUP_FOLDER TEXT`
- `/runtime-stop GROUP_FOLDER`
- `/runtime-logs GROUP_FOLDER [LINES]`

Legacy `/remote-control` commands are not part of the supported Andrea operator surface in this repo.

## NanoClaw Integration Boundary

This repo now exposes a transport-agnostic orchestration service for external operator surfaces.

Phase 1 surface:

- `createJob`
- `followUp`
- `getJob`
- `listJobs`
- `getJobLogs`
- `stopJob`

What this means:

- NanoClaw can own the Telegram dashboard and current-job UX
- Andrea can own durable Codex/OpenAI runtime execution
- there is still no HTTP, CLI, or stdio transport wrapper in this pass
- `openai_cloud` remains conditional on `OPENAI_API_KEY`

## Docs

- [Docs Index](docs/README.md)
- [Runtime](docs/RUNTIME.md)
- [Orchestration Contract](docs/ORCHESTRATION_CONTRACT.md)
- [Runtime audit](docs/RUNTIME_AUDIT.md)
- [Operations (restarts)](docs/OPERATIONS.md)
- [Setup And Requirements](docs/REQUIREMENTS.md)
- [Operator Commands](docs/OPERATOR_COMMANDS.md)
- [Testing And Validation](docs/TESTING.md)
- [Merge Boundary](docs/MERGE_BOUNDARY.md)
- [Legacy Reference](docs/LEGACY_REFERENCE.md)

Stress-style chat testing (~200 scripted messages, optional Telegram sender) is documented in [docs/TESTING.md](docs/TESTING.md).

## Honest Bottom Line

This repo is now operationally real enough to build, test, and exercise as Andrea's Codex-first runtime bot.

It is not fully proven as a production-ready daily driver yet because:

- the cross-repo transport layer does not exist yet
- `openai_cloud` still needs configured credentials and remains intentionally limited
- the Telegram-side operator flow was not live-driven in this pass

Even with those limits, the runtime is no longer just architecture on paper. Podman execution, per-group Codex auth seeding, structured error propagation, and runtime/operator surfaces are implemented and behaving truthfully.
