# Andrea Setup And Features Guide

This is the practical operator guide for Andrea_NanoBot.
Use it when you need to install, configure, verify, or operate Andrea on a real machine.

For the in-chat user journey and command reference, also see:

- [CHANNEL_COMMANDS_AND_ONBOARDING.md](CHANNEL_COMMANDS_AND_ONBOARDING.md)
- [USER_GUIDE.md](USER_GUIDE.md)
- [ADMIN_GUIDE.md](ADMIN_GUIDE.md)
- [TELEGRAM_OPERATOR_LIVE_TESTING.md](TELEGRAM_OPERATOR_LIVE_TESTING.md) for operator-only closed-loop Telegram testing from this machine

## Current Product Model

Keep this split in mind while reading the rest of the setup guide:

- Andrea is one public assistant identity
- Telegram is the main public front door
- the public-safe surface stays narrow and conversation-first
- Cursor Cloud is the current validated heavy-lift queued coding path
- desktop bridge is the operator-only session and terminal path on your own machine
- Andrea_NanoBot is the merged home for the shared shell and backend-lane registry
- the integrated `andrea_runtime` lane is secondary and conditional, but it now lives inside the same `/cursor` work cockpit rather than a separate product story
- Cursor-backed runtime routing is a separate optional diagnostic/runtime surface
- the shell increasingly presents one task model with lane-specific capabilities, while keeping Cursor as the stronger validated lane

## Signature Flows

The current productization target is not more primitives. It is a short list of journeys Andrea should feel exceptional at:

- Alexa daily orientation -> Telegram richer follow-through
- `What am I forgetting?` -> one open loop -> reminder, save, or tracking
- `What's still open with Candace?` -> draft reply -> save to thread or remind later
- `Help me plan tonight / this weekend` -> mission -> blocker -> confirmed action
- source-grounded research -> deeper answer -> save to library
- BlueBubbles message help -> summarize -> draft -> remind later -> optional Telegram escalation

The shared proof harness for those journeys is:

```bash
npm run debug:signature-flows
```

## Status Terms

Use these meanings consistently when reading `/cursor_status` and the setup docs:

- **configured** = the required environment variables are present
- **ready** = configured and validated enough for intended use now
- **conditional** = partially wired or environment-dependent; not the baseline promise
- **unavailable** = missing config, unreachable dependency, or unsupported on this machine

## What This Package Includes

- `nanoclaw` runtime and isolation model as the base.
- Container runtime abstraction across Docker, Podman, and Apple Container.
- Channel integration through skills (`/add-whatsapp`, `/add-telegram`, and others).
- OpenClaw community marketplace integration:
  - bundled discovery catalog
  - global cache
  - explicit per-chat enable/disable
- Anthropic-compatible model routing with OpenAI-key-backed gateway support.
- Optional operator-enabled integrations such as Amazon Business shopping and Alexa voice.
- A secondary integrated `andrea_runtime` lane for Codex/OpenAI execution truth, with a `Codex/OpenAI` view inside `/cursor`, a shared current-work model, and `/runtime-*` as the explicit fallback shell.
- A bounded life-thread layer for ongoing people, household, and follow-up continuity across Telegram and Alexa.
- A shared assistant capability graph so Telegram and Alexa can call the same daily, household, memory, thread, and research actions safely.
- A bounded Knowledge Library for explicit saved source material, source-grounded retrieval, and library-first research answers.
- A bounded communication-companion layer for explicit conversation summaries, reply drafting, and owed-reply guidance.
- A bounded chief-of-staff and decision layer for priorities, slip-risk reads, prep guidance, and explainable planning.
- A bounded missions layer for explicit multi-step plans that can reuse reminders, drafting, threads, research, and handoffs without becoming a second planner.
- A bounded rituals and follow-through layer for morning, midday, evening, and carryover guidance.
- A bounded Alexa-to-Telegram cross-channel handoff layer for richer continuations and voice-triggered action completion.
- A small bounded personality layer plus request-driven Andrea Pulse.
- A real bounded BlueBubbles companion channel for one linked personal messages thread.

For demo use, keep the default public surface smaller than the full operator feature set.
The safest baseline is Telegram + direct assistance + fast quick replies for simple asks + reminders/tasks + `/cursor_status` + clean startup/health checks.

## Life Threads And Daily Continuity

Andrea now has a compact **life thread** layer above reminders, calendar, current work, and accepted memory facts.

Use it for active ongoing matters such as:

- Candace or relationship follow-up
- family or household logistics
- band or community planning
- work carryover that is not the same thing as `Current Work`

Mental model:

- memory facts describe stable facts or preferences
- threads track open ongoing matters
- reminders are specific future nudges
- current work is the immediate execution focus
- the daily companion synthesizes all of them

Practical user prompts:

- `What threads do I have open?`
- `Save this under the family thread`
- `What am I forgetting?`
- `What's still open with Candace?`
- `Don't bring this up automatically`

Important limits:

- no proactive nagging in this pass
- explicit save/track phrasing creates or updates threads directly
- inferred thread suggestions stay confirmation-first
- sensitive topics are not silently persisted just because they were mentioned once

## Shared Capability Graph And Research Orchestrator

Andrea now uses a shared assistant capability graph above the channel edges.

Practical meaning:

- Telegram and Alexa can now reuse the same assistant action for daily guidance, household questions, explicit thread lookup, memory controls, and bounded research
- channel-specific shaping still happens at the edge
- operator-only current-work controls stay on Telegram/runtime paths even though they exist in the same registry

The shared capability registry records:

- what the action is
- what inputs it needs
- whether linking or confirmation is required
- whether it is safe for Alexa
- whether it is safe for Telegram
- whether it is safe for BlueBubbles
- whether it is operator-only
- what output shape each channel should prefer

The research orchestrator now sits behind the same shared assistant core.

Current provider order:

- `local_context`
  - life threads
  - reminders/tasks
  - accepted profile facts
  - optional calendar signal
- `knowledge_library`
  - explicit saved notes
  - approved text-like file imports
  - saved research results and summaries
- `openai_responses`
  - only when concrete OpenAI credentials are configured
  - used for bounded synthesis and optional web-backed comparative answers
  - route choice is now explicit and explainable in the result itself
- `runtime_delegate`
  - reserved for execution-heavy or operator-like requests that belong on the runtime lane

Current media truth:

- image generation, image editing, and video generation are now capability-gated
- Telegram now has a bounded outbound media-delivery primitive for shared capabilities
- `media.image_generate` is wired for Telegram when OpenAI credentials are configured and the provider account is usable
- Alexa keeps image generation at the request-and-deliver handoff layer
- `media.image_edit` and `media.video_generate` remain prepared-only
- if OpenAI is not configured, Andrea now reports the exact blocker honestly instead of pretending the provider is live

Research output shape now differs intentionally by channel:

- Telegram:
  - concise summary first
  - structured findings / tradeoffs
  - recommendation when appropriate
  - route explanation and next-step suggestions
- Alexa:
  - short spoken summary
  - one short recommendation or tradeoff line when useful
  - natural Telegram handoff when the fuller answer is too long for voice

Helpful operator smoke paths:

- `npm run debug:daily-companion`
- `npm run debug:chief-of-staff`
- `npm run debug:alexa-conversation`
- `npm run debug:shared-capabilities`
- `npm run debug:research-mode`
- `npm run debug:knowledge-library`
- `npm run debug:rituals`
- `npm run debug:cross-channel-handoffs`
- `npm run debug:missions`
- `npm run debug:signature-flows`

For the full architecture and the license-safe external patterns behind it, see [ASSISTANT_CAPABILITY_GRAPH.md](ASSISTANT_CAPABILITY_GRAPH.md).

## Chief-of-Staff Mode

Andrea now has a bounded chief-of-staff layer on top of the existing daily companion, life threads, reminders, communication companion, current work, and Knowledge Library.

Use it for:

- what matters most today
- what should I do next
- what is slipping
- what should I prepare before tonight
- what matters this week
- why are you prioritizing that

Keep the product model clear:

- chief-of-staff mode is synthesis, not storage
- life threads stay the ongoing-matters model
- communication threads stay the people and reply model
- reminders stay the concrete nudge model
- rituals stay the timing and surfacing model
- current work stays the execution-focus model

Alexa uses this layer as a short orientation surface.
Telegram uses it as the richer planning and decision surface.

See [CHIEF_OF_STAFF_MODE.md](CHIEF_OF_STAFF_MODE.md) for the focused model and limits.

## Missions And Multi-Step Execution

Andrea now has a bounded `missions.*` layer for turning an explicit goal into a stored plan that can move forward across existing systems.

Use it for:

- `help me plan Friday dinner with Candace`
- `turn this into a plan`
- `help me prepare for tonight`
- `what's the blocker`
- `save this plan`
- `pause that plan`

Keep the product model clear:

- missions are plan storage and step synthesis, not a full task manager
- chief-of-staff still answers what matters and why
- life threads still hold ongoing matters
- reminders stay the concrete nudge system
- durable supporting actions still require explicit approval

Alexa uses missions for short orientation and handoff.
Telegram is the richer mission surface.

See [MISSIONS_AND_EXECUTION.md](MISSIONS_AND_EXECUTION.md) for the model, execution rules, and limits.

## Proactive Rituals And Follow-Through

Andrea now has a bounded rituals layer above daily companion, reminders, life threads, knowledge library, and personalization.

Key product truth:

- rituals define assistant timing and surfacing behavior
- life threads remain the canonical ongoing matters
- reminders remain the concrete future nudges
- Telegram is the scheduled and richer ritual surface
- Alexa stays on-demand, concise, and voice-first

Current ritual examples:

- morning brief
- midday re-grounding
- evening reset
- follow-through prompts
- household check-ins
- leave-transition prompts

Current user controls:

- `what rituals do I have enabled`
- `enable morning brief`
- `enable evening reset`
- `make the morning brief shorter`
- `stop doing that`
- `stop surfacing family context automatically`
- `make this part of my evening reset`
- `reset my routine preferences`

Default behavior stays conservative:

- no surprise push behavior
- no Alexa background push
- midday and household automatic surfacing stay off or suggested until enabled
- follow-through loops reuse life threads instead of creating a second task system

See [PROACTIVE_RITUALS.md](PROACTIVE_RITUALS.md) for the full model and limits.

## Cross-Channel Handoffs

Andrea now has a bounded cross-channel layer so Alexa can start a conversation and Telegram can finish the richer part.

Current product truth:

- handoffs are explicit and user-visible
- only Alexa-to-Telegram handoffs are in scope for v1
- only the registered main Telegram chat is used as the delivery target
- voice-triggered actions reuse existing reminders, life threads, rituals, drafts, and Knowledge Library flows
- no background push or generic automation layer was added

Typical voice follow-ups:

- `send me the details`
- `send the full version to Telegram`
- `save that in my library`
- `track that under Candace`
- `turn that into a reminder`

For the deeper operator view and proof harness, see [CROSS_CHANNEL_HANDOFFS.md](CROSS_CHANNEL_HANDOFFS.md).

## Communication Companion

