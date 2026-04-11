<p align="center">
  <img src="assets/andrea-banner.svg" alt="Andrea hero banner" width="1100">
</p>

<p align="center">
  Andrea_NanoBot is the merged home for Andrea's Telegram-first orchestration shell, built on NanoClaw isolation and expanded with curated OpenClaw skills.
</p>

<p align="center">
  This repository is now the canonical Andrea codebase. The older <code>ANDREA/nanoclaw</code> checkout is reference-only and should not be used as the runtime root.
</p>

<p align="center">
Andrea is designed to be practically useful every day: calendar help, reminders, planning, reply drafting, follow-through, research, coding help, guarded shopping approvals, and secure chat-based automation across multiple backend lanes.
</p>

<p align="center">
  Andrea now also has a bounded chief-of-staff layer for priorities, prep, and explainable decision support across Alexa, Telegram, and BlueBubbles.
</p>

<p align="center">
  Andrea can also remember explicitly delegated safe defaults, so repeated reminder, save, ritual, and handoff patterns become smoother without turning into silent automation.
</p>

<p align="center">
  Andrea now also has a bounded messaging trust ladder, so draft, approve, send, defer, and review can happen in one explainable flow without slipping into uncontrolled auto-send.
</p>

<p align="center">
  <a href="docs/USER_GUIDE.md">User Guide</a>&nbsp; | &nbsp;
  <a href="docs/ADMIN_GUIDE.md">Admin Guide</a>&nbsp; | &nbsp;
  <a href="docs/ANDREA_OPENAI_BACKEND.md">OpenAI Backend</a>&nbsp; | &nbsp;
  <a href="docs/SETUP_AND_FEATURES_GUIDE.md">Setup Guide</a>&nbsp; | &nbsp;
  <a href="docs/KNOWLEDGE_LIBRARY.md">Knowledge Library</a>&nbsp; | &nbsp;
  <a href="docs/COMMUNICATION_COMPANION.md">Communication Companion</a>&nbsp; | &nbsp;
  <a href="docs/ACTION_BUNDLES.md">Action Bundles</a>&nbsp; | &nbsp;
  <a href="docs/DELEGATION_RULES_AND_SAFE_AUTOMATION.md">Delegation Rules</a>&nbsp; | &nbsp;
  <a href="docs/MESSAGING_TRUST_LADDER_AND_LIVE_DELIVERY.md">Messaging Trust Ladder</a>&nbsp; | &nbsp;
  <a href="docs/OUTCOME_TRACKING_AND_REVIEWS.md">Reviews</a>&nbsp; | &nbsp;
  <a href="docs/CHIEF_OF_STAFF_MODE.md">Chief-of-Staff Mode</a>&nbsp; | &nbsp;
  <a href="docs/MISSIONS_AND_EXECUTION.md">Missions</a>&nbsp; | &nbsp;
  <a href="docs/PROACTIVE_RITUALS.md">Proactive Rituals</a>&nbsp; | &nbsp;
  <a href="docs/CROSS_CHANNEL_HANDOFFS.md">Cross-Channel Handoffs</a>&nbsp; | &nbsp;
  <a href="docs/BLUEBUBBLES_CHANNEL_PREP.md">BlueBubbles</a>&nbsp; | &nbsp;
  <a href="docs/CHANNEL_COMMANDS_AND_ONBOARDING.md">Chat Commands</a>&nbsp; | &nbsp;
  <a href="docs/COMMAND_SURFACE_REFERENCE.md">Command Surface</a>&nbsp; | &nbsp;
  <a href="docs/BACKEND_LANES_ARCHITECTURE.md">Backend Lanes</a>&nbsp; | &nbsp;
  <a href="docs/ASSISTANT_CAPABILITY_GRAPH.md">Capability Graph</a>&nbsp; | &nbsp;
  <a href="docs/DEMO_CHECKLIST.md">Demo Checklist</a>&nbsp; | &nbsp;
  <a href="docs/ADDONS_AND_FEATURE_MATRIX.md">Add-On Matrix</a>&nbsp; | &nbsp;
  <a href="docs/CURSOR_API_KEYS.md">Cursor API Keys</a>&nbsp; | &nbsp;
  <a href="docs/TESTING_AND_RELEASE_RUNBOOK.md">Testing Runbook</a>&nbsp; | &nbsp;
  <a href="PRIVACY.md">Privacy Policy</a>
</p>

---

## Signature Flows

The best way to understand Andrea now is through the flagship journeys it should nail end to end:

- Alexa or Telegram schedule check -> calendar move/add/remind follow-up
- `What's on my calendar tomorrow?` -> short read -> add, move, or reminder continuation
- `What am I forgetting?` -> one open loop -> reminder, save, or tracking action
- `What should I say back?` -> draft -> approve/send, save under thread, remind later, or queue a bounded send-later -> honest review state
- `Help me plan tonight / tomorrow morning` -> next step -> blocker -> confirmed action
- `What do I owe people?` -> open communication loop -> remind later or thread follow-up
- source-grounded research -> richer detail -> save to library
- BlueBubbles message help -> summarize -> draft -> remind later -> optional Telegram escalation

