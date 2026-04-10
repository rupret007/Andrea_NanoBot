# Andrea Channel Commands And Onboarding

This guide explains the public-safe Telegram experience for Andrea.
Use it when you want to know how people should actually interact with the bot once setup is complete.

For the shorter day-to-day version, start with [USER_GUIDE.md](USER_GUIDE.md).

## Public-Safe Surface

Andrea is conversation-first.
Most people should start with a normal message, not a command.

Stable user-safe behaviors:

- direct conversation in DMs
- mention-based requests in groups
- reminders and follow-ups
- calendar scheduling when that path is enabled
- fast direct replies for simple questions and basic math
- research and summaries in normal language
- a small public-safe command set

Surface roles:

- Telegram is Andrea's richest day-to-day companion surface.
- Alexa is the shorter voice surface when your operator enabled the custom skill.
- BlueBubbles is the bounded personal messaging surface and stays mention-required.

## First-Time Telegram Onboarding

Recommended direct-message flow:

1. Open a DM with the bot.
2. Run `/start`.
3. Run `/registermain`.
4. Run `/help` or `/commands`.
5. Send a plain-language request.

Good first requests:

- `What's the meaning of life?`
- `Remind me tomorrow at 3pm to call Sam`
- `Summarize my tasks for today`
- `Research the best standing desks for small apartments`

## Group Behavior

In groups:

- mention Andrea when you want action
- use her for reminders, summaries, research, and project help
- keep high-trust admin actions in the main control chat

Examples:

- `@your_bot_username remind the team every Monday at 9am to post weekly updates`
- `@your_bot_username summarize this thread and list action items`
- `@your_bot_username research the best ergonomic keyboards under $150`

## Public-Safe Command Reference

- `/start` - quick-start welcome
- `/help` - short in-chat guide
- `/commands` - safe command list
- `/features` - short capability overview
- `/ping` - basic health check
- `/chatid` - show the current Telegram chat ID and type
- `/registermain` - register this DM as the main control chat
- `/cursor_status` - safe Cursor readiness check only

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
2. Run `/commands`.
3. Run `/ping`.
4. Run `/cursor_status` if the issue touches coding/status readiness.
5. Ask your admin to check the admin guide and release runbook.