Andrea now has a bounded communication-companion layer for real human conversations.

Current product truth:

- communication threads are explicit conversation-level tracking, not a second people database
- Andrea can summarize a message, decide if it still needs a reply, suggest one or two next actions, and draft a reply in the user's tone
- the layer reuses profile subjects, life threads, reminders, rituals, and handoffs instead of building a separate CRM or inbox product
- Alexa is the orientation surface
- Telegram and BlueBubbles are the richer communication surfaces
- no passive inbox crawl, no passive BlueBubbles sync, and no auto-send

Typical prompts:

- `summarize this message`
- `what should I say back`
- `give me a short reply`
- `make it warmer`
- `what do I owe people`
- `what's still open with Candace`
- `remind me to reply later`
- `save this conversation under the Candace thread`

See [COMMUNICATION_COMPANION.md](COMMUNICATION_COMPANION.md) for the exact boundaries and testing flow.

## Knowledge Library

Andrea now has a bounded Knowledge Library for saved source material.

Keep the boundary clear:

- memory facts are durable preferences or profile truths
- life threads are open ongoing matters
- reminders are future nudges
- current work is the active execution lane
- the Knowledge Library is saved source material Andrea can retrieve and cite

Current v1 implementation:

- explicit/manual ingestion only
- manual notes, saved research, and approved local text-file imports
- SQLite-backed source and chunk storage
- lexical-first retrieval through FTS5
- provenance kept on every retrieval hit
- disable, delete, and reindex controls

Typical prompts:

- `save this to my library`
- `what do my saved notes say about this`
- `what did I save about Candace`
- `show me the relevant saved items`
- `what sources are you using`
- `use only my saved material`
- `combine my notes with outside research`

See [KNOWLEDGE_LIBRARY.md](KNOWLEDGE_LIBRARY.md) for the full model and controls.

## Alexa Companion Productization And Andrea Pulse

Alexa Companion Mode is now productized around a calmer daily-companion feel rather than a feature-list feel.

What changed:

- warmer launch, help, and fallback copy
- stronger first sentences for daily guidance
- smoother `anything else` continuity
- better household phrasing for Candace and family flows
- light personality texture in low-stakes moments only

Andrea Pulse is the separate light-fun layer.

Important truth:

- `/ping` stays a pure operational health check
- Pulse is request-only in this pass
- Pulse uses a local curated catalog, not a new provider path
- examples:
  - `Andrea Pulse`
  - `tell me something interesting`
  - `give me a weird fact`
  - `surprise me`

Tone tuning is also explicit and bounded:

- `be a little warmer`
- `keep it plain`
- `go back to balanced`

These style controls affect phrasing. They do not change trust, linking, or capability safety.

## BlueBubbles Companion Channel

BlueBubbles is now a live V1 companion channel through the same adapter architecture Andrea already uses elsewhere.

Current implementation truth:

- one linked BlueBubbles conversation can share the same Andrea companion folder, defaulting to `main`
- Andrea accepts inbound BlueBubbles webhook messages, normalizes them into shared `bb:` identities, and replies back to the same conversation
- outbound is intentionally text-only in V1
- BlueBubbles stays companion-safe and does not become a main control chat
- richer detail and artifacts still hand off explicitly to Telegram

See [BLUEBUBBLES_CHANNEL_PREP.md](BLUEBUBBLES_CHANNEL_PREP.md) for the exact config, webhook/send model, and current limits.

## 1) Quick Start (Recommended Path)

From repo root:

```bash
npm install
```

Windows PowerShell note:

- If script execution policy blocks `npx.ps1`, use `npx.cmd`/`npm.cmd` in commands instead of `npx`/`npm`.
- The same applies to the Telegram user-session test tooling: use `npm.cmd run telegram:user:auth` / `npm.cmd run telegram:user:smoke` / `npm.cmd run telegram:user:batch` if needed.

Create local env file:

```powershell
Copy-Item .env.example .env
```

Open Claude Code and run setup:

```bash
claude
```

Then inside Claude Code:

1. Run `/setup`.
2. Add at least one channel (`/add-whatsapp`, `/add-telegram`, `/add-discord`, `/add-slack`, or `/add-gmail`).
3. For Telegram-first setups, send `/registermain` to the bot in the exact direct chat you want to use as the main control chat.
   - After registration, `npm run services:status` should show that DM as `registered_main_chat_jid`.
4. If you want OneCLI vault mode, run `/init-onecli`.
5. Verify install health:
   - `npm run setup -- --step verify`

## 2) Prerequisites And Baseline Checks

Required baseline:

- Node.js `22.x` (`>=22 <23`)
- Claude Code
- One container runtime:
  - Docker (Windows/macOS/Linux)
  - Podman (Windows/Linux)
  - Apple Container (macOS)

Suggested quick checks:

```bash
node --version
npm --version
docker info
podman info
container --help
claude --version
```

Only one runtime must be healthy.

## 3) Container Runtime Selection

Default resolution when `CONTAINER_RUNTIME` is not set:

- Windows: Docker, then Podman
- macOS: Apple Container, then Docker
- Linux: Docker, then Podman

Force a runtime in `.env`:

```bash
CONTAINER_RUNTIME=docker
# or podman
# or apple-container
```

If Docker is installed and running on Windows, Docker is selected by default.

## 4) Model Credentials (Anthropic And OpenAI-Compatible)

### Option A (Recommended): OneCLI Agent Vault

Run `/init-onecli` in Claude Code.
This keeps raw credentials out of container environments and routes auth through OneCLI.

### Option B: `.env` Credentials

Use one of these patterns:

Anthropic-native:

```bash
ANTHROPIC_AUTH_TOKEN=...
# or ANTHROPIC_API_KEY=...
# or CLAUDE_CODE_OAUTH_TOKEN=...
```

OpenAI key through an Anthropic-compatible gateway:

```bash
ANTHROPIC_BASE_URL=https://your-anthropic-compatible-endpoint
# or OPENAI_BASE_URL=https://your-anthropic-compatible-endpoint
OPENAI_API_KEY=...
# optional for Telegram image generation
OPENAI_IMAGE_MODEL=gpt-image-1
```

9Router (Cursor-backed routing path):

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:20128/v1
ANTHROPIC_AUTH_TOKEN=your-9router-api-key
NANOCLAW_AGENT_MODEL=cu/default
```

This lets NanoClaw use 9Router as the Anthropic-compatible runtime endpoint while 9Router handles provider routing (including Cursor-connected models).
When this endpoint is set to `localhost`/`127.0.0.1`, NanoClaw rewrites it to
the active runtime host alias inside containers.

Windows + Podman local gateway (auto-managed by service wrapper):

```bash
ANTHROPIC_BASE_URL=http://host.containers.internal:4000
OPENAI_API_KEY=...
```

Cursor Cloud Agents API (for direct Cursor job lifecycle control):

```bash
CURSOR_API_KEY=key_...
# Optional:
# CURSOR_API_BASE_URL=https://api.cursor.com
# CURSOR_API_AUTH_MODE=auto
# CURSOR_API_TIMEOUT_MS=20000
# CURSOR_API_MAX_RETRIES=2
# CURSOR_API_RETRY_BASE_MS=800
# CURSOR_MAX_ACTIVE_JOBS_PER_CHAT=4
```

`CURSOR_API_AUTH_MODE` accepts `auto`, `bearer`, or `basic`. Default `auto` tries Bearer first and falls back to Basic, which matches the mixed real-world Cursor Cloud auth behavior seen across tools and docs.

What this enables in Andrea today:

- queued heavy-lift Cursor Cloud job creation
- Cloud job sync, conversation, follow-up, and stop
- model lookup plus result-file lookup and download where applicable

If `CURSOR_API_KEY` is missing, `/cursor_status` should say `Cloud coding jobs: unavailable`, and `/cursor-create`, `/cursor-followup`, `/cursor-stop`, `/cursor-models`, `/cursor-results`, and `/cursor-download` should stay out of the operational path.

If you need to create the key itself or want the shortest explanation of Cloud versus desktop bridge, see [CURSOR_API_KEYS.md](CURSOR_API_KEYS.md).

Cursor Desktop Bridge (for using your own Cursor machine remotely):

```bash
CURSOR_DESKTOP_BRIDGE_URL=https://your-mac-bridge.example.com
CURSOR_DESKTOP_BRIDGE_TOKEN=replace-with-random-secret
# Optional:
# CURSOR_DESKTOP_BRIDGE_TIMEOUT_MS=30000
# CURSOR_DESKTOP_BRIDGE_LABEL=Jeff MacBook Pro
```

Use this mode when you want Andrea to reach the Cursor machine you normally use, such as your Mac while you are away from your desk.

Important notes:

- the bridge runs on the machine that has your normal Cursor setup
- in the current product shape, use Cursor Cloud for queued heavy-lift coding jobs and use the desktop bridge for operator-only session recovery plus line-oriented terminal control on that machine
- it uses the local Cursor agent CLI there for bridge-managed session state instead of the hosted Cursor API
- on Windows PCs, if you do not have a standalone `cursor-agent` command on `PATH`, set `CURSOR_DESKTOP_CLI_PATH` to Cursor's installed `cursor.cmd`; the bridge can invoke it in agent mode for health checks and compatibility attempts, but `/cursor_status` is still the source of truth for whether desktop agent jobs are actually validated on that machine
- after a bridge session is tracked or recovered, operators can also run line-oriented shell commands on that machine with `/cursor-terminal ...`
- those terminal commands are operator-only and limited to bridge-managed session state
- if the bridge health probe works on Windows but desktop sessions fail immediately with `Warning: 'p' is not in the list of known options`, your local Cursor CLI is not accepting the expected agent flags yet; keep using Cursor Cloud for heavy-lift jobs on that machine until the Windows agent entrypoint is confirmed
- if your main model runtime points at a remote 9router endpoint, set:
  - `CURSOR_GATEWAY_HINT=9router`
- see [CURSOR_DESKTOP_BRIDGE.md](CURSOR_DESKTOP_BRIDGE.md) for the full bridge setup
- after restart, use `/cursor_status` and confirm it reports the correct split for your environment before relying on deeper Cursor job commands:
  - `Cloud coding jobs: ready` for queued heavy-lift Cloud work
  - `Desktop bridge terminal control: ready` for bridge-managed shell/session control
  - `Desktop bridge agent jobs: validated|conditional|unavailable` for local desktop agent-run compatibility on that machine

If `Desktop bridge terminal control: unavailable`, treat that as a missing-config or bridge-health issue, not as a Cursor Cloud issue. The usual next step is to fix `CURSOR_DESKTOP_BRIDGE_URL`, `CURSOR_DESKTOP_BRIDGE_TOKEN`, or the bridge's private tunnel reachability.

Andrea runtime lane (secondary, conditional):

```bash
ANDREA_RUNTIME_EXECUTION_ENABLED=true
AGENT_RUNTIME_DEFAULT=codex_local
AGENT_RUNTIME_FALLBACK=openai_cloud
CODEX_LOCAL_ENABLED=true
OPENAI_MODEL_FALLBACK=gpt-5.4
```

Use this only after validating Codex/OpenAI runtime execution on the host.

Important truth:

- `/cursor` remains the primary operator workflow
- the `Codex/OpenAI` tile inside `/cursor` is the natural shell-facing entry for runtime work
- `/runtime-*` is the explicit runtime fallback shell for the integrated `andrea_runtime` lane
- `codex_local` is the intended primary runtime for this lane
- `openai_cloud` remains conditional on `OPENAI_API_KEY` or a compatible gateway token
- the imported `imported/andrea_openai_bot` subtree is temporary staging/history preservation, not the long-term runtime home

When this mode is active:

- `scripts/start-openai-gateway.ps1` runs LiteLLM as container `litellm-gateway`
- it creates/uses Podman network `nanoclaw-openai`
- agent containers automatically bind to that network and use `http://litellm-gateway:4000`

