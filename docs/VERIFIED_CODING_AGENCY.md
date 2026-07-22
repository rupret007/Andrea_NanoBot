# Verified Coding Agency v1

Andrea's coding surfaces share one capability truth model while keeping their execution and authority boundaries separate. This version adds a supervised in-repository Codex service, completes the Cursor desktop bridge lifecycle, and makes `/cursor`, `/job`, `/work`, diagnostics, repair routing, and ordinary capability answers use the same readiness facts.

## Architecture

`CodingCapabilityRegistry` is the decision source. A surface can be `disabled`, `configured`, `reachable`, `authenticated`, `ready`, `degraded`, `needs-proof`, `external-block`, or `policy-block`. Every record states operations, locality, mutability, separate approvals, current proof, blocker, and next action.

| Surface | Purpose | Execution truth |
| --- | --- | --- |
| Cursor Cloud | Hosted queued agent work | Ready only after an authenticated read-only API probe |
| Cursor desktop terminal | Loopback terminal/session control | Separate from agent execution; never GUI automation |
| Cursor desktop agent | Supported standalone agent CLI | `Cursor.app` or its launcher alone is not proof |
| Codex CLI | Binary/auth availability | Does not imply Andrea can dispatch Codex |
| Codex local backend | Loopback supervised jobs | Ready only when enabled, reachable, authenticated, and execution-ready |
| OpenAI fallback | Bounded text analysis | Never substituted for filesystem or coding-agent work |

Explicit `--lane=cursor` and `--lane=codex` requests fail closed if unavailable. Auto routing considers only ready surfaces that support every classified operation and reports any fallback.

## Authority and result truth

Every delegated task receives a `CodingDelegationPacket`. Analysis and repository reads are read-only. Edits are allowed only in a private isolated Git worktree. Dependency installation, commit, push, pull request, merge, deployment, destructive Git, production changes, external mutation, and messaging require independent authority and are prohibited when that authority is absent.

Every terminal Codex job includes a `CodingWorkResult`. Agent prose is always untrusted. The supervisor independently observes process exit, Git/filesystem changes, configured verification commands, and artifacts before allowing a claim into grounded response planning. Cursor provider summaries and URLs are labeled provider output and do not prove files, tests, artifacts, remote changes, deployment, or goal success.

Normal chat such as “can you use Codex?” or “can you build a game?” reports capability and does not launch a job. Job creation remains explicit through `/job` or `/work`.

## Supervised Codex service

The optional service preserves Andrea's existing backend contract:

- `GET /meta` and `GET /status`
- `PUT /groups/:groupFolder`
- `POST /jobs`, `GET /jobs`, and `GET /jobs/:jobId`
- `POST /jobs/:jobId/followup` and `POST /followups`
- `GET /jobs/:jobId/logs`
- `POST /jobs/:jobId/stop`
- `POST /jobs/:jobId/cleanup`

It binds only to loopback, takes an exclusive process lock, keeps state private (`0700` directories and `0600` records), uses the existing host Codex authentication in place, and never reads, logs, or copies credential contents. It uses argv-based process execution with no shell interpolation and a minimal environment without API keys.

Repository mappings are canonicalized and checked against allowlisted roots. Repository-root symlinks, tracked secret-sensitive files, path escapes, and live-checkout edits are rejected. A dirty source checkout is preserved. Each new task gets a detached private Git worktree; a follow-up must reuse the proven Codex thread and exact worktree. Recovery converts an interrupted invocation to a truthful failed state while preserving the worktree. Cleanup removes only a clean terminal worktree and refuses to discard dirty work products.

Configuration is intentionally inert until an operator enables it separately:

```dotenv
ANDREA_CODEX_SERVICE_HOST=127.0.0.1
ANDREA_CODEX_SERVICE_PORT=3210
ANDREA_CODEX_ALLOWED_REPOSITORY_ROOTS=/absolute/approved/root
ANDREA_CODEX_GROUP_REPOSITORIES={"main":"/absolute/approved/root/repository"}
ANDREA_CODEX_DEFAULT_REPOSITORY_ROOT=/absolute/approved/root/repository
ANDREA_CODEX_MAX_CONCURRENT_JOBS=1
ANDREA_CODEX_JOB_TIMEOUT_MS=2700000
ANDREA_CODEX_VERIFICATION_COMMANDS=[["npm","run","typecheck"],["npm","test","--","--run"]]
```

`ANDREA_CODEX_BINARY` can select an existing absolute executable. Omit values that are not needed; at least one approved repository root must resolve. The service manager reads only `ANDREA_CODEX_*` values and never modifies `.env`.

Build first, then inspect without installing or restarting anything:

```bash
npm run build
npm run codex:local:dry-run
npm run debug:coding
npm run debug:coding:probe
```

Owner-reviewed activation is a separate operation:

```bash
npm run codex:local:install
npm run codex:local:status
```

Andrea's client must also be configured for the loopback URL and enabled by its existing backend policy. Installing this service alone does not change the production lane.

## Cursor desktop lifecycle

The bridge is also loopback-only and token-authenticated. It distinguishes the Cursor launcher from a standalone agent executable and never invokes a launcher subcommand merely to discover capabilities. `CURSOR_DESKTOP_FORCE` defaults to false.

Relevant values are:

```dotenv
CURSOR_DESKTOP_BRIDGE_HOST=127.0.0.1
CURSOR_DESKTOP_BRIDGE_PORT=4124
CURSOR_DESKTOP_BRIDGE_URL=http://127.0.0.1:4124
CURSOR_DESKTOP_BRIDGE_TOKEN=<private-random-token>
CURSOR_DESKTOP_DEFAULT_CWD=/absolute/approved/workspace
CURSOR_DESKTOP_AGENT_CLI_PATH=/absolute/path/to/a-supported-standalone-agent
CURSOR_DESKTOP_FORCE=false
```

Inspect and, only after owner review, install with:

```bash
npm run cursor:bridge:dry-run
npm run cursor:bridge:status
npm run cursor:bridge:install
```

Terminal/session readiness does not imply agent-job readiness. A standalone agent remains `needs-proof` until authentication and isolated disposable-repository execution are proven.

## Diagnostics and certification

`npm run debug:coding` is configuration/filesystem-only. `npm run debug:coding:probe` adds bounded read-only network/process health checks. Neither starts a coding job.

The feature gate is:

```bash
npm run test:verified-coding-agency
```

It runs a frozen deterministic policy evaluation with at least 30 cases and an actual-Git disposable-repository test. Unit coverage additionally exercises loopback HTTP compatibility, unauthorized roots, symlink escape, tracked secret paths, concurrency, cancellation, timeout, continuation, cleanup, false claims, failed verification, capability replies, and routing consistency.

## Current activation posture

The implementation is ready for review and disposable testing. Production activation is deliberately deferred: this build does not edit production `.env`, install/restart either LaunchAgent, enable the backend policy, contact a person, push from an agent job, deploy, or enable BlueBubbles outbound.
