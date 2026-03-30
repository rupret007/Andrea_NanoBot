# Cursor Desktop Bridge

Use this when you want Andrea to reach the Cursor machine you normally use, such as your Mac while you are away from your desk.

This is different from Cursor Cloud Agents:

- Cursor Cloud is the supported queued heavy-lift coding path in Andrea today
- Cursor Desktop Bridge is the operator-only path for session recovery and line-oriented terminal control on your own machine
- Andrea talks to the bridge over HTTPS or a private tunnel, and the bridge talks to your local Cursor install

If you need a real Cursor Cloud key instead, start with [CURSOR_API_KEYS.md](CURSOR_API_KEYS.md).

## What This Gives You

With the desktop bridge enabled, Andrea can use these operator-only machine-side controls against your own machine:

- `/cursor_status`
- `/cursor_jobs`
- `/cursor_sync ...`
- `/cursor_conversation ...`
- `/cursor_terminal <agent_id> <command>`
- `/cursor_terminal_status <agent_id>`
- `/cursor_terminal_log <agent_id> [limit]`
- `/cursor_terminal_stop <agent_id>`

This is still asynchronous and operator-only. It is not a live remote desktop, and it is not the same thing as Cursor Cloud queued coding work.

Important truth boundary:

- `/cursor_jobs` can show tracked Andrea jobs plus recoverable bridge sessions that the bridge already knows about
- `/cursor_sync <id>` can attach one of those recoverable bridge sessions to the current Andrea workspace
- `/cursor_conversation <id>` can show stored desktop session conversation when the bridge has it
- terminal commands work only for tracked or recoverable bridge sessions that the bridge itself knows about
- terminal control is line-oriented shell execution on your own machine, not an attach-to-anything remote shell
- the bridge does **not** attach to arbitrary already-open Cursor GUI tabs, random shell sessions, or a live PTY stream
- the supported queued heavy-lift coding path in the current product is still Cursor Cloud, not the desktop bridge

Important scope rule:

- `/cursor_status` is the safe status command that can stay visible more broadly
- the deeper Cursor and terminal commands are operator controls and should be run from Andrea's registered main control chat

## 1) On The Machine That Normally Runs Cursor

This is your normal Cursor workstation. It can be a Mac or a Windows PC.

Required:

- Node.js 22.x
- this repo checked out
- `npm install`
- Cursor CLI support available either as a standalone `cursor-agent` command, or through Cursor's installed CLI on Windows for bridge health and terminal control

Start with these environment variables on that machine:

```bash
export CURSOR_DESKTOP_BRIDGE_TOKEN="replace-with-a-long-random-secret"
export CURSOR_DESKTOP_DEFAULT_CWD="/Users/you/src"
export CURSOR_DESKTOP_BRIDGE_HOST="127.0.0.1"
export CURSOR_DESKTOP_BRIDGE_PORT="4124"
export CURSOR_DESKTOP_FORCE="true"
```

On Windows PCs, if you have Cursor installed but do not have a separate
`cursor-agent` command on `PATH`, point the bridge at Cursor's installed CLI:

```powershell
$env:CURSOR_DESKTOP_CLI_PATH="$env:LOCALAPPDATA\Programs\cursor\resources\app\bin\cursor.cmd"
```

The bridge can invoke that CLI in its `agent` mode automatically for bridge
health checks and compatibility attempts. You do not need to create a wrapper
script just to test the Windows bridge path, but `/cursor_status` is still the
source of truth for whether desktop agent jobs are actually validated.

Important Windows truth:

- a healthy bridge probe and working terminal commands do **not** automatically mean local desktop agent jobs are validated on that machine
- if the installed Windows Cursor CLI rejects the expected agent flags, `/cursor_status` will show desktop bridge terminal control as ready while desktop agent jobs remain conditional or unavailable
- in that case, keep using Cursor Cloud for queued heavy-lift coding jobs on that machine

Then run:

```bash
npm run cursor:bridge
```

Expected result:

- the bridge listens on `http://127.0.0.1:4124`
- it exposes `/health`
- it stores session state under `~/.cursor-desktop-bridge/state.json` by default

## 2) Expose The Bridge Safely

Do not expose the bridge publicly without protection.

Recommended:

- put it behind Tailscale, Cloudflare Tunnel, or another private tunnel
- keep the bearer token secret
- restrict access to only the Andrea host

If you do expose it over HTTPS through a tunnel or reverse proxy, the Andrea host should use the final HTTPS URL, not the local `127.0.0.1` address.

Example:

```bash
CURSOR_DESKTOP_BRIDGE_URL=https://cursor-mac.example.com
CURSOR_DESKTOP_BRIDGE_TOKEN=replace-with-the-same-random-secret
CURSOR_DESKTOP_BRIDGE_LABEL=Jeff MacBook Pro
```

## 3) On The Andrea Host

Set these in Andrea's `.env`:

```bash
CURSOR_DESKTOP_BRIDGE_URL=https://cursor-mac.example.com
CURSOR_DESKTOP_BRIDGE_TOKEN=replace-with-the-same-random-secret
CURSOR_DESKTOP_BRIDGE_TIMEOUT_MS=30000
CURSOR_DESKTOP_BRIDGE_LABEL=Jeff MacBook Pro
```

