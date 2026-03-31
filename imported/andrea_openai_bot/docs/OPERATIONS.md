# Operations: builds, services, restarts

## Prerequisites

- **Node 22.x** for local `npm install`, tests, and builds (see [TESTING.md](TESTING.md)).
- **Podman** (default) or Docker, with `CONTAINER_RUNTIME_BIN` set if not using Podman.
- Built agent image: `podman build -t andrea-openai-agent:latest ./container` (from repo root).

## Clean restart (generic)

Use this order to avoid stale containers or half-started processes.

1. **Stop the bot process**  
   - **launchd (macOS):** `launchctl unload ~/Library/LaunchAgents/com.andrea-openai-bot.plist` then load again after any config change, or use `launchctl kickstart -k gui/$(id -u)/com.andrea-openai-bot` if already loaded.  
   - **systemd (Linux):** `sudo systemctl stop andrea-openai-bot` (unit name may match your install; check `setup/service` output).  
   - **Manual / dev:** stop the `node dist/index.js` or `npm run dev` process (Ctrl+C or kill PID from `logs/andrea-openai-bot.pid` if used).

2. **Optional: stop stuck agent containers**  
   List: `podman ps` (or `docker ps`). Stop NanoClaw/Andrea-named containers if they are orphaned from a crashed run.

3. **Ensure container runtime is healthy**  
   `podman info` or `docker info` should succeed.

4. **Rebuild if TypeScript or agent-runner changed**  
   ```bash
   npm run build
   npm run build:agent-runner
   podman build -t andrea-openai-agent:latest ./container
   ```

5. **Start the bot**  
   - **launchd:** `launchctl load ~/Library/LaunchAgents/com.andrea-openai-bot.plist`  
   - **systemd:** `sudo systemctl start andrea-openai-bot`  
   - **Dev:** `npm run start` or `npm run dev` from repo root with `.env` loaded.

6. **Smoke check**  
   Send a short message in the main Telegram chat, or run `npm run validate:runtime -- --runtime codex_local` (expect either success or a **structured** provider error, not a silent failure).

## First-time service install

Interactive setup still flows through `npm run setup` (or `tsx setup/index.ts`), which can generate launchd/systemd units via `setup/service.ts`. Prefer that path so paths and Node binary match your machine.

## Logs

- Application: `logs/andrea-openai-bot.log` and `logs/andrea-openai-bot.error.log` when using generated launchd templates.  
- Setup: `logs/setup.log` where applicable.

## Real-world message corpus

For sustained chat testing (with rate limits in mind), see [TESTING.md](TESTING.md) § Real-world corpus. Send logs are written under `logs/realworld-send-log-*.jsonl` (gitignored).
