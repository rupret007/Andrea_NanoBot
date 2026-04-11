# Andrea Alexa Voice Integration

Alexa is a bounded channel for Andrea, not a second assistant and not a public control plane.

Andrea now uses an internal **Alexa Companion Mode**:

- shorter, warmer, spoken-first replies
- one main thing first
- one or two short supporting lines
- direct in-voice handling for clear low-risk assistant jobs like calendar reads, simple event adds or moves, and reminders
- shared assistant capabilities for daily guidance, household questions, memory controls, explicit thread lookup, and bounded research
- measured guidance for open-ended daily questions
- short-lived conversational continuity
- calmer, more natural recovery when phrasing is imperfect
- a small bounded personality layer for softer transitions in low-stakes replies
- thread-aware continuity for active household, relationship, and follow-up topics
- household-aware follow-ups when context is strong
- explicit, consent-based personalization only
- request-driven Andrea Pulse turns for light interesting facts or surprises

Telegram remains the primary operator surface. Alexa reuses the same trust boundaries, schedule intelligence, reminders, drafting, and follow-through logic.
In flagship journeys, Alexa should orient quickly, finish one useful voice step when it safely can, and only then hand off richer detail to Telegram without making the user restate the whole topic.

## 0A) Shared Capability Routing

Alexa now sits on top of the same Andrea assistant capability graph used by Telegram where that is safe.

In practice, that means:

- explicit Alexa intents still exist where the interaction model needs them
- the live model is now organized around a small number of broader intent families instead of a long list of brittle one-phrase silos
- those broader intents map into shared Andrea capabilities first whenever possible
- open captured carrier phrases now reach the same shared assistant graph before Alexa falls back to a narrower bridge path
- `ConversationControlIntent`, legacy `ConversationalFollowupIntent`, and `AnythingElseIntent` first try shared capability continuation before broader fallback paths
- Alexa keeps voice-first shaping at the edge instead of letting internal capability labels leak into spoken output

Examples of shared actions now routed this way:

- `What am I forgetting?`
- `What matters most today?`
- `What should I do next?`
- `What should I prepare before tonight?`
- `What about Candace?`
- `What's still open with Candace?`
- `What should I remember tonight?`
- `Why did you say that?`
- bounded research turns like `Compare meal delivery options for this week`

The shared capability graph does **not** make Alexa and Telegram identical.

- Alexa stays short, bounded, and voice-safe
- Telegram stays richer and more explicit
- operator-only current-work controls remain blocked on Alexa even though they are present in the same registry

## 0B) Chief-of-Staff Orientation

Alexa is now a bounded chief-of-staff and practical assistant surface.

The strongest everyday assistant jobs are:

- `what's on my calendar today`
- `what's on my calendar tomorrow`
- `what do I have this afternoon`
- `add dinner with Candace tomorrow at 6:30 PM`
- `move dinner to 7`
- `cancel dinner tomorrow`
- `remind me at 4 to text Candace`
- `remind me about that tonight`
- `what should I say back`
- `help me figure out tonight`

Good Alexa asks in this layer:

- `What matters most today?`
- `What am I forgetting?`
- `What should I remember tonight?`
- `What should I do next?`
- `What should I prepare before tonight?`
- `Why are you prioritizing that?`

Expected Alexa behavior:

- one main thing first
- one or two short support lines
- explainable reasoning when asked
- optional Telegram handoff when a richer breakdown is more useful than voice

Alexa also now acts as a mission-orientation surface for explicit planning asks such as:

- `help me plan tonight`
- `what's the next step on that`
- `what am I missing for this`
- `what's still open in that plan`

In that mode Andrea should stay short:

- lead summary
- next step
- blocker or missing piece
- optional fuller-plan handoff to Telegram

Important limits:

- no long spoken list of every open loop
- no hidden reprioritization
- no work-cockpit controls leaking into Alexa

## 0C) Signature Flow Role

Alexa's job in the flagship journeys is useful orientation plus one clear assistant step, not exhaustiveness.

The strongest Alexa-first flows are:

- `what matters most today`
- `what am I forgetting`
- `what should I remember tonight`
- `what should I do next`
- `what's on my calendar tomorrow`
- `add dinner with Candace tomorrow at 6:30 PM`
- `move dinner to 7`
- `remind me at 4 to text Candace`
- `what's still open with Candace`
- `help me plan tonight`