These flows are now backed by one shared capability graph, one continuation/handoff layer, and one productized proof harness:

```bash
npm run debug:signature-flows
```

Treat that flagship-flow suite and harness as the main product proof. The subsystem harnesses are still useful, but they are supporting checks now.

## Field-Trial Truth

Current host truth for the Windows field-trial machine:

- `LAUNCH_CANDIDATE_STATUS=core_ready_with_manual_surface_sync` is the current honest launch overlay on this host.
- Core live-proven surfaces:
  - Telegram companion
  - Alexa companion while the handled proof stays fresh
  - Google Calendar write path
  - unified `/cursor` work cockpit plus the Codex/OpenAI runtime lane
  - life threads, communication companion, chief-of-staff / missions, knowledge library, and action-bundle / outcome-review flows
  - startup / watchdog / host health
- Manual human sync still pending:
  - the latest repo Alexa interaction model hash has not been marked as synced locally yet
  - after importing and building `docs/alexa/interaction-model.en-US.json` in the Alexa Developer Console, run `npm run setup -- --step alexa-model-sync mark-synced`
- Degraded but usable:
  - BlueBubbles transport and real traffic are healthy, but the canonical self-thread still needs one fresh same-thread `message_action` proof leg before it returns to `live_proven`
- Optional provider-blocked lanes:
  - outward research
  - Telegram image generation
  - the local Anthropic-compatible LiteLLM compatibility lane
- Freshness gaps that should not be confused with host failure:
  - `journey_daily_guidance=near_live_only` until one fresh `what am I forgetting` or `what should I remember tonight` turn lands on this host
- `npm run services:status`, `npm run setup -- --step verify`, and `npm run debug:status` are the operator truth surfaces and should agree on the same core/manual-sync/provider-blocked story
- `npm run debug:pilot` is the proof-freshness and dogfooding surface for flagship journeys, degraded-but-usable fallback, and exact next steps

For the current demo/field-trial script, use [docs/DEMO_CHECKLIST.md](docs/DEMO_CHECKLIST.md).

## Pilot Mode

Andrea now has a bounded pilot and dogfooding loop on this host:

- flagship journey proof is recorded privately in local SQLite as sanitized journey events
- operator review now distinguishes `live_proven`, `degraded_but_usable`, and externally blocked pilot states so dogfooding does not confuse a bounded fallback with a clean live proof
- explicit pilot issue capture is available from shared assistant chat with phrases like:
  - `this felt weird`
  - `that answer was off`
  - `this shouldn't have happened`
  - `save this as a pilot issue`
  - `mark this flow as awkward`
- pilot review stays operator-only through `npm run debug:pilot`
- raw private transcripts are not stored in pilot instrumentation; only short sanitized summaries and linked artifact ids are retained
- set `ANDREA_PILOT_LOGGING_ENABLED=0` on the host if you need to disable both journey logging and explicit pilot issue capture

## What Andrea Is

Andrea is one public assistant identity built on a secure NanoClaw runtime.
The product is conversation-first in Telegram, with deeper operator tooling behind a narrower admin surface.

What normal users should expect:

- calendar help, reminders, follow-ups, and simple task support
- daily planning, what-next guidance, and open-loop review
- quick reply help and message summaries
- research, summaries, and project help
- fast direct replies for simple questions, playful prompts, and basic math
- warm ordinary chat plus graceful degraded replies when deeper runtime or live research is unavailable
- a small safe Telegram command set
- `/cursor_status` as the only public-safe Cursor command

What operators should expect:

- setup, restart, verify, and troubleshooting
- Cursor Cloud job workflows through the primary `/cursor` dashboard
- a secondary `andrea_runtime` lane for Codex/OpenAI execution truth
- desktop bridge session and terminal workflows
- live `/debug-*` troubleshooting controls plus host-side `npm run debug:*` fallbacks
- a loopback-backed Codex/OpenAI runtime lane with reply-linked follow-up and current-task selection
- optional integrations only after same-day validation

The runtime is still based on NanoClaw, which means the security model matters:

- agents run in isolated containers
- each registered chat keeps its own context and files
- community skills are cached globally but enabled explicitly per chat
- model access can run through OneCLI or an Anthropic-compatible gateway
- shopping credentials stay on the host behind a narrow approval-aware boundary

## Why This Repo Exists

The upstream NanoClaw project provides a strong secure runtime.
This fork turns that foundation into Andrea: a more opinionated, more polished personal assistant with stronger Telegram UX, better operator docs, reliable direct replies, and a more intentional day-to-day assistant experience.

In short:

- NanoClaw gives Andrea the safety model
- OpenClaw skills give Andrea breadth
- this repo focuses on making the whole package feel usable, personal, and reliable

## Quick Start

Clone this repo, install dependencies, and open Claude Code:

```bash
git clone https://github.com/rupret007/Andrea_NanoBot.git
cd Andrea_NanoBot
npm install
claude
```

If you are on Windows PowerShell, create `.env` like this:

```powershell
Copy-Item .env.example .env
```

Then use this setup flow:

1. In Claude Code, run `/setup`
2. In Claude Code, add Telegram with `/add-telegram`
3. Optionally run `/init-onecli` for safer credential handling
4. Start the bot and open a DM with Andrea in Telegram
5. In Telegram, run `/start`
6. In Telegram, run `/registermain`
7. In Telegram, run `/help`