Important compatibility note:

- The core runtime uses Claude Agent SDK semantics.
- Native OpenAI endpoints (`https://api.openai.com/v1`) are not direct drop-ins unless exposed through an Anthropic-compatible layer.
- If your gateway does not yet accept the newest Claude default alias, set:
  - `NANOCLAW_AGENT_MODEL=claude-3-5-sonnet-latest`

### Option C: Amazon Business Shopping

Andrea can search Amazon Business and prepare approval-gated purchase requests.

Recommended first rollout:

```bash
AMAZON_BUSINESS_ORDER_MODE=trial
AMAZON_PURCHASE_APPROVAL_TTL_MINUTES=30
```

Required for search:

```bash
AMAZON_BUSINESS_API_BASE_URL=https://na.business-api.amazon.com
AMAZON_BUSINESS_AWS_REGION=us-east-1
AMAZON_BUSINESS_LWA_CLIENT_ID=...
AMAZON_BUSINESS_LWA_CLIENT_SECRET=...
AMAZON_BUSINESS_LWA_REFRESH_TOKEN=...
AMAZON_BUSINESS_AWS_ACCESS_KEY_ID=...
AMAZON_BUSINESS_AWS_SECRET_ACCESS_KEY=...
AMAZON_BUSINESS_USER_EMAIL=buyer@example.com
```

Required for purchase submission or trial validation:

```bash
AMAZON_BUSINESS_SHIPPING_FULL_NAME=Andrea Buyer
AMAZON_BUSINESS_SHIPPING_PHONE_NUMBER=555-123-4567
AMAZON_BUSINESS_SHIPPING_ADDRESS_LINE1=123 Main St
AMAZON_BUSINESS_SHIPPING_CITY=Chicago
AMAZON_BUSINESS_SHIPPING_STATE_OR_REGION=IL
AMAZON_BUSINESS_SHIPPING_POSTAL_CODE=60601
AMAZON_BUSINESS_SHIPPING_COUNTRY_CODE=US
```

Full details:

- [AMAZON_SHOPPING_AND_APPROVALS.md](AMAZON_SHOPPING_AND_APPROVALS.md)

### Option D: Alexa Voice

Andrea can expose a bounded custom Alexa skill endpoint so you can talk to the same assistant out loud.
Treat this as an optional personal-assistant channel, not part of the default baseline or demo path unless it has been validated end to end in the current environment.

Current closeout truth:

- the Alexa v1 code path is ready in this repo
- live Alexa use is still setup-dependent
- if `ALEXA_*` env, HTTPS ingress, console setup, or account linking are missing, treat Alexa as **code-ready but setup-blocked**
- validate Alexa on **Node 22.22.2**; unsupported host runtimes such as Node 24 can fail DB-backed Alexa checks without indicating an Alexa feature bug

Minimum:

```bash
ALEXA_SKILL_ID=amzn1.ask.skill.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

Recommended first rollout:

```bash
ALEXA_HOST=127.0.0.1
ALEXA_PORT=4300
ALEXA_PATH=/alexa
ALEXA_VERIFY_SIGNATURE=true
ALEXA_REQUIRE_ACCOUNT_LINKING=true
ALEXA_ALLOWED_USER_IDS=amzn1.ask.account.your-user-id
ALEXA_OAUTH_CLIENT_ID=andrea-alexa-poc-client
ALEXA_OAUTH_CLIENT_SECRET=replace-with-a-local-client-secret
ALEXA_OAUTH_SCOPE=andrea.alexa.link
ALEXA_LINKED_ACCOUNT_GROUP_FOLDER=main
```

Practical notes:

- Alexa requires an HTTPS endpoint, so local dev usually sits behind a tunnel or reverse proxy.
- `ALEXA_ALLOWED_USER_IDS` is the easiest security rail for a private skill rollout.
- Use `/alexa-status` in Telegram to confirm that the listener actually started, and `npm run services:status` to confirm `alexa_listener_health` plus `alexa_oauth_health` on the host.
- Account linking is required for Alexa personal-data intents in v1.
- unlinked Alexa is intentionally limited to launch/help/fallback style responses.
- The Andrea OAuth server now mints the linked access token and maps it to one Andrea `groupFolder`.
- that OAuth target `groupFolder` must already exist as a valid Andrea registered group
- Alexa now supports short-lived multi-turn follow-ups like `anything else`, `what about Candace`, `make that shorter`, and `remind me before that`.
- Alexa Companion Mode also supports broader daily-life guidance like `what matters most today`, `what am I forgetting`, `anything I should know`, `what should I remember tonight`, and family guidance such as `what does the family have going on`.
- person follow-ups can now stay voice-natural with prompts like `what about Travis`, `say more`, `what should I do about that`, `why`, and `should I be worried about anything`.
- Alexa can also handle explicit memory controls like `remember this`, `remember that`, `forget that`, `don't bring that up automatically`, `be a little more direct`, and `what do you remember about me`.
- remembered personalization stays structured and consent-based; Andrea does not silently store arbitrary conversation history as long-term memory.
- typed Alexa+ app chat is diagnosis-only unless it produces a real signed follow-up `IntentRequest` after skill launch
- authoritative live proof should use voice in the Alexa app, voice on device, or the authenticated Alexa simulator
- if you change `docs/alexa/interaction-model.en-US.json`, you must re-import it in the Alexa Developer Console and run `Build Model`
- `npm run debug:alexa-conversation` is the near-live operator harness for tuning the multi-turn Alexa flow locally before or after a live voice attempt

