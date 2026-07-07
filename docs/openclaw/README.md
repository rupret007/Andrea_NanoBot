# OpenClaw Ops

> **Consolidated into the NanoClaw repo on 2026-07-06** from the former standalone
> `~/Documents/OpenClaw` ops repo. OpenClaw runs as its own macOS LaunchAgent gateway
> (port `18789`); NanoClaw ("Andrea") integrates with it via the registered BlueBubbles
> MCP bridge (`src/openclaw-andrea-bridge.ts`). This folder is the single source of truth
> for OpenClaw operational notes — the separate repo has been retired.

Sanitized operational notes for the local OpenClaw setup on the Mac mini.

This folder should contain only reproducible documentation and helper scripts. Do not commit live OpenClaw state, API keys, auth databases, bot tokens, session logs, or copied files from `~/.openclaw`.

## Current Shape

- Gateway runs as a macOS LaunchAgent on port `18789`.
- Gateway bind is loopback with Tailscale Serve providing private remote access.
- Primary model is `minimax/MiniMax-M3`.
- Fallback order is Anthropic Sonnet, Gemini Flash, then OpenAI mini.
- Brave Search is the managed `web_search` provider.
- Andrea remains the user-facing assistant persona; BlueBubbles access goes through Andrea's registered MCP bridge.

## Useful Commands

```bash
./scripts/verify-openclaw.sh
openclaw gateway restart
openclaw gateway status
openclaw logs --follow
```

## Secret Handling

Provider secrets live outside this repo, currently under trusted OpenClaw runtime state such as `~/.openclaw/.env` and the OpenClaw auth store.

After any secret exposure, rotate keys in the provider dashboard, update the local trusted source, restart the gateway, then run the verification script.