After `/registermain`, that exact DM should become Andrea's main control chat.
If operator-only surfaces later feel flat or unavailable, run `npm run services:status`
and confirm `registered_main_chat_jid` matches the real Telegram DM you use.

## Pick Your Guide

If you only read one doc, use the one that matches your role:

- User: [docs/USER_GUIDE.md](docs/USER_GUIDE.md)
- Operator/Admin: [docs/ADMIN_GUIDE.md](docs/ADMIN_GUIDE.md)
- Full setup and runtime details: [docs/SETUP_AND_FEATURES_GUIDE.md](docs/SETUP_AND_FEATURES_GUIDE.md)

## Cursor In One Minute

Andrea now documents Cursor as three separate surfaces:

- **Cursor Cloud**
  - requires `CURSOR_API_KEY`
  - current validated heavy-lift queued coding path
- **Cursor desktop bridge**
  - requires `CURSOR_DESKTOP_BRIDGE_URL` and `CURSOR_DESKTOP_BRIDGE_TOKEN`
  - operator-only session recovery plus line-oriented terminal control on your own machine
  - does not automatically mean queued desktop-agent execution is validated on Windows
- **Cursor-backed runtime route**
  - optional diagnostic/runtime-routing surface
  - separate from both Cloud jobs and desktop bridge readiness

## Backend Lanes

Andrea_NanoBot now owns the shared shell while backend lanes own execution truth.

- **Shell ownership stays here**
  - Telegram UX
  - `/cursor` tile dashboard
  - selection state, wizard state, and reply-linked operator behavior
- **Cursor lane stays first-class**
  - current rich operator lane
  - primary taught dashboard and job workflow
- **`andrea_runtime` is now a backend-backed secondary lane**
  - uses the local `Andrea_OpenAI_Bot` loopback backend for Codex/OpenAI execution truth
  - now has a `Codex/OpenAI` surface inside the primary `/cursor` work cockpit
  - `/runtime-*` remains the explicit runtime fallback shell
  - does not replace Cursor or the `/cursor` dashboard
  - the shell now presents one chat-scoped current-work model with lane-specific capabilities, not two separate operator products
  - direct `/cursor-*` and `/runtime-*` replies now mirror the cockpit more closely: they render richer single-task cards, keep exact backend ids visible, and point back to explicit fallback commands when you want to stay out of the dashboard

On this host, the unified Telegram work cockpit is now live-proven across both first-class execution lanes:

- Cursor Cloud task creation, refresh/output controls, explicit fallback commands, and reply-to-card continuation
- Codex/OpenAI runtime creation, follow-up, logs, stop, and reply-to-card continuation

Shared shell handles now resolve as `{ laneId, jobId }`.
The imported `imported/andrea_openai_bot` subtree is temporary staging plus history preservation, not the long-term runtime home.

Under the hood, the current Codex/OpenAI lane now resolves through the local `Andrea_OpenAI_Bot` loopback backend when that lane is enabled. `npm run services:status` surfaces `runtime_backend_health`, `runtime_backend_local_execution_state`, and `runtime_backend_auth_state` so host truth matches `/runtime-status` and the `/cursor` cockpit. See [docs/ANDREA_OPENAI_BACKEND.md](docs/ANDREA_OPENAI_BACKEND.md) for the ownership split and the current auth/bootstrap flow.

## Alexa Companion Mode

Alexa is now a bounded companion channel for Andrea rather than a novelty skill.

- it reuses the same Andrea core, account-linking, and trust boundaries
- it now maps core daily, household, memory, thread, and bounded research asks through the shared assistant capability graph
- it now captures broader natural speech through a small set of carrier-phrase intent families instead of leaning only on narrow one-off intents
- it is shorter, warmer, more spoken-first, and less menu-like than Telegram
- it now has a small bounded personality layer for softer transitions in low-stakes moments
- it supports daily guidance like morning brief, what matters most today, anything important, what am I forgetting, evening reset, and family-upcoming flows
- it keeps short-lived conversational continuity for turns like `anything else`, `what about Candace`, `what about Travis`, `say more`, `why`, `remember that`, `make that shorter`, `be a little more direct`, and `remind me before that`
- it supports request-driven Andrea Pulse asks such as `Andrea Pulse`, `tell me something interesting`, `give me a weird fact`, or `surprise me`
- it can handle bounded research or comparison asks briefly by voice and keep longer follow-through on Telegram when needed
- it can now orient you around open conversations, owed replies, and communication follow-through without turning Alexa into a full messaging client
- personalization remains explicit and consent-based
- use Node `22.22.2` for truthful Alexa validation on the operator host
- use `npm run debug:alexa-conversation -- --review` to see repeated Alexa misses, weak clarifiers, and carrier phrases worth adding from real use

Alexa proof on this host is now status-led:

