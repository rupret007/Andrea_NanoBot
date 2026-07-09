# Mac mini Service Runbook

This runbook owns the macOS launchd path for running Andrea/NanoClaw as a
Mac mini background service without changing the shared TypeScript runtime.

## Files

- `launchd/com.nanoclaw.mac-mini.plist.template` is the LaunchAgent template.
- `scripts/mac-mini-service.sh` renders and manages the LaunchAgent.
- `scripts/mac-mini-service-runner.sh` is what launchd executes.
- `scripts/agi-doctor.sh` performs read-only host, runtime, launchd, config,
  state, and recent-log checks.
- `scripts/agi-backup.sh` creates local private backups under `data/backups`.
- `scripts/agi-replay.sh` captures redacted diagnostic replay packets under
  `data/replays`.

## First install

```bash
npm ci
npm run build
scripts/mac-mini-service.sh install
scripts/mac-mini-service.sh status
```

The same launchd path is also exposed through package scripts:

```bash
npm run mac:services:install
npm run mac:services:status
```

The service uses the current checkout path as its working directory. If the
repo moves, run `scripts/mac-mini-service.sh install` again so the rendered
plist points to the new path.

## Daily operations

```bash
scripts/mac-mini-service.sh status
scripts/mac-mini-service.sh restart
scripts/mac-mini-service.sh logs
scripts/agi-doctor.sh
```

Equivalent npm wrappers:

```bash
npm run mac:services:status
npm run mac:services:restart
npm run mac:services:logs
npm run mac:doctor
```

The service label defaults to `com.nanoclaw.mac-mini`. Override it with
`NANOCLAW_LAUNCHD_LABEL` before install if this Mac needs multiple checkouts.

## Post-change verification

After repo-side runtime, messaging, or BlueBubbles changes:

```bash
npm run build
npm run mac:services:restart
npm run mac:services:status
npm run services:status
npm run setup -- --step verify
npm run debug:status
```

Confirm the active root is the intended checkout, host state is
`running_ready`, and the serving commit matches workspace `HEAD`. For
BlueBubbles changes, add the focused test suite and live proof only when live
Messages side effects are acceptable:

```bash
npm test -- src/recent-text-review.test.ts src/messages-fluidity.test.ts src/assistant-capabilities.test.ts src/assistant-capability-router.test.ts src/channels/bluebubbles.test.ts
npm run debug:bluebubbles -- --live
```

## Backups

```bash
scripts/agi-backup.sh --dry-run
scripts/agi-backup.sh
```

Backups are written to `data/backups` and may include `.env`, local auth,
sessions, SQLite data, and logs. Treat the archive as private secret material.

## Replay packets

```bash
scripts/agi-replay.sh capture
scripts/agi-replay.sh list
scripts/agi-replay.sh show <packet-id>
```

Replay packets are redacted local evidence bundles for debugging service
regressions. They do not replay side effects or mutate runtime state.

## Uninstall

```bash
scripts/mac-mini-service.sh uninstall
```

This unloads and removes the rendered LaunchAgent plist from
`~/Library/LaunchAgents`; it does not delete repo state, logs, backups, or
credentials.
