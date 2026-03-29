# Andrea Alexa Voice Integration

Andrea can now speak through Alexa as a proper voice ingress instead of a second public bot persona.
Telegram is still the main text front door.
Alexa is just another way to talk to the same assistant.

That means:

- the user hears Andrea
- Andrea stays the final voice
- OpenClaw stays internal
- shopping and approvals stay guarded
- nobody has to learn a weird two-bot dance at 7 a.m. before coffee

## What This Integration Actually Does

This repo now includes:

- a custom Alexa skill web-service endpoint
- official ASK request verification support
- optional Alexa user/person allowlisting
- optional account-link enforcement
- a bridge into Andrea's existing routing and container helper path
- speech cleanup so internal tags, markdown, and raw links do not spill into Alexa's voice output

## Architecture In One Breath

The shape is:

1. Alexa sends a signed request to the Andrea host
2. Andrea verifies the request
3. Andrea authorizes the Alexa user according to env config
4. Andrea converts the utterance into a normal assistant turn
5. Andrea uses the same routing and helper boundary already used elsewhere
6. Andrea formats the final voice response
7. Alexa speaks it back

No public bot-to-bot choreography.
No "please ask the other assistant."
No leaked internal helper chatter.

## Files Added For This

- `src/alexa.ts`
- `src/alexa-bridge.ts`
- `docs/alexa/interaction-model.en-US.json`

## Recommended First Setup

### 1) Set the env values

At minimum:

```bash
ALEXA_SKILL_ID=amzn1.ask.skill.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

Recommended for a private first rollout:

```bash
ALEXA_HOST=127.0.0.1
ALEXA_PORT=4300
ALEXA_PATH=/alexa
ALEXA_VERIFY_SIGNATURE=true
ALEXA_ALLOWED_USER_IDS=amzn1.ask.account.your-user-id
ALEXA_TARGET_GROUP_FOLDER=main
```

Notes:

- `ALEXA_VERIFY_SIGNATURE=true` should stay on outside local experiments.
- `ALEXA_ALLOWED_USER_IDS` is the easiest guardrail when the skill is still personal/private.
- `ALEXA_TARGET_GROUP_FOLDER=main` makes Alexa share the same core Andrea context as your Telegram main chat.
- If `ALEXA_TARGET_GROUP_FOLDER` is omitted, Andrea uses `main` when available and otherwise creates an isolated Alexa voice workspace.

### 2) Create a custom Alexa skill

In the Alexa developer console:

1. Create a new custom skill.
2. Use your preferred display name.
3. Set the invocation name to something natural like `andrea assistant`.
4. Import the interaction model from:
   - [docs/alexa/interaction-model.en-US.json](./alexa/interaction-model.en-US.json)

### 3) Point Alexa at the Andrea endpoint

Alexa requires HTTPS for hosted skill endpoints.
That means the local Andrea server usually sits behind one of these:

- a reverse proxy on a public host
- a secure tunnel such as Cloudflare Tunnel or ngrok
- your own HTTPS edge / ingress

The runtime listens on:

- `http://<ALEXA_HOST>:<ALEXA_PORT><ALEXA_PATH>`

Default local example:

- `http://127.0.0.1:4300/alexa`

Typical public endpoint example after a tunnel:

- `https://voice.example.com/alexa`

### 4) Test the local runtime first

From Telegram:

```text
/alexa_status
```

That shows:

- whether Alexa is configured
- whether the listener started
- whether signature verification is on
- whether account linking is required
- whether a target group folder is pinned

### 5) Test inside the Alexa console

Try:

- "open Andrea assistant"
- "ask Andrea assistant to research the best standing desks for small apartments"
- "ask Andrea assistant to remind me tomorrow at 9 a.m. to call Sam"
- "ask Andrea assistant to look for a good keyboard before I buy anything"

Andrea should answer conversationally.

## Security Settings That Matter

### Request verification