- treat `npm run services:status`, `npm run debug:status`, and `npm run setup -- --step verify` as the live authority
- Alexa only becomes `live_proven` while a fresh handled Andrea custom-skill proof remains inside the 24-hour window
- operator surfaces can satisfy that proof either from the persisted handled signed-request markers or, after restart, from a recent same-host `alexa_orientation` pilot success that already recorded the qualifying handled turn
- if that handled proof ages out or no fresh qualifying proof remains on this host, Alexa should read as `near_live_only`
- if the latest repo interaction-model hash has not been marked synced yet, launch-readiness should read `core_ready_with_manual_surface_sync` even while Alexa proof itself remains `live_proven`

When you want to refresh Alexa proof freshness, this is the validation flow:

- `Open Andrea Assistant`
- `What am I forgetting?`
- `Anything else?`
- `What about Candace?`
- `Be a little more direct.`
- optional `What should I remember tonight?`

If that handled signed proof ages past 24 hours, operator surfaces will intentionally drop Alexa back to `near_live_only` until you run this flow again.

Typed Alexa+ app chat is diagnosis-only right now. It may trigger a skill launch, but it does not count as live proof unless Andrea logs a real signed follow-up `IntentRequest` after launch.

After any interaction-model change, re-import `docs/alexa/interaction-model.en-US.json` in the Alexa Developer Console, run `Build Model`, then run `npm run setup -- --step alexa-model-sync mark-synced` before treating live fallback as a repo bug.

For repo-side conversation tuning on the operator host, use `npm run debug:alexa-conversation`.

## Andrea Pulse

Andrea Pulse is a separate request-driven personality feature. It is not a health check, not a replacement for `/ping`, and not a source of proactive spam.

- `/ping` remains pure operational health
- Pulse is currently request-only
- examples: `Andrea Pulse`, `tell me something interesting`, `give me a weird fact`, `surprise me`
- Pulse uses a small local curated catalog instead of adding a new provider dependency just for facts
- `say more` stays on the same Pulse item, while `anything else` can move to a different one

## BlueBubbles Companion Channel

BlueBubbles is now a real bounded Andrea messaging channel, not just prep work.

- BlueBubbles V1 now supports all synced personal and group chats, not one pinned linked thread
- Andrea replies only when a message explicitly mentions `@Andrea`, so ordinary social chatter does not trigger assistant replies
- current-chat asks like `summarize this` now use recent `bb:` chat context and can prime recent history from the live BlueBubbles server when local context is thin
- BlueBubbles keeps companion-safe capabilities like daily guidance, communication help, follow-through, Knowledge Library summaries, draft follow-up, and short research summaries
- richer details still hand off explicitly to Telegram when that is the better surface
- BlueBubbles does **not** become a main control chat and does not expose work-cockpit or admin/runtime controls

On this host, BlueBubbles is currently `degraded_but_usable`: Andrea has the live `BLUEBUBBLES_*` configuration loaded, the server is reachable, Andrea's public webhook is registered, and real traffic is flowing, but the canonical proof thread `bb:iMessage;-;+14695405551` still needs one fresh same-thread `message_action` leg before the surface returns to `live_proven`.

See [docs/BLUEBUBBLES_CHANNEL_PREP.md](docs/BLUEBUBBLES_CHANNEL_PREP.md) for the live V1 scope, config, webhook/send model, and exact current limits.

## Relationship-Centered Communication Companion

Andrea now has a bounded communication-companion layer for real conversations and follow-through.

- communication threads are explicit conversation-level state, not a CRM
- Andrea can summarize a message, decide whether it still needs a reply, suggest next actions, and draft a reply in a warmer or more direct tone
- Telegram and BlueBubbles are the richer communication surfaces
- Alexa stays concise and can orient you around `what do I owe people`, `what's still open with Candace`, or `draft that for me`
- open conversations can feed into daily guidance and evening carryover without creating passive inbox surveillance

Communication threads stay distinct from:

- memory facts
- life threads
- reminders
- the Knowledge Library

See [docs/COMMUNICATION_COMPANION.md](docs/COMMUNICATION_COMPANION.md) for the exact model, prompts, and testing flow.

## Missions And Multi-Step Execution

Andrea now has a bounded missions layer for turning an explicit goal into a stored plan that can move forward across Alexa, Telegram, and BlueBubbles.

- explicit planning asks like `help me plan Friday dinner with Candace` create a stored `proposed` mission immediately
- missions stay distinct from chief-of-staff, life threads, reminders, and current work
- each mission keeps a short summary, 3-5 steps, blockers, and one suggested next action
- durable follow-through still requires explicit approval such as `remind me`, `draft it`, `save that`, `track that`, or `start the research`
- Alexa gives a short orientation read, while Telegram gets the fuller plan and action surface

See [docs/MISSIONS_AND_EXECUTION.md](docs/MISSIONS_AND_EXECUTION.md) for the model, controls, and testing flow.

## Shared Assistant Core

Andrea now has a shared assistant capability graph so Alexa and Telegram feel like two expressions of the same assistant rather than separate route trees.

