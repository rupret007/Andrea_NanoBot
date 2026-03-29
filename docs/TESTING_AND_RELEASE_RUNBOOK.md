# Andrea Testing And Release Runbook

This runbook defines how to validate Andrea_NanoBot end-to-end for every major iteration.
Use it before major merges, main-branch pushes, or live deployment changes.

## Goals

- catch regressions before release
- keep Windows + Node 22 + container runtime paths reliable
- validate runtime credentials, channel routing, and registration behavior
- produce a repeatable process the team can run every time

## Test Layers

### 1) Fast local checks

```bash
npm run format:check
npm run typecheck
npm run lint
npm run test
npm run build
```

### 2) Major iteration suite (single command)

```bash
npm run test:major
```

What it runs in order:

1. `format:check`
2. `typecheck`
3. `lint`
4. `test` (Vitest suite)
5. `build` (TypeScript compile)
6. `setup -- --step verify` (live runtime verification)

Use this before each major merge/deploy.

### 3) CI-safe major suite

```bash
npm run test:major:ci
```

This is the same suite without live credential verification (`--skip-live-verify`).
Use this in CI runners that do not have live credentials/channels.

## Live End-to-End Acceptance (Operator Machine)

Run this on the real host where the bot is deployed.

### Preconditions

- Node 22 baseline available
- at least one container runtime healthy (`docker info`, `podman info`, or `container --help`)
- model credentials configured (OneCLI or `.env`)
- at least one channel configured
- at least one registered group or `/registermain` completed

### Acceptance sequence

1. Run:
   - `npm run test:major`
2. Confirm verify output includes:
   - `STATUS: success`
   - `CREDENTIAL_RUNTIME_PROBE: ok`
   - `REGISTERED_GROUPS: >= 1`
   - `SERVICE: running`
3. Send a real message from a registered chat and confirm:
   - message is stored in logs/DB
   - assistant returns a response
4. If using marketplace features:
   - search a skill
   - enable it in one target chat
   - confirm it is available next message
   - disable it and confirm removal from that chat

## Failure Handling

### `CREDENTIAL_RUNTIME_PROBE: failed`

- quota/auth/model mismatch issues surface here
- rerun `npm run setup -- --step verify`
- check `CREDENTIAL_RUNTIME_PROBE_REASON` and `NEXT_STEPS` fields

### Service not running

```bash
npm run setup -- --step service
npm run setup -- --step verify
```

### Telegram registered group issues

- DM bot: `/registermain`
- verify DB registration:
  - `registered_groups` contains your `tg:<chat-id>` row

## CI Policy

`.github/workflows/ci.yml` runs on:

- pull requests to `main`
- pushes to `main`
- `ubuntu-latest` and `windows-latest`
- Node 22

CI command:

```bash
npm run test:major:ci
```

## Release Gate (Required)

Before pushing a release branch:

1. `npm run test:major` must pass.
2. live verify must be green (`STATUS: success`).
3. update docs if behavior changed (setup/runtime/channels/marketplace/testing).
4. capture final command outputs in release notes/PR summary.
