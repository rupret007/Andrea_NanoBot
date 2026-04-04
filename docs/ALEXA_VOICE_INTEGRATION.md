# Andrea Alexa Voice Integration

Alexa is a bounded channel for Andrea, not a second assistant and not a public control plane.

Andrea now uses an internal **Alexa Companion Mode**:

- shorter, warmer, spoken-first replies
- one main thing first
- one or two short supporting lines
- measured guidance for open-ended daily questions
- short-lived conversational continuity
- household-aware follow-ups when context is strong
- explicit, consent-based personalization only

Telegram remains the primary operator surface. Alexa reuses the same trust boundaries, schedule intelligence, reminders, drafting, and follow-through logic.

## 0) Current Truth

Treat Alexa as:

- **live-ready** only when the live skill, HTTPS ingress, account linking, and linked Andrea group are all configured and current
- **code-ready but setup-blocked** when repo-side validation is green but one or more external Alexa steps are still missing

Current repo-side and near-live proof on the operator host is strong:

- Andrea runs under Node `22.22.2`
- the local Alexa listener can run even when no Telegram channel is connected
- `groupFolder=main` is valid
- `ngrok` forwards `https://patronymically-nonremedial-london.ngrok-free.dev` to `http://localhost:4300`
- local and public OAuth health respond on `/alexa/oauth/health`
- the live authorization-code flow succeeds against the public ngrok URL
- issued access tokens resolve to `groupFolder=main`
- near-live conversational proof through the built skill handler and a real linked token is green

If you have not re-proven it on the current host today, the one remaining external live step is:

- one real signed Alexa utterance from the app, a device, or an authenticated simulator session

Important validation note:

- use **Node 22.22.2** for Alexa validation on this repo
- do not rely on host Node 24 for truthful Alexa checks

## 1) Alexa Surface

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
- broad freeform chat
- operator-shell commands
- hidden long-term memory
- multi-user household routing

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
3. Set the HTTPS endpoint to:
   - `https://patronymically-nonremedial-london.ngrok-free.dev/alexa`
4. Configure account linking as **Authorization Code Grant**.
5. Use:
   - auth URI `https://patronymically-nonremedial-london.ngrok-free.dev/alexa/oauth/authorize`
   - token URI `https://patronymically-nonremedial-london.ngrok-free.dev/alexa/oauth/token`
   - client ID `andrea-alexa-poc-client`
   - client secret from local `ALEXA_OAUTH_CLIENT_SECRET`
   - scope `andrea.alexa.link`
   - client authentication `HTTP Basic`
6. Make sure the live skill/application ID matches local `ALEXA_SKILL_ID`.

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
- `say more`
- `what should I do about that`
- `should I be worried about anything`
- `save that for later`

If context is weak or expired, Andrea falls back honestly with one short clarification.

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
5. confirm the live skill endpoint and account-link settings in the Alexa console
6. confirm the OAuth-issued token resolves to the intended Andrea group
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