In those flows Alexa should:

- give one lead read
- finish the obvious low-risk voice action directly when the request is clear
- mention one next step or blocker
- keep the same context alive for `anything else`, `what happens next`, `remind me`, `save that`, or `send me the fuller plan`
- hand richer detail to Telegram instead of trying to read the whole plan, research answer, or conversation aloud

## 0) Current Truth

Treat Alexa as:

- **live-ready** only when the live skill, HTTPS ingress, account linking, and linked Andrea group are all configured and current
- **code-ready but setup-blocked** when repo-side validation is green but one or more external Alexa steps are still missing

Current truthful host status:

- Andrea runs under Node `22.22.2`
- the local Alexa listener can run even when no Telegram channel is connected
- `groupFolder=main` is valid
- local Alexa health responds on `/alexa/health`
- local OAuth health responds on `/alexa/oauth/health`
- live HTTPS ingress must still be current, reachable, and correctly wired in the Alexa Developer Console
- if the live HTTPS host is an `ngrok` `*.ngrok-free.dev` tunnel, the Alexa endpoint SSL type must be set to the wildcard certificate option
- issued access tokens resolve to `groupFolder=main`
- Alexa proof on this host is status-led rather than a static doc claim
- Alexa only counts as **live_proven** when a fresh handled Andrea custom-skill proof remains within **24 hours**
- pilot-mode operator surfaces (`services:status`, `setup verify`, `debug:status`, `debug:pilot`) should classify Alexa as `live_proven` while that proof stays fresh, and intentionally drop it back to `near_live_only` if the proof becomes stale
- after restart, those operator surfaces may credit the proof either from the persisted handled signed-request markers or from a recent same-host `alexa_orientation` pilot success that already recorded the qualifying handled turn
- if there is no fresh handled signed custom-skill turn on this host, Alexa should read as `near_live_only`
- the latest repo interaction-model hash is tracked separately from proof freshness
- if the repo model changed and the local sync marker was not refreshed yet, launch-readiness should read `core_ready_with_manual_surface_sync`, not `near_live_only`
- use current operator surfaces for the exact proof markers instead of treating this guide as the live authority

### Local Model-Sync Marker

Use this repo-side marker after you import the current model in the Alexa Developer Console:

```bash
npm run setup -- --step alexa-model-sync status
npm run setup -- --step alexa-model-sync mark-synced
```

Use `mark-synced` only after all three are true:

1. `docs/alexa/interaction-model.en-US.json` is the file you imported
2. the Alexa Developer Console model was saved
3. `Build Model` succeeded

This keeps the launch story honest:

- fresh Alexa voice proof tells us the skill is working
- the model-sync marker tells us the live console build matches the current repo model

## 0D) Exact Live-Proof Rule

Alexa becomes `live_proven` only when all of these are true on this host:

- a fresh handled Andrea custom-skill proof exists on this host
- that proof comes from either the persisted handled signed-request state or a recent same-host `alexa_orientation` pilot success after restart
- when the signed-request markers are still present, the last signed request type is `IntentRequest`
- when the signed-request markers are still present, the last signed intent was actually handled, not just received
- when the signed-request markers are still present, `alexa_last_signed_response_source` is a handled path such as `local_companion`, `life_thread_local`, `assistant_bridge`, or `bridge`
- the handled proof is no older than **24 hours**

These states do **not** count as live proof:

- `LaunchRequest` only
- `responseSource=received_trusted_request`
- `responseSource=barrier`
- `responseSource=fallback`
- a handled proof older than 24 hours

Fast operator close path:

1. Use a **real device** or the **authenticated Alexa Developer Console simulator**
2. Say:
   - `Open Andrea Assistant`
   - `What am I forgetting?`
3. Run:
   - `npm run services:status`

Success should look like:

- `alexa_last_signed_request_type=IntentRequest`
- `alexa_last_signed_intent=WhatAmIForgettingIntent`
- `alexa_last_signed_response_source=local_companion` or another handled source
- `alexa_live_proof=live_proven`
- `alexa_live_proof_kind=handled_intent`
- `alexa_live_proof_freshness=fresh`

Stale proof should look like:

- a handled intent is still recorded
- `alexa_live_proof=near_live_only`
- `alexa_live_proof_kind=handled_intent`
- `alexa_live_proof_freshness=stale`

If the turn does not register, check:

- no `IntentRequest` was recorded
- only `LaunchRequest` was recorded
- `alexa_last_signed_response_source=received_trusted_request`
- `alexa_last_signed_response_source=barrier` or `fallback`
- the live interaction model is stale and needs import + `Build Model`
- endpoint or account-link config drift
- the signed request never reached this host

Important validation note:

- use **Node 22.22.2** for Alexa validation on this repo
- do not rely on host Node 24 for truthful Alexa checks
- `npm run services:status` now exposes the local Alexa listener and OAuth health when Alexa is configured, plus the last signed Alexa request markers
- public HTTPS ingress and real signed Alexa requests still need their own checks
- typed Alexa+ app chat is **not** an authoritative proof surface unless it produces a real signed follow-up `IntentRequest` after launch
- if you change the interaction model in `docs/alexa/interaction-model.en-US.json`, you must re-import it in the Alexa Developer Console and run `Build Model` before treating live voice fallback as a repo bug

## 1) Authoritative Proof Surfaces

Use these as the source of truth for live acceptance:

- voice launch from the Alexa app
- voice launch from a physical Alexa device
- authenticated Alexa Developer Console simulator

Treat typed Alexa+ app chat as diagnosis-only unless Andrea logs a real signed follow-up intent after launch.

## 2) Alexa Surface

The interaction model now keeps Alexa bounded through a small set of broader custom intent families:

- `CompanionGuidanceIntent`
  - `what matters today`
  - `what am I forgetting`
  - `what should I do next`
  - `what should I remember tonight`
  - `what's up`
  - `what time is it`
  - `can you help me`
- `PeopleHouseholdIntent`
  - `what about Candace`
  - `what's still open with Candace`
  - `what should I say back about Candace`
  - `help me with Candace`
- `PlanningOrientationIntent`
  - `help me plan tonight`
  - `help me figure out tonight`
  - `figure out tonight`
  - `what's the next step for tonight`
  - `what's blocking this`
- `SaveRemindHandoffIntent`
  - `save that`
  - `remind me about that`
  - `send me the full version`
  - `send that to Telegram`
- `OpenAskIntent`
  - `what should I say back`
  - `tell me about X`
  - `help me with X`
  - `what should I know about X`
  - `compare X and Y`
- `ConversationControlIntent`
  - `anything else`
  - `say more`
  - `make it shorter`
  - `be a little more direct`
  - `what about that`
  - `remember that`

Legacy intent names still remain supported in runtime code for one compatibility window, so a stale live interaction model does not immediately hard-fail during rollout.

The current broadened model also includes lighter carrier coverage for simple voice turns through `CompanionGuidanceIntent`, including patterns like:

- `what's up`
- `what's X`
- `can you help me`
- `can you X`

Standard Alexa intents still apply:

- `LaunchRequest`
- `AMAZON.HelpIntent`
- `AMAZON.YesIntent`
- `AMAZON.NoIntent`
- `AMAZON.CancelIntent`
- `AMAZON.StopIntent`
- `AMAZON.FallbackIntent`

Out of scope:

- smart-home control
- unbounded freeform chat
- operator-shell commands
- hidden long-term memory
- multi-user household routing

### 2A) Open-Utterance Capture

Alexa is still interaction-model driven, but Andrea now captures more natural phrasing through bounded carrier-phrase slots instead of asking users to memorize one exact utterance.

Current carrier-style openings include:

- `what's on my calendar ...`
- `what do I have ...`
- `add ...`
- `schedule ...`
- `move ...`
- `cancel ...`
- `what should I say back`
- `tell me about ...`
- `help me with ...`
- `what should I know about ...`
- `compare ...`
- `explain ...`
- `remind me about ...`
- `save ...`
- `draft ...`
- `what should I say back about ...`

Important limits:

- no bare giant catch-all slot
- no unrestricted freeform Alexa chat
- if the utterance is too underspecified, Andrea asks for one anchor and keeps the thread alive
- when the request is valid but too rich for voice, Andrea stays concise and hands the fuller continuation to Telegram

Pulse is intentionally separate from health and diagnostics:

