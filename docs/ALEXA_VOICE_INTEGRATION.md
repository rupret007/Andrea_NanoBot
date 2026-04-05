# Andrea Alexa Voice Integration

Alexa is a bounded channel for Andrea, not a second assistant and not a public control plane.

Andrea now uses an internal **Alexa Companion Mode**:

- shorter, warmer, spoken-first replies
- one main thing first
- one or two short supporting lines
- shared assistant capabilities for daily guidance, household questions, memory controls, explicit thread lookup, and bounded research
- measured guidance for open-ended daily questions
- short-lived conversational continuity
- calmer, more natural recovery when phrasing is imperfect
- thread-aware continuity for active household, relationship, and follow-up topics
- household-aware follow-ups when context is strong
- explicit, consent-based personalization only

Telegram remains the primary operator surface. Alexa reuses the same trust boundaries, schedule intelligence, reminders, drafting, and follow-through logic.

## 0A) Shared Capability Routing

Alexa now sits on top of the same Andrea assistant capability graph used by Telegram where that is safe.

In practice, that means:

- explicit Alexa intents still exist where the interaction model needs them
- those intents now map into shared Andrea capabilities first whenever possible
- `ConversationalFollowupIntent` and `AnythingElseIntent` first try shared capability continuation before broader fallback paths
- Alexa keeps voice-first shaping at the edge instead of letting internal capability labels leak into spoken output

Examples of shared actions now routed this way:

- `What am I forgetting?`
- `What about Candace?`
- `What's still open with Candace?`
- `What should I remember tonight?`
- `Why did you say that?`
- bounded research turns like `Compare meal delivery options for this week`

The shared capability graph does **not** make Alexa and Telegram identical.

- Alexa stays short, bounded, and voice-safe
- Telegram stays richer and more explicit
- operator-only current-work controls remain blocked on Alexa even though they are present in the same registry

## 0) Current Truth

Treat Alexa as:

- **live-ready** only when the live skill, HTTPS ingress, account linking, and linked Andrea group are all configured and current
- **code-ready but setup-blocked** when repo-side validation is green but one or more external Alexa steps are still missing

Current accepted live proof on the operator host is strong:

- Andrea runs under Node `22.22.2`
- the local Alexa listener can run even when no Telegram channel is connected
- `groupFolder=main` is valid
- local Alexa health responds on `/alexa/health`
- local OAuth health responds on `/alexa/oauth/health`
- live HTTPS ingress must still be current, reachable, and correctly wired in the Alexa Developer Console
- if the live HTTPS host is an `ngrok` `*.ngrok-free.dev` tunnel, the Alexa endpoint SSL type must be set to the wildcard certificate option
- issued access tokens resolve to `groupFolder=main`
- one real signed Alexa voice conversation is accepted on the current host
- the accepted live flow was:
  - `Open Andrea Assistant`
  - `What am I forgetting?`
  - `Anything else?`
  - `What about Candace?`
  - `Be a little more direct.`
  - optional `What should I remember tonight?`
- those accepted live turns resolved to `groupFolder=main` and stayed on `responseSource=local_companion`

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

The interaction model keeps the Alexa surface intentionally bounded:

- `MyDayIntent`
- `UpcomingSoonIntent`
- `WhatNextIntent`
- `BeforeNextMeetingIntent`
- `WhatMattersMostTodayIntent`
- `AnythingImportantIntent`
- `WhatAmIForgettingIntent`
- `TomorrowCalendarIntent`
- `EveningResetIntent`
- `CandaceUpcomingIntent`
- `FamilyUpcomingIntent`
- `AnythingElseIntent`
- `ConversationalFollowupIntent`
- `MemoryControlIntent`
- `RemindBeforeNextMeetingIntent`
- `SaveForLaterIntent`
- `DraftFollowUpIntent`

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
- `say more`
- `why`
- `remember that`
- `don't bring that up automatically`
- `what should I do about that`
- `should I be worried about anything`
- `save that for later`

If context is weak or expired, Andrea falls back honestly with one short clarification.

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

For operator-side conversation tuning, use:

- `npm run debug:alexa-conversation` for a near-live multi-turn Alexa walkthrough
- `npm run debug:daily-companion` for grounded local comparison against real `groupFolder=main` data
- `npm run debug:shared-capabilities` for a shared Telegram/Alexa capability and research smoke pass

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

If you need one sentence for the current state, use this:

- Alexa Companion Mode is repo-ready and near-live validated; the only remaining full-live step is one real signed Alexa utterance unless that has already been re-proven on the current host.

## 9) Incident Notes

For incidents, use:

- `/alexa-status`
- `npm run setup -- --step verify`
- `logs/nanoclaw.log`

Alexa is additive. Telegram remains the primary operator control surface and the safer default front door.