If you are also routing the main model runtime through a remote 9router instance, add:

```bash
CURSOR_GATEWAY_HINT=9router
```

That explicit hint matters when your 9router endpoint is remote or uses a custom domain instead of the default local port.

## 4) Validate It

After restarting Andrea, check:

```text
/cursor_status
```

You should see a `Cursor Desktop Bridge Status` section with:

- `Enabled: yes`
- the bridge URL
- `Auth configured: yes`
- `Probe: ok`

You should also see a `Cursor Capability Summary` section where:

- `Desktop bridge terminal control: ready`
- `Desktop bridge agent jobs: validated`, `conditional`, or `unavailable`

Then run safe non-destructive bridge actions from the main control chat:

```text
/cursor_jobs
/cursor_sync <agent_id>
/cursor_terminal <agent_id> git status
/cursor_terminal_log <agent_id>
```

If the bridge already has sessions from earlier Andrea-driven work, `/cursor_jobs` can surface them as recoverable even before they are attached to the current workspace record.

If you want queued heavy-lift coding work, validate Cursor Cloud separately and use `/cursor_create` through the Cloud path instead of treating the bridge as the default queued-job backend.

Useful safe follow-up:

```text
/cursor_conversation <agent_id>
/cursor_terminal_status <agent_id>
/cursor_terminal_stop <agent_id>
```

## 5) Security Notes

Keep these rules:

- never reuse the bridge token in screenshots or chat
- prefer a private network path over a public endpoint
- keep the bridge on a machine you already trust with Cursor access
- do not treat the bridge as a public API
- rotate the bridge token if the machine or tunnel is ever exposed

## 6) What The Bridge Can And Cannot Control

What is real today:

- recover bridge sessions that the bridge itself has already persisted
- attach a recoverable bridge session to the current Andrea workspace
- read the stored session conversation when the bridge has it
- run line-oriented shell commands for a tracked bridge session
- read cached terminal output for those commands
- stop an active terminal command that the bridge started
- report whether local desktop agent-job compatibility is validated, conditional, or unavailable on that machine

What is intentionally not real today:

- attaching to a live shell or PTY
- typing into an arbitrary existing terminal window
- remote desktop control of the Cursor GUI
- discovering random pre-existing Cursor tabs that were never started through the bridge
- treating the bridge as the primary queued heavy-lift coding path in Andrea's current product shape

## 7) Troubleshooting

If `/cursor_status` still says the desktop bridge is disabled:

1. confirm Andrea has `CURSOR_DESKTOP_BRIDGE_URL` and `CURSOR_DESKTOP_BRIDGE_TOKEN`
2. confirm the bridge process is running on the Mac
3. open `<bridge-url>/health` from the Andrea host
4. confirm your tunnel or reverse proxy forwards to the bridge port
5. restart Andrea and run `/cursor_status` again

If `/cursor_jobs` does not show a bridge session you expected:

1. confirm that session was started through the bridge, not only inside the local GUI
2. confirm the bridge state file still exists on the machine running Cursor
3. run `/cursor_jobs` from Andrea's registered main control chat
4. if the session appears as recoverable, run `/cursor_sync <agent_id>` to attach it to the current workspace

If `/cursor_terminal ...` fails:

1. confirm the job id belongs to a desktop bridge session, not a Cursor Cloud job
2. confirm that session is tracked or recoverable in `/cursor_jobs`
3. run `/cursor_sync <agent_id>` first if it is only listed as recoverable
4. remember that commands run in bridge-managed shell state, not in an arbitrary already-open terminal window

If the bridge `/health` probe works on Windows but a desktop session immediately
fails with warnings like `Warning: 'p' is not in the list of known options`:

1. your bridge process is reachable, but the configured local Cursor CLI is not accepting the expected agent flags
2. confirm the machine really exposes a compatible `cursor-agent` entrypoint, or another CLI path that supports `-p ... --output-format stream-json`
3. keep using Cursor Cloud for heavy-lift jobs on that machine until the Windows agent CLI entrypoint is confirmed
4. the bridge terminal commands can still be useful for tracked desktop sessions, but that is not the same as a working desktop agent run

If Andrea can reach the bridge but your model routing still does not look Cursor-backed:

1. confirm your main runtime points at the intended 9router endpoint
2. set `CURSOR_GATEWAY_HINT=9router`
3. if needed, set `NANOCLAW_AGENT_MODEL=cu/default`

## 8) When To Use Desktop Bridge vs Cloud

Use the desktop bridge when:

- you want Andrea to inspect a bridge-known session on your normal machine
- you want line-oriented shell control in the repo or environment you already trust
- you want "away from my desk" access to machine-side terminal actions through Andrea

Use Cursor Cloud Agents when:

- you specifically want hosted jobs
- you already have `CURSOR_API_KEY` configured
- you want the supported queued heavy-lift coding path in the current product
- you do not need the work to happen on your own machine
