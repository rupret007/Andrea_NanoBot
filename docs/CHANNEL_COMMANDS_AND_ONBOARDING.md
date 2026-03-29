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

- `@Andrea remind the team every Monday at 9am to post weekly updates`
- `@Andrea summarize the last week of discussion and turn it into action items`
- `@Andrea research the best ergonomic keyboards under $150`

## 4) Command Reference

Core chat commands:

- `/start` - quick-start welcome message
- `/help` - full in-chat guide
- `/commands` - command reference
- `/features` - capability overview
- `/ping` - health check
- `/chatid` - show current Telegram chat ID and type
- `/registermain` - register this DM as the main control chat

Cursor commands:

- `/cursor_status` - show whether the Cursor/9router path is configured correctly
- `/cursor_models [filter]` - list available Cursor Cloud models (optionally filtered)
- `/cursor_test` - run a live end-to-end smoke test against the configured Cursor/9router gateway
- `/cursor_jobs` - list tracked Cursor cloud jobs for this chat
- `/cursor_create [options] <prompt>` - create a new Cursor cloud coding job
- `/cursor_create --repo <url> --ref <branch> --model <id> <prompt>` - create a job with explicit repo/model targeting
- `/cursor_sync <agent_id>` - refresh one Cursor job status and artifact list
- `/cursor_stop <agent_id>` - request stop for a Cursor job
- `/cursor_followup <agent_id> <text>` - send follow-up instructions to a Cursor job
- `/cursor_conversation <agent_id> [limit]` - fetch recent Cursor conversation messages
- `/cursor_artifacts <agent_id>` - list tracked artifacts for a Cursor job
- `/cursor_artifact_link <agent_id> <absolute_path>` - generate a temporary download link for one tracked Cursor artifact

Voice and Alexa commands:

- `/alexa_status` - show whether Alexa voice ingress is configured, listening, and locked down the way you expect

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
- optional admin-enabled extras only after they are validated in that environment

## 6) Good Prompting Patterns

Requests work best when they are specific about outcome, timing, and scope.

Good examples:

- `@Andrea remind me every weekday at 8:30am to review my priorities`
- `@Andrea research the best Outlook alternatives for a small team and give me a short comparison`
- `@Andrea summarize my tasks for today and suggest the top three priorities`
- `@Andrea find a standing desk on Amazon and prepare an approval request for the best one`

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
- use `/cursor_status` or `/cursor_test` when testing Cursor-backed routing
- use `/cursor_jobs` and `/cursor_sync <agent_id>` when debugging Cursor cloud job lifecycle
- use `/alexa_status` before testing the Alexa skill endpoint
- use `/amazon_status` before testing shopping
- use `/purchase_requests` if someone forgot which request id Andrea already prepared

Runtime behavior note:

- for direct conversational asks, Andrea now prefers a fast local reply path for simple questions before escalating to heavier runtime work
- experimental surfaces should stay out of the demo until they have been validated in that exact environment

For operator-side troubleshooting, also see:

- [SETUP_AND_FEATURES_GUIDE.md](SETUP_AND_FEATURES_GUIDE.md)
- [ALEXA_VOICE_INTEGRATION.md](ALEXA_VOICE_INTEGRATION.md)
- [AMAZON_SHOPPING_AND_APPROVALS.md](AMAZON_SHOPPING_AND_APPROVALS.md)
- [DEBUG_CHECKLIST.md](DEBUG_CHECKLIST.md)
- [TESTING_AND_RELEASE_RUNBOOK.md](TESTING_AND_RELEASE_RUNBOOK.md)
