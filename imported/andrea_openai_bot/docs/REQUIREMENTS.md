# Setup And Requirements

## Validated Baseline

Validated in this repo on March 30, 2026:

- Node `22.22.2`
- Podman Desktop on Windows
- Podman image build for `andrea-openai-agent:latest`
- Focused runtime tests

Not validated in this pass:

- Node `24.x`
- Docker as the primary local runtime for this repo
- A successful `openai_cloud` turn without configured credentials

## Required

- Node `22.x`
- Podman Desktop with a healthy local machine/runtime
- `npm install`
- Existing host Codex auth in `%USERPROFILE%\\.codex` or `CODEX_HOME`, or an `OPENAI_API_KEY`

## Optional

- `OPENAI_API_KEY`
  - Required for `openai_cloud`
  - Also works for local Codex login if host auth is not already present

- `OPENAI_BASE_URL`
  - Optional if you use a compatible gateway

## Runtime Config

Supported environment variables:

- `ASSISTANT_NAME`
- `AGENT_RUNTIME_DEFAULT`
- `AGENT_RUNTIME_FALLBACK`
- `CONTAINER_RUNTIME_BIN`
- `CODEX_LOCAL_ENABLED`
- `CODEX_LOCAL_MODEL`
- `OPENAI_MODEL_FALLBACK`
- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`

Example:

```dotenv
ASSISTANT_NAME=Andrea
AGENT_RUNTIME_DEFAULT=codex_local
AGENT_RUNTIME_FALLBACK=openai_cloud
CONTAINER_RUNTIME_BIN=podman
CODEX_LOCAL_ENABLED=true
OPENAI_MODEL_FALLBACK=gpt-5.4
```

## Build Steps

```powershell
npm install
npm run build
npm run build:agent-runner
podman build -t andrea-openai-agent:latest .\container
```

## Codex Auth Seeding

The local runtime now seeds each per-group mounted `.codex` home from the host Codex home when these files exist:

- `auth.json`
- `config.toml`
- `cap_sid`

That means a local Codex login on the host can be reused inside each group container without mounting the entire host Codex directory.

## Known Setup Limits

- If your Codex account is out of usage, `codex_local` will now report that explicitly from inside the container.
- If `OPENAI_API_KEY` is missing, `openai_cloud` now fails with an explicit credential error instead of a vague container failure.
