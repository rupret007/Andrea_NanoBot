# Andrea Testing And Release Runbook

This runbook defines how to validate Andrea end to end before major merges, main-branch pushes, or live deployment changes.

## What This Runbook Separates

This repo has three different validation layers:

- **CI-safe validation**
  - formatting, typecheck, lint, tests, build
  - no assumption of live credentials or channels
- **Operator-host live validation**
  - real runtime, real credentials, real channel behavior
  - restart and verify on the deployed machine
- **Optional integration validation**
  - Cursor Cloud
  - desktop bridge
  - Alexa
  - Amazon
  - marketplace/community skills

Do not treat optional integration checks as baseline unless that integration is actually configured.

## 1. Fast Local Checks

```bash
npm run format:check
npm run typecheck
npm run lint
npm run test
npm run build
```

## 2. Major Suite

```bash
npm run test:major
```

This is the standard pre-release validation stack on a real operator machine.

It includes:

1. formatting check
2. typecheck
3. lint
4. unit tests
5. production build
6. `setup -- --step verify`

Implementation note:

- `test:major` and `test:major:ci` already run with Node 22 through `npx -p node@22`

## 3. Stability Gate

```bash
npm run test:stability
```

Use this when you want release confidence, not just a single clean pass.

For live environments where credential/runtime probes should be exercised each round:

```bash
npm run test:stability:live
```

## 4. CI-Safe Suite

```bash
npm run test:major:ci
```

Use this in CI runners that do not have live credentials, channels, or operator-only integrations.

## 5. Operator-Host Live Validation

Run this on the real deployed host.

### Preconditions

- Node 22 available
- one healthy container runtime
- model credentials configured
- at least one configured channel
- at least one registered chat or `/registermain` completed

### Baseline Runtime Checks

Run:

```bash
npm run setup -- --step verify
```

Confirm:

- `STATUS: success`
- `SERVICE: running`
- `CREDENTIAL_RUNTIME_PROBE: ok`
- `CONFIGURED_CHANNELS: telegram`

Then validate the public-safe Telegram surface:

- `/start`
- `/help`
- `/commands`
- simple quick reply prompt
- reminder prompt
- `/cursor_status`

## 6. Cursor Validation

### Cursor Cloud Validation

Only run this if `CURSOR_API_KEY` is configured.

Expected meaning:

- `Cloud coding jobs: ready` means Cursor Cloud queued heavy-lift workflows are ready now

Run:

- `/cursor_status`
- `/cursor-jobs`
- `/cursor-create --repo https://github.com/rupret007/Andrea_NanoBot Reply with exactly: live cloud smoke ok. Do not modify files, branches, or PRs.`
- `/cursor-sync <agent_id>`
- `/cursor-conversation <agent_id> 5`
- `/cursor-results <agent_id>`

Optional if safe:

- `/cursor-followup <agent_id> ...`
- `/cursor-stop <agent_id>` on a disposable job only

### Desktop Bridge Validation

Only run this if all of these are configured:

- `CURSOR_DESKTOP_BRIDGE_URL`
- `CURSOR_DESKTOP_BRIDGE_TOKEN`
- a live bridge process on your normal machine

Expected meaning:

- `Desktop bridge terminal control: ready` means operator-only session recovery and line-oriented terminal control are ready
- `Desktop bridge agent jobs: conditional|unavailable` means desktop terminal control can still be real while local queued desktop-agent execution is not the baseline promise on that machine

Run:

- `/cursor_status`
- `/cursor-jobs`
- `/cursor-sync <desktop_session_id>` if a recoverable session exists
- `/cursor-terminal <agent_id> echo operator smoke ok`
- `/cursor-terminal-status <agent_id>`
- `/cursor-terminal-log <agent_id> 20`
- `/cursor-terminal-stop <agent_id>` if appropriate

Do not confuse desktop bridge readiness with Cursor Cloud readiness.

### Optional Alexa Validation

Only run this if Alexa is configured and the HTTPS ingress is live.

Run:

- `/alexa-status`
- one Alexa console or device request against the currently configured skill

Confirm:

- status says the listener is enabled and healthy
- requests route into the intended Andrea group context

### Optional Amazon Validation

Only run this if Amazon Business credentials are configured.

Run from the main control chat:

- `/amazon-status`
- `/amazon-search ergonomic keyboard`

Optional if safe:

- `/purchase-request <asin> <offer_id> 1`
- `/purchase-approve <request_id> <approval_code>` only in trial mode or another intentionally disposable validation setup

## 7. Restart And Verify

After meaningful runtime or operator-surface changes:

```bash
npm run services:restart
npm run setup -- --step verify
```

Important rule:

- run restart and verify sequentially, not in parallel

Then rerun a small live smoke:

- `/ping`
- `/help`
- `/cursor_status`

## 8. Failure Handling

### `CREDENTIAL_RUNTIME_PROBE: failed`

- rerun `npm run setup -- --step verify`
- check `CREDENTIAL_RUNTIME_PROBE_REASON`
- check `NEXT_STEPS`

### Cloud coding jobs unavailable

- `CURSOR_API_KEY` is missing, rejected, or not loaded
- fix `.env`
- restart
- rerun `/cursor_status`

### Desktop bridge terminal control unavailable

- `CURSOR_DESKTOP_BRIDGE_URL` and/or `CURSOR_DESKTOP_BRIDGE_TOKEN` are missing
- or the configured bridge is unreachable/unhealthy
- confirm the bridge process and tunnel
- restart Andrea
- rerun `/cursor_status`

### Runtime route unavailable

- treat it as optional unless you specifically want Cursor-backed runtime routing
- check 9router endpoint/auth/model settings separately from Cloud/desktop

## 9. Release Gate

Before pushing a release:

1. `npm run test:major` passes
2. `npm run test:stability` passes
3. live verify is green on the operator host
4. docs and help surfaces are updated if wording or behavior changed
5. optional integrations are documented as optional, not baseline
6. final command outputs and any caveats are captured in release notes or the PR summary
