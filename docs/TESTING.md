# Testing And Validation

## Use Node 22

This repo is currently validated on Node `22.x`.

Why:

- `better-sqlite3` did not load cleanly in this environment on Node `24.x`
- runtime-focused tests were run and passed under Node `22.22.2`

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
- operator command gating
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

- focused runtime suite
- root typecheck
- root build
- agent-runner build
- Podman image build
- Podman smoke run
- real local container launch through the runtime runner

Conditionally blocked:

- successful `codex_local` reply because the Codex account hit a usage limit
- successful `openai_cloud` reply because `OPENAI_API_KEY` was not configured
- same-thread live follow-up because there was no successful first local turn to continue
