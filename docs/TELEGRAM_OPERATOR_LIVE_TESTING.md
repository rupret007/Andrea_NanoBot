# Telegram Operator Live Testing

This is an operator-only workflow.

Use it when you want this machine to send **real inbound Telegram test messages**
from your own Telegram account to Andrea, then capture the real replies.

This is different from the normal bot runtime:

- the bot runtime uses `TELEGRAM_BOT_TOKEN`
- this live-testing harness uses a **Telegram user session**
- it exists only so operators can run closed-loop validation against the real bot

Do not treat this as a public product feature.

Andrea_NanoBot remains the shared Telegram-first shell in the merged repo:

- `/cursor` stays the primary taught operator surface
- Cursor remains the validated rich backend lane
- `/runtime-*` is temporary secondary scaffolding for the integrated `andrea_runtime` lane

## What It Can Do

With a configured Telegram user session, this machine can:

- authenticate your Telegram user account once
- store the session locally under `store/telegram-user.session`
- send real test messages to Andrea from your own account
- wait for Andrea's real reply in the same DM
- run a repeatable batch of live messages

Current scripts:

```bash
npm run telegram:user:auth
npm run telegram:user:send -- "What's the meaning of life?"
npm run telegram:user:send -- --reply-to 1234 "/cursor-sync"
npm run telegram:user:tap -- 1234 1
npm run telegram:user:batch
```

## Required Setup

