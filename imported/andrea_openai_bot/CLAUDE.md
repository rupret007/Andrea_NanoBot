# Andrea OpenAI Bot

This repo is Andrea's standalone Codex/OpenAI-backed bot. It exists so Andrea
can use a Codex-first runtime now and merge the mature runtime pieces back into
Andrea_NanoBot later.

## Product Intent

- Andrea is the only assistant identity on the public surface.
- Telegram and conversation-first behavior matter more than exposing internal
  runtime machinery.
- Operator controls exist, but they stay secondary and gated.
- Status, docs, and command replies must be honest about what is proven,
  conditional, or intentionally deferred.

## Runtime Truth

- `codex_local` is the primary runtime.
- `openai_cloud` is the secondary fallback for cloud-safe work.
- Podman is the default local container runtime.
- Existing `CLAUDE.md` files remain the canonical memory input in this pass.
- `claude_legacy` exists only as an internal compatibility lane.
- The old remote-control bridge is intentionally disabled here.

## Key Paths

| Path | Purpose |
|------|---------|
| `src/index.ts` | Main bot/runtime entry point |
| `src/agent-runtime.ts` | Runtime routing, readiness, and status formatting |
| `src/container-runner.ts` | Host-side container execution and per-group mounts |
| `src/container-runtime.ts` | Podman/Docker/Apple runtime abstraction |
| `src/db.ts` | SQLite persistence |
| `src/task-scheduler.ts` | Scheduled task execution |
| `container/agent-runner/src/index.ts` | Container-side Codex/OpenAI runtime loop |
| `docs/RUNTIME.md` | Truthful runtime behavior and validation notes |
| `docs/MERGE_BOUNDARY.md` | What should merge back into Andrea_Nano later |

## Working Rules

- Keep Andrea-first language on public and operator-facing surfaces.
- Do not oversell runtime health when credentials or live proof are missing.
- Do not import Cursor-specific workflow into this repo.
- Prefer small, truthful operator surfaces over speculative power features.
- When changing runtime behavior, update tests and docs in the same pass.

## Validation Commands

```powershell
npm run test:runtime
npm run test
npm run typecheck
npm run build
npm run build:agent-runner
podman build -t andrea-openai-agent:latest .\container
npm run validate:runtime -- --runtime codex_local
```
