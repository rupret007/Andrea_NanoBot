# OpenClaw Restore Checklist

Use this after a reboot, OpenClaw update, API-key rotation, or service repair.

## Gateway

```bash
openclaw gateway status
openclaw config validate --json
```

Expected:

- LaunchAgent loaded and running.
- Gateway probe succeeds.
- Config validates with no warnings.

## Models

```bash
openclaw models status
```

Expected:

- Default: `minimax/MiniMax-M3`
- Fallbacks: `anthropic/claude-sonnet-4-6`, `google/gemini-2.5-flash`, `openai/gpt-5.4-mini`
- MiniMax, Anthropic, Gemini, Brave, and OpenAI auth sources are detected.

## Brave Search

```bash
openclaw plugins doctor
openclaw agent \
  --session-key agent:main:ops-brave-smoke \
  --message 'Use web_search once for query "OpenClaw Brave Search". Reply exactly OK_SEARCH if search worked.' \
  --timeout 180 \
  --json
```

Expected:

- Plugin doctor reports no plugin issues.
- Agent reply contains `OK_SEARCH`.
- Tool summary shows one `web_search` call with no failures.

## Telegram

```bash
openclaw channels status --json
```

Expected:

- OpenClaw's own Telegram channel is **disabled by design** (`channels.telegram.enabled: false`
  in `~/.openclaw/openclaw.json`). Andrea (NanoClaw, service `com.nanoclaw.mac-mini`) owns the
  shared Telegram bot token and is the only `getUpdates` consumer. Two pollers on one token
  cause `token_rotation_required` collisions.
- OpenClaw is reached from the shared Telegram channel through Andrea's delegation path
  (`/openclaw ...`, `ask OpenClaw: ...`, or `@openclaw ...` in the main control chat), which
  invokes the `openclaw agent` CLI against the local gateway.

If Telegram collisions reappear, verify no other process is polling the bot token
(`launchctl list | grep -i openclaw`) and that `channels.telegram.enabled` is still `false`.

## Andrea Bridge

```bash
openclaw mcp probe andrea-bluebubbles --json
```

Expected:

- Probe succeeds with no diagnostics.
- Use only Andrea-hosted BlueBubbles read/status/action-gated tools.
