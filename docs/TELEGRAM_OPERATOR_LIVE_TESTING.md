# Telegram Operator Live Testing

This is an operator-only workflow.

Use it when you want this machine to send **real inbound Telegram test messages**
from your own Telegram account to Andrea, then capture the real replies.

This is different from the normal bot runtime:

- the bot runtime uses `TELEGRAM_BOT_TOKEN`
- this live-testing harness uses a **Telegram user session**
- it exists only so operators can run closed-loop validation against the real bot

Do not treat this as a public product feature.

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
TELEGRAM_LIVE_REPLY_TIMEOUT_MS=20000
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
- replies are printed to stdout
- runs are exclusive; if another auth/send/batch process is already active, wait for it to finish before starting a new one

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

What is not real:

- this is not a public feature for end users
- this does not replace the bot runtime
- this does not grant arbitrary Telegram account automation beyond the operator account you explicitly authenticate
