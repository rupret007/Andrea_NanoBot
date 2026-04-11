# Andrea Field-Trial Demo Pack

Use this as the canonical demo and dogfood checklist for the current Windows host.

## Readiness Matrix

| Surface | Current truth | Exact blocker | Owner | Smallest next action |
| --- | --- | --- | --- | --- |
| Telegram companion | `live_proven` | none | none | Keep `npm run telegram:user:smoke` current before demos |
| Alexa companion | `live_proven` with manual sync pending | latest repo interaction-model hash is not marked synced locally yet | external/manual | Import/build `docs/alexa/interaction-model.en-US.json`, then run `npm run setup -- --step alexa-model-sync mark-synced` |
| BlueBubbles companion | `degraded_but_usable` | canonical self-thread still needs one fresh same-thread `message_action` proof leg | repo-side proof freshness | In `bb:iMessage;-;+14695405551`, ask what Andrea should say back or send back, then use `send it` or `send it later tonight` |
| Google Calendar | `live_proven` | none | none | Keep `npm run debug:google-calendar` current |
| Work cockpit | `live_proven` | none | none | Re-run one `/cursor` sanity flow after restart |
| Life threads / communication | `live_proven` | none | none | Re-run one Candace chain in Telegram |
| Chief-of-staff / missions | `live_proven` | none | none | Re-run one nightly-planning chain |
| Knowledge library | `live_proven` | none | none | Re-run one save plus one grounded answer |
| Action bundles / delegation / outcome review | `live_proven` | none | none | Re-run one approve/partial/review chain if this release touched bundle behavior |
| Research mode | `externally_blocked` | provider quota/billing | external | Restore provider quota/billing, then rerun `npm run debug:research-mode` |
| Image generation | `externally_blocked` | provider quota/billing/access | external | Restore provider quota/billing/access, then rerun `npm run debug:research-mode` |
| Startup / host-control / watchdog / health | `live_proven` | none for core host; optional local gateway compatibility lane is degraded | external/provider | Keep `services:status`, `setup verify`, and `debug:status` aligned after each restart |

## Operator Preflight

Run these before anyone is watching:

```bash
npm run services:status
npm run setup -- --step verify
npm run debug:status
npm run debug:pilot
```

Confirm:

- `phase=running_ready`
- `serving_commit_matches_workspace_head=true`
- repo root is `C:\Users\rupret\Desktop\Andrea_NanoBot`
- Node is `22.22.2`
- `LAUNCH_CANDIDATE_STATUS` reads one of:
  - `core_ready`
  - `core_ready_with_manual_surface_sync`
  - `provider_blocked_but_core_usable`
- manual sync, optional provider blockers, and proof freshness gaps are explicit instead of vague

Important truth:

- `setup verify` now follows **pass core, warn extras**
- optional provider blockers and proof freshness gaps should not be described as host failure
- on this host today, the normal story is:
  - core companion is ready
  - Alexa still wants one local model-sync marker
  - BlueBubbles is usable but still wants one same-thread proof leg
  - research and image generation are optional provider-blocked lanes

## Flagship Demo Flows

### 1. Telegram ordinary conversation

- Best prompts:
  - `hi`
  - `what's up`
- Expected behavior:
  - warm, concise, ordinary conversation without operator language
- What makes it impressive:
  - Andrea feels like one assistant, not a shell
- If an optional dependency is blocked:
  - stay in ordinary chat and avoid research/image asks

### 2. Telegram daily guidance

- Best prompts:
  - `what am I forgetting`
  - `what should I remember tonight`
- Expected behavior:
  - one grounded open loop or nightly reminder, with a follow-through option
- What makes it impressive:
  - strongest personal-assistant story on the current host
- If an optional dependency is blocked:
  - Andrea should still answer locally and briefly; no provider dependency is required

### 3. Candace / household follow-through

- Best prompts:
  - `what's still open with Candace`
  - `what should I say back`
  - `save that for later`
- Expected behavior:
  - open-loop summary, grounded draft, and a saved follow-through step in the same thread
- What makes it impressive:
  - continuity, communication help, and action capture without feeling CRM-like
- If an optional dependency is blocked:
  - keep it in-thread; do not pivot to research or media lanes

