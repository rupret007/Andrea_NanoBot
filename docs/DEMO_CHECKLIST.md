# Andrea Field-Trial Demo Pack

Use this as the demo and dogfood checklist for the current operator host. Command output wins over this file whenever they disagree.

## Canonical Truth Order

1. `npm run debug:status`
2. `npm run setup -- --step verify`
3. `npm run agi:readiness -- --write --no-live-probe`
4. `npm run debug:pilot`
5. this checklist

The readiness matrix below is historical operator guidance, not a live claim.
When it disagrees with `agi:readiness`, treat the command output as truth and
update the proof before demoing that lane.

## Readiness Matrix

| Surface                                      | Current truth                  | Exact blocker                                               | Owner              | Smallest next action                                                                  |
| -------------------------------------------- | ------------------------------ | ----------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------- |
| Telegram user-session proof                  | `externally_blocked`           | missing `TELEGRAM_USER_API_ID` and `TELEGRAM_USER_API_HASH` | external/config    | Set the credentials, then run `npm run telegram:user:smoke`                           |
| Alexa companion                              | `near_live_only`               | no fresh signed handled `IntentRequest` recorded            | external/live turn | Use a real simulator/device turn, then run `npm run services:status`                  |
| BlueBubbles companion                        | `degraded_but_usable`          | missing fresh same-thread message-action proof              | live turn          | Run one same-chat draft -> `send it` or `send it later tonight` proof                 |
| Google Calendar                              | `externally_blocked`           | token refresh returns `invalid_grant`                       | external/OAuth     | Reauthorize with the current repo, then run `npm run debug:google-calendar`           |
| Work cockpit                                 | `near_live_only` / proof-stale | no fresh flagship work-cockpit turn                         | operator/live turn | Re-run one `/cursor` sanity flow                                                      |
| Life threads / communication                 | `near_live_only` / proof-stale | no fresh Candace/communication chain                        | operator/live turn | Re-run one Candace follow-through chain                                               |
| Chief-of-staff / missions                    | `near_live_only` / proof-stale | no fresh planning journey                                   | operator/live turn | Re-run one nightly-planning or mission chain                                          |
| Knowledge library                            | `near_live_only` / proof-stale | no fresh save plus grounded answer                          | operator/live turn | Re-run one save and one library-grounded answer                                       |
| Action bundles / delegation / outcome review | `near_live_only` / proof-stale | no fresh approve/partial/review chain                       | operator/live turn | Re-run one action-bundle review chain                                                 |
| Follow-through review                        | `not_intended_for_trial`       | retired as a standalone launch proof surface                | none               | Use daily command center and action-bundle review proofs instead                      |
| Research mode                                | command-derived                | provider credential/proof may be stale on a new host        | external/config    | Run `npm run agi:readiness -- --write --no-live-probe` before claiming live proof     |
| Image generation                             | command-derived                | provider credential/proof may be stale on a new host        | external/config    | Run `npm run agi:readiness -- --write --no-live-probe` before claiming live proof     |
| Startup / host-control / watchdog / health   | `live_proven`                  | none for core host                                          | none               | Keep `services:status`, `setup verify`, and `debug:status` aligned after each restart |

## Operator Preflight

Run these before anyone is watching:

```bash
npm run services:status
npm run setup -- --step verify
npm run debug:status
npm run debug:pilot
```

Confirm:

- host state is `running_ready`
- `serving_commit_matches_workspace_head=true`
- active repo and serving commit are aligned
- `LAUNCH_CANDIDATE_STATUS` is not described as ready while Telegram, Alexa, or same-host flagship proof is missing
- external blockers and proof freshness gaps are explicit instead of vague

Important truth:

- `setup verify` can prove assistant execution while still failing launch readiness because external proof/config gates are open.
- `ASSISTANT_EXECUTION_PROBE: ok` means the assistant answered; a final failed launch status should be read with the listed blockers, not as an ambiguous runtime failure.
- Telegram is blocked by missing user-session API credentials until `npm run telegram:user:smoke` succeeds.
- Alexa is not `live_proven` until a fresh signed handled `IntentRequest` is recorded.
- BlueBubbles is usable, but not fully live-proven until a fresh same-thread message-action proof is recorded.
- Google Calendar is currently blocked by a stale or revoked OAuth grant; reauthorize before claiming calendar launch readiness.
- Research and image generation are optional advanced lanes; claim them only when the latest readiness report says they are live-proven.

## Proof Recovery Checklist

Close proof debt in this order:

1. Telegram
   - Set `TELEGRAM_USER_API_ID` and `TELEGRAM_USER_API_HASH`.
   - Run `npm run telegram:user:smoke`.
   - Success shape: no missing-credential blocker, user-session smoke records a request/response proof, and `debug:status` no longer reports Telegram as `externally_blocked`.
2. Google Calendar
   - Run `npm run setup -- --step google-calendar auth --client-secret-json "<client-secret.json>"`.
   - Complete browser consent for the current repo.
   - Run `npm run debug:google-calendar` and `npm run services:status`.
   - Success shape: token refresh succeeds, provider discovery works, and a disposable live-write proof is current.
3. BlueBubbles
   - Run `npm run debug:bluebubbles -- --live`.
   - In the same Messages chat, ask Andrea to draft a reply, then execute `send it` or `send it later tonight`.
   - Success shape: transport and webhook stay ready, and the same-thread inbound/outbound/message-action proof is fresh.
4. Alexa
   - From the real Alexa simulator or device, say `Open Andrea Assistant`, then `What am I forgetting?`.
   - Run `npm run services:status` and `npm run debug:pilot`.
   - Success shape: latest signed request is a handled `IntentRequest`, the proof is inside the freshness window, and Alexa reports `live_proven`.
5. Flagship journeys
   - Re-run ordinary chat, daily guidance, Candace follow-through, mission planning, work cockpit, cross-channel handoff, knowledge library, and follow-through review.
   - Run `npm run debug:pilot`.
   - Success shape: flagship proof freshness improves without any stale `live_proven` claims.

Treat missing credentials, manual signed turns, phone/device availability, and provider account limits as external blockers. Treat deterministic command failures, incorrect blocker classification, or mismatched docs as repo bugs.

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
  - `what bills do I need to pay this week`
- Expected behavior:
  - one grounded open loop or nightly reminder, with a follow-through option
- What makes it impressive:
  - strongest personal-assistant story on the current host
- If an optional dependency is blocked:
  - Andrea should still answer locally and briefly; no provider dependency is required

### 3. Telegram personalized setup and everyday capture

- Best prompts:
  - `help me set this up`
  - `add milk to my shopping list`
  - `what do I still need to buy`
  - `mark that done`
- Expected behavior:
  - Andrea proposes a practical setup, then handles quick list capture and short readout without turning into a project manager
- What makes it impressive:
  - the assistant adapts to the person instead of assuming one fixed life template
- If an optional dependency is blocked:
  - setup should fall back to the deterministic starter plan and core list CRUD should still work locally

### 4. Candace / household follow-through

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

### 5. Mission / chief-of-staff planning

- Best prompts:
  - `help me plan tonight`
  - `help me plan meals this week`
  - `what's the next step`
  - `what's blocking this`
- Expected behavior:
  - concise plan, one next move, one blocker
- What makes it impressive:
  - Andrea feels like a bounded chief of staff instead of a generic bot
- If an optional dependency is blocked:
  - stay in local planning guidance and avoid research-heavy branches

### 6. Work cockpit continuity

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

### 7. Alexa orientation and follow-up

- Best prompts:
  - `What am I forgetting?`
  - `Remind me to take my pills at 9`
  - `What bills do I need to pay this week?`
  - `Anything else?`
  - `What about Candace?`
  - `What should I remember tonight?`
