# BlueBubbles Receipt Inbox LaunchAgent

The durable BlueBubbles receipt inbox runs as its own macOS process under the
fixed launchd label `com.nanoclaw.bluebubbles-receipt-inbox`. It commits
self-authored `new-message` delivery evidence to SQLite before acknowledging
the webhook. It is deliberately independent of the main
`com.nanoclaw.mac-mini` process: restarting, stopping, or crashing Andrea does
not stop this inbox, and restarting this inbox does not restart Andrea.

## Configuration

Add this receipt-specific block to `.env` alongside the existing BlueBubbles
settings:

```bash
BLUEBUBBLES_WEBHOOK_SECRET=<same-random-secret-used-by-the-main-webhook>
BLUEBUBBLES_RECEIPT_INBOX_ENABLED=true
BLUEBUBBLES_RECEIPT_INBOX_HOST=127.0.0.1
BLUEBUBBLES_RECEIPT_INBOX_PORT=4306
BLUEBUBBLES_RECEIPT_INBOX_BASE_URL=http://127.0.0.1:4306
BLUEBUBBLES_RECEIPT_INBOX_WEBHOOK_PUBLIC_BASE_URL=http://127.0.0.1:4306
BLUEBUBBLES_RECEIPT_INBOX_PATH=/bluebubbles/receipt-inbox
BLUEBUBBLES_RECEIPT_INBOX_HEALTH_PATH=/health
# Optional override:
# BLUEBUBBLES_RECEIPT_INBOX_DB_PATH=~/.andrea/bluebubbles/receipt-inbox.sqlite3
```

The default database is
`${ANDREA_STATE_DIR:-~/.andrea}/bluebubbles/receipt-inbox.sqlite3`.
`BLUEBUBBLES_RECEIPT_INBOX_BASE_URL` is the main process's local health-probe
base. `BLUEBUBBLES_RECEIPT_INBOX_WEBHOOK_PUBLIC_BASE_URL` is the base used to
verify the provider registration; it normally has the same loopback value when
BlueBubbles Server and Andrea run on the same Mac.

The listener accepts only `127.0.0.1` or `::1`.
`0.0.0.0`, `::`, hostnames, LAN addresses, and public addresses fail startup.
Do not reuse `BLUEBUBBLES_HOST`, `BLUEBUBBLES_PORT`, or
`BLUEBUBBLES_WEBHOOK_PATH` for this process.

## Build And Read-Only Preflight

The ordinary build emits `dist/bluebubbles-receipt-inbox-main.js`; there is no
second build pipeline:

```bash
npm run build
npm run mac:bluebubbles-receipt-inbox:dry-run
```

The dry run validates the compiled entry, pinned Node runtime, secret-bearing
configuration, loopback bind, and rendered plist. It writes no service files
and does not start or restart either process.

Review the rendered paths before the explicit install:

- plist: `~/Library/LaunchAgents/com.nanoclaw.bluebubbles-receipt-inbox.plist`
- state: `${ANDREA_STATE_DIR:-~/.andrea}/bluebubbles`
- logs: `${ANDREA_LOG_DIR:-~/Library/Logs/andrea}/bluebubbles-receipt-inbox`

The explicit operator install command is:

```bash
npm run mac:bluebubbles-receipt-inbox:install
```

Install prepares state/log directories as mode `0700`, log files and the
rendered plist as `0600`, and the SQLite database as `0600`. A custom database
parent must be a dedicated real directory with mode `0700`; the service refuses
an existing shared, permissive, or symlinked parent instead of changing it.

## Add The Second BlueBubbles Webhook

Keep the existing main Andrea webhook. Add a second registration dedicated to
durable outbound receipt evidence. In BlueBubbles Server, open **Settings → API
& Webhooks**, choose **Add Webhook**, and configure exactly:

- URL:
  `http://127.0.0.1:4306/bluebubbles/receipt-inbox?secret=<URL-encoded-BLUEBUBBLES_WEBHOOK_SECRET>`
- Event: **New Messages** only (the API event value is exactly `new-message`)

Do not choose “all events,” message updates, read receipts, typing, or group
events for this registration. The sidecar accepts only correlated,
self-authored direct-message evidence and rejects unrelated payloads.

After saving, BlueBubbles' webhook list (`GET /api/v1/webhook`) must contain a
separate record whose URL exactly matches the configured receipt-inbox public
base plus path and secret query, and whose events are exactly
`["new-message"]`. Andrea's readiness gate treats a missing, differently
encoded, or broader registration as not ready. See the official
[BlueBubbles REST API and webhooks guide](https://docs.bluebubbles.app/server/developer-guides/rest-api-and-webhooks)
for the provider UI/API concepts.

## Independent Operations

```bash
npm run mac:bluebubbles-receipt-inbox:status
npm run mac:bluebubbles-receipt-inbox:restart
npm run mac:bluebubbles-receipt-inbox:stop
npm run mac:bluebubbles-receipt-inbox:uninstall
```

`status` checks the fixed service kind/protocol, authenticated health payload,
build identity, start time, and process identity; when launchd exposes a PID,
the health PID must match it. `restart`, `stop`, and `uninstall` target only
`com.nanoclaw.bluebubbles-receipt-inbox`. Uninstall preserves the receipt
database and logs.

After rebuilding sidecar code, restart it explicitly. Neither
`npm run mac:services:restart` nor the main service's own restart path touches
this LaunchAgent.

## Login Versus Boot

This is a per-user LaunchAgent in the `gui/<uid>` domain. `RunAtLoad` and
`KeepAlive=true` make it start at user login and restart after a crash, with a
15-second launchd throttle, but it cannot run before that user logs in. It is
not a boot-time LaunchDaemon and is unavailable at the FileVault/login window
after a reboot.

A true pre-login service requires a separately reviewed, root-owned
LaunchDaemon design with explicit credential, checkout, and file-ownership
handling; this repository does not install one. Do not describe this
LaunchAgent as boot-persistent.