- `/ping` stays operational and non-personality-driven on Telegram
- Alexa Pulse is request-driven only
- there is no automatic fun-fact push behavior in this pass

## 1A) Life Threads In Alexa

Alexa can now use the same bounded life-thread layer as Telegram when that improves continuity.

That means prompts like these can stay short, natural, and grounded:

- `What's still open today`
- `What am I forgetting`
- `What should I follow up on`
- `What's still open with Candace`
- `Is there anything I still need to handle for the house`
- `Save that under the family thread`

Important limits:

- Alexa uses thread context only when the linked account resolves cleanly
- thread replies stay conversational, not database-like
- threads are not hidden memory; they are compact active-topic records
- sensitive relationship or family threads still need strong user intent or confirmation before becoming durable
- `don't bring this up automatically` switches a thread to manual-only surfacing instead of deleting it

## 2) Trust And Account Linking

Andrea only answers personal Alexa requests when the request resolves to a linked local Andrea context.

The Alexa boundary enforces:

- ASK request signature and timestamp verification when enabled
- configured skill/application ID matching
- optional coarse Alexa user/person allowlist
- required linked-account lookup for personal-data intents

The local link model is intentionally narrow:

- Andrea stores hashed access tokens in `alexa_linked_accounts`
- the hash maps to one Andrea `groupFolder`
- optional stored Alexa user/person IDs can further lock that mapping down

Linked versus unlinked behavior is strict:

- unlinked requests may use launch/help/fallback safely
- personal intents do not return calendar, reminder, or follow-through data unless linking resolves cleanly
- if the token is missing, unknown, or bound to the wrong Alexa user/person, Andrea returns a concise barrier instead of a fake personal answer

## 3) Required Local Config

Minimum listener config:

```bash
ALEXA_SKILL_ID=amzn1.ask.skill.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
ALEXA_HOST=127.0.0.1
ALEXA_PORT=4300
ALEXA_PATH=/alexa
ALEXA_VERIFY_SIGNATURE=true
ALEXA_REQUIRE_ACCOUNT_LINKING=true
```

Recommended private-user allowlist:

```bash
ALEXA_ALLOWED_USER_IDS=amzn1.ask.account...,amzn1.ask.person...
```

OAuth config:

```bash
ALEXA_OAUTH_CLIENT_ID=andrea-alexa-poc-client
ALEXA_OAUTH_CLIENT_SECRET=replace-with-a-local-client-secret
ALEXA_OAUTH_SCOPE=andrea.alexa.link
ALEXA_OAUTH_ALLOWED_REDIRECT_URIS=https://layla.amazon.com/api/skill/link/<vendor-id>
ALEXA_PUBLIC_BASE_URL=https://your-current-public-host.example.com
ALEXA_LINKED_ACCOUNT_NAME=Andrea Alexa
ALEXA_LINKED_ACCOUNT_GROUP_FOLDER=main
ALEXA_LINKED_ACCOUNT_ALLOWED_USER_ID=amzn1.ask.account...
ALEXA_LINKED_ACCOUNT_ALLOWED_PERSON_ID=amzn1.ask.person...
```

The OAuth target `groupFolder` must already exist as a valid Andrea registered group.

## 4) Developer Console Wiring

In the Alexa Developer Console:

1. Create or open the custom skill.
2. Import the interaction model from:
   - `docs/alexa/interaction-model.en-US.json`
   - any utterance change in that file requires `Build Model`
3. Set `ALEXA_PUBLIC_BASE_URL` locally to your current public HTTPS base URL.
4. Set the HTTPS endpoint to:
   - `${ALEXA_PUBLIC_BASE_URL}/alexa`
5. If that public host is an `ngrok` `*.ngrok-free.dev` domain, choose:
   - `My development endpoint is a sub-domain of a domain that has a wildcard certificate from a certificate authority`
6. Configure account linking as **Authorization Code Grant**.
7. Use:
   - auth URI `${ALEXA_PUBLIC_BASE_URL}/alexa/oauth/authorize`
   - token URI `${ALEXA_PUBLIC_BASE_URL}/alexa/oauth/token`
   - client ID `andrea-alexa-poc-client`
   - client secret from local `ALEXA_OAUTH_CLIENT_SECRET`
   - scope `andrea.alexa.link`
   - client authentication `HTTP Basic`
