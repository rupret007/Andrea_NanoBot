# Andrea Alexa Voice Integration

Alexa is a bounded channel for Andrea, not a second assistant and not a public control plane.

V1 keeps the scope intentionally small:

- account-linked personal assistant access
- short spoken summaries
- daily-life guidance and prioritization
- calendar and meeting-aware questions
- family and household-aware questions
- reminder-before-next-meeting
- save-for-later capture
- short follow-up drafting
- short-lived conversational follow-ups
- explicit, consent-based personalization controls

Telegram remains the primary operator surface. Alexa reuses Andrea's existing routing, schedule intelligence, reminders, and follow-through logic.

## 0) Current Closeout Status

Alexa v1 is code-complete in this repo, but live acceptance is still environment-dependent.

Treat the channel as:

- **live-ready** only when the Alexa skill, HTTPS ingress, account linking, linked token seed, and target `groupFolder` are all configured
- **code-ready but setup-blocked** when the code/tests are green but those external prerequisites are still missing

Current operator-host closeout result on this machine:

- the local Alexa listener can run under Node 22 even when no Telegram channel is connected
- the linked target `groupFolder` is already valid (`main`)
- `ngrok` is forwarding `https://patronymically-nonremedial-london.ngrok-free.dev` to `http://localhost:4300`
- local `http://127.0.0.1:4300/alexa/health` responds successfully
- public `https://patronymically-nonremedial-london.ngrok-free.dev/alexa/health` responds successfully when the ngrok browser-warning header is supplied during manual checks
- local and public OAuth health now respond on `/alexa/oauth/health`
- a real authorization-code flow now works against the ngrok URL and mints access tokens that resolve to `groupFolder=main`
- the next exact blocker is Alexa Developer Console account-link configuration plus the real `ALEXA_SKILL_ID`

Important validation note:

- use **Node 22.x** for Alexa validation on this repo
- unsupported host runtimes such as Node 24 can fail DB-backed Alexa tests with native-module ABI errors that are not Alexa feature failures

## 1) Alexa V1 Surface

The Alexa interaction model now exposes a narrow intent set:

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

Standard Alexa intents remain:

- `LaunchRequest`
- `AMAZON.HelpIntent`
- `AMAZON.YesIntent`
- `AMAZON.NoIntent`
- `AMAZON.CancelIntent`
- `AMAZON.StopIntent`
- `AMAZON.FallbackIntent`

Out of scope for this pass:

- smart-home control
- broad freeform assistant access
- operator-shell commands
- dashboard concepts
- rich multi-user household routing
- hidden or automatic long-term memory

## 2) Trust And Account Linking

Andrea only answers personal Alexa intents when the request is linked to a local Andrea context.

The Alexa boundary now enforces:

- ASK request signature + timestamp verification when enabled
- configured Alexa skill/application ID matching
- optional coarse Alexa user/person allowlist
- required linked-account lookup for personal data intents

V1 linked-account lookup is intentionally local and dev-safe:

- Andrea stores a tiny `alexa_linked_accounts` table
- the incoming Alexa access token is hashed
- the hash maps to one configured `groupFolder`
- optional stored Alexa user/person IDs can further lock that mapping down

This is enough for private local use. It is not a full OAuth platform.

Linked versus unlinked behavior is intentionally strict:

- unlinked requests may use `LaunchRequest`, help, and fallback safely
- personal intents do **not** return calendar, reminder, or follow-through data unless the linked account resolves cleanly
- if the token is missing, unknown, or bound to the wrong Alexa user/person, Andrea returns a concise link-account or forbidden response instead of a fake personal answer

## 3) Local / Dev Setup

Minimum Alexa ingress:

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

Local OAuth issuer config for v1:

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

Andrea issues real authorization codes and access tokens from the local OAuth endpoints. Issued access tokens are hashed into `alexa_linked_accounts`, and personal Alexa intents then bind directly to that `groupFolder`.

Before you treat Alexa as live-ready, also confirm:

1. the linked `groupFolder` already exists as a valid Andrea registered group
2. the Alexa console Authorization Code Grant flow exchanges against Andrea's OAuth endpoints successfully
3. the machine running Andrea is actually using Node 22 for validation and service startup

## 4) Interaction Model And Endpoint

In the Alexa Developer Console:

1. Create a **Custom** skill.
2. Set the invocation name, for example `andrea assistant`.
3. Import the interaction model from:
   - `docs/alexa/interaction-model.en-US.json`
4. Configure the endpoint to your HTTPS Alexa ingress URL.
5. Use the same skill ID in `ALEXA_SKILL_ID`.

Alexa still requires HTTPS at the console boundary. Common local/private options:

- reverse proxy on your own host
- Cloudflare Tunnel
- ngrok

The local Andrea listener can stay loopback-only:

- `http://127.0.0.1:4300/alexa`

## 5) Production Prerequisites

This repo now supports a private/dev-safe authorization-code OAuth path, but a real production Alexa rollout still needs:

- HTTPS ingress with stable hostname
- Alexa custom skill setup in the console
- real account-linking configuration in the Alexa console
- a real OAuth/token issuer for linked access tokens
- a real way to mint, refresh, and revoke those tokens outside the static local seed

Until that exists, the local Andrea OAuth issuer is appropriate for private development and operator validation only.

## 6) Live Acceptance Prerequisites

Do not claim a real Alexa pass until all of these are true:

1. `ALEXA_SKILL_ID` is set locally
2. the Alexa listener is enabled and reachable on the configured host/path
3. an HTTPS tunnel or reverse proxy forwards the public Alexa endpoint to the local listener
4. the Alexa Developer Console skill uses the same skill ID and endpoint
5. the Alexa Developer Console account-linking screen uses:
   - Authorization Code Grant
   - auth URI `https://patronymically-nonremedial-london.ngrok-free.dev/alexa/oauth/authorize`
   - token URI `https://patronymically-nonremedial-london.ngrok-free.dev/alexa/oauth/token`
   - client ID from `ALEXA_OAUTH_CLIENT_ID`
   - client secret from `ALEXA_OAUTH_CLIENT_SECRET`
   - scope `andrea.alexa.link`
   - client authentication `HTTP Basic`
6. the OAuth-linked `groupFolder` is already registered in Andrea

If any of those are missing, Alexa is **setup-blocked**, not broken.

On the current operator host, the first concrete blocker is:

1. open the Alexa Developer Console for the real custom skill
2. set the skill endpoint to `https://patronymically-nonremedial-london.ngrok-free.dev/alexa`
3. set account linking to Authorization Code Grant using the Andrea OAuth endpoints above
4. copy the real Alexa skill/application ID into local `ALEXA_SKILL_ID`
5. rebuild or restart Andrea under Node 22 with that real skill ID

Until that succeeds, real Alexa requests will fail skill/application trust checks even though the listener and HTTPS tunnel are both alive.

## 7) Conversational Alexa Behavior

Alexa responses are intentionally shorter than Telegram:

- one short first sentence
- at most one or two short supporting statements
- one clarification at a time
- yes/no confirmations for reminder and save-for-later flows

Alexa now also keeps a short-lived conversational context that is separate from Telegram/operator state.

The conversational layer is intentionally bounded:

- Alexa-only
- linked-account scoped
- tied to the resolved Andrea `groupFolder`
- expires after about 10 minutes
- keeps only the current conversational subject plus allowed follow-up actions

That enables natural follow-ups like:

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

If the prior spoken context is too weak or already expired, Andrea falls back honestly with a short clarification instead of guessing.

The short yes/no capture flow for reminders, save-for-later, and memory consent stays in the existing short-lived `alexa_sessions` table. Conversational subject memory is stored separately so it does not collide with those confirmation flows.

Andrea now also uses an internal **Alexa Companion Mode**. This is not a second assistant. It is the Alexa-specific operating style for the same Andrea core:

- voice-first
- warm but concise
- one main thing first
- one or two supporting follow-through points
- measured guidance on open-ended questions
- family context when clearly relevant and allowed by the user's preferences

## 8) Progressive Personalization And Consent

Andrea now supports explicit, inspectable personalization across Alexa and Telegram.

What Andrea may remember after consent:

- people
- relationships
- preferences
- routines
- household context
- conversational style
- recurring priorities

Important limits:

- Andrea does **not** silently turn Alexa conversations into hidden memory
- proposed memories are only activated after an explicit `yes` or a direct command such as `remember this`
- only accepted facts are reused later
- rejected or disabled facts are not treated as active preferences
- Alexa can now also answer simple control questions like:
  - `why did you say that`
  - `what are you using to personalize this`
  - `what do you remember about me`
  - `what do you remember about Candace`
  - `be more direct`
  - `be less personal`
  - `use less family context`
  - `reset that preference`

Examples of supported control phrases:

- `remember this`
- `forget that`
- `what do you remember about me`
- `what do you remember about Candace`
- `stop using that`
- `be less personal`
- `be more direct`
- `use less family context`
- `reset my preferences`

Alexa answers these briefly. Telegram can return a richer structured summary because it has more room.

## 9) Family And Household Context

Andrea can now carry a little more family context when it is explicit or remembered with consent.

High-value examples:

- `Candace and I`
- `our family`
- `what do we have going on`
- `what should I remember for tonight`

Immediate turn context can still shape a single answer, but persistent family or relationship facts only become part of Andrea's profile after consent.

## 10) Final Live Acceptance Order

When the prerequisites are in place, run the final pass in this order:

1. verify the local runtime on Node 22
2. confirm `/alexa_status` shows the ingress is enabled and listening
3. start HTTPS ingress:
   - `ngrok http 4300`
4. confirm the public HTTPS endpoint reaches the local Alexa listener
   - manual health checks against ngrok may need the `ngrok-skip-browser-warning` header on the free plan
5. confirm the OAuth health endpoint:
   - local `http://127.0.0.1:4300/alexa/oauth/health`
   - public `https://patronymically-nonremedial-london.ngrok-free.dev/alexa/oauth/health`
6. configure the Alexa Developer Console skill endpoint, Authorization Code Grant settings, and local `ALEXA_SKILL_ID`
7. confirm the OAuth-issued access token resolves to the intended Andrea group
8. confirm the seeded `groupFolder` is a valid Andrea group
9. test unlinked behavior:
   - launch
   - help
   - one personal-data intent that should return a link-account style response
10. test linked behavior:
   - my day
   - what is next
   - what is on my calendar tomorrow
   - what Candace and I have coming up
   - remind me before my next meeting
   - save that for later
   - draft a follow-up

If the skill is reachable but personal answers fail, check these first:

- skill ID mismatch
- signature verification failure
- missing or unknown OAuth-issued access token
- wrong Alexa user/person ID for the seeded linked account
- linked `groupFolder` not present in Andrea

If the machine has no `ALEXA_*` env, no `.env`, or no Alexa console/tunnel setup, stop here and record the blocker as **code-ready but setup-blocked**.
