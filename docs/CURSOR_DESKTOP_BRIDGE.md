# Cursor Desktop Bridge

Use this when you want Andrea to reach the Cursor machine you normally use, such as your Mac while you are away from your desk.

This is different from Cursor Cloud Agents:

- Cursor Cloud runs work through Cursor's hosted API
- Cursor Desktop Bridge runs work through the `cursor-agent` CLI on your own machine
- Andrea talks to the bridge over HTTPS or a private tunnel, and the bridge talks to your local Cursor install

If you need a real Cursor Cloud key instead, start with [CURSOR_API_KEYS.md](CURSOR_API_KEYS.md).

## What This Gives You

With the desktop bridge enabled, Andrea can use the existing Cursor job controls against your own machine:

- `/cursor_status`
- `/cursor_jobs`
- `/cursor_create ...`
- `/cursor_sync ...`
- `/cursor_followup ...`
- `/cursor_stop ...`
- `/cursor_conversation ...`
- `/cursor_terminal <agent_id> <command>`
- `/cursor_terminal_status <agent_id>`
- `/cursor_terminal_log <agent_id> [limit]`
- `/cursor_terminal_stop <agent_id>`

The experience is still asynchronous. This is not a live remote desktop. The goal is to let Andrea queue and manage real Cursor agent work on the machine you already trust and use.

Important truth boundary:

- `/cursor_jobs` can show tracked Andrea jobs plus recoverable bridge sessions that the bridge already knows about
- `/cursor_sync <id>` can attach one of those recoverable bridge sessions to the current Andrea workspace
- terminal commands work only for tracked or recoverable bridge sessions that the bridge itself knows about
- terminal control is line-oriented shell execution on your own machine, not an attach-to-anything remote shell
- the bridge does **not** attach to arbitrary already-open Cursor GUI tabs, random shell sessions, or a live PTY stream

Important scope rule:

- `/cursor_status` is the safe status command that can stay visible more broadly
- the deeper Cursor job commands are operator controls and should be run from Andrea's registered main control chat

## 1) On The Machine That Normally Runs Cursor

This is usually your Mac.

Required:

- Node.js 22.x
- this repo checked out
- `npm install`
- Cursor CLI support available as `cursor-agent`

Start with these environment variables on that machine:

```bash
export CURSOR_DESKTOP_BRIDGE_TOKEN="replace-with-a-long-random-secret"
export CURSOR_DESKTOP_DEFAULT_CWD="/Users/you/src"
export CURSOR_DESKTOP_BRIDGE_HOST="127.0.0.1"
export CURSOR_DESKTOP_BRIDGE_PORT="4124"
export CURSOR_DESKTOP_FORCE="true"
```

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

- `Job backend: desktop bridge`
- `Main-control job commands: ready`

Then run a small non-destructive job from the main control chat:

```text
/cursor_create Review the current README and suggest 3 improvements.
```

Follow with:

```text
/cursor_jobs
/cursor_sync <agent_id>
/cursor_conversation <agent_id>
/cursor_terminal <agent_id> git status
/cursor_terminal_log <agent_id>
```

If the bridge already has sessions from earlier Andrea-driven work, `/cursor_jobs` can surface them as recoverable even before they are attached to the current workspace record.

## 5) Security Notes

Keep these rules:

- never reuse the bridge token in screenshots or chat
- prefer a private network path over a public endpoint
- keep the bridge on a machine you already trust with Cursor access
- do not treat the bridge as a public API
- rotate the bridge token if the machine or tunnel is ever exposed

## 6) What The Bridge Can And Cannot Control

What is real today:

- start a new `cursor-agent` run on your normal machine
- follow up on a tracked bridge session
- stop a tracked bridge session
- read the stored session conversation
- recover bridge sessions that the bridge itself has already persisted
- run line-oriented shell commands for a tracked bridge session
- read cached terminal output for those commands
- stop an active terminal command that the bridge started

What is intentionally not real today:

- attaching to a live shell or PTY
- typing into an arbitrary existing terminal window
- remote desktop control of the Cursor GUI
- discovering random pre-existing Cursor tabs that were never started through the bridge

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

If Andrea can reach the bridge but your model routing still does not look Cursor-backed:

1. confirm your main runtime points at the intended 9router endpoint
2. set `CURSOR_GATEWAY_HINT=9router`
3. if needed, set `NANOCLAW_AGENT_MODEL=cu/default`

## 8) When To Use Desktop Bridge vs Cloud

Use the desktop bridge when:

- you want Andrea to use your normal machine
- you care about your existing local repo checkout or environment
- you want "away from my desk" access to the Cursor setup you already trust

Use Cursor Cloud Agents when:

- you specifically want hosted jobs
- you already have `CURSOR_API_KEY` configured
- you do not need the work to happen on your own machine
