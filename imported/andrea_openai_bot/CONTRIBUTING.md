# Contributing

This repo is the standalone Codex/OpenAI Andrea bot. Keep changes focused on
making the runtime more real, more truthful, and easier to merge back into the
broader Andrea product later.

## Core Principles

- Keep Andrea as one coherent assistant identity.
- Keep runtime/provider details mostly behind the scenes.
- Keep operator controls powerful but secondary.
- Prefer honest status over optimistic status.
- Do not add features that only exist on paper.

## Good Contribution Areas

- runtime routing and provider selection
- Podman/container execution
- per-group isolation and persistence
- scheduler/runtime integration
- operator-only runtime controls
- truthful setup/admin/testing docs
- focused validation and failure-mode improvements

## Out Of Scope For This Repo

- Cursor-specific runtime workflows from `Andrea_NanoBot`
- public product redesign work that belongs in the sibling repo
- fake parity features with no validation path
- exposing every internal tool on the public assistant surface

## Before You Open A PR

Run the relevant checks for your change. Runtime changes should usually include:

```powershell
npm run test:runtime
npm run test
npm run typecheck
npm run build
npm run build:agent-runner
```

If your change touches the local runtime path, also validate the container path:

```powershell
podman build -t andrea-openai-agent:latest .\container
npm run validate:runtime -- --runtime codex_local
```

## PR Expectations

- One focused change per PR when possible.
- Update docs when behavior or operational expectations change.
- Call out what is newly validated, what is still conditional, and what remains
  intentionally deferred.
- Keep user-facing language Andrea-first and operator language truthful.