8. Make sure the live skill/application ID matches local `ALEXA_SKILL_ID`.

If you see `SSL certificate verification failed` in the Alexa app for an `ngrok-free.dev` host, the usual cause is the Alexa console endpoint still being set to the standard trusted-certificate option instead of the wildcard-certificate option.

If voice launch works but known-good phrases like `what's still open with Candace` or `what should I remember tonight` still fall into generic fallback, the most likely cause is a stale live interaction model. Import the current repo JSON again and rebuild the model before debugging Andrea itself.

If those phrases still fall into fallback after a fresh rebuild:

- use the Alexa Developer Console Utterance Profiler or Intent History to capture the exact recognized phrase
- compare that phrasing with `docs/alexa/interaction-model.en-US.json`
- add the missing utterance variant, rebuild the model again, and retry live voice before treating it as a transport bug
- use `npm run debug:daily-companion` locally to compare Andrea's grounded local reply for the same canonical prompt against the live Alexa result

If any of those are missing, Alexa is **setup-blocked**, not broken.

## 5) Conversational Companion Behavior

Alexa replies are intentionally shorter than Telegram:

- one strong first sentence
- one or two short support lines
- one clarification at a time
- yes/no confirmations for reminder, save-for-later, and memory-consent flows

Andrea keeps a short-lived Alexa conversation context that is:

- Alexa-only
- linked-account scoped
- tied to the resolved Andrea `groupFolder`
- short-lived, roughly 10 minutes
- limited to the current subject, guidance goal, and allowed follow-ups

That enables bounded follow-ups like:

- `anything else`
- `what about Candace`
- `what about Travis`
- `what's next after that`
- `before that`
- `remind me before that`
- `make that shorter`
- `be a little more direct`
- `be a little warmer`
- `keep it plain`
- `go back to balanced`
- `say more`
- `why`
- `remember that`
- `don't bring that up automatically`
- `what should I do about that`
- `should I be worried about anything`
- `save that for later`
- `send me the details`
- `send the full version to Telegram`
- `save that in my library`
- `track that under Candace`
- `turn that into a reminder`

If context is weak or expired, Andrea falls back honestly with one short clarification.

## 5C) Cross-Channel Handoffs

Alexa can now start a conversation and hand the richer continuation to Telegram when the user asks for it explicitly.

Current v1 truth:

- handoffs are Alexa-to-Telegram only
- the delivery target is the registered main Telegram chat for the linked Andrea group
- no hidden push behavior was added
- if no Telegram main chat exists for the linked account, Andrea says so plainly

Typical voice phrasing:

- `Want the fuller version in Telegram?`
- `I can send the details to Telegram.`
- `I can save that for tonight if you want.`

Current action-completion phrases:

- `send me the details`
- `also send it to Telegram`
- `send me the full comparison`
- `give me the deeper comparison in Telegram`
- `save that for later`
- `remember that for later`
- `save that in my library`
- `track that under Candace`
- `keep track of that for tonight`
- `draft that for me`
- `draft a message about that`
- `turn that into a reminder`

The richer continuation stays on Telegram.
Alexa remains the orientation and summary surface.

The important closeout change is that `save for later` and `draft follow-up` no longer rely only on older Alexa-specific capture flows. When Alexa already has usable continuation context, those phrases now go through the same shared action-completion layer as `send details`, `save to library`, `track thread`, and `create reminder`.

## 5A) Research In Alexa

Alexa can now route bounded research asks into the shared Andrea research orchestrator.

Current supported shape:

- short spoken summary first
- optional Telegram handoff when a comparison or synthesis is too long for voice
- local personal context can be included when the request is about your own schedule, reminders, threads, or household context
- optional OpenAI-backed synthesis is only used when concrete OpenAI credentials are configured locally

Examples that should now map cleanly:

- `research meal delivery options for this week`
- `compare these options`
- `summarize what matters`
- `what's the best choice and why`

Important limits:

- Alexa is not a general long-form research reading surface
- runtime-heavy or operator-like research requests still belong on the runtime/Telegram side
- no hidden provider capability is assumed beyond what the repo actually configures

## 5B) Andrea Pulse And Bounded Personality

Alexa now has a very small personality layer, but it is intentionally restrained.

What changed:

- low-stakes daily and household replies can include one smoother transition or lightly warm line
- not every turn gets texture
- safety, trust, permission, fallback, and urgent reminder paths stay plain

Andrea Pulse is the explicit light-fun surface:

- `Andrea Pulse`
- `tell me something interesting`
- `give me a weird fact`
- `surprise me`
- `one little thing to know today`

Current truth:

- Pulse is request-only in this pass
- it uses a local curated catalog
- `say more` stays on the same item
- `anything else` can move to another one
- it does not replace `/ping`

For operator-side conversation tuning, use:

- `npm run debug:alexa-conversation` for a repo-side multi-turn Alexa walkthrough that does not advance live proof
- `npm run debug:alexa-conversation -- --review` for grouped utterance misses, including no-context references, follow-up binding failures, should-have-routed communication/planning asks, weak clarifiers, and carrier-phrase gaps from recent Alexa pilot events
- `npm run debug:daily-companion` for grounded local comparison against real `groupFolder=main` data
- `npm run debug:shared-capabilities` for a shared Telegram/Alexa capability and research smoke pass
- `npm run debug:pilot` for the higher-level proof surface plus the Alexa utterance-review summary

## 6) Daily Guidance And Household Context

Alexa Companion Mode is built to answer practical daily-life questions, not just isolated commands.

High-value guidance flows:

- morning brief
- what should I know about today
- what matters most today
- what am I forgetting
- anything important
- what is next
- evening reset
- what does the family have going on
- what do Candace and I have coming up

Household context remains bounded and explainable:

- immediate family phrasing can be used from the current turn
- persistent family or relationship facts require consent
- Andrea can use remembered people like Candace or Travis without turning Alexa into a freeform family-memory bot

## 7) Personalization And Control

Andrea supports structured, inspectable personalization across Alexa and Telegram.

What Andrea may remember after consent:

- people
- relationships
- preferences
- routines
- household context
- conversational style
- recurring priorities

Important limits:

- Alexa does not silently create hidden long-term memory
- proposed memories only become active after explicit consent or a direct command like `remember this`
- only accepted facts are reused later
- rejected or disabled facts are not treated as active preferences

Supported control questions include:

- `remember this`
- `forget that`
- `what do you remember about me`
- `what do you remember about Candace`
- `why did you say that`
- `what are you using to personalize this`
- `be more direct`
- `be a little warmer`
- `keep it plain`
- `go back to balanced`
- `be less personal`
- `use less family context`
- `reset my preferences`

Alexa answers these briefly. Telegram can return a richer structured summary.

## 8) Final Acceptance Order

When the environment is configured, use this order:

1. verify the host is on Node `22.22.2`
2. confirm `/alexa-status`
3. confirm local `GET /alexa/oauth/health`
4. confirm public `GET /alexa/oauth/health`
   - if the host is an `ngrok` `*.ngrok-free.dev` tunnel, use the `ngrok-skip-browser-warning: 1` header for browser-style checks
5. confirm the live skill endpoint and account-link settings in the Alexa console
   - if the endpoint host is `*.ngrok-free.dev`, confirm the SSL certificate type is set to the wildcard-certificate option
6. confirm the OAuth-issued token resolves to the intended Andrea group
7. use an authoritative proof surface
   - preferred phrase: `Alexa, open Andrea Assistant skill`
   - then ask one thread-aware follow-up such as `What's still open with Candace?`
   - confirm `npm run services:status` shows `alexa_last_signed_request_type=IntentRequest`
7. test one unlinked-safe request
8. test one linked personal request
9. test one linked follow-up such as `anything else`
10. test one household-aware follow-up such as `what about Candace`
11. test one action handoff such as `remind me before that`
12. optionally test one preference or explainability turn
13. optionally test one cross-channel follow-up such as `send me the details`

If you need one sentence for the current state, use this:

- Alexa Companion Mode is status-led on this host: operator surfaces should show `live_proven` only while a fresh handled Andrea custom-skill proof remains inside the 24-hour proof window, and otherwise should show `near_live_only`.

## 9) Incident Notes

For incidents, use:

- `/alexa-status`
- `npm run setup -- --step verify`
- `logs/nanoclaw.log`

Alexa is additive. Telegram remains the primary operator control surface and the safer default front door.
