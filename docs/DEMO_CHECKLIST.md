# Andrea Demo Checklist

Use this when you want the smoothest possible live demo on the current operator host.

## Safe Demo Baseline

The default demo should stay on the currently validated public-safe surface:

- Telegram conversation
- quick replies for simple asks
- reminders and follow-ups
- `/help`
- `/commands`
- `/cursor_status`

Treat deeper operator workflows as optional same-day extras, not as the baseline demo.

## Preflight

Run before anyone is watching:

```bash
npm run setup -- --step verify
```

Confirm:

- `STATUS: success`
- `SERVICE: running`
- `CONFIGURED_CHANNELS: telegram`
- `CHANNEL_AUTH: {"telegram":"configured"}`
- `CREDENTIAL_RUNTIME_PROBE: ok`

Then open a DM with `@andrea_nanobot`.

## Default Demo Script

Use this order unless you have a good reason to change it:

1. `/start`
   - expected: quick onboarding
2. `/registermain`
   - expected: main chat registration success or an already-registered confirmation
3. `/help`
   - expected: short, warm guide with the narrow safe command set
4. `What's the meaning of life?`
   - expected: fast witty direct reply
5. `What is 56 + 778?`
   - expected: fast direct quick-reply math answer
6. `Remind me tomorrow at 3pm to call Sam`
   - expected: clear reminder confirmation, no helper chatter
7. `/cursor_status`
   - expected: honest status output that cleanly separates Cloud, desktop bridge, and runtime-route readiness

## Demo Success Criteria

The demo is healthy if:

- Andrea feels like one assistant
- answers are clean and answer-first
- simple asks resolve quickly
- reminders do not fall into heavy orchestration
- `/help` and `/commands` stay on the small safe surface
- `/cursor_status` is honest and easy to understand

## Optional Same-Day Extras

Only demo these if you validated them again the same day:

- Cursor Cloud job creation and follow-up
- desktop bridge terminal control
- Alexa voice ingress
- Amazon shopping flows
- marketplace/community skill flows

## What Not To Demo Casually

Do not casually demo:

- remote-control flows
- anything that depends on unvalidated desktop bridge setup
- anything that depends on optional integrations you have not rechecked

## If Something Feels Off

Use these in order:

1. `/ping`
2. `/help`
3. `/cursor_status`
4. `npm run setup -- --step verify`
5. `npm run services:restart`

If the runtime is healthy but replies still feel brittle, stay on quick replies, reminders, and `/cursor_status`.
