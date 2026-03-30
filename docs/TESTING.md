# Testing And Validation

## Use Node 22

This repo is currently validated on Node `22.x`.

Why:

- `better-sqlite3` did not load cleanly in this environment on Node `24.x`
- runtime-focused tests were run and passed under Node `22.22.2`

### Windows note

On Windows, Node `24.x` may have no prebuilt `better-sqlite3` binary. `npm install` can fall back to `node-gyp` and fail without Visual Studio "Desktop development with C++". Prefer Node `22.x` to match `engines` in `package.json` and use the validated prebuild path.

See also [RUNTIME_AUDIT.md](RUNTIME_AUDIT.md) and [OPERATIONS.md](OPERATIONS.md).

## Focused Runtime Suite

```powershell
npm run test:runtime
```

This suite covers:

- runtime routing
- provider selection
- Codex auth seeding
- Podman selection behavior
- DB persistence for runtime threads
- operator command gating and runtime command dispatch
- scheduler/runtime integration
- IPC auth
- failure message behavior

## Broader Checks

```powershell
npm run test
npm run build
npm run build:agent-runner
npm run typecheck
```

## Live Validation

Build the image:

```powershell
podman build -t andrea-openai-agent:latest .\container
```

Smoke test the image:

```powershell
podman run -i --rm --entrypoint /bin/echo andrea-openai-agent:latest "Container OK"
```

Run a local Codex probe:

```powershell
npm run validate:runtime -- --runtime codex_local
```

Run a cloud fallback probe:

```powershell
npm run validate:runtime -- --runtime openai_cloud --route cloud_allowed
```

## March 30, 2026 Results

Succeeded:

- `npm run test`: 253 passed under Node `22.22.2`
- `npm run test:runtime`: 154 passed under Node `22.22.2`
- root typecheck
- root build
- agent-runner build
- Podman image build
- Podman smoke run
- successful `codex_local` one-shot reply in a real Podman container
- same-thread `codex_local` follow-up reuse with the returned session id
- `openai_cloud` returns an explicit structured credential error when `OPENAI_API_KEY` is missing

Conditionally blocked:

- successful `openai_cloud` reply because `OPENAI_API_KEY` was not configured
- live Telegram-side operator walkthrough because it was not exercised against a connected chat in this pass

## Windows + Podman: run validate when host `npm install` fails

If Windows has Node 24 without C++ build tools, run validation from the Podman machine (Linux), where `podman` can spawn the agent container:

```bash
podman machine ssh 'curl -fsSL https://nodejs.org/dist/v22.22.2/node-v22.22.2-linux-x64.tar.xz -o /tmp/node.tar.xz && tar -xJf /tmp/node.tar.xz -C /tmp && export PATH=/tmp/node-v22.22.2-linux-x64/bin:$PATH && cd /mnt/c/Users/<you>/Desktop/Andrea_OpenAI_Bot && npm run install:all && CONTAINER_RUNTIME_BIN=podman npx tsx scripts/validate-runtime.ts --runtime codex_local'
```

Adjust the repo path. OneCLI may be unreachable from the VM; the runner logs a warning but still exercises Podman.

## Reality Audit

Subsystem classification (tests vs live vs conditional) lives in [RUNTIME_AUDIT.md](RUNTIME_AUDIT.md). Update that file whenever validation state changes.

## Real-World Message Corpus (~200)

Regenerate JSON (exactly 200 messages):

```powershell
npm run generate:realworld-corpus
```

Output: `scripts/fixtures/realworld-messages.json`.

Preview without sending:

```powershell
npm run realworld:send:dry-run
npm run realworld:send:dry-run -- --limit 10
npm run realworld:send:dry-run -- --category operator_runtime
```

Send via Telegram (rate-limit friendly: use a large `--delay-ms` and optional `--jitter-ms`):

```powershell
$env:TELEGRAM_BOT_TOKEN = "<bot token>"
$env:TELEGRAM_CHAT_ID = "<chat id>"
node scripts/realworld-send.mjs --send --delay-ms 45000 --jitter-ms 15000
```

Do not fire 200 heavy `codex_heavy` prompts back-to-back while Codex is rate-limited. Prefer filtering by category, smaller `--limit`, or long delays. Operator commands belong in the main control chat only.

## Service Restart

See [OPERATIONS.md](OPERATIONS.md) for stop/start order and smoke checks after a restart.