- shared capabilities now cover daily guidance, household-aware answers, explicit thread lookup, memory controls, and bounded research
- shared capabilities now also cover explicit Knowledge Library controls such as saving sources, listing relevant sources, explaining source choice, and summarizing saved material
- shared capabilities now also cover ritual status, ritual control, and follow-through guidance
- shared capabilities now also include explicit Andrea Pulse actions
- Alexa can now hand richer results off to Telegram explicitly instead of pretending voice should carry everything
- voice follow-ups like `send me the details`, `save that in my library`, and `turn that into a reminder` now map into the same shared completion layer
- Alexa keeps voice-safe shaping and bounded follow-ups
- BlueBubbles is now a real companion channel with its own safety gate and output-shaping policy
- Telegram keeps richer rendering and deeper operator-side actions
- operator-only current-work controls stay out of Alexa even though they live in the same registry

## Proactive Rituals And Follow-Through

Andrea now has a bounded rituals layer that sits above daily companion, reminders, life threads, calendar, personalization, and the Knowledge Library.

- rituals define assistant behavior and timing, not a second task system
- follow-through loops stay attached to life threads instead of spawning a parallel backlog
- morning and evening rituals can be scheduled on Telegram, but stay off until you opt in
- Alexa stays on-demand only and voice-first
- family and household automatic surfacing stay conservative unless you explicitly enable them

Typical prompts now include:

- `What rituals do I have enabled?`
- `Enable morning brief`
- `What follow-ups am I carrying right now?`
- `What have I been putting off?`
- `Make this part of my evening reset`
- `Stop doing that`

See [docs/PROACTIVE_RITUALS.md](docs/PROACTIVE_RITUALS.md) for the model, controls, and limits.
- bounded research now returns a summary first, structured findings, route explanation, and exact blocker truth when web-backed OpenAI research is unavailable
- bounded research can now use local context, the Knowledge Library, optional OpenAI-backed synthesis with `web_search` when configured, and runtime delegation only when the request is clearly execution-heavy
- Telegram image generation is now wired through the shared media capability when OpenAI credentials are present and the provider account is usable; Alexa keeps media at the handoff layer

See [docs/ASSISTANT_CAPABILITY_GRAPH.md](docs/ASSISTANT_CAPABILITY_GRAPH.md) for the descriptor model, safety rules, research provider boundaries, and license-safe pattern sources.

For operator-side smoke testing of the shared core, use `npm run debug:shared-capabilities`, `npm run debug:research-mode`, and `npm run debug:knowledge-library`.
For the missions layer specifically, use `npm run debug:missions`.
For the ordinary conversational surface and no-leakage degraded-response policy, use `npm run debug:conversational-core`.

## Approval Center And Action Bundles

Andrea now has a bounded Action Bundle layer so good advice can turn into explicit next steps without taking control away from you.

- bundles are small, explainable sets of actions built on top of existing reminders, drafts, thread saves, library saves, rituals, handoffs, and mission follow-through
- Telegram is the rich approval surface with inline actions like `Approve all`, `Pick actions`, and `Not now`
- Alexa stays concise and can orient you around the bundle, approve simple subsets, or send the full bundle to Telegram
- BlueBubbles stays bounded and hands richer bundle approval back to Telegram
- bundle execution is explicit, tracked, and honest about partial success or failure

See [docs/ACTION_BUNDLES.md](docs/ACTION_BUNDLES.md) for the model, approval flow, and current limits.

## Outcome Tracking And Reviews

Andrea now has a bounded closed-loop review layer so execution does not stop at "I created a reminder" or "I ran that bundle."

- outcomes track what actually happened after bundles, reminders, missions, communication follow-through, handoffs, and current-work moves
- daily and weekly review stay on-demand and grounded in real state Andrea owns or can safely infer
- Telegram is the richer review surface with grouped sections and bounded controls
- Alexa stays concise and can orient you around what got done, what slipped, and what is carrying into tomorrow
- BlueBubbles stays bounded and should hand off dense review to Telegram

This layer stays distinct from:

- missions as the plan structure
- bundles as the approval-and-execution layer
- reminders as future nudges
- life threads as ongoing matters

See [docs/OUTCOME_TRACKING_AND_REVIEWS.md](docs/OUTCOME_TRACKING_AND_REVIEWS.md) for the model, controls, and testing flow.

## Cross-Channel Companion Handoffs

Andrea now has a bounded cross-channel handoff layer so a conversation can start briefly on Alexa, continue in BlueBubbles or Telegram when appropriate, and still feel like one assistant.

- handoffs are explicit and user-visible
- Telegram remains the richer artifact/detail surface, while BlueBubbles can now receive bounded text continuations
- no silent push behavior was added
- voice-triggered completion actions reuse existing reminder, thread, ritual, and Knowledge Library systems instead of creating a second planner

Typical follow-ups now include:

- `send me the details`
- `send the full version to Telegram`
- `send that to my messages`
- `save that in my library`
- `track that under Candace`
- `turn that into a reminder`

Use `npm run debug:cross-channel-handoffs` and `npm run debug:bluebubbles` for the operator-side near-live proof harnesses, and see [docs/CROSS_CHANNEL_HANDOFFS.md](docs/CROSS_CHANNEL_HANDOFFS.md) for the delivery model and limits.

## Knowledge Library

Andrea now has a bounded **Knowledge Library** for saved source material.

