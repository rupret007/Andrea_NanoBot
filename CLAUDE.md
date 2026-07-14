# Andrea_NanoBot

Personal AI assistant. See [README.md](README.md) for the product and setup
overview, [docs/SECURITY.md](docs/SECURITY.md) for current trust boundaries,
and [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) only for the archived upstream
design record.

## Quick Context

Single Node.js process with a skill-based channel system. Telegram and
BlueBubbles are bundled Andrea channel surfaces; WhatsApp, Slack, Discord,
Gmail, and other channel paths are optional skills/add-ons when enabled. Active
channels self-register at startup. Messages are classified into route-specific
Claude Agent SDK policies: ordinary direct chat is tool-free, while protected,
control, advanced, and code work receive bounded capabilities. Each group has
isolated filesystem and session state.

## Key Files

| File                       | Purpose                                                           |
| -------------------------- | ----------------------------------------------------------------- |
| `src/index.ts`             | Orchestrator: state, message loop, agent invocation               |
| `src/channels/registry.ts` | Channel registry (self-registration at startup)                   |
| `src/ipc.ts`               | IPC watcher and task processing                                   |
| `src/router.ts`            | Message formatting and outbound routing                           |
| `src/config.ts`            | Trigger pattern, paths, intervals                                 |
| `src/container-runner.ts`  | Spawns agent containers with mounts                               |
| `src/task-scheduler.ts`    | Runs scheduled tasks                                              |
| `src/db.ts`                | SQLite operations                                                 |
| `groups/{name}/CLAUDE.md`  | Per-group memory (isolated)                                       |
| `container/skills/`        | Canonical skills exposed only to routes with the `Skill` built-in |

## Secrets / Credentials / Proxy (OneCLI)

OneCLI Agent Vault is the preferred credential boundary. When it is available,
raw credentials stay behind its constrained proxy. If it is unavailable,
Andrea may use an explicitly degraded fallback that injects exactly one selected
credential through the container-runtime child environment. Container arguments
contain only the bare key name; values must never appear in arguments, process
listings, mounted files, logs, errors, or diagnostics. Host Codex home, auth,
and config are never mounted or copied into agent containers.

## Skills

Four types of skills exist in NanoClaw. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy and guidelines.

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-telegram`, `/add-slack`)
- **Utility skills** — may ship reviewed code alongside SKILL.md; the historical
  `/claw` alternate runner is retired and inert
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`)

| Skill               | When to Use                                                                        |
| ------------------- | ---------------------------------------------------------------------------------- |
| `/setup`            | First-time installation, authentication, service configuration                     |
| `/customize`        | Adding channels, integrations, changing behavior                                   |
| `/debug`            | Container issues, logs, troubleshooting                                            |
| `/update-nanoclaw`  | Bring upstream NanoClaw updates into a customized install                          |
| `/init-onecli`      | Preflight an operator-provisioned OneCLI vault without reading or changing secrets |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch                      |
| `/get-qodo-rules`   | Load org- and repo-level coding rules from Qodo before code tasks                  |

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, SKILL.md format rules, PR requirements, and the pre-submission checklist (searching for existing PRs/issues, testing, description format).

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
npm run container:install
npm run typecheck:agent-runner
npm run build:agent-runner
npm run test:agent-runner
npm run check:container-contract
npm run build:container
npm run check:container-canary
npm run check:container-mounts
```

Service management:

```bash
# Cross-platform status
npm run services:status

# Windows lifecycle
npm run services:start
npm run services:stop
npm run services:restart

# macOS launchd lifecycle
npm run mac:services:start
npm run mac:services:stop
npm run mac:services:restart
```

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate skill, not bundled in core. Run `/add-whatsapp`, which merges the `whatsapp/main` skill branch (see `.claude/skills/add-whatsapp/SKILL.md`) and then `npm run build`. Existing auth credentials and groups are preserved.

## Container Build Cache

Use the repository-owned build and canary commands above. Do not automatically
prune Docker, Podman, Apple Container, or owner caches: pruning is destructive,
can affect unrelated workloads, and is not a release-validation shortcut.