### 4. Mission / chief-of-staff planning

- Best prompts:
  - `help me plan tonight`
  - `what's the next step`
  - `what's blocking this`
- Expected behavior:
  - concise plan, one next move, one blocker
- What makes it impressive:
  - Andrea feels like a bounded chief of staff instead of a generic bot
- If an optional dependency is blocked:
  - stay in local planning guidance and avoid research-heavy branches

### 5. Work cockpit continuity

- Best prompts:
  - `/cursor`
  - `Current Work`
  - one reply-linked continuation from the active work card
- Expected behavior:
  - honest current-work state and reply-linked continuation on the same task
- What makes it impressive:
  - shows real work coordination, not just chat
- If an optional dependency is blocked:
  - the local runtime backend still supports the core cockpit story on this host

### 6. Alexa orientation and follow-up

- Best prompts:
  - `What am I forgetting?`
  - `Anything else?`
  - `What about Candace?`
  - `What should I remember tonight?`
- Expected behavior:
  - concise orientation plus one useful follow-up step
- What makes it impressive:
  - same assistant voice in a distinct spoken surface
- If an optional dependency is blocked:
  - if the latest model hash is not marked synced, say the exact console/build step and show the current status output

### 7. Cross-channel handoff

- Best prompts:
  - `send me the full version`
  - `save that for later`
- Expected behavior:
  - same-subject continuation without making the user restate the topic
- What makes it impressive:
  - channel-aware continuity instead of isolated replies
- If an optional dependency is blocked:
  - keep the shorter version in-channel and say that the richer provider-backed lane is unavailable right now

### 8. Knowledge-library grounded answer

- Best prompts:
  - `use only my saved material for this`
  - `save this to my library`
- Expected behavior:
  - source-grounded answer or save confirmation without drifting into generic research
- What makes it impressive:
  - grounded recall from the same assistant identity
- If an optional dependency is blocked:
  - this flow still works because it stays local/library-first

### 9. Calendar add vs remind vs save

- Best prompts:
  - `add dinner with Candace tomorrow at 6:30 PM`
  - `remind me about that tonight`
  - `save that for later`
- Expected behavior:
  - calendar write, reminder, and save stay clearly distinct
- What makes it impressive:
  - Andrea behaves like a practical assistant instead of flattening everything into one tool
- If an optional dependency is blocked:
  - Google Calendar itself is live here, so avoid using research/image blockers as excuses in this flow

## Same-Day Demo Story

Default showable story on this host:

1. Telegram ordinary conversation
2. Telegram daily guidance
3. Candace follow-through
4. Mission / chief-of-staff planning
5. Work cockpit continuity
6. Alexa orientation if you want voice
7. Cross-channel handoff
8. Knowledge-library grounded answer
9. Calendar add / remind / save distinction

Optional lanes that should be described honestly:

- Alexa latest-model sync may still need one manual console/build confirmation
- BlueBubbles is usable, but the canonical proof thread still wants one same-thread `message_action` leg
- outward research and image generation are provider-blocked and should be framed as optional premium lanes, not core failure

## Short Pilot Checklist

1. Run `npm run services:status`, `npm run setup -- --step verify`, `npm run debug:status`, and `npm run debug:pilot`.
2. Confirm `SERVICE: running_ready` and `serving_commit_matches_workspace_head=true`.
3. Confirm the launch story is still:
   - core companion ready
   - Alexa proof live with manual sync pending only if applicable
   - BlueBubbles `degraded_but_usable` unless the same-thread proof leg was refreshed
   - optional provider blockers explicit
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

## Exact Next Steps If Blocked

- Alexa model sync pending:
  - import/build `docs/alexa/interaction-model.en-US.json`
  - run `npm run setup -- --step alexa-model-sync mark-synced`
- BlueBubbles proof freshness gap:
  - in `bb:iMessage;-;+14695405551`, ask what Andrea should say back or send back, then use `send it` or `send it later tonight`
- Outward research blocked:
  - restore provider quota/billing
  - rerun `npm run debug:research-mode`
- Image generation blocked:
  - restore provider billing/access
  - rerun `npm run debug:research-mode`

These are exact next steps, not reasons to call the core Andrea product broken when `SERVICE: running_ready`.
