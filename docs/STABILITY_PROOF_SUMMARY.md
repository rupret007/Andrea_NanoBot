# Stability Proof Summary

This document identifies the two areas of Andrea/NanoClaw that should be kept most stable to maintain system reliability.

## Top Two Stability-Critical Areas

### 1. Container Runner and Agent Execution Layer

**Location:** `src/container-runner.ts`, `container/agent-runner/src/index.ts`, `src/container-runtime.ts`

**Why this must stay stable:**

The container runner is the execution boundary between the host orchestrator and the agent sandbox. It handles:

- **Security isolation** — All agent execution happens inside containers with restricted mounts. The `buildVolumeMounts()` function carefully controls what the agent can read/write. Any regression here could expose secrets (`.env` is explicitly shadowed) or allow cross-group privilege escalation.

- **Credential flow** — The OneCLI integration (`onecli.applyContainerConfig()`) ensures real API keys never enter containers. Credentials are injected at the gateway layer. Breaking this path would either leak secrets or break all agent invocations.

- **Timeout and lifecycle management** — The dual-timeout system (initial output timeout + hard timeout) prevents runaway containers. The `OUTPUT_START_MARKER`/`OUTPUT_END_MARKER` protocol enables reliable streaming output parsing. Any protocol changes require synchronized updates to both host and container code.

- **Error classification** — The `failureKind` taxonomy (`auth_failed`, `insufficient_quota`, `runtime_bootstrap_failed`, etc.) powers self-healing retries. Changing this classification affects recovery behavior across the entire system.

**Recent activity risk:** The last 30 commits show active development in runtime lanes and diagnostics. Changes to container timeouts, mount logic, or error handling require careful validation since they affect every user message.

**Stability recommendations:**
- Do not change the `OUTPUT_START_MARKER`/`OUTPUT_END_MARKER` protocol without coordinated updates
- Treat `buildVolumeMounts()` as security-critical — any mount changes need security review
- Keep the OneCLI fallback path (`collectFallbackCredentialEnv`) working for users without OneCLI
- Maintain backward compatibility for `ContainerInput`/`ContainerOutput` interfaces

---

### 2. SQLite Database Schema and State Persistence

**Location:** `src/db.ts`

**Why this must stay stable:**

The database is the single source of truth for all persistent state. It stores:

- **Message history** — `chats` and `messages` tables. Breaking schema changes would lose conversation context.

- **Scheduled tasks** — `scheduled_tasks` table with status tracking and next-run calculation. Regressions here silently break automations users depend on.

- **Lane-aware operator context** — `cursor_operator_contexts` with `selected_lane_id`, `selected_jobs_by_lane_json`. This is the newest addition that enables multi-lane job tracking. Legacy rows without lane data are treated as `cursor` for backward compatibility.

- **Alexa, calendar, and runtime job state** — Multiple interrelated tables (`alexa_conversation_contexts`, `calendar_automations`, `runtime_backend_jobs`, etc.) that must stay consistent.

**Schema coupling risk:** The database schema touches nearly every feature: Telegram commands read/write here, task scheduler queries `scheduled_tasks`, Cursor dashboard reads `cursor_operator_contexts`, Alexa uses `alexa_*` tables. A schema migration bug would cascade across the entire system.

**Stability recommendations:**
- Never drop columns without a migration path
- Maintain the `CREATE TABLE IF NOT EXISTS` pattern for additive schema changes
- Keep the `selected_lane_id` null-means-cursor fallback logic for backward compatibility
- Test schema changes against existing production databases before merge

---

## Validation Checklist

Before any change to these areas:

```bash
# 1. Full stability gate
npm run test:stability

# 2. Live verify on operator host
npm run setup -- --step verify

# 3. Restart and smoke test
npm run services:restart
npm run telegram:user:smoke
```

See [TESTING_AND_RELEASE_RUNBOOK.md](./TESTING_AND_RELEASE_RUNBOOK.md) for the complete validation sequence.

---

## Areas That Can Tolerate More Change

For contrast, these areas are more tolerant of iteration:

- **Channel implementations** (`src/channels/telegram.ts`, etc.) — Isolated behind the registry interface
- **Cursor dashboard UI** — Button layouts and tile formatting can iterate freely
- **Alexa spoken output wording** — Can be refined without affecting core stability
- **Container skills** (`container/skills/`) — Additive and self-contained

The key distinction: container runner and database are foundational infrastructure that everything else depends on. Channel UX and dashboard polish are leaf nodes that can change without cascading effects.