- it is explicit, inspectable, and source-labeled
- it is separate from memory facts, life threads, reminders, and current work
- it supports manual notes, saved research, and approved local text-file imports
- retrieval is lexical-first with chunk-level provenance instead of silent blob matching
- Telegram is the richer source-grounded surface, while Alexa stays concise and source-aware

Useful prompts include:

- `save this to my library`
- `what do my saved notes say about this`
- `compare these saved sources`
- `what sources are you using`
- `use only my saved material`
- `combine my notes with outside research`

See [docs/KNOWLEDGE_LIBRARY.md](docs/KNOWLEDGE_LIBRARY.md) for the library model, ingestion rules, retrieval behavior, privacy boundaries, and testing path.

For day-to-day operator checks, use `/alexa-status` inside the registered main control chat and `npm run services:status` for the local Alexa listener, OAuth health, public-ingress hinting, and the last signed Alexa request markers on the host. Public HTTPS ingress and live signed utterances remain separate acceptance checks. If the live host is an `ngrok` `*.ngrok-free.dev` tunnel, the Alexa console endpoint SSL setting must use the wildcard-certificate option.

## Two Command Surfaces

This is one of the easiest places for new users to get confused, so the split is important:

### Claude Code Skills

These run inside the `claude` terminal session while you are operating the repo:

- `/setup`
- `/add-telegram`
- `/add-whatsapp`
- `/add-discord`
- `/init-onecli`
- `/debug`
- `/update-nanoclaw`
- `/update-skills`

### Telegram Bot Commands

These run inside Telegram after the bot is live:

- `/start`
- `/help`
- `/commands`
- `/features`
- `/ping`
- `/chatid`
- `/registermain`
- `/cursor_status`

Andrea Pulse is deliberately separate from this command surface. It does not replace `/ping`, and it only runs when explicitly requested in conversation.

Advanced operator workflows still exist, but they are operator-only, live in the admin guide, and should stay out of the default demo unless they were validated the same day.

Preferred operator command style:

- public-safe commands stay documented exactly as shown above
- deeper operator examples use hyphen aliases in Telegram, such as `/cursor`, `/cursor-jobs`, and `/cursor-create`
- operator examples use `/cursor-results` for output files and `/cursor-download` for one-file retrieval
- the normal Telegram operator flow is now `/cursor` -> `Current Work`/`Jobs`/`New Cloud Job` or `Codex/OpenAI` tiles -> tap a task/action -> reply with plain text only when you are supplying a follow-up prompt or a new-job prompt
- replying to a fresh work card always continues that exact task; otherwise Andrea uses the current work selected in the lane you opened
- if a work-card reply is stale or missing, Andrea now says so explicitly and points you back to `Current Work` or the lane-specific explicit command fallback
- underscore aliases still work for compatibility, but the docs now standardize on the hyphen form for operator workflows
- older `/cursor-artifacts` and `/cursor-artifact-link` aliases still work for compatibility, but they are no longer the preferred operator examples

## Demo-Ready Surface

For a reliable demo, keep the story tight:

- Telegram onboarding and `/registermain`
- direct questions, fast quick replies for simple asks, reminders, and light research
- stable health checks, `/help`, and `/cursor_status`
- secure per-chat isolation and clean user-facing replies

Optional integrations such as Cursor Cloud job control, desktop bridge control, Alexa, shopping flows, marketplace skills, and calendar-oriented skills exist, but they should be treated as operator-enabled extras unless they were validated the same day. Alexa in particular is now code-complete as a bounded personal-assistant channel, but live use still depends on Node 22, HTTPS ingress, Alexa console setup, and account linking being configured on that host.

## Calendar Integration

Andrea now has a local fast path for plain-language calendar reads such as:

- `What's on my calendar tomorrow?`
- `What's on my schedule this week?`
- `Am I free Friday afternoon?`
- `Do I have anything at 3pm tomorrow?`

Supported provider paths:

- Google Calendar with an access token or refresh token plus explicit calendar ids
- Apple Calendar directly on a Mac running Andrea
- Apple/iCloud-style CalDAV using calendar collection URLs plus credentials
- Outlook calendars through Microsoft Graph

These are optional operator-enabled integrations. Google Calendar is the best first setup when your real family events already live there, and Andrea answers truthfully when no provider is configured instead of pretending a calendar is connected.

Google Calendar now supports two practical operator flows on a configured host:

- read real events from explicit selected calendars such as `primary` plus family/shared calendars
- create simple one-time Google Calendar events after a clear confirmation in chat

Use the Google setup flow on the host instead of trying to give Andrea your Google account password:

```powershell
npm run setup -- --step google-calendar auth --client-secret-json "C:\path\to\client_secret.json"
npm run setup -- --step google-calendar discover --select all
npm run setup -- --step google-calendar validate
```

Notes:

- while the Google OAuth app stays in Testing, the Google account must be listed as a test user
- `GOOGLE_CALENDAR_IDS` should stay explicit so Andrea only reads the calendars you selected
- `npm run setup -- --step google-calendar validate` is the operator truth surface for calendar access on the current host
  - `FAILURE_KIND: missing_config` means the current repo does not have usable Google Calendar credentials yet
  - `FAILURE_KIND: invalid_refresh_token` usually means an older refresh token went stale and you should rerun `auth` in the current repo instead of copying legacy tokens forward
