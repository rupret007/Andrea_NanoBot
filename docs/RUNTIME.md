# Runtime

## Architecture

This repo uses a provider-neutral runtime model:

- `codex_local`
- `openai_cloud`
- `claude_legacy`

Routing policy:

- `local_required`
- `cloud_allowed`
- `cloud_preferred`

High-level flow:

```text
Telegram or other channel
  -> SQLite message/task state
  -> per-group queue
  -> runtime selection
  -> Podman container
  -> Andrea reply
```

## Local Runtime

`codex_local` is the primary path.

What it does:

- runs inside a per-group Podman container
- mounts the group workspace and IPC namespace
- mounts a per-group `.codex` home
- seeds that `.codex` home from the host Codex auth files when available
- generates an `AGENTS.md` overlay while keeping `CLAUDE.md` as the current memory source

What was live-validated on March 30, 2026:

- container image build
- Podman smoke run
- real container launch through `runContainerAgent`
- host Codex auth seeding into the per-group `.codex` mount
- structured Codex runtime error propagation back to the host runner

What is still blocked:

- a successful live local answer in this environment, because the Codex account hit a usage limit during validation
- live same-thread follow-up proof, because there was no successful first turn to continue from

## Cloud Fallback

`openai_cloud` is intentionally secondary.

What it does today:

- handles cloud-safe text work
- uses OpenAI Responses
- persists provider-neutral thread/job metadata

What it does not do yet:

- full local tool parity
- local filesystem edits
- local shell parity with `codex_local`

What was validated on March 30, 2026:

- the container reaches the `openai_cloud` lane
- missing credentials now produce an explicit structured error

What is still needed:

- configured `OPENAI_API_KEY` or compatible gateway token
- successful live cloud turn validation

## Persistence

Persisted state includes:

- runtime threads
- legacy sessions
- scheduled tasks
- task run logs
- registered groups

Legacy `sessions` rows are hydrated as `claude_legacy` thread records so old session state is not silently dropped.

## Operator Surface

Operator-only runtime commands are handled separately from normal assistant conversation:

- `/runtime-status`
- `/runtime-jobs`
- `/runtime-followup`
- `/runtime-stop`
- `/runtime-logs`

The old Claude remote-control bridge is intentionally disabled.

## `/runtime-artifacts`

Deferred in this pass.

Reason:

- there is no small, truthful artifact abstraction shared by both `codex_local` and `openai_cloud`
- current operator inspection uses logs and job/thread state
- exposing a command now would overpromise availability and semantics
