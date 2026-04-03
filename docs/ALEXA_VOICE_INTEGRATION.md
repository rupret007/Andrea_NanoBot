# Andrea Alexa Voice Integration

Alexa is a bounded channel for Andrea, not a second assistant and not a public control plane.

V1 keeps the scope intentionally small:

- account-linked personal assistant access
- short spoken summaries
- calendar and meeting-aware questions
- reminder-before-next-meeting
- save-for-later capture
- short follow-up drafting

Telegram remains the primary operator surface. Alexa reuses Andrea's existing routing, schedule intelligence, reminders, and follow-through logic.

## 1) Alexa V1 Surface

The Alexa interaction model now exposes a narrow intent set:

- `MyDayIntent`
- `UpcomingSoonIntent`
- `WhatNextIntent`
- `BeforeNextMeetingIntent`
- `TomorrowCalendarIntent`
- `CandaceUpcomingIntent`
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

Local linked-account seed for v1:

```bash
ALEXA_LINKED_ACCOUNT_TOKEN=replace-with-your-linked-access-token
ALEXA_LINKED_ACCOUNT_NAME=Andrea Alexa
ALEXA_LINKED_ACCOUNT_GROUP_FOLDER=main
ALEXA_LINKED_ACCOUNT_ALLOWED_USER_ID=amzn1.ask.account...
ALEXA_LINKED_ACCOUNT_ALLOWED_PERSON_ID=amzn1.ask.person...
```

Andrea seeds that linked-account mapping into the local DB on startup. Personal Alexa intents then bind directly to that `groupFolder`.

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

This repo now supports a private/dev-safe linked-account path, but a real production Alexa rollout still needs:

- HTTPS ingress with stable hostname
- Alexa custom skill setup in the console
- real account-linking configuration in the Alexa console
- a real OAuth/token issuer for linked access tokens
- a real way to mint, refresh, and revoke those tokens outside the static local seed

Until that exists, the local linked-account seed is appropriate for private development and operator validation only.

## 6) Voice Behavior

Alexa responses are intentionally shorter than Telegram:

- one short first sentence
- at most one or two short supporting statements
- one clarification at a time
- yes/no confirmations for reminder and save-for-later flows

Alexa clarification state is stored separately from Telegram/operator state in a short-lived local `alexa_sessions` table.

## 7) Live Testing Checklist

When you are ready for a near-live or live Alexa pass, verify:

1. `/alexa_status` shows the ingress is enabled and listening.
2. The Alexa skill points at the correct HTTPS endpoint.
3. The linked-access token used by account linking matches the locally seeded hash.
4. The seeded `groupFolder` is already a valid Andrea registered group.
5. The skill can answer:
   - my day
   - what is next
   - what is on my calendar tomorrow
   - remind me before my next meeting
   - save that for later
   - draft a follow-up

If the skill is reachable but personal answers fail, check these first:

- skill ID mismatch
- signature verification failure
- missing or unknown linked access token
- wrong Alexa user/person ID for the seeded linked account
- linked `groupFolder` not present in Andrea
