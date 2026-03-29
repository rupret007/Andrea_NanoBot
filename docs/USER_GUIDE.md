# Andrea User Guide

This guide is for people who use Andrea in chat.
It focuses on what to do, what commands matter, and what to expect.

## 1) What Andrea Is

Andrea is one assistant identity across chat surfaces.

You can use Andrea for:

- reminders and to-do help
- summaries and research
- coding help and Cursor-linked job control
- shopping research and approval-gated purchase requests
- optional voice access through Alexa

## 2) First 5 Minutes (Telegram)

1. Open a direct message with `@andrea_nanobot`.
2. Run `/start`.
3. Run `/registermain`.
4. Run `/help` or `/commands`.
5. Send one plain-English request.

Try:

- `Add "renew passport" to my to-do list`
- `Remind me tomorrow at 3pm to call Sam`
- `Research the best calendar setup for Apple + Outlook households`

## 3) Daily Commands You Actually Need

Core:

- `/help`
- `/commands`
- `/features`
- `/ping`

Cursor/coding:

- `/cursor_status`
- `/cursor_models [filter]`
- `/cursor_jobs`
- `/cursor_create [options] <prompt>`
- `/cursor_sync <agent_id>`
- `/cursor_followup <agent_id> <text>`
- `/cursor_conversation <agent_id> [limit]`
- `/cursor_artifacts <agent_id>`
- `/cursor_artifact_link <agent_id> <absolute_path>`

Amazon shopping:

- `/amazon_status`
- `/amazon_search <keywords>`
- `/purchase_request <asin> <offer_id> [quantity]`
- `/purchase_requests`
- `/purchase_approve <request_id> <approval_code>`
- `/purchase_cancel <request_id>`

Voice:

- `/alexa_status`

## 4) Best Request Patterns

Andrea performs best when your request includes outcome + timing + scope.

Examples:

- `Summarize my pending tasks and suggest top 3 for today.`
- `Remind me every weekday at 8:30am to review my calendar.`
- `Find an ergonomic keyboard on Amazon and prepare an approval request.`
- `Create a Cursor job to fix flaky auth tests and open a PR.`

## 5) Group Chat Use

In groups, mention Andrea when you want action.

Examples:

- `@Andrea summarize this thread and list action items`
- `@Andrea remind this group every Monday at 9am to post weekly updates`

For sensitive admin actions, use the main control chat.

## 6) Alexa Voice Use

If Alexa is configured by your admin:

1. Open the Alexa skill by invocation name.
2. Ask for the same kinds of tasks you use in Telegram.
3. Use `/alexa_status` in Telegram if voice behavior seems wrong.

Common voice requests:

- `Ask Andrea assistant to remind me tomorrow at 8am to stretch.`
- `Ask Andrea assistant to research standing desks for small apartments.`

## 7) Shopping Safety (Important)

Andrea does not silently buy things.

Expected flow:

1. You search products.
2. You create a purchase request.
3. You review request details and approval code.
4. You explicitly approve or cancel.

If a request feels wrong, run `/purchase_cancel <request_id>`.

## 8) What Andrea Should Not Do

Tell your admin if you see any of these:

- internal system chatter in normal replies
- surprise order behavior without approval
- cross-chat data that should not be visible in your current chat
- obvious secret/token leakage in responses

## 9) Quick Troubleshooting

If something is off:

1. Run `/ping`.
2. Run `/help`.
3. Run `/cursor_status`, `/amazon_status`, or `/alexa_status` for the feature you are using.
4. If the issue persists, send the exact command and timestamp to your admin.

## 10) One-Line Mental Model

Andrea is your front door.
Ask in plain language first, then use commands only when you need control.
