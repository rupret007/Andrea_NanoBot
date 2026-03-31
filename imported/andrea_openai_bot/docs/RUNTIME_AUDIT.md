# Runtime reality audit

This document classifies subsystems for the Andrea OpenAI Bot (Codex-first standalone). It is the non-negotiable audit called for in the runtime completion plan. Update it when live proof or automated coverage changes.

Legend:

| Tag | Meaning |
|-----|---------|
| **A** | Automated test coverage (CI / `vitest`) |
| **L** | Live-proven on a real host (manual or scripted) |
| **C** | Conditional on environment, credentials, or provider quotas |
| **U** | Implemented but not live-proven end-to-end |
| **D** | Doc drift risk (legacy NanoClaw/Claude framing elsewhere) |

---

## Runtime / provider model

| Aspect | State | Notes |
|--------|-------|-------|
| Provider-neutral routing (`codex_local`, `openai_cloud`, `claude_legacy`) | **A**, **U** | Routing and policy exercised in tests; full multi-provider live matrix not always re-run locally. |
| Policy: `local_required`, `cloud_allowed`, `cloud_preferred` | **A** | See `src/routing.test.ts`, `src/agent-runtime.test.ts`. |
| Env: `AGENT_RUNTIME_DEFAULT`, `AGENT_RUNTIME_FALLBACK`, `CONTAINER_RUNTIME_BIN`, `CODEX_LOCAL_ENABLED`, `OPENAI_MODEL_FALLBACK` | **A**, **C** | Verify against `setup/environment.ts` when adding new vars. |

---

## codex_local

| Aspect | State | Notes |
|--------|-------|-------|
| Podman container launch, mounts, `.codex` seeding | **A**, **L** | Live validation (Mar 30, 2026): container reached Codex; structured errors on quota/limit. Second pass same day: `validate:runtime` from Podman machine VM + portable Node 22 launched child container; honest error when Codex auth not seeded (`auth.json` / `cap_sid`). |
| Successful assistant reply | **C** | Blocked when Codex account is rate-limited or over quota; plumbing is not the blocker. |
| Same-thread follow-up after first success | **A**, **C** | Persistence covered in tests; live E2E follow-up needs one successful prior turn. |

---

## openai_cloud

| Aspect | State | Notes |
|--------|-------|-------|
| Lane selection and honest missing-credential errors | **A**, **L** | Explicit error when `OPENAI_API_KEY` / compatible token missing. Re-verified Mar 30, 2026 (second pass) via `validate:runtime --runtime openai_cloud` in Podman machine + Node 22. |
| Successful cloud completion | **C** | Requires valid OpenAI credentials and routing that allows cloud. |

---

## Podman selection / container runtime

| Aspect | State | Notes |
|--------|-------|-------|
| `CONTAINER_RUNTIME_BIN`, Podman-first messaging | **A**, **L** | Tests + live Podman on Windows (Mar 30, 2026). |
| Docker fallback | **C** | Works when `CONTAINER_RUNTIME_BIN=docker` and Docker is available. |

---

## Group isolation and workspace mounts

| Aspect | State | Notes |
|--------|-------|-------|
| Per-group folder, IPC paths, mount rules | **A** | `container-runner` tests and integration-style coverage. |
| Operational clarity for operators | **U** | Documented in `RUNTIME.md`; on-call proof is ad hoc. |

---

## Thread / session persistence

| Aspect | State | Notes |
|--------|-------|-------|
| Runtime threads and jobs in SQLite | **A** | `src/db-agent-threads.test.ts` and related. |
| Hydration of legacy `sessions` as `claude_legacy` | **A** | See `RUNTIME.md` persistence section. |

---

## Operator runtime commands

| Command | Parsing / gating | Live Telegram |
|---------|------------------|---------------|
| `/runtime-status` | **A** | **U** |
| `/runtime-jobs` | **A** | **U** |
| `/runtime-followup` | **A** | **U** |
| `/runtime-stop` | **A** | **U** |
| `/runtime-logs` | **A** | **U** |
| `/runtime-artifacts` | **Deferred** | Not implemented; logs and DB job rows are the honest inspection surface until artifact semantics are real. |

---

## Scheduler / runtime interaction

| Aspect | State | Notes |
|--------|-------|-------|
| Scheduled tasks invoke container agent with runtime metadata | **A** | `src/task-scheduler.test.ts`. |
| Live long-running schedule stability | **U** | Depends on production-like uptime testing. |

---

## Claude-shaped assumptions (legacy)

| Aspect | State | Notes |
|--------|-------|-------|
| `claude_legacy` internal lane | **A**, **D** | Product copy should not present Claude as primary; code may retain compat. |
| `CLAUDE.md` memory file naming in groups | **D** | Intentional compatibility; `AGENTS.md` overlay documented in `RUNTIME.md`. |
| Disabled `/remote-control` | **A** | See `OPERATOR_COMMANDS.md`. |

---

## Documentation truthfulness

| Doc set | State | Notes |
|---------|-------|-------|
| `README.md`, `docs/RUNTIME.md`, `OPERATOR_COMMANDS.md`, `TESTING.md`, `MERGE_BOUNDARY.md` | **L** (reviewed in pass) | Current Codex-first Andrea framing. |
| Older NanoClaw deep dives under `docs/` | **D** | Treat as legacy unless updated; see `docs/README.md`. |

---

## Automated tests vs live proof — summary

**Has automated tests:** runtime routing, provider gating, Podman argv behavior, DB persistence for threads/jobs, operator command parsing/gating, scheduler integration, IPC auth, many failure paths.

**Has real live proof (reported):** Podman image build/smoke, container launch through runner, Codex structured errors (including quota and missing Codex home auth), OpenAI missing-key path, runtime validation script wiring, full **200-message** real-world corpus dry-run (`scripts/realworld-send.mjs --dry-run`).

**Second pass (Mar 30, 2026, same day):** `npm test` **257** passed and `npm run test:runtime` **143** passed inside `podman run … node:22` with both root and `container/agent-runner` installs; `podman build -t andrea-openai-agent:latest ./container` on Windows host; `podman run … echo` smoke **Container OK**; `npm run validate:runtime` for `codex_local` and `openai_cloud` executed from **Podman machine** Linux VM (portable Node 22 tarball + `CONTAINER_RUNTIME_BIN=podman`) with structured JSON errors as expected without credentials. **Service restart** (launchd/systemd): not applicable on this dev host — no Andrea unit configured; use [OPERATIONS.md](OPERATIONS.md) where a service exists.

**Blocked or conditional:** full successful Codex reply (needs host Codex auth seed and quota); OpenAI success without key; same-thread live follow-up without prior success; live Telegram operator walkthrough; optional `--send` corpus run (needs `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`, main chat only for `/runtime-*`).

**Product-shape cleanup:** keep public copy Andrea-first; keep runtime details in operator/docs layers.

---

## Windows / Node install caveat (Mar 30, 2026)

On a Windows host with **Node 24** and **no Visual Studio C++ build tools**, `npm install` may fail on `better-sqlite3` (no prebuild for that Node version). Use **Node 22.x** as documented in `docs/TESTING.md`, or install build tools, so `npm test` and `npm run build` can run locally.
