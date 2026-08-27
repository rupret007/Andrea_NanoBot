# Andrea Channel Commands And Onboarding

This guide explains the public-safe Telegram experience for Andrea.
Use it when you want to know how people should actually interact with the bot once setup is complete.

For the shorter day-to-day version, start with [USER_GUIDE.md](USER_GUIDE.md).

## Public-Safe Surface

Andrea is conversation-first.
Most people should start with a normal message, not a command.

Stable user-safe behaviors:

- direct conversation in DMs
- guided setup for what Andrea should track for you
- mention-based requests in groups
- reminders and follow-ups
- calendar scheduling and schedule questions
- planning, meal planning, groceries, errands, bill follow-through, and reply help
- zero-setup capture for groceries, errands, bills, meal ideas, household checklists, and tonight items
- fast direct replies for simple questions and basic math
- research and summaries in normal language
- a small public-safe command set

Surface roles:

- Telegram is Andrea's richest day-to-day companion surface.
- Alexa is the shorter voice surface when your operator enabled the custom skill.
- BlueBubbles is an optional bounded Messages bridge when available. Only the configured owner self-thread is a control surface; ordinary contact and group threads are data-only.
- Alexa should read back only the most useful slice of a list and hand richer review to Telegram when needed.
- BlueBubbles should stay capture-and-readout only for lists, with fuller management handed off to Telegram.

UX defaults for Telegram:

- `/start` should be a one-line bind reminder, not a wall of help text or a programmed menu
- `/help` should stay the same short reminder: just talk, and `/registermain` if the DM is not bound
- `/commands` should stay focused on setup and status, not become the primary way to talk to Andrea or a thinking-command wall
- `/thinking`, `/council`, `/cognition`, `/memory`, and `/learning` still work if typed; they should explain how Andrea reasons, plans tasks, and learns without exposing hidden provider traces
- `/features` still works if typed; it should not appear in the Telegram command menu
- Telegram menus stay bind-only in DMs (`/registermain`, `/mainchat`) and empty in groups
- list capture should work without setup friction and seed sensible default groups on first use
- Telegram may show bounded inline actions like `Done`, `Reopen`, `Defer`, `Remind`, `Move`, or `Convert` after a natural-language list readout
- longer list review should stay grouped by practical buckets like Groceries, Errands, Bills This Week, Meals This Week, Household Open, Tonight, and Weekend instead of becoming a flat dump
- smart household asks should work in plain language first, like `what do we need from the store`, `what's left for tonight`, `what should I handle this weekend`, or `what's missing for dinner`

## First-Time Telegram Onboarding

Recommended direct-message flow:

1. Open a DM with `@andrea_nanobot`.
2. Send a plain-language request. `/start` is a short welcome, not a menu wall.
3. Run `/registermain` once if this DM should be the main Andrea chat.
4. Run `/mainchat` only if a chat says it is not set up.
5. Type `/help` or `/commands` only if you want setup or status. Ordinary chat should just be Bob talking.

If `/registermain` says a main chat is already registered, that is not a failure by itself. Run `/mainchat`; it will print the current registered main chat and whether the current DM matches it. If you ask for calendar or operator features from a different DM, Andrea should tell you the current main chat and send you back through `/mainchat` plus `/registermain` instead of replying with generic setup text.

Good first requests:

- `Help me set this up`
- `What's on my calendar tomorrow?`
- `Add milk to my shopping list`
- `What's on groceries?`
- `What do we need from the store?`
- `Make this a monthly bill`
- `Remind me to take my pills at 9`
- `What bills do I need to pay this week?`
- `What's left for tonight?`
- `What should I handle this weekend?`
- `What's missing for dinner?`
- `What should I say back?`
- `Help me plan tonight`
- `Help me plan meals this week`

## Group Behavior

In groups:

- mention Andrea when you want action
- use her for reminders, summaries, research, and project help
- keep high-trust admin actions in the main control chat
- keep the visible command menu empty; group chats should feel conversation-first

Examples:

- `@your_bot_username remind the team every Monday at 9am to post weekly updates`
- `@your_bot_username summarize this thread and list action items`
- `@your_bot_username what still needs attention here`

## Public-Safe Command Reference

These commands are for onboarding, setup, and status.
Most users should still start with a plain-language request.

- `/start` - short bind reminder
- `/help` - short "just talk" reminder
- `/commands` - setup and status commands
- `/features` - what Andrea is best at in Telegram
- `/ping` - basic health check
- `/chatid` - show the current Telegram chat ID and type
- `/registermain` - register this DM as the main control chat
- `/mainchat` - show the registered main control chat and exact recovery steps
- `/thinking` - show smart auto thinking mode plus `ultrathink` / `ultracode` / `think harder` / `quick answer` controls
- `/council` - show redacted council quality, calibration, task-ease drills, and provider reliability
- `/cognition` - show the cognitive task engine, Cognitive Executive route/snapshot, Cognitive Workspace packet, active program, durable goal, blackboard trail, autonomy budget, Runtime Spine checkpoints, Supervisor Core handoffs/blackboard, Session Graph continuity clusters, continuity cockpit action queue, Agency Convergence Loop state, evidence gaps, truth support, World Model proof debt, approval blockers, and next repair action
- `/memory` - show memory behavior and natural memory controls
- `/learning` - show durable learning policy, learned skill playbooks, and safety rails
- `/forget` - show how to disable a remembered detail
- `/cursor_status` - safe Cursor readiness check only

Menu behavior:

- in DMs, the Telegram command menu stays bind-only: `/registermain` and `/mainchat`
- in groups, the Telegram command menu stays empty so shared chats stay conversation-first

Important boundary:

- `/cursor_status` is the only public-safe Cursor command.
- Deeper Cursor work, result retrieval, and desktop terminal commands are operator-only and should stay in the admin guide.
- The full operator and internal command inventory lives in [COMMAND_SURFACE_REFERENCE.md](COMMAND_SURFACE_REFERENCE.md).

## What `/cursor_status` Means For Users

`/cursor_status` is a readiness check, not a work command.
It can safely tell you whether:

- Cursor Cloud jobs are ready
- desktop bridge terminal control is ready
- local desktop agent execution is still conditional
- optional Cursor-backed runtime routing is configured

If it says something is `unavailable`, that usually means your operator has not configured that path yet or it is unhealthy right now.

## UX Principles

This repo keeps the public chat experience intentionally small:

- plain-language interaction first
- slash commands for onboarding and status, not for everything
- quick replies for simple asks
- deeper operator tooling kept out of the default user surface
- no helper chatter in normal replies

## Troubleshooting

If the channel experience feels wrong:

1. Run `/help`.
2. Run `/mainchat` and confirm the current DM matches the registered main chat.
3. Run `/commands`.
4. Run `/ping`.
5. Retry the plain-language ask, such as `What's on my calendar tomorrow?`.
6. Run `/cursor_status` if the issue touches coding/status readiness.
7. Ask your admin to check the admin guide and release runbook.