Recommended setup order:

1. switch to Node 22 on the host
2. set `ALEXA_SKILL_ID` plus the local listener env
3. set the Andrea OAuth client env:
   - `ALEXA_OAUTH_CLIENT_ID`
   - `ALEXA_OAUTH_CLIENT_SECRET`
   - `ALEXA_OAUTH_SCOPE`
4. make sure the OAuth target `groupFolder` already exists in Andrea
5. expose the endpoint through HTTPS
   - default v1 dev path: `ngrok http 4300`
   - if ngrok returns `ERR_NGROK_4018`, finish ngrok account verification and install the local authtoken first
   - set `ALEXA_PUBLIC_BASE_URL` to the current live HTTPS base URL you are actually using
6. configure the Alexa Developer Console skill and Authorization Code Grant account linking
   - endpoint URI: `${ALEXA_PUBLIC_BASE_URL}/alexa`
   - auth URI: `${ALEXA_PUBLIC_BASE_URL}/alexa/oauth/authorize`
   - token URI: `${ALEXA_PUBLIC_BASE_URL}/alexa/oauth/token`
   - scope: `andrea.alexa.link`
   - auth scheme: `HTTP Basic`
   - import the interaction model from `docs/alexa/interaction-model.en-US.json`
   - run `Build Model` after any interaction-model change
   - use the same live skill/application ID as local `ALEXA_SKILL_ID`
   - if `ALEXA_PUBLIC_BASE_URL` ends with `.ngrok-free.dev`, choose the wildcard-certificate endpoint option in the Alexa Developer Console
7. run `/alexa-status`, then perform the linked and unlinked live checks from [ALEXA_VOICE_INTEGRATION.md](ALEXA_VOICE_INTEGRATION.md)
8. if repo-side and near-live proof are already green, treat one real signed Alexa voice conversation as the final live acceptance step
   - preferred launch phrase: `Alexa, open Andrea Assistant skill`
   - if known-good phrases like `what's still open with Candace` still fall into generic fallback, treat the live model as stale first and rebuild it before debugging repo code
   - confirm `npm run services:status` shows the last signed request fields changing from `LaunchRequest` to a follow-up `IntentRequest`

Full details:

- [ALEXA_VOICE_INTEGRATION.md](ALEXA_VOICE_INTEGRATION.md)

## 5) Channel Setup And Main-Chat Responsibilities

Install one or more channels with skills:

- `/add-whatsapp`
- `/add-telegram`
- `/add-discord`
- `/add-slack`
- `/add-gmail`

During setup, register a main control chat.
Main chat can:

- manage group registration
- manage cross-group scheduled tasks
- enable/disable marketplace skills for target chats

## 6) Setup CLI Steps (For Manual Or CI-Style Verification)

The setup runner supports these deterministic steps:

- `npm run setup -- --step timezone`
- `npm run setup -- --step environment`
- `npm run setup -- --step container`
- `npm run setup -- --step groups`
- `npm run setup -- --step register` (used by setup flows, normally not manual)
- `npm run setup -- --step mounts`
- `npm run setup -- --step service`
- `npm run setup -- --step verify`

For a full health check, always run:

```bash
npm run setup -- --step verify
```

`verify` now reports two separate runtime truths:

- `CREDENTIAL_RUNTIME_PROBE`
  - the configured auth/endpoint/model path is reachable
- `ASSISTANT_EXECUTION_PROBE`
  - Andrea's real direct-assistant container path can start and produce first output

Read both fields together. A passing credential probe does **not** guarantee that the assistant lane can actually answer.

## 7) Daily Usage

Use your configured trigger in chats.
Use your real Telegram bot username when demonstrating mention-based group prompts.

Typical commands:

- ask for regular assistance in any registered chat
- ask for recurring tasks:
  - `@your_bot_username every weekday at 9am send me a sales summary`
- public-safe Telegram commands:
  - `/start`
  - `/help`
  - `/commands`
  - `/features`
- `/cursor_status` as the public-safe Cursor readiness check
- Amazon shopping commands for operators in the main control chat:
  - `/amazon-status`
  - `/amazon-search <keywords>`
  - `/purchase-request <asin> <offer_id> [quantity]`
  - `/purchase-requests`
  - `/purchase-approve <request_id> <approval_code>`
  - `/purchase-cancel <request_id>`