- if the browser reaches the Google callback but `auth` still times out, finish the same current-repo OAuth run with `npm run setup -- --step google-calendar auth-complete --callback-url "http://127.0.0.1:PORT/?state=...&code=..."`
- reminder phrasing still creates reminders, not Google Calendar events
- a host is only live-proven for Google Calendar writes after `auth`, `discover`, `validate`, and one disposable create-event proof all succeed on that host
- on this Windows host, Google Calendar read/write is now live-proven through `npm run debug:google-calendar` and a real Telegram assistant-style create confirmation flow

## What Andrea Can Do

### Personal Assistant Work

- track tasks and simple to-do lists
- set reminders and recurring follow-ups
- keep compact ongoing life threads for people, household, and work continuity
- summarize conversations and notes
- run lightweight personal workflow automation

## Life Threads And Ongoing Context

Andrea now has a bounded **life thread** layer for ongoing matters like Candace, family logistics, band follow-ups, home errands, health routines, or work continuity.

- threads track what is still open across days
- threads are not the same thing as long-term memory facts
- reminders are still the place for a specific future nudge
- current work is still the immediate execution focus in the cockpit
- explicit prompts like `save this under the band thread`, `remember I need to talk to Candace about dinner plans tonight`, `what's still open with Candace`, and `what threads do I have open` work in plain language
- inferred continuity stays confirmation-first; Andrea does not silently turn every recurring topic into durable memory
- `don't bring this up automatically` moves a thread into manual-only use without deleting it
- `forget that thread` is the explicit hard-delete path

### Research And Knowledge Work

- research a topic and summarize the result
- compare options, explain tradeoffs, and recommend a choice with route explanation
- save source material into a bounded Knowledge Library and ask source-grounded follow-up questions later
- compare saved notes, summaries, and imported reference material with visible provenance
- keep Alexa concise while Telegram carries the richer structured research surface
- monitor or re-check information through scheduled tasks
- organize output per chat or group context

### Coding And Operator Work

- help with repos, debugging, and code tasks
- use `/cursor_status` as the safe Cursor readiness check
- operators can create, continue, stop, inspect, and recover **Cursor Cloud** coding tasks from the main control chat
- operators use `Refresh`, `View Output`, and `Results` in `/cursor`, while `/cursor-conversation`, `/cursor-results`, and `/cursor-download` stay available as explicit fallbacks
- operators can sync and inspect **desktop bridge sessions**, then run line-oriented terminal commands against tracked bridge sessions on their own machine
- operators can also open the integrated **Codex/OpenAI runtime** lane from `/cursor` to review or continue runtime tasks when that lane is enabled and validated on the host
- `/runtime-*` remains available as the explicit runtime fallback shell for direct control, logs, and stop actions
- when `current` or a lane selection points at a dead task, Andrea now clears the stale selection honestly and tells you to reopen `Current Work` or use the exact-id fallback command
- keep optional integrations behind explicit operator setup instead of treating them as default demo features

Important Cursor rule:

- `/cursor_status` now splits Cloud coding jobs, desktop bridge terminal control, desktop agent-job compatibility, and Cursor-backed runtime routing into separate lines
- if it says `Cloud coding jobs: unavailable`, treat `/cursor-create`, `/cursor-followup`, `/cursor-stop`, `/cursor-models`, `/cursor-results`, and `/cursor-download` as unavailable until `CURSOR_API_KEY` is configured
- if it says `Desktop bridge terminal control: unavailable`, treat `/cursor-terminal*` and desktop session recovery as unavailable until the bridge is configured and reachable
- if it says `Desktop bridge agent jobs: conditional` or `unavailable`, keep using Cursor Cloud for queued heavy-lift work and treat the bridge as terminal/session control only on that machine
- Cursor desktop bridge control is operator-only. It can inspect bridge-known sessions and run line-oriented shell commands for tracked bridge sessions, but it is not a live PTY or remote desktop surface.

## Using Andrea In Chat

In a direct message:

- use `/start` for quick onboarding
- use `/registermain` to make that DM your main control chat
- ask normal requests in plain English

In a group:

- mention Andrea when you want her to act
- keep high-trust admin tasks in the main control chat when possible

Examples:

```text
@your_bot_username add "renew passport" to my to-do list
@your_bot_username remind me every Monday at 9am to send updates
@your_bot_username research the best standing desks for small apartments
@your_bot_username what's the meaning of life?
```

## Model And Runtime Support

Andrea currently supports:

- Node.js 22.x
- Docker, Podman, and Apple Container
- Anthropic-compatible model endpoints
- OpenAI-key-backed gateways exposed through Anthropic-compatible APIs
- optional 9router / Cursor-backed runtime-routing paths
- optional Cursor Cloud Agents API control via `CURSOR_API_KEY` and optional `CURSOR_API_AUTH_MODE=auto|bearer|basic`
- optional integrations only after operator validation

If you need to create or verify a real Cursor Cloud key, see [docs/CURSOR_API_KEYS.md](docs/CURSOR_API_KEYS.md).

Useful runtime validation commands:

```text
/ping
/cursor_status
/debug-status
/debug-level debug chat 60m
/debug-logs current 120
/debug-reset all
```

