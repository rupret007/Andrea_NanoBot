# Andrea Channel Commands And Onboarding

This guide covers the user-facing chat experience for Andrea, especially on Telegram.
Use it when you want a simple but complete explanation of how people should interact with the bot once setup is complete.

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

## 2) First-Time Telegram Onboarding

Recommended flow:

1. Open the bot in a direct message.
2. Run `/start`.
3. Run `/registermain`.
4. Run `/help` or `/commands`.
5. Send a plain-language request such as:
   - `Add "renew passport" to my to-do list`
   - `Remind me tomorrow at 3pm to call Sam`
   - `Research the best Apple Calendar and Outlook sync options for families`

If the bot is already configured, `/registermain` confirms whether this DM is already the main chat.

## 3) Group Behavior

In groups:

- mention the bot to trigger work
- ask for reminders, summaries, research, or project help
- keep sensitive admin actions in the main control chat when possible

Examples:

- `@Andrea remind the team every Monday at 9am to post weekly updates`
- `@Andrea summarize the last week of discussion and turn it into action items`
- `@Andrea search for a community skill that helps with GitHub Actions debugging`

## 4) Command Reference

Core chat commands:

- `/start` - quick-start welcome message
- `/help` - full in-chat guide
- `/commands` - command reference
- `/features` - capability overview
- `/ping` - health check
- `/chatid` - show current Telegram chat ID and type
- `/registermain` - register this DM as the main control chat

Cursor and remote-control commands:

- `/cursor_status` - show whether the Cursor/9router path is configured correctly
- `/cursor_test` - run a live end-to-end smoke test against the configured Cursor/9router gateway
- `/cursor_jobs` - list tracked Cursor cloud jobs for this chat
- `/cursor_create <prompt>` - create a new Cursor cloud coding job
- `/cursor_sync <agent_id>` - refresh one Cursor job status and artifact list
- `/cursor_stop <agent_id>` - request stop for a Cursor job
- `/cursor_followup <agent_id> <text>` - send follow-up instructions to a Cursor job
- `/cursor_conversation <agent_id> [limit]` - fetch recent Cursor conversation messages
- `/cursor_artifacts <agent_id>` - list tracked artifacts for a Cursor job
- `/cursor_remote` - start the remote control bridge from the main control chat
- `/cursor_remote_end` - end the remote control bridge

Amazon shopping commands:

- `/amazon_status` - show whether Amazon Business search and purchase flow are configured
- `/amazon_search <keywords>` - search Amazon Business products
- `/purchase_request <asin> <offer_id> [quantity]` - prepare an approval-gated purchase request
- `/purchase_requests` - list tracked purchase requests for this chat
- `/purchase_approve <request_id> <approval_code>` - approve one prepared request
- `/purchase_cancel <request_id>` - cancel a pending request

## 5) Capability Overview

Andrea is strongest when used as a practical assistant, not just a chatbot.

Typical jobs:

- to-do lists and reminders
- recurring scheduled tasks
- research and summaries
- Amazon shopping with explicit approval before any order submission
- coding help and repo work
- community skill discovery and enablement per chat

Calendar support today:

- first-party core calendar connectors are not built into the base runtime yet
- calendar support is available through approved marketplace/community skills
- current skill ecosystem includes Apple Calendar, Google Calendar, Outlook/Microsoft 365, and CalDAV-oriented options

That means calendar features are possible now, but they are still skill-driven rather than a single built-in core subsystem.

## 6) Good Prompting Patterns

Requests work best when they are specific about outcome, timing, and scope.

Good examples:

- `@Andrea remind me every weekday at 8:30am to review my calendar`
- `@Andrea research the best Outlook and Apple Calendar sync tools and give me a short comparison`
- `@Andrea enable a vetted calendar skill for this chat if one supports Apple Calendar`
- `@Andrea summarize my tasks for today and suggest the top three priorities`
- `@Andrea find a standing desk on Amazon and prepare an approval request for the best one`

## 7) UX Principles In This Repo

The intended UX direction is:

- plain-language interaction first
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
- use `/cursor_status` or `/cursor_test` when testing Cursor-backed routing
- use `/cursor_jobs` and `/cursor_sync <agent_id>` when debugging Cursor cloud job lifecycle
- use `/amazon_status` before testing shopping
- use `/purchase_requests` if someone forgot which request id Andrea already prepared

For operator-side troubleshooting, also see:

- [SETUP_AND_FEATURES_GUIDE.md](SETUP_AND_FEATURES_GUIDE.md)
- [AMAZON_SHOPPING_AND_APPROVALS.md](AMAZON_SHOPPING_AND_APPROVALS.md)
- [DEBUG_CHECKLIST.md](DEBUG_CHECKLIST.md)
- [TESTING_AND_RELEASE_RUNBOOK.md](TESTING_AND_RELEASE_RUNBOOK.md)
