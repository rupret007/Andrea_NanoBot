# Andrea Channel Commands And Onboarding

This guide covers the user-facing chat experience for Andrea, especially on Telegram.
Use it when you want a simple but complete explanation of how people should interact with the bot once setup is complete.

If you want a shorter day-to-day version, start with [USER_GUIDE.md](USER_GUIDE.md).

## 1) How Chat UX Works

There are three common chat modes:

- Direct chat with the bot:
  - best for setup, private requests, and admin tasks
  - slash commands work naturally here
- Group chat:
  - best for shared reminders, project work, and team coordination
  - mention the bot when you want it to act
- Main control chat:
  - one chat is registered as the main control chat
  - use it for administration, cross-group work, and higher-trust control actions

For short questions like greetings, playful prompts, and simple math, Andrea may answer immediately through a direct quick-reply path. That fast path is intentional and exists to keep simple interactions stable and natural.

## 2) First-Time Telegram Onboarding

Recommended flow:

1. Open the bot in a direct message.
2. Run `/start`.
3. Run `/registermain`.
4. Run `/help` or `/commands`.
5. Send a plain-language request such as:
   - `Add "renew passport" to my to-do list`
   - `Remind me tomorrow at 3pm to call Sam`
   - `Research the best standing desks for small apartments`

If the bot is already configured, `/registermain` confirms whether this DM is already the main chat.

## 3) Group Behavior

In groups:

- mention the bot to trigger work
- ask for reminders, summaries, research, or project help
- keep sensitive admin actions in the main control chat when possible

Examples:

- `@your_bot_username remind the team every Monday at 9am to post weekly updates`
- `@your_bot_username summarize the last week of discussion and turn it into action items`
- `@your_bot_username research the best ergonomic keyboards under $150`

## 4) Command Reference

Core chat commands:

- `/start` - quick-start welcome message
- `/help` - full in-chat guide
- `/commands` - command reference
- `/features` - capability overview
- `/ping` - health check
- `/chatid` - show current Telegram chat ID and type
- `/registermain` - register this DM as the main control chat

Operator-safe status:

- `/cursor_status` - show safe Cursor readiness, including Cloud coding jobs, desktop bridge terminal control, desktop agent-job compatibility, and runtime-route status

Advanced operator workflows still exist, but they are restricted to Andrea's main control chat and should stay in the admin guide and out of the default demo unless they were validated the same day. That includes Cloud job control and any desktop bridge session or terminal actions.

## 5) Capability Overview

Andrea is strongest when used as a practical assistant, not just a chatbot.

Typical jobs:

- to-do lists and reminders
- recurring scheduled tasks
- research and summaries
- coding help and repo work
- optional admin-enabled extras only after they are validated in that environment

## 6) Good Prompting Patterns

Requests work best when they are specific about outcome, timing, and scope.

Good examples:

- `@your_bot_username remind me every weekday at 8:30am to review my priorities`
- `@your_bot_username research the best Outlook alternatives for a small team and give me a short comparison`
- `@your_bot_username summarize my tasks for today and suggest the top three priorities`
- `@your_bot_username what's the meaning of life?`

## 7) UX Principles In This Repo

The intended UX direction is:

- plain-language interaction first
- quick direct answers for simple asks before heavier orchestration
- minimal command memorization
- helpful slash commands for discovery and setup
- isolated, low-surprise behavior per chat
- secure capability expansion through explicit skill enablement

## 8) Troubleshooting

If people are confused in the channel, start here:

- run `/help`
- run `/commands`
- verify the bot is in a direct chat if `/registermain` is needed
- use `/chatid` to confirm the current chat identity
- use `/cursor_status` when checking the coding/status path

Runtime behavior note:

- for direct conversational asks, Andrea now prefers a fast local reply path for simple questions before escalating to heavier runtime work
- experimental surfaces should stay out of the demo until they have been validated in that exact environment

For operator-side troubleshooting, also see:

- [SETUP_AND_FEATURES_GUIDE.md](SETUP_AND_FEATURES_GUIDE.md)
- [ADMIN_GUIDE.md](ADMIN_GUIDE.md)
- [DEBUG_CHECKLIST.md](DEBUG_CHECKLIST.md)
- [TESTING_AND_RELEASE_RUNBOOK.md](TESTING_AND_RELEASE_RUNBOOK.md)