Keep this on:

```bash
ALEXA_VERIFY_SIGNATURE=true
```

That validates Alexa-signed requests before Andrea processes them.

### User allowlist

Recommended for personal/private use:

```bash
ALEXA_ALLOWED_USER_IDS=amzn1.ask.account...,amzn1.ask.person...
```

If this is set, only matching Alexa identities are accepted.

### Account linking

Optional:

```bash
ALEXA_REQUIRE_ACCOUNT_LINKING=true
```

This makes Andrea require a linked account before handling requests.

Current practical note:

- account-link presence is useful UX and policy enforcement
- the simplest strong access control for personal rollout is still `ALEXA_ALLOWED_USER_IDS`

## Shared Context Versus Isolated Voice Context

You have two good modes:

### Shared main context

Use:

```bash
ALEXA_TARGET_GROUP_FOLDER=main
```

Best when:

- Alexa is for your personal Andrea
- you want reminders, shopping, and follow-up context to line up with Telegram
- you want one assistant brain and zero "which assistant knows this?" drama

### Isolated Alexa workspace

Leave `ALEXA_TARGET_GROUP_FOLDER` unset and omit a registered `main` group.

Best when:

- you want voice experiments without touching main context
- you are prototyping before tying Alexa into your real daily workflow

## Shopping And Research Through Voice

Andrea can absolutely help research products over Alexa.

Practical pattern:

1. ask Andrea to compare or narrow options
2. ask Andrea to search Amazon Business if shopping is configured
3. keep actual purchase approval in the explicit approval flow

Important boundary:

- this repo does not assume an OpenAI-native checkout API
- OpenAI-backed models can help with research and recommendation
- actual order execution in this repo stays on the guarded Amazon Business flow

Andrea is happy to help choose the keyboard.
Andrea is still not allowed to become a surprise procurement goblin.

## Example Utterances

- "Ask Andrea assistant to research the best humidifiers for a bedroom."
- "Ask Andrea assistant to remind me tomorrow at 8 a.m. to stretch."
- "Ask Andrea assistant to compare Outlook and Apple Calendar for a family."
- "Ask Andrea assistant to look for a standing desk on Amazon before I buy one."
- "Ask Andrea assistant to summarize what I should focus on today."

## Troubleshooting

### Alexa says the endpoint failed

Check:

- `/alexa_status`
- the tunnel / HTTPS endpoint
- `ALEXA_SKILL_ID`
- `ALEXA_VERIFY_SIGNATURE`

### Alexa says Andrea is not authorized

Check:

- `ALEXA_ALLOWED_USER_IDS`
- whether the request came from the Alexa user/profile you expect

### Alexa asks for account linking

Check:

- `ALEXA_REQUIRE_ACCOUNT_LINKING`
- whether the skill account is linked in the Alexa app

### Andrea answers oddly or reads links like a robot lawyer

That should be much better now because the voice layer strips:

- internal tags
- markdown
- raw URLs

If a response still sounds clunky, improve the prompt or shorten the request.

## Test Coverage Added

This integration now has tests for:

- config parsing
- speech normalization
- allowlist behavior
- account-link prompts
- bridge invocation
- failure sanitization
- live local HTTP request handling with signature verification disabled for test mode

## Research Sources Used

Official sources:

- Alexa Skills Kit docs for hosting a custom skill as a web service
- Alexa request-signature verification guidance
- Alexa account-linking guidance
- ASK SDK for Node.js

Example repos and SDK references reviewed:

- `alexa-samples/skill-sample-nodejs-fact`
- `alexa/alexa-skills-kit-sdk-for-nodejs`

## Recommended Next Step

After your endpoint is live behind HTTPS:

1. import the interaction model
2. wire the endpoint in the Alexa console
3. test with a private skill first
4. keep `ALEXA_ALLOWED_USER_IDS` on
5. use `/alexa_status` before blaming the nearest Echo
