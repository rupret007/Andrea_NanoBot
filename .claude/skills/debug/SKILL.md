---
name: debug
description: Diagnose Andrea service, routing, container, channel, and credential health through the canonical read-only status and validation surfaces.
---

# Debug Andrea

Diagnose before changing state. Use the canonical service and route-aware
container path; never revive a legacy runner or weaken a trust boundary to make
a probe pass.

## 1. Establish current truth

Run read-only checks first:

```bash
git status --short
git rev-parse HEAD
npm run services:status
npm run check:node
```

Record the active repository root, branch/SHA, serving SHA, process identity,
container runtime, configured channels, and explicit external proof debt. A
responsive service on an older or dirty artifact is stale, not healthy release
evidence.

Inspect only the bounded log lines needed to explain the symptom. Redact secret
values, tokens, message bodies, and personal paths from any report. Never print
or copy `.env`, OneCLI configuration responses, host Claude/Codex profiles, or
full transcripts.

## 2. Validate the container boundary

For runner, mount, routing, or credential symptoms, use:

```bash
npm run container:install
npm run typecheck:agent-runner
npm run build:agent-runner
npm run test:agent-runner
npm run check:container-contract
npm run check:container-canary
npm run check:container-mounts
```

Current invariants:

- ordinary `direct_assistant` turns have zero SDK tools and no MCP;
- other routes receive only their exact built-in and MCP allowlists;
- canonical runner source and trusted controls are read-only and compile into
  container-local `/tmp`;
- only scoped session/group state and IPC are writable;
- host `.env`, Codex home/auth/config, project settings, and hooks are never
  mounted or copied;
- OneCLI is preferred; when unavailable, exactly one selected credential may
  enter through the child-process environment in
  `degraded_env_fallback`, with only a bare key name in container arguments;
- Docker and Podman are supported; Apple Container execution fails closed.

Do not copy environment files, mount `/root/.claude`, restore writable runner
copies, use the retired `/claw` helper, or force Apple Container.

## 3. Classify the failure

- **Repository regression:** reproduce in a focused test, fix the smallest
  affected boundary, and rerun callers plus the relevant full gate.
- **Stale build/service:** build from a clean committed SHA, verify provenance,
  then restart only with operator authorization.
- **External/operator evidence debt:** report the exact missing configuration or
  proof without editing production state to manufacture success.
- **Credential mode:** use status/metadata only. Never accept a key in chat,
  read secret values, put values in argv, or install/migrate OneCLI.

`npm run setup -- --step verify` is live: it can make a model request and start
container probes. Run it only after explicit live-validation authorization.

## 4. Repair boundary

Use repository-owned build/service commands. Do not automatically prune Docker,
Podman, Apple Container, caches, volumes, images, or owner data. Do not reset,
rebase, rewrite history, manually advance cursors, or alter production state to
make a check pass.

After an authorized repair, rerun the focused reproducer, the affected release
gate, and `npm run services:status`. Report what was proved, what remains
external, and whether serving SHA/provenance match the candidate.