- Cursor-focused control commands:
  - `/cursor` (main control chat only; open the Cursor tile dashboard for status, jobs, current-job controls, and the new-job wizard)
  - `/cursor-models [filter]` (main control chat only; Cursor Cloud only; some accounts return no model list even when jobs still work with the default model)
  - `/cursor-jobs` (main control chat only; open the Jobs browser inside the Cursor dashboard and refresh tracked/recoverable jobs for this workspace)
  - `/cursor-create [options] <prompt>` (main control chat only; starts a Cursor Cloud job; Cloud jobs need either `--repo <url>` or a default repo configured in Cursor settings)
  - `/cursor-create --repo <url> --ref <branch> --model <id> <prompt>` (target a specific repo/ref/model)
  - `/cursor-sync [agent_id|list_number|current]` (main control chat only; refresh a tracked Cursor Cloud job or attach an existing Cursor Cloud job or desktop bridge session to this workspace)
  - `/cursor-stop [agent_id|list_number|current]` (main control chat only; request stop for a Cursor Cloud job)
  - `/cursor-followup [agent_id|list_number|current] <text>` (main control chat only; send follow-up instructions to a Cursor Cloud job)
  - `/cursor-conversation [agent_id|list_number|current] [limit]` (main control chat only; show the text trail for a Cursor Cloud job or a stored desktop session conversation)
  - `/cursor-results [agent_id|list_number|current]` (main control chat only; list tracked Cursor Cloud result files)
  - `/cursor-download [agent_id|list_number|current] <absolute_path>` (main control chat only; generate a temporary Cursor Cloud download link for one result file)
  - `/cursor-terminal [agent_id|list_number|current] <command>` (main control chat only; run a line-oriented shell command for a desktop bridge session)
  - `/cursor-terminal-status [agent_id|list_number|current]` (main control chat only; inspect the bridge-managed terminal state)
  - `/cursor-terminal-log [agent_id|list_number|current] [limit]` (main control chat only; read cached terminal output)
  - `/cursor-terminal-stop [agent_id|list_number|current]` (main control chat only; stop the active bridge-managed terminal command)
  - `/cursor-test` (main control chat only; troubleshooting smoke for the optional runtime-route surface, not part of the normal Cloud workflow)

Important scope rule:

- `/cursor_status` is safe to keep visible in the narrower public product surface
- the deeper Cursor, Amazon, and Alexa slash commands are operator-facing controls and should be run from Andrea's registered main control chat only
- for Cursor specifically, Cloud job commands are only operational when `/cursor_status` says `Cloud coding jobs: ready`
- desktop bridge terminal commands are only operational when `/cursor_status` says `Desktop bridge terminal control: ready`
- older `/cursor-artifacts` and `/cursor-artifact-link` aliases still work, but `/cursor-results` and `/cursor-download` are the preferred operator examples
- runtime-route readiness is optional and separate; `Cursor-backed runtime route: not configured` does not mean Cloud or desktop bridge are broken
- the desktop bridge gives Andrea bridge-managed session recovery and line-oriented shell commands on your normal machine, but not a live PTY, remote desktop, or a guaranteed local Windows agent-job path
- the normal Telegram operator flow is now `/cursor` -> tap `Current Work`/`Jobs`/`New Cloud Job` or `Codex/OpenAI` -> tap a task or control tile -> reply with plain text only when you are supplying a follow-up prompt or a new-job prompt
- the same `/cursor` shell now also exposes a `Codex/OpenAI` tile so runtime work feels like part of the same assistant instead of a second operator surface
- `/runtime-*` remains available as the main-chat-only explicit fallback shell for the integrated `andrea_runtime` lane when `ANDREA_RUNTIME_EXECUTION_ENABLED=true`
- replying to a fresh work card continues that exact task; otherwise Andrea uses the current work selected in the lane you opened
- stale or missing work-card replies fail honestly and point back to `Current Work` or the lane-specific explicit command fallback
- marketplace skill discovery and enablement still exist in the operator/runtime layer, but they are not part of the default Telegram command surface

Preferred operator command style:

- use hyphen aliases in Telegram for deeper operator commands
- underscore aliases still work for compatibility, but docs and examples standardize on the hyphen form

Architecture note:

- [BACKEND_LANES_ARCHITECTURE.md](BACKEND_LANES_ARCHITECTURE.md)

## 8) OpenClaw Marketplace Behavior And Security

Discovery catalog:

- `container/skills/openclaw-market/catalog.json`
- generated from `VoltAgent/awesome-openclaw-skills`

Lifecycle model:

- cache once globally at `data/marketplace/skills/<owner>/<slug>/`
- enable per chat by copying into that chat's isolated `.claude/skills`
- disable removes only the chat copy and mapping
- cache remains for reuse

Accepted source URLs:

- `clawskills.sh`
- `clawhub.ai`
- `github.com/openclaw/skills` (official path only)

Security gates before cache/enable:

- reject `Suspicious` or `Malicious` security status
- require `SKILL.md`
- enforce safe relative paths
- enforce file count and file size limits
- never run arbitrary installer code on host

Runtime-exposed marketplace tool surface:

- `search_openclaw_skills`
- `enable_openclaw_skill`
- `disable_openclaw_skill`
- `list_enabled_openclaw_skills`
- `install_openclaw_skill` (compatibility alias)

## 9) Add-Ons And Feature Catalog

For a detailed matrix of major add-ons, prerequisites, and platform scope, see:

- [ADDONS_AND_FEATURE_MATRIX.md](ADDONS_AND_FEATURE_MATRIX.md)
- [AMAZON_SHOPPING_AND_APPROVALS.md](AMAZON_SHOPPING_AND_APPROVALS.md)

## 10) Operations And Maintenance

Useful commands:

```bash
npm run build
npm run test
npm run test:major
npm run test:major:ci
npm run test:stability
npm run setup -- --step verify
npm run services:start
npm run services:stop
npm run services:restart
npm run debug:status
npm run debug:level -- verbose component:container 30m
npm run debug:logs -- current 120
npm run debug:reset -- all
```

Validation runner note:

- `npm run test:major`, `npm run test:major:ci`, and `npm run test:stability` run their internal checks on Node 22 via `npx -p node@22`, which keeps results consistent on hosts where the default Node version is newer.

