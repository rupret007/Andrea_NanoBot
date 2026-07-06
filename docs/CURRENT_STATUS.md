# Andrea Current Status

Generated from local operator checks on 2026-07-06.

## Recovery Context

- Recovered Codex thread: `Set up project on this Mac`
- Recovered thread id: `019e86f7-3449-7112-802d-3b10f8707ceb`
- Canonical repo root: `/Users/jeffstory/Andrea_NanoBot`
- Convenience path: `/Users/jeffstory/Documents/Andrea_NanoBot` is a symlink to the canonical repo root.
- This thread is the current recovery context. The recovered setup thread should remain reference-only unless there is a specific reason to inspect older history.

## Repo And Runtime

- Git branch during release hardening: `codex/agi-improvement-loop`
- Remote state before push: release branch tracked `origin/codex/agi-improvement-loop`; final release should be verified against `origin/main`
- Workspace HEAD before the release commit: `adf2c7bb`
- Serving commit before the release commit: `adf2c7bb`
- Runtime state: `running_ready`
- Serving commit aligned with workspace HEAD: yes
- Open pilot issues: check `npm run debug:pilot`

## Live Proof Truth

- Launch status: release-candidate with manual Alexa proof debt
- Core status: running
- Live proof gauntlet: use `npm run services:status` and `npm run integrations:status -- --json`
- Proof debt: Alexa manual proof plus any flagship journey freshness that has aged out
- Repo work required: 0

Current live-proven surfaces:

- Host health
- Telegram user-session roundtrip
- BlueBubbles canonical same-thread message-action proof in `bb:iMessage;-;+14695405551`
- Google Calendar
- OpenAI, Anthropic, Gemini, MiniMax, Brave Search, research, and image generation

Current blocked or proof-stale surfaces:

- Alexa signed IntentRequest proof: `manual_action_required` until a fresh signed handled turn reaches this host
- Work cockpit execution: may report `externally_blocked` when the Andrea OpenAI backend lane is disabled
- Flagship journey proofs: may be proof-stale independently of integration health

## Next Proof Actions

1. Keep Telegram proof fresh.
   - Run `npm run telegram:user:smoke`.
   - Send `hi` or `what's up` in Telegram on this host before demos.

2. Keep Google Calendar proof fresh.
   - Run `npm run debug:google-calendar` and `npm run services:status`.
   - If the host later reports `invalid_grant`, rerun the current-repo OAuth flow.

3. Keep BlueBubbles same-thread proof fresh.
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

Do not start new repo repair work for current proof gaps unless a fresh operator surface reports `repo_work=yes`. Manual Alexa proof, proof freshness, disabled backend lanes, credentials, OAuth, and provider account limits should stay classified as external/operator state, not assumed repo defects.
