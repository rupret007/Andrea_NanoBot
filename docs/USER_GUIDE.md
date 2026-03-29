# Andrea User Guide

This guide is for people who use Andrea in chat.
It focuses on what to do, what commands matter, and what to expect.

## 1) What Andrea Is

Andrea is one assistant identity across chat surfaces.

You can use Andrea for:

- fast answers to simple questions, playful prompts, and basic math
- reminders and to-do help
- summaries and research
- coding help and operator-safe status checks
- optional admin-enabled extras when your operator has validated them

## 2) First 5 Minutes (Telegram)

1. Open a direct message with `@andrea_nanobot`.
2. Run `/start`.
3. Run `/registermain`.
4. Run `/help` or `/commands`.
5. Send one plain-English request.

Try:

- `Add "renew passport" to my to-do list`
- `Remind me tomorrow at 3pm to call Sam`
- `Research the best standing desks for a small office`
- `What's the meaning of life?`

## 3) Daily Commands You Actually Need

Core:

- `/help`
- `/commands`
- `/features`
- `/ping`
- `/chatid`
- `/registermain`

Operator-safe status:

- `/cursor_status`

Optional note:

- Alexa, shopping, marketplace skills, and calendar-oriented skills are operator-enabled extras rather than the default demo path
- advanced Cursor, shopping, and voice control workflows live in the admin guide, are restricted to the main control chat, and should be used only after same-day validation

## 4) Best Request Patterns

Andrea performs best when your request includes outcome + timing + scope.

For short conversational asks like greetings, playful questions, or simple math, Andrea may answer immediately through a direct reply path instead of routing the request through the heavier helper flow. That is intentional and is part of the reliability design.

Examples:

- `Summarize my pending tasks and suggest top 3 for today.`
- `Remind me every weekday at 8:30am to review my priorities.`
- `What's the meaning of life?`
- `What is 56 + 778?`

## 5) Group Chat Use

In groups, mention Andrea when you want action.

Examples:

- `@your_bot_username summarize this thread and list action items`
- `@your_bot_username remind this group every Monday at 9am to post weekly updates`

For sensitive admin actions, use the main control chat.

## 6) Optional Extras

Alexa, shopping, and deeper coding workflows may exist in some environments, but they are not part of the default demo path.

If your admin tells you one of those is enabled, treat it as an opt-in extra rather than the baseline experience.

## 7) What Andrea Should Not Do

Tell your admin if you see any of these:

- internal system chatter in normal replies
- surprise order behavior without approval
- cross-chat data that should not be visible in your current chat
- obvious secret/token leakage in responses

## 8) Quick Troubleshooting

If something is off:

1. Run `/ping`.
2. Run `/help`.
3. Run `/cursor_status` if the coding/status path seems off.
4. If the issue persists, send the exact command and timestamp to your admin.

## 9) One-Line Mental Model

Andrea is your front door.
Ask in plain language first, then use commands only when you need control.
