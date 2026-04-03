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

## 0) Current Closeout Status

Alexa v1 is code-complete in this repo, but live acceptance is still environment-dependent.

Treat the channel as:

- **live-ready** only when the Alexa skill, HTTPS ingress, account linking, linked token seed, and target `groupFolder` are all configured
- **code-ready but setup-blocked** when the code/tests are green but those external prerequisites are still missing

Important validation note:

- use **Node 22.x** for Alexa validation on this repo
- unsupported host runtimes such as Node 24 can fail DB-backed Alexa tests with native-module ABI errors that are not Alexa feature failures

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

Local linked-account seed for v1:

```bash
ALEXA_LINKED_ACCOUNT_TOKEN=replace-with-your-linked-access-token
ALEXA_LINKED_ACCOUNT_NAME=Andrea Alexa
ALEXA_LINKED_ACCOUNT_GROUP_FOLDER=main
ALEXA_LINKED_ACCOUNT_ALLOWED_USER_ID=amzn1.ask.account...
ALEXA_LINKED_ACCOUNT_ALLOWED_PERSON_ID=amzn1.ask.person...
```

Andrea seeds that linked-account mapping into the local DB on startup. Personal Alexa intents then bind directly to that `groupFolder`.

Before you treat Alexa as live-ready, also confirm:

1. the linked `groupFolder` already exists as a valid Andrea registered group
2. the Alexa console account-linking flow returns the same access token you seeded locally
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

This repo now supports a private/dev-safe linked-account path, but a real production Alexa rollout still needs:

- HTTPS ingress with stable hostname
- Alexa custom skill setup in the console
- real account-linking configuration in the Alexa console
- a real OAuth/token issuer for linked access tokens
- a real way to mint, refresh, and revoke those tokens outside the static local seed

Until that exists, the local linked-account seed is appropriate for private development and operator validation only.

## 6) Live Acceptance Prerequisites

Do not claim a real Alexa pass until all of these are true:

1. `ALEXA_SKILL_ID` is set locally
2. the Alexa listener is enabled and reachable on the configured host/path
3. an HTTPS tunnel or reverse proxy forwards the public Alexa endpoint to the local listener
4. the Alexa Developer Console skill uses the same skill ID and endpoint
5. account linking is configured in the Alexa console
6. a local linked-account seed exists:
   - `ALEXA_LINKED_ACCOUNT_TOKEN`
   - `ALEXA_LINKED_ACCOUNT_GROUP_FOLDER`
7. the seeded `groupFolder` is already registered in Andrea

If any of those are missing, Alexa is **setup-blocked**, not broken.

## 7) Voice Behavior

Alexa responses are intentionally shorter than Telegram:

- one short first sentence
- at most one or two short supporting statements
- one clarification at a time
- yes/no confirmations for reminder and save-for-later flows

Alexa clarification state is stored separately from Telegram/operator state in a short-lived local `alexa_sessions` table.

## 8) Final Live Acceptance Order

When the prerequisites are in place, run the final pass in this order:

1. verify the local runtime on Node 22
2. confirm `/alexa_status` shows the ingress is enabled and listening
3. confirm the public HTTPS endpoint reaches the local Alexa listener
4. confirm the linked-access token used by account linking matches the locally seeded hash
5. confirm the seeded `groupFolder` is a valid Andrea group
6. test unlinked behavior:
   - launch
   - help
   - one personal-data intent that should return a link-account style response
7. test linked behavior:
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
- missing or unknown linked access token
- wrong Alexa user/person ID for the seeded linked account
- linked `groupFolder` not present in Andrea

If the machine has no `ALEXA_*` env, no `.env`, or no Alexa console/tunnel setup, stop here and record the blocker as **code-ready but setup-blocked**.