- Expected behavior:
  - concise orientation plus one useful follow-up step
- What makes it impressive:
  - same assistant voice in a distinct spoken surface
- If an optional dependency is blocked:
  - if no fresh signed handled `IntentRequest` is recorded, run the live simulator/device proof before calling Alexa launch-ready

### 8. Cross-channel handoff

- Best prompts:
  - `send me the full version`
  - `save that for later`
- Expected behavior:
  - same-subject continuation without making the user restate the topic
- What makes it impressive:
  - channel-aware continuity instead of isolated replies
- If an optional dependency is blocked:
  - keep the shorter version in-channel and say that the richer provider-backed lane is unavailable right now

### 9. Knowledge-library grounded answer

- Best prompts:
  - `use only my saved material for this`
  - `save this to my library`
- Expected behavior:
  - source-grounded answer or save confirmation without drifting into generic research
- What makes it impressive:
  - grounded recall from the same assistant identity
- If an optional dependency is blocked:
  - this flow still works because it stays local/library-first

### 10. Calendar add vs remind vs save

- Best prompts:
  - `add dinner with Candace tomorrow at 6:30 PM`
  - `remind me about that tonight`
  - `save that for later`
- Expected behavior:
  - calendar write, reminder, and save stay clearly distinct
- What makes it impressive:
  - Andrea behaves like a practical assistant instead of flattening everything into one tool
- If an optional dependency is blocked:
  - If Google Calendar is blocked in the readiness report, show the confirmation and fallback path instead of claiming a live write

## Same-Day Demo Story

Default showable story after proof recovery:

1. Telegram ordinary conversation
2. Telegram daily guidance
3. Telegram personalized setup and everyday capture
4. Candace follow-through
5. Mission / chief-of-staff planning
6. Work cockpit continuity
7. Alexa orientation if you want voice
8. Cross-channel handoff
9. Knowledge-library grounded answer
10. Calendar add / remind / save distinction

Optional lanes that should be described honestly:

- Alexa is voice-ready only after a fresh signed handled `IntentRequest`.
- BlueBubbles is usable but needs a fresh same-thread `message_action` proof before it should be called `live_proven`.
- Research and image generation are advanced lanes. Their live status is command-derived, so demo them only when the latest readiness report says they are live-proven.

## Short Pilot Checklist

1. Run `npm run services:status`, `npm run setup -- --step verify`, `npm run debug:status`, and `npm run debug:pilot`.
2. Confirm host state is `running_ready` and `serving_commit_matches_workspace_head=true`.
3. Confirm the launch story is still:
   - no stale `live_proven` claims
   - Telegram user-session proof unblocked only after credentials and smoke test
   - Alexa `live_proven` only after a fresh signed handled `IntentRequest`
   - BlueBubbles `live_proven` only after a fresh same-thread `message_action` proof chain
   - proof-stale flagship journeys named plainly
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

- Telegram externally blocked:
  - set `TELEGRAM_USER_API_ID` and `TELEGRAM_USER_API_HASH`
  - run `npm run telegram:user:smoke`
- Alexa near-live only:
  - run one real signed simulator/device flow: `Open Andrea Assistant`, then `What am I forgetting?`
  - run `npm run services:status`
  - if the model hash is no longer marked synced, import/build `docs/alexa/interaction-model.en-US.json`, then run `npm run setup -- --step alexa-model-sync mark-synced`
- BlueBubbles proof gap:
  - run `npm run debug:bluebubbles -- --live`
  - retry the same Messages chat draft -> `send it` proof chain
- Flagship proof stale:
  - rerun the short pilot chain plus one work-cockpit continuation
  - run `npm run debug:pilot`
- Research or image generation regresses:
  - check provider account/billing/quota and rerun the relevant debug command

These are exact next steps, not reasons to call the repo broken when host health is `running_ready` and the blocker is external proof/config.