Create Telegram API credentials at [my.telegram.org](https://my.telegram.org).

Set these in `.env` or your shell:

```bash
TELEGRAM_USER_API_ID=123456
TELEGRAM_USER_API_HASH=your_api_hash
```

Optional:

```bash
TELEGRAM_USER_SESSION=...
TELEGRAM_USER_SESSION_FILE=store/telegram-user.session
TELEGRAM_TEST_TARGET=@andrea_nanobot
TELEGRAM_TEST_CHAT_ID=tg:123456789
TELEGRAM_PHONE=+15551234567
TELEGRAM_USER_AUTH_MODE=qr
TELEGRAM_USER_2FA_PASSWORD=...
TELEGRAM_LIVE_REPLY_TIMEOUT_MS=30000
TELEGRAM_LIVE_REPLY_SETTLE_MS=1500
```

Notes:

- `TELEGRAM_TEST_TARGET` can be a username like `@andrea_nanobot`
- `TELEGRAM_TEST_CHAT_ID` can be the stored jid form like `tg:123456789`
- if both are missing, the harness tries `TELEGRAM_BOT_USERNAME` and then the live bot token

## One-Time Login

Recommended default:

- `TELEGRAM_USER_AUTH_MODE=qr`

That lets this machine generate a QR login image instead of forcing a phone-number prompt.

Run:

```bash
npm run telegram:user:auth
```

If `TELEGRAM_USER_AUTH_MODE=qr`, the harness will:

- write a QR image to `store/telegram-user-login.png`
- write login details to `store/telegram-user-login.txt`
- update `store/telegram-user-auth-status.json`
- wait for you to scan the QR in Telegram:
  - `Settings`
  - `Devices`
  - `Link Desktop Device`

If `TELEGRAM_USER_AUTH_MODE=phone`, the harness will prompt for:

- phone number
- Telegram login code
- 2FA password if Telegram asks for it

If QR auth still hits Telegram 2FA, set `TELEGRAM_USER_2FA_PASSWORD` or rerun the auth command interactively.

After a successful login, the session is saved locally to:

```text
store/telegram-user.session
```

`store/` is already gitignored.

## Send One Real Message

```bash
npm run telegram:user:send -- "What is 56 + 778?"
```

Expected behavior:

- the harness sends the message as your Telegram user
- Andrea receives it through the real bot path
- the harness waits for Andrea's reply
- replies are printed to stdout with bot reply ids
- if a bot reply contains inline buttons, the harness prints visible button labels too
- runs are exclusive; if another auth/send/batch process is already active, wait for it to finish before starting a new one
- the default 30s reply timeout is intentional because live Cursor Cloud syncs can take longer than a quick chat reply

Reply-linked variant:

```bash
npm run telegram:user:send -- --reply-to 1234 "/cursor-sync"
```

Use this when you want to reply to a specific Cursor card without retyping a raw job id.

## Tap An Inline Button

```bash
npm run telegram:user:tap -- 1234 1
npm run telegram:user:tap -- 1234 "Results"
```

Expected behavior:

- the harness fetches the target bot message
- it resolves a button by exact label first, then by 1-based visible index
- it sends the callback action as your Telegram user session
- it captures Andrea's resulting replies just like `telegram:user:send`
- if the button only edits the existing dashboard message, the harness prints the edited source message and its updated buttons

## Run The Default Live Batch

```bash
npm run telegram:user:batch
```

Default batch:

- `/start`
- `/help`
- `What's the meaning of life?`
- `What is 56 + 778?`
- `Thanks`
- `ok`
- `Remind me tomorrow at 3pm to call Sam`
- `/cursor_status`

For Cursor-specific operator validation, prefer this live workflow:

1. `/cursor`
2. note the dashboard message id from stdout
3. `npm run telegram:user:tap -- <dashboard_id> "Jobs"`
4. `npm run telegram:user:tap -- <dashboard_id> 1`
5. `npm run telegram:user:tap -- <dashboard_id> "Refresh"`
6. `npm run telegram:user:tap -- <dashboard_id> "View Output"`
7. `npm run telegram:user:tap -- <dashboard_id> "Results"`
8. `npm run telegram:user:tap -- <dashboard_id> "Continue"`
9. `npm run telegram:user:send -- --reply-to <dashboard_id> "continue with ..."` for a Cloud follow-up
10. `npm run telegram:user:tap -- <dashboard_id> "New Cloud Job"` when you want to exercise the create wizard

Raw ids still work, but the normal Telegram operator path is now dashboard-, tile-, and reply-driven.

If you are validating the merged `andrea_runtime` lane instead of Cursor:

- keep the test in the main control chat
- start from `/cursor`, then tap `Codex/OpenAI`
- use `Recent Work` or `Current Task` there before falling back to `/runtime-*`
- treat `/runtime-*` as secondary scaffolding, not the primary shell
- only expect live execution when `ANDREA_RUNTIME_EXECUTION_ENABLED=true` and the Codex/OpenAI runtime has been validated on this host

## Live Troubleshooting Loop

When a real Telegram turn fails or goes quiet, keep the debug loop tight and temporary.

Recommended operator-only flow in the main control chat:

1. `/debug-status`
2. `/debug-level debug chat 60m`
3. `/debug-level verbose component:container 30m`
4. reproduce the failing turn
5. `/debug-logs current 120`
6. `/debug-logs stderr 120`
7. `/debug-reset all`

If you restart services during this loop, wait for restart to finish and only then run `npm run setup -- --step verify`.

Use this to distinguish:

- credential/auth/endpoint failures
- assistant runtime startup failures before first output
- chat-specific routing or state issues

Important truth:

- `setup verify` now reports both `CREDENTIAL_RUNTIME_PROBE` and `ASSISTANT_EXECUTION_PROBE`
- if the assistant execution probe fails with `initial_output_timeout`, that is a runtime-startup/output problem, not automatically a missing-key problem
- `/debug-*` is troubleshooting-only and should stay out of the public command story

## Security Notes

Keep these rules:

- use only your own Telegram account or a dedicated test account
- do not point this at real user chats or production groups
- do not paste `TELEGRAM_USER_SESSION` into screenshots or tickets
- keep this tooling operator-only
- do not expose it through Andrea's public Telegram command surface
- do not run multiple `telegram:user:*` commands in parallel against the same chat; the harness now locks to prevent cross-captured replies

## Truth Boundary

What is real:

- real inbound Telegram testing from this machine is possible once user-session auth is configured
- this is useful for regression loops against the live bot
- the merged repo still teaches `/cursor` first; `/runtime-*` is only for secondary runtime-lane validation

What is not real:

- this is not a public feature for end users
- this does not replace the bot runtime
- this does not grant arbitrary Telegram account automation beyond the operator account you explicitly authenticate