Windows service lifecycle helpers:

- `npm run services:start` delegates to the canonical Windows host launcher, uses the pinned Node 22.22.2 runtime, and starts NanoClaw plus any configured companions.
- `npm run services:stop` stops NanoClaw, the local gateway, and any repo-managed companions started through the host launcher.
- `npm run services:restart` runs stop then start through the same host-controlled path.
- `npm run services:ensure` runs one explicit health-enforcement pass through the same host launcher.
- `npm run services:status` reports the active repo root, git branch and commit, pinned Node runtime, installed login-start mechanism, active `.env` and DB paths, the local Alexa listener and OAuth health when Alexa is configured, the current `assistant_health` view, `telegram_roundtrip_health`, the public assistant name/source, the registered main Telegram chat, whether the watchdog is running, and the last startup error if one occurred.

Startup behavior:

- `npm run setup -- --step service` configures platform-native startup.
- On Windows it prefers a Scheduled Task (`NanoClaw`) at user logon and falls back to the repo-owned Startup-folder launcher when task creation is denied by OS policy.
- On this machine, Scheduled Task creation is denied, so the canonical validated login path is:
  - `C:\Users\rupret\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\nanoclaw-start.cmd`
  - which delegates to `scripts\nanoclaw-host.ps1`
- The Windows host launcher bootstraps and reuses the repo-local pinned runtime under `data\runtime\node-v22.22.2-win-x64`, so daily startup does not depend on host Node 24.
- The Windows host launcher also keeps a repo-owned watchdog running and periodically calls `ensure`, so a live process that loses Telegram polling or stops updating its health marker gets corrected automatically.
- Telegram responsiveness is now enforced with a real `/ping` roundtrip probe every 30 minutes when no more recent successful Telegram exchange has already refreshed the same heartbeat.
- `npm run telegram:user:smoke` is the canonical operator-side proof for that path and exits non-zero if the real reply does not come back.
- On macOS this uses launchd.
- On Linux this uses systemd (or nohup fallback).
- So startup is not only a container setting; it is handled by host service manager policy plus runtime startup wrapper logic.

Rebuild bundled marketplace catalog (if `awesome-openclaw-skills` is cloned beside this repo):

```bash
npm run build:openclaw-market -- ../awesome-openclaw-skills/categories
```

Update workflows:

- `/update-nanoclaw` for upstream core updates
- `/update-skills` for installed skill branch updates
- `/debug-status` plus `/debug-level` and `/debug-logs` for live incident triage

Live troubleshooting controls:

- `/debug-status`
- `/debug-level <normal|debug|verbose> [scope] [duration]`
- `/debug-reset [scope|all]`
- `/debug-logs [service|stderr|current|cursor|runtime] [lines]`

Supported scopes:

- `global`
- `chat` or `current`
- `lane:cursor`
- `lane:andrea_runtime`
- `component:assistant`
- `component:container`
- `component:telegram`

Operator truth:

- these controls are operator-only and should stay in the registered main control chat
- Telegram-issued overrides default to `60m`
- log changes apply live without restart
- the same persisted control state is available from the host with the `npm run debug:*` commands above

## 11) Common "Not Live Yet" Causes

- missing model credentials
- model credentials configured but unusable at runtime (for example, OpenAI `insufficient_quota`)
- model credentials look reachable but the assistant lane still fails before first output
- no authenticated or configured channel
- no registered groups
- runtime binary installed but daemon not running
- wrong Node version (must be `22.x`)

Important interpretation:

- if `ASSISTANT_EXECUTION_PROBE=failed` with `initial_output_timeout`, treat that as a runtime-startup/output problem first
- do not flatten that into "credentials are missing" unless the credential probe also failed with an auth/endpoint/model signal

When blocked, start here:

- `/debug-status`
- if service state looks stale: `npm run services:restart`, wait for it to finish, then run `npm run setup -- --step verify`
- `/debug-level debug chat 60m`
- `/debug-logs current 120`
- [DEBUG_CHECKLIST.md](DEBUG_CHECKLIST.md)
- [SECURITY.md](SECURITY.md)

Short interpretation:

- no reply: restart first, then verify, then reproduce and inspect `current`
- delayed reply: add `verbose` on `component:container`, reproduce, then inspect `current` and `stderr`
- `ASSISTANT_EXECUTION_PROBE=failed` with `initial_output_timeout` means the runtime did not reach first output cleanly; do not flatten it into a missing-key issue unless the credential probe also failed

## 12) Go-Live Checklist (Methodical)

Use this exact order:

1. Verify baseline:
   - `npm run setup -- --step environment`
   - confirm `CONTAINER_RUNTIME_RESOLVED` is healthy
2. Configure model credentials:
   - preferred: `/init-onecli`
   - fallback: `.env` with Anthropic or OpenAI-compatible gateway credentials
3. Configure at least one channel:
   - Telegram/Discord/Slack tokens or WhatsApp auth
4. Register at least one group from the main chat.
5. Run final verify:
   - `npm run setup -- --step verify`
   - expected: `STATUS: success`
6. Start service:
   - `npm run setup -- --step service`
   - optional immediate restart check: `npm run services:restart`
7. Optional same-day operator validation only:
   - if you plan to use marketplace skills, search one skill, enable it in one chat, confirm it appears on the next response, then disable it again
   - if you plan to use Alexa, validate the live HTTPS endpoint and one real voice request
   - if you plan to use Amazon, keep `AMAZON_BUSINESS_ORDER_MODE=trial` and validate one full approval flow before treating it as real
