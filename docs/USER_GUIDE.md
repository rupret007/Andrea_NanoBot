# Andrea User Guide

This guide is for people who talk to Andrea in chat.
It explains the normal user experience, the small safe command set, and what to expect.

## What Andrea Is

Andrea is one public assistant identity.
Talk to her in normal language first. Use commands only when you want setup or a quick status check.

Andrea is strongest at:

- everyday questions and quick answers
- reminders, follow-ups, and simple task help
- summaries and light research
- project help in normal language
- fast direct replies for simple prompts, playful questions, and basic math
- optional Alexa Companion Mode if your admin enabled the linked voice channel

## First Five Minutes In Telegram

1. Open a direct message with `@andrea_nanobot`.
2. Run `/start`.
3. Run `/registermain`.
4. Run `/help` or `/commands`.
5. Send one plain-language request.

`/registermain` should make that same DM Andrea's main control chat. If operator-style features still look unavailable after that, ask the operator to check `registered_main_chat_jid` in `npm run services:status`.

Good first messages:

- `What's the meaning of life?`
- `Remind me tomorrow at 3pm to call Sam`
- `Summarize my tasks for today`
- `Research the best standing desks for a small office`

## Public-Safe Commands

These are the commands normal users should rely on:

- `/start` - quick onboarding
- `/help` - short in-chat guide
- `/commands` - safe command list
- `/features` - short capability overview
- `/ping` - basic health check
- `/chatid` - show the current Telegram chat ID and type
- `/registermain` - register this DM as Andrea's main control chat
- `/cursor_status` - safe Cursor readiness check only

Important Cursor rule:

- `/cursor_status` is safe to use.
- Deeper Cursor work, result-file retrieval, and terminal controls are operator-only and live in the admin guide.

## Best Ways To Ask

Andrea works best when your request includes the outcome you want.

Examples:

- `Remind me Friday at 2pm to check on the demo`
- `Summarize the last week of discussion and list the next three actions`
- `Research the best ergonomic keyboards under $150`
- `What is 1,234 plus 99?`

For short greetings, playful prompts, and basic math, Andrea may answer immediately through a fast direct-reply path. That is normal.

## What Andrea Can Do Right Now

- hold a normal conversation
- answer quick factual questions
- handle reminders and recurring follow-ups
- summarize notes, chats, and lightweight research
- help with project work in normal language
- show `/cursor_status` as a safe readiness check when the coding/integration path matters

If your admin enabled Alexa, Andrea can also answer short spoken questions like:

- `what should I know about today`
- `anything else`
- `what about Candace`
- `remind me before that`

Those voice features stay linked-account only and use explicit personalization controls.

If your admin enabled the work cockpit, Andrea can also keep one chat-scoped current work item across Cursor and Codex/OpenAI. That selection is operator-facing convenience only; explicit job or task ids still win whenever an admin uses them.

## What To Expect From `/cursor_status`

`/cursor_status` is not a job launcher.
It is a safe readiness check that shows:

- whether Cursor Cloud heavy-lift jobs are ready
- whether desktop bridge terminal control is ready
- whether local desktop agent execution is still conditional
- whether optional Cursor-backed runtime routing is configured

If something says `unavailable`, send the exact output and timestamp to your admin.

## What Not To Expect

Normal users should not expect:

- deep Cursor job control commands
- desktop bridge terminal commands
- Amazon ordering flows
- Alexa admin setup
- marketplace skill management

Those are operator-managed extras, not the baseline user surface.

## If Something Feels Off

1. Run `/ping`.
2. Run `/help`.
3. Run `/cursor_status` if the coding/status path seems off.
4. Send your admin the exact command, reply, and approximate time.

## One-Line Mental Model

Andrea is conversation-first.
Talk naturally, use the small safe command set when needed, and leave deeper operator workflows to your admin.
