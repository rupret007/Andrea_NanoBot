# Andrea Testing And Release Runbook

This runbook defines how to validate Andrea_NanoBot end-to-end for every major iteration.
Use it before major merges, main-branch pushes, or live deployment changes.

## Goals

- catch regressions before release
- keep Windows + Node 22 + container runtime paths reliable
- validate runtime credentials, channel routing, and registration behavior
- produce a repeatable process the team can run every time
- enforce a stability gate of three consecutive full passes before sign-off

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

Implementation note:

- `test:major` and `test:major:ci` execute checks with Node 22 through `npx -p node@22` so validation remains deterministic even if your host default Node is newer.

What it runs in order:

1. `format:check`
2. `typecheck`
3. `lint`
4. `test` (Vitest suite)
5. `build` (TypeScript compile)
6. `setup -- --step verify` (live runtime verification)

Use this before each major merge/deploy.

### 3) Stability gate (three full successful rounds)

```bash
npm run test:stability
```

This runs the full CI-safe major stack three times in a row and fails immediately if any round fails.
Use this when you want high confidence before a restart, deploy, or branch cut.

For live environments where credential/runtime probes are expected:

```bash
npm run test:stability:live
```

That adds `setup -- --step verify` to each round.

### 4) CI-safe major suite

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
2. Run stability gate:
   - `npm run test:stability`
3. Confirm verify output includes:
   - `STATUS: success`
   - `CREDENTIAL_RUNTIME_PROBE: ok`
   - `REGISTERED_GROUPS: >= 1`
   - `SERVICE: running`
4. Send a real message from a registered chat and confirm:
   - message is stored in logs/DB
   - assistant returns a response
5. If using marketplace features:
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
npm run services:restart
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
2. `npm run test:stability` must pass with `3/3` successful rounds.
3. live verify must be green (`STATUS: success`) on the operator host.
4. update docs if behavior changed (setup/runtime/channels/marketplace/testing/services).
5. capture final command outputs in release notes/PR summary.
