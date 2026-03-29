# Cursor Desktop Bridge

Use this when you want Andrea to reach the Cursor machine you normally use, such as your Mac while you are away from your desk.

This is different from Cursor Cloud Agents:

- Cursor Cloud runs work through Cursor's hosted API
- Cursor Desktop Bridge runs work through the `cursor-agent` CLI on your own machine
- Andrea talks to the bridge over HTTPS or a private tunnel, and the bridge talks to your local Cursor install

## What This Gives You

With the desktop bridge enabled, Andrea can use the existing Cursor job controls against your own machine:

- `/cursor_status`
- `/cursor_create ...`
- `/cursor_sync ...`
- `/cursor_followup ...`
- `/cursor_stop ...`
- `/cursor_conversation ...`

The experience is still asynchronous. This is not a live remote desktop. The goal is to let Andrea queue and manage real Cursor agent work on the machine you already trust and use.

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

Then run a small non-destructive job from the main control chat:

```text
/cursor_create Review the current README and suggest 3 improvements.
```

Follow with:

```text
/cursor_sync <agent_id>
/cursor_conversation <agent_id>
```

## 5) Security Notes

Keep these rules:

- never reuse the bridge token in screenshots or chat
- prefer a private network path over a public endpoint
- keep the bridge on a machine you already trust with Cursor access
- do not treat the bridge as a public API
- rotate the bridge token if the machine or tunnel is ever exposed

## 6) Troubleshooting

If `/cursor_status` still says the desktop bridge is disabled:

1. confirm Andrea has `CURSOR_DESKTOP_BRIDGE_URL` and `CURSOR_DESKTOP_BRIDGE_TOKEN`
2. confirm the bridge process is running on the Mac
3. open `<bridge-url>/health` from the Andrea host
4. confirm your tunnel or reverse proxy forwards to the bridge port
5. restart Andrea and run `/cursor_status` again

If Andrea can reach the bridge but your model routing still does not look Cursor-backed:

1. confirm your main runtime points at the intended 9router endpoint
2. set `CURSOR_GATEWAY_HINT=9router`
3. if needed, set `NANOCLAW_AGENT_MODEL=cu/default`

## 7) When To Use Desktop Bridge vs Cloud

Use the desktop bridge when:

- you want Andrea to use your normal machine
- you care about your existing local repo checkout or environment
- you want "away from my desk" access to the Cursor setup you already trust

Use Cursor Cloud Agents when:

- you specifically want hosted jobs
- you already have `CURSOR_API_KEY` configured
- you do not need the work to happen on your own machine
