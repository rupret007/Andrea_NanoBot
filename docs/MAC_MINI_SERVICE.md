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

`install`, `start`, and `restart` return only after the replacement process has
written matching ready, health, runtime, Git, and build provenance. The current
boot-ID marker is not authoritative independent restart proof. Until that
instrumentation is corrected, require a changed process identity/PID, matching
ready/health PIDs, verified build provenance, and the expected serving commit.
The default readiness timeout is 120 seconds; set
`ANDREA_MAC_READY_TIMEOUT_SECONDS` only when a slower host needs a larger
bounded window. A timeout exits nonzero and prints metadata-only service and
readiness diagnostics plus the configured log paths instead of allowing an
immediate verifier to trust stale state.

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

`npm run setup -- --step verify` is a live, potentially billable operator
probe. Run it only when model/container probing is authorized; it is not part of
the offline release gate.

Confirm the active root is the intended checkout, host state is
`running_ready`, and the serving commit matches workspace `HEAD`. For
full readiness, also confirm `Host disk pressure: healthy`. A running process
with warning/critical disk pressure is `degraded_but_usable`, because SQLite,
health markers, evaluation artifacts, and containers can still fail with
`ENOSPC`. Andrea may report and guide recovery but must not delete Docker
images, containers, evidence, caches, or user files automatically. Free the
target reported by the doctor (the greater of 5 GiB or 5% of the volume) after
owner review, then rerun `npm run integrations:doctor` and
`npm run debug:status`.

For
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