Useful local validation commands:

```bash
npm run test:major:ci
npm run test:major
npm run test:stability
npm run services:restart
npm run services:status
npm run setup -- --step verify
npm run debug:status
npm run debug:level -- verbose component:container 30m
npm run debug:logs -- stderr 120
npm run debug:reset -- all
```

## Verify And Troubleshooting

`npm run setup -- --step verify` now checks two different things:

- `CREDENTIAL_RUNTIME_PROBE`
  - endpoint/auth/model reachability
- `ASSISTANT_EXECUTION_PROBE`
  - whether Andrea's main direct-assistant container path can actually start and produce first output

That distinction matters during incidents:

- a passing credential probe does **not** guarantee the assistant lane can answer
- an `initial_output_timeout` is a runtime-startup/output problem, not automatically a missing-key problem
- `/debug-*` commands are operator-only and let you turn log volume up or down live without restarting the service
- `npm run services:status`, `npm run debug:status`, and `npm run setup -- --step verify` now show the serving commit, the local workspace `HEAD`, installed artifact mode, current launch mode, and exact external blockers so host truth and dependency truth do not get mixed together
- if `SERVING_COMMIT_MATCHES_WORKSPACE_HEAD: false`, restart into the current repo before treating any live proof as current
- when you need both restart and verify, run `npm run services:restart` first, wait for it to finish, then run `npm run setup -- --step verify`

## Documentation Map

Use the docs based on what you are trying to do:

- [docs/USER_GUIDE.md](docs/USER_GUIDE.md)
  for daily usage, command examples, and what Andrea can do for end users
- [docs/ADMIN_GUIDE.md](docs/ADMIN_GUIDE.md)
  for setup ownership, security rails, service operations, and release steps
- [docs/SETUP_AND_FEATURES_GUIDE.md](docs/SETUP_AND_FEATURES_GUIDE.md)
  for operator setup, runtime config, and day-to-day operations
- [docs/CHANNEL_COMMANDS_AND_ONBOARDING.md](docs/CHANNEL_COMMANDS_AND_ONBOARDING.md)
  for Telegram onboarding, chat UX, and command reference
- [docs/BACKEND_LANES_ARCHITECTURE.md](docs/BACKEND_LANES_ARCHITECTURE.md)
  for shell-versus-lane ownership, the `{ laneId, jobId }` handle model, and the temporary imported subtree boundary
- [docs/AMAZON_SHOPPING_AND_APPROVALS.md](docs/AMAZON_SHOPPING_AND_APPROVALS.md)
  for Amazon Business setup, safety rails, and shopping commands
- [docs/CURSOR_DESKTOP_BRIDGE.md](docs/CURSOR_DESKTOP_BRIDGE.md)
  for operator-only desktop session recovery and terminal commands on your own machine while Andrea controls it remotely
- [docs/CURSOR_API_KEYS.md](docs/CURSOR_API_KEYS.md)
  for where `CURSOR_API_KEY` comes from, what it enables, and how it differs from the desktop bridge
- [docs/ALEXA_VOICE_INTEGRATION.md](docs/ALEXA_VOICE_INTEGRATION.md)
  for Alexa v1 setup, account-linking rules, Node 22 validation requirements, and the final live-acceptance runbook
- [docs/KNOWLEDGE_LIBRARY.md](docs/KNOWLEDGE_LIBRARY.md)
  for the Knowledge Library model, explicit save/import rules, lexical-first retrieval, and source-grounded answer behavior
- [docs/BLUEBUBBLES_CHANNEL_PREP.md](docs/BLUEBUBBLES_CHANNEL_PREP.md)
  for the live BlueBubbles companion channel scope, config, safety model, and current limits
- [docs/ADDONS_AND_FEATURE_MATRIX.md](docs/ADDONS_AND_FEATURE_MATRIX.md)
  for deciding which skills and add-ons to enable
- [docs/TESTING_AND_RELEASE_RUNBOOK.md](docs/TESTING_AND_RELEASE_RUNBOOK.md)
  for release-quality validation
- [docs/README.md](docs/README.md)
  for the full local docs hub

## Repo Structure

Key areas in this repo:

- `src/` - core runtime, channels, IPC, scheduler, container integration
- `docs/` - local operator, onboarding, testing, and reference docs
- `assets/` - Andrea branding and repo visuals
- `container/skills/openclaw-market/` - bundled marketplace catalog
- `groups/` - per-chat working context and memory
- `data/` - runtime data, cache, and marketplace skill state

## Testing And Release Discipline

This repo is meant to be run methodically.
The standard validation gate is:

```bash
npm run test:major:ci
```

That runs:

1. formatting checks
2. type checking
3. linting
4. unit tests
5. production build

For live operator verification on a real machine, use:

```bash
npm run test:major
```

## Built On

Andrea_NanoBot is built on top of:

- [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw) for the secure runtime base
- [VoltAgent/awesome-openclaw-skills](https://github.com/VoltAgent/awesome-openclaw-skills) for curated skill discovery

This fork is where the Andrea-specific product experience, docs, Telegram UX, and operator workflow improvements live.

## License

MIT
