# Andrea Field-Trial Demo Pack

Use this as the canonical demo and field-trial checklist for the current Windows host.

## Readiness Matrix

| Surface | Status | Exact blocker | Blocker owner | Smallest next action |
| --- | --- | --- | --- | --- |
| Telegram companion surface | `live_proven` | none | none | Keep `npm run telegram:user:smoke` current before demos |
| Alexa conversational surface | `near_live_only` | No fresh signed `IntentRequest` is recorded on this host | external | Perform one real signed Alexa voice or authenticated simulator turn and confirm `services:status` records an `IntentRequest` |
| BlueBubbles companion surface | `externally_blocked` | BlueBubbles Server/webhook is not installed or connected on this PC | external | Reconnect the Mac-side BlueBubbles server/webhook and restore the `BLUEBUBBLES_*` connection values here |
| Unified work cockpit (`/cursor` + Codex/OpenAI runtime) | `live_proven` | none | none | Re-run one `/cursor` sanity flow after restart |
| Life threads / communication companion | `live_proven` | none | none | Re-run the Candace flagship chain in Telegram |
| Chief-of-staff / missions | `live_proven` | none | none | Re-run the nightly planning chain in Telegram |
| Knowledge library | `live_proven` | none for local saved-material answers | none | Re-run one saved-material answer and one save flow |
| Research mode | `externally_blocked` | Direct provider credentials / quota are not currently usable for outward research | external | Restore a working direct provider key with billing/quota, then re-prove one outward fact lookup |
| Image generation | `externally_blocked` | Direct provider credentials / quota are not currently usable for Telegram image generation | external | Restore a working direct provider key with image access, then re-prove one Telegram image request |
| Startup / host-control / watchdog / health | `live_proven` | none | none | Keep `services:status`, `setup verify`, and `debug:status` aligned after each restart |

## Operator Preflight

Run these before anyone is watching:

```bash
npm run services:status
npm run setup -- --step verify
npm run debug:status
```

Confirm:

- `phase=running_ready`
- `serving_commit_matches_workspace_head=true`
- repo root is `C:\Users\rupret\Desktop\Andrea_NanoBot`
- Node is `22.22.2`
- Telegram live proof is healthy
- Alexa / BlueBubbles / research / image blockers are explicit instead of vague

Important truth:

- `STATUS: failed` in `setup verify` does **not** mean the host is broken if `SERVICE: running_ready` and the failure is only external blockers
- for this host today, the expected non-green blockers are Alexa live proof and direct-provider research/image access

## Flagship Demo Flows

### 1. Telegram ordinary chat

- Prompts:
  - `hi`
  - `what's up`
- Expected outcome:
  - warm, concise replies
  - no operator wording
- Why it is impressive:
  - Andrea feels like one assistant, not a shell
- Fallback:
  - if deeper runtime feels brittle, stay on ordinary chat plus daily guidance

### 2. Telegram daily guidance

- Prompts:
  - `what am I forgetting`
  - `what should I remember tonight`
- Expected outcome:
  - one grounded open loop or nightly reminder
- Why it is impressive:
  - this is the cleanest "personal assistant" story on the live host
- Fallback:
  - if a deeper lane is unavailable, Andrea should still answer briefly and honestly

### 3. Candace / household follow-through

- Prompts:
  - `what's still open with Candace`
  - `what should I say back`
  - `save that for later`
- Expected outcome:
  - open-loop summary, grounded draft, and a saved follow-through step in the same thread
- Why it is impressive:
  - shows continuity, communication help, and action capture without feeling like a CRM
- Fallback:
  - if a deeper draft path is blocked, show the open loop and offer a save/reminder step

### 4. Mission / chief-of-staff flow

- Prompts:
  - `help me plan tonight`
  - `what's the next step`
  - `what's blocking this`
- Expected outcome:
  - concise plan, one next move, one blocker
- Why it is impressive:
  - shows Andrea as a bounded chief-of-staff rather than a generic chat bot
