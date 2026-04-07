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
  Andrea is designed to be practically useful every day: tasks, reminders, research, coding help, guarded shopping approvals, and secure chat-based automation across multiple backend lanes.
</p>

<p align="center">
  Andrea now also has a bounded chief-of-staff layer for priorities, prep, and explainable decision support across Alexa, Telegram, and BlueBubbles.
</p>

<p align="center">
  <a href="docs/USER_GUIDE.md">User Guide</a>&nbsp; | &nbsp;
  <a href="docs/ADMIN_GUIDE.md">Admin Guide</a>&nbsp; | &nbsp;
  <a href="docs/ANDREA_OPENAI_BACKEND.md">OpenAI Backend</a>&nbsp; | &nbsp;
  <a href="docs/SETUP_AND_FEATURES_GUIDE.md">Setup Guide</a>&nbsp; | &nbsp;
  <a href="docs/KNOWLEDGE_LIBRARY.md">Knowledge Library</a>&nbsp; | &nbsp;
  <a href="docs/COMMUNICATION_COMPANION.md">Communication Companion</a>&nbsp; | &nbsp;
  <a href="docs/CHIEF_OF_STAFF_MODE.md">Chief-of-Staff Mode</a>&nbsp; | &nbsp;
  <a href="docs/MISSIONS_AND_EXECUTION.md">Missions</a>&nbsp; | &nbsp;
  <a href="docs/PROACTIVE_RITUALS.md">Proactive Rituals</a>&nbsp; | &nbsp;
  <a href="docs/CROSS_CHANNEL_HANDOFFS.md">Cross-Channel Handoffs</a>&nbsp; | &nbsp;
  <a href="docs/BLUEBUBBLES_CHANNEL_PREP.md">BlueBubbles</a>&nbsp; | &nbsp;
  <a href="docs/CHANNEL_COMMANDS_AND_ONBOARDING.md">Chat Commands</a>&nbsp; | &nbsp;
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

- Alexa daily orientation -> Telegram richer follow-through
- `What am I forgetting?` -> one open loop -> reminder, save, or tracking action
- `What's still open with Candace?` -> draft reply -> save to thread or remind later
- `Help me plan tonight / this weekend` -> mission proposal -> blocker -> confirmed next action
- source-grounded research -> richer detail -> save to library
- BlueBubbles message help -> summarize -> draft -> remind later -> optional Telegram escalation

These flows are now backed by one shared capability graph, one continuation/handoff layer, and one productized proof harness:

```bash
npm run debug:signature-flows
```

Treat that flagship-flow suite and harness as the main product proof. The subsystem harnesses are still useful, but they are supporting checks now.

## What Andrea Is

Andrea is one public assistant identity built on a secure NanoClaw runtime.
The product is conversation-first in Telegram, with deeper operator tooling behind a narrower admin surface.

What normal users should expect:

- reminders, follow-ups, and simple task help
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
- it is shorter, warmer, more spoken-first, and less menu-like than Telegram
- it now has a small bounded personality layer for softer transitions in low-stakes moments
- it supports daily guidance like morning brief, what matters most today, anything important, what am I forgetting, evening reset, and family-upcoming flows
- it keeps short-lived conversational continuity for turns like `anything else`, `what about Candace`, `what about Travis`, `say more`, `why`, `remember that`, `make that shorter`, `be a little more direct`, and `remind me before that`
- it supports request-driven Andrea Pulse asks such as `Andrea Pulse`, `tell me something interesting`, `give me a weird fact`, or `surprise me`
- it can handle bounded research or comparison asks briefly by voice and keep longer follow-through on Telegram when needed
- it can now orient you around open conversations, owed replies, and communication follow-through without turning Alexa into a full messaging client
- personalization remains explicit and consent-based
- use Node `22.22.2` for truthful Alexa validation on the operator host

Alexa is repo-ready and near-live validated on this host. As of April 7, 2026, the local listener, OAuth flow, public ingress, and pinned Node 22 runtime are healthy, but the remaining full-live step is one fresh human-operated signed voice or authenticated simulator run after importing `docs/alexa/interaction-model.en-US.json` and running `Build Model`.

When you do that last human step, this is the target validation flow:

- `Open Andrea Assistant`
- `What am I forgetting?`
- `Anything else?`
- `What about Candace?`
- `Be a little more direct.`
- optional `What should I remember tonight?`

Until that fresh signed run happens, do not call Alexa live-accepted on this host for this release-candidate pass.

Typed Alexa+ app chat is diagnosis-only right now. It may trigger a skill launch, but it does not count as live proof unless Andrea logs a real signed follow-up `IntentRequest` after launch.

After any interaction-model change, re-import `docs/alexa/interaction-model.en-US.json` in the Alexa Developer Console and run `Build Model` before treating live fallback as a repo bug.

For near-live conversation tuning on the operator host, use `npm run debug:alexa-conversation`.

## Andrea Pulse

Andrea Pulse is a separate request-driven personality feature. It is not a health check, not a replacement for `/ping`, and not a source of proactive spam.

- `/ping` remains pure operational health
- Pulse is currently request-only
- examples: `Andrea Pulse`, `tell me something interesting`, `give me a weird fact`, `surprise me`
- Pulse uses a small local curated catalog instead of adding a new provider dependency just for facts
- `say more` stays on the same Pulse item, while `anything else` can move to a different one

## BlueBubbles Companion Channel

BlueBubbles is now a real bounded Andrea messaging channel, not just prep work.

- one linked `bb:` conversation can share the same companion context as Telegram and Alexa through the existing `groupFolder`, defaulting to `main`
- Andrea now accepts inbound BlueBubbles webhooks, replies back to that same linked conversation, and stays text-only on BlueBubbles for V1
- BlueBubbles keeps companion-safe capabilities like daily guidance, reminders, follow-through, Knowledge Library summaries, draft follow-up, and short research summaries
- richer details and artifacts still hand off explicitly to Telegram when that is the safer surface
- BlueBubbles does **not** become a main control chat and does not expose work-cockpit or admin/runtime controls

On this host, BlueBubbles remains near-live for release-candidate proof until a reachable webhook/server is reproved.

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
- reminder phrasing still creates reminders, not Google Calendar events

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
