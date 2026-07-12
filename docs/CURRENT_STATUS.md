# Andrea Current Status

Generated from local operator checks on 2026-07-12.

## Recovery Context

- Recovered Codex thread: `Set up project on this Mac`
- Recovered thread id: `019e86f7-3449-7112-802d-3b10f8707ceb`
- Canonical repo root: `/Users/jeffstory/Andrea_NanoBot`
- Convenience path: `/Users/jeffstory/Documents/Andrea_NanoBot` is a symlink to the canonical repo root.
- This thread is the current recovery context. The recovered setup thread should remain reference-only unless there is a specific reason to inspect older history.

## Repo And Runtime

- Git branch: `main`
- Remote state: `main` matches `origin/main` with zero ahead/behind divergence
- Workspace and serving identity: use `npm run debug:status` for the exact
  current SHA; every release must report `Serving commit aligned: yes`
- Modernization work: combined release validated for direct `main` publication
- Process/runtime state: `running_ready`
- Host resource state: healthy with about 43 GiB free after the
  owner-authorized regenerable-cache cleanup; the prior ENOSPC condition and
  warning threshold are both cleared
- Serving commit aligned with workspace HEAD: yes
- Open pilot issues: check `npm run debug:pilot`
- Learning evidence: 56 metric samples, zero owner-reviewed outcomes, and no
  saved personal baseline. Fresh standalone owner verdicts are now wired but
  must not be backfilled from prior conversation history.

## Live Proof Truth

- Launch status: `near_live_only` while one life-thread proof gap remains
- Core status: usable with healthy persistence headroom
- Live proof gauntlet: use `npm run services:status` and `npm run integrations:status -- --json`
- Proof debt: one life-thread control turn plus a fresh signed Alexa turn
- Operator action required: complete the explicit life-thread and Alexa proof
  turns; no disk cleanup is currently required
- Repo work required for disk detection: complete

Current live-proven surfaces:

- Telegram user-session roundtrip
- BlueBubbles canonical same-thread message-action proof in `bb:iMessage;-;+14695405551`
- Google Calendar
- OpenAI, Anthropic, Gemini, MiniMax, Brave Search, research, and image generation

Current blocked or proof-stale surfaces:

- Alexa signed IntentRequest proof: `manual_action_required` until a fresh signed handled turn reaches this host
- Life-thread proof: `near_live_only` until one genuine save/thread-control turn occurs

## Next Proof Actions

1. Preserve persistence headroom.
   - Host disk pressure is currently healthy with about 43 GiB available; keep
     the existing health monitor active and avoid automatic deletion of Docker
     images, containers, evaluation evidence, or user files.

2. Ground communication identities explicitly.
   - Run `review communication identities` in the registered main Telegram chat or configured Messages self-thread.
   - Confirm or dismiss unresolved direct conversations; authoritative group
     metadata is excluded automatically, and people are never inferred from
     phone numbers or message bodies.

3. Keep Telegram proof fresh.
   - Run `npm run telegram:user:smoke`.
   - Send `hi` or `what's up` in Telegram on this host before demos.

4. Keep Google Calendar proof fresh.
   - Run `npm run debug:google-calendar` and `npm run services:status`.
   - If the host later reports `invalid_grant`, rerun the current-repo OAuth flow.

5. Keep BlueBubbles same-thread proof fresh.
   - In canonical self-thread `bb:iMessage;-;+14695405551`, ask what to say back or send back.
   - Use `send it later tonight` to prove the message-action leg without loosening send safety.
   - Confirm with `npm run debug:bluebubbles -- --live`.

6. Close Alexa proof.
   - Use a real device or authenticated simulator: `Open Andrea Assistant`, then `What am I forgetting?`.
   - Confirm with `npm run services:status`.

7. Refresh flagship journeys.
   - In Telegram, exercise ordinary chat, Candace follow-through, mission planning, `/cursor` work cockpit, and cross-channel handoff.
   - Rerun `npm run debug:pilot`.

8. Establish the first real learning baseline.
   - Review at least five genuine Andrea responses with `Helpful`, `Not
     helpful`, a Messages tapback, or a fresh standalone success/failure reply.
   - Save a baseline only after the fifth genuine review; never synthesize or
     backfill these outcomes.

## Guardrail

Do not start new repo repair work for current proof gaps unless a fresh operator surface reports `repo_work=yes`. Disk cleanup, manual Alexa proof, proof freshness, credentials, OAuth, and provider account limits stay classified as external/operator state. Andrea may diagnose and guide disk recovery but must never delete owner-controlled data automatically.