- Fallback:
  - if the mission seed is weak, Andrea should say that briefly and ask for the missing anchor

### 5. Cross-channel handoff

- Prompts:
  - `send me the full version`
  - `save that for later`
- Expected outcome:
  - same-thread continuation or richer follow-up without losing the subject
- Why it is impressive:
  - demonstrates channel-aware continuity rather than isolated replies
- Fallback:
  - if the richer surface is unavailable, Andrea should keep the shorter version in-channel and say so plainly

### 6. Unified work cockpit

- Prompts:
  - `/cursor`
  - `Current Work`
  - one reply-linked continuation from the active work card
- Expected outcome:
  - honest current-work card and reply-linked continuation on the same task
- Why it is impressive:
  - shows Andrea coordinating real work, not just chat
- Fallback:
  - if there is no current task, Andrea should say so clearly instead of faking one

### 7. Alexa orientation flow

- Prompts:
  - `What am I forgetting?`
  - `Anything else?`
  - `What about Candace?`
  - `What should I remember tonight?`
  - `Be a little more direct.`
- Expected outcome:
  - one short orientation answer at a time
- Why it is impressive:
  - demonstrates a distinct but shared spoken companion surface
- Fallback:
  - if you cannot perform a fresh signed turn from this environment, state the exact missing step and show `services:status`

### 8. BlueBubbles message-help flow

- Prompts:
  - `what am I forgetting`
  - `what should I say back`
- Expected outcome:
  - bounded message-help flow in the linked BlueBubbles conversation
- Why it is impressive:
  - shows Andrea outside Telegram without widening the control plane
- Fallback:
  - on this Windows host, keep it as an externally blocked Mac-side companion flow and use `npm run debug:bluebubbles`

## What To Demo Live On This Host

Default live story:

1. Telegram ordinary chat
2. Telegram daily guidance
3. Candace follow-through
4. Mission planning
5. Cross-channel save / richer-version flow
6. Unified work cockpit

Optional same-day extras:

- Alexa only if you can perform one real signed turn
- BlueBubbles only if the Mac-side server/webhook is reachable again
- outward research or image generation only if direct provider credentials are truly working again

## Short Pilot Checklist

Use this when Andrea is being dogfooded day to day instead of formally demoed.

1. Run `npm run services:status`, `npm run setup -- --step verify`, `npm run debug:status`, and `npm run debug:pilot`.
2. Confirm `SERVICE: running_ready` and `serving_commit_matches_workspace_head=true`.
3. Confirm flagship journey proof shows:
   - Telegram `live_proven`
   - ordinary chat, daily guidance, Candace follow-through, mission planning, work cockpit, and cross-channel handoff `live_proven`
   - Alexa `near_live_only` unless a fresh signed turn happened today
4. Re-run one short Telegram chain:
   - `hi`
   - `what am I forgetting`
   - `what should I say back`
   - `save that for later`
5. Re-run one work-cockpit chain:
   - `/cursor`
   - `Current Work`
   - one reply-linked continuation
6. If something feels off, capture it explicitly with:
   - `this felt weird`
   - `that answer was off`
   - `this shouldn't have happened`
   - `save this as a pilot issue`
   - `mark this flow as awkward`
7. Review open issues with `npm run debug:pilot`.

## Known Live Blockers On This Windows Host

- Alexa is still one fresh signed `IntentRequest` away from full live proof.
- BlueBubbles is externally blocked here because the real server/webhook lives on the Mac-side environment and is not installed on this PC.
- Outward research is externally blocked by direct-provider quota or billing.
- Telegram image generation is externally blocked by direct-provider billing or image access.

These are exact host caveats, not reasons to call the core host unhealthy when `SERVICE: running_ready`.

## What Not To Claim

Do not claim on this Windows host today:

- Alexa is freshly live-proven
- BlueBubbles is freshly live-proven
- outward research is live
- Telegram image generation is live

Those may be code-ready or near-live, but the current host truth is narrower than that.
