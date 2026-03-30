# Debug Checklist

Use this checklist before claiming the Codex-first runtime is healthy.

## 1. Node Version

- Confirm Node `22.x`
- If you are on Node `24.x`, do not trust DB-backed tests until `better-sqlite3` is confirmed working

## 2. Container Runtime

- Run `podman info`
- Confirm Podman is the selected default runtime
- Build `andrea-openai-agent:latest`
- Run the smoke container test

## 3. Local Codex Auth

- Check host `%USERPROFILE%\\.codex` or `CODEX_HOME`
- Confirm at least one of these exists:
  - `auth.json`
  - `cap_sid`
- Confirm the per-group runtime `.codex` directory gets seeded on first run

## 4. Local Runtime Probe

- Run `npm run validate:runtime -- --runtime codex_local`
- If it fails, check whether the failure is:
  - usage limit
  - missing host auth
  - Podman/container failure
  - image build drift

## 5. Cloud Fallback Probe

- Run `npm run validate:runtime -- --runtime openai_cloud --route cloud_allowed`
- If it fails, check whether `OPENAI_API_KEY` or a compatible gateway token is configured

## 6. Operator Surface

- Run `npm run test:runtime`
- Confirm operator command gating still passes
- Remember that live Telegram-side operator validation is still separate from unit coverage

## 7. Failure Honesty

- Make sure runtime errors are returned as structured runtime/provider messages
- Do not accept a generic “container exited with code 1” if a more specific structured error exists inside stdout/logs
