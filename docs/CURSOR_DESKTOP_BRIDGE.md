# Cursor Desktop Bridge

Use this when you want Andrea to reach the Cursor machine you normally use.

This is an operator-only surface.
It is different from Cursor Cloud.

## What The Desktop Bridge Is For

The desktop bridge is the current operator-only path for:

- recovering bridge-known sessions
- inspecting stored bridge conversation
- running line-oriented terminal commands on your own machine

For a cleaner mental model:

- use `/cursor-conversation` for stored text output from a bridge session
- use `/cursor-terminal*` for machine-side control
- keep `/cursor-results` and `/cursor-download` in the Cursor Cloud output-files lane, not the desktop bridge lane

It is **not**:

- the default queued heavy-lift coding path
- a live PTY attach
- arbitrary shell takeover
- remote desktop control of the Cursor UI
- proof that local Windows queued desktop-agent execution is validated

Current product truth:

- Cursor Cloud is the validated queued heavy-lift coding path
- desktop bridge is the operator-only machine/session and terminal path

## What It Requires

On Andrea's host:

```bash
CURSOR_DESKTOP_BRIDGE_URL=https://your-bridge.example.com
CURSOR_DESKTOP_BRIDGE_TOKEN=replace-with-random-secret
```

Optional on Andrea's host:

```bash
CURSOR_DESKTOP_BRIDGE_TIMEOUT_MS=30000
CURSOR_DESKTOP_BRIDGE_LABEL=Your Cursor Machine
```

Sometimes required on the bridge machine:

```bash
CURSOR_DESKTOP_CLI_PATH=/path/to/cursor-agent
```

On Windows, if you do not have a standalone `cursor-agent`, you can point `CURSOR_DESKTOP_CLI_PATH` at Cursor's installed `cursor.cmd`.

## What Ready vs Conditional Means

- **configured** = `CURSOR_DESKTOP_BRIDGE_URL` and `CURSOR_DESKTOP_BRIDGE_TOKEN` are present
- **ready** = Andrea can reach the bridge and use terminal/session control now
- **conditional** = the bridge is healthy, but local desktop agent execution is still environment-dependent on that machine
- **unavailable** = config is missing, the bridge is unreachable, or the machine does not support the needed path

## Bridge Machine Setup

On the machine that normally runs Cursor:

1. Install Node.js 22.
2. Clone this repo.
3. Run `npm install`.
4. Set:

```bash
CURSOR_DESKTOP_BRIDGE_TOKEN=replace-with-a-long-random-secret
CURSOR_DESKTOP_BRIDGE_HOST=127.0.0.1
CURSOR_DESKTOP_BRIDGE_PORT=4124
CURSOR_DESKTOP_DEFAULT_CWD=/path/to/your/workspace
CURSOR_DESKTOP_FORCE=true
```

Then start the bridge:

```bash
npm run cursor:bridge
```

Expected result:

- bridge listens locally
- `/health` responds
- bridge persists its own session state

## Andrea Host Setup

Add these to Andrea's `.env`:

```bash
CURSOR_DESKTOP_BRIDGE_URL=https://your-bridge.example.com
CURSOR_DESKTOP_BRIDGE_TOKEN=replace-with-the-same-random-secret
CURSOR_DESKTOP_BRIDGE_TIMEOUT_MS=30000
CURSOR_DESKTOP_BRIDGE_LABEL=Your Cursor Machine
```

Then restart Andrea and run `/cursor_status`.

## Validation Steps

After setup, run:

- `/cursor_status`
- `/cursor`
- tap `Jobs`

What you want to see:

- `Desktop bridge terminal control: ready`
- `Cursor Desktop Bridge Status`
  - `Enabled: yes`
  - `Auth configured: yes`
  - `Probe: ok`

Then run safe bridge-only commands from the main control chat:

- tap a desktop session to make it current
- tap `Sync` if a recoverable desktop session exists
- `/cursor-terminal <agent_id> echo operator smoke ok`
- tap `Current Job` -> `Terminal Status`
- tap `Current Job` -> `Terminal Log`

Only use `/cursor-terminal-stop <agent_id>` when a bridge-started terminal command is actually active.

## What `/cursor-jobs` Means Here

For desktop bridge sessions:

- tracked desktop sessions are already attached to the current Andrea workspace
- recoverable desktop sessions are bridge-known sessions you can attach with `Sync` from the dashboard or `/cursor-sync <agent_id>`

Terminal commands only work for tracked or recoverable bridge sessions that the bridge itself knows about.

## Windows Truth Boundary

On Windows, a healthy bridge does **not** automatically mean local queued desktop-agent execution is validated.

If `/cursor_status` says:

- `Desktop bridge terminal control: ready`
- `Desktop bridge agent jobs: conditional` or `unavailable`

then the bridge is still useful for session recovery and terminal control, but Cursor Cloud should remain the baseline heavy-lift queued coding path on that machine.

## Troubleshooting

### `/cursor_status` says desktop bridge is unavailable

Check:

1. `CURSOR_DESKTOP_BRIDGE_URL`
2. `CURSOR_DESKTOP_BRIDGE_TOKEN`
3. bridge process is running
4. private tunnel or reverse proxy reachability

### `/cursor-terminal ...` fails

Check:

1. the id belongs to a desktop bridge session, not a Cloud job
2. the session is tracked or recoverable in `/cursor-jobs`
3. the bridge is reachable

### Bridge health works but desktop agent jobs stay conditional or unavailable

That means the bridge is real, but local queued desktop-agent execution is still not validated on that machine.
Keep using Cursor Cloud for queued heavy-lift jobs there.

## One-Line Mental Model

Use the desktop bridge for operator-only machine-side session recovery and line-oriented terminal control.
Use Cursor Cloud for the validated queued heavy-lift coding path.
