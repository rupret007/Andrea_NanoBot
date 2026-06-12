# Andrea Current Status

Generated from local operator checks on 2026-06-12.

## Recovery Context

- Recovered Codex thread: `Set up project on this Mac`
- Recovered thread id: `019e86f7-3449-7112-802d-3b10f8707ceb`
- Canonical repo root: `/Users/jeffstory/Andrea_NanoBot`
- Convenience path: `/Users/jeffstory/Documents/Andrea_NanoBot` is a symlink to the canonical repo root.
- This thread is the current recovery context. The recovered setup thread should remain reference-only unless there is a specific reason to inspect older history.

## Repo And Runtime

- Git branch: `main`
- Remote state at recovery: `main` matched `origin/main`
- Workspace HEAD: `6542100a532dca70b7c3236b22d01037c595ec4f`
- Serving commit: `6542100a532dca70b7c3236b22d01037c595ec4f`
- Runtime state: `running_ready`
- Serving commit aligned with workspace HEAD: yes
- Open pilot issues: 0

## Live Proof Truth

- Launch status: `externally_blocked`
- Core status: `blocked`
- Live proof gauntlet: `2/7`
- Proof debt: 5
- Repo work required: 0

Current live-proven surfaces:

- Host health
- Research/provider proof
- Image generation proof

Current blocked or proof-stale surfaces:

- Telegram user-session proof: `missing_config`
- Telegram bot proof: `near_live_only`
- Google Calendar live write proof: `externally_blocked` because token refresh returns `invalid_grant`
- Alexa signed IntentRequest proof: `externally_blocked` until a fresh signed handled turn reaches this host
- BlueBubbles same-thread message-action proof: `near_live_only`; transport is ready, but the message-action proof leg is not fresh

## Next Proof Actions

1. Refresh Telegram proof.
   - Send `hi` or `what's up` in Telegram on this host.
   - If user-session automation matters, set `TELEGRAM_USER_API_ID` and `TELEGRAM_USER_API_HASH`, then run `npm run telegram:user:smoke`.

2. Reauthorize Google Calendar.
   - Run `npm run setup -- --step google-calendar auth --client-secret-json "<client-secret.json>"`.
   - Complete browser consent for the current repo.
   - Then run `npm run debug:google-calendar` and `npm run services:status`.

3. Close BlueBubbles same-thread proof.
   - In canonical self-thread `bb:iMessage;-;+14695405551`, ask what to say back or send back.
   - Use `send it later tonight` to prove the message-action leg without loosening send safety.
   - Confirm with `npm run debug:bluebubbles -- --live`.

4. Close Alexa proof.
   - Use a real device or authenticated simulator: `Open Andrea Assistant`, then `What am I forgetting?`.
   - Confirm with `npm run services:status`.

5. Refresh flagship journeys.
   - In Telegram, exercise ordinary chat, Candace follow-through, mission planning, `/cursor` work cockpit, and cross-channel handoff.
   - Rerun `npm run debug:pilot`.

## Guardrail

Do not start new repo repair work for the current proof gaps unless a fresh operator surface reports `repo_work=yes`. The current blockers are live proof, credentials, OAuth, and manual/same-host validation debt, not known code defects.
