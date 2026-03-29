# Andrea Demo Checklist

Use this when you want the smoothest possible live demo of Andrea on the current Windows host.

## 1) Preflight

Run these before the audience is watching:

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

## 2) Default Demo Script

Use this exact order unless you have a reason to change it:

1. `/start`
   Expected: quick-start onboarding text.
2. `/registermain`
   Expected: main chat registration success or “already registered” confirmation.
3. `/help`
   Expected: a short, clean command/capability guide with no Alexa, Amazon, or remote-control clutter.
4. `What's the meaning of life?`
   Expected: fast witty direct reply that starts with `42`.
5. `What is 56 + 778?`
   Expected: fast direct quick-reply math answer.
6. `Remind me tomorrow at 3pm to call Sam`
   Expected: protected assistant flow, not internal helper chatter.
7. `/cursor_status`
   Expected: clear status output for the coding/integration path.

## 3) Demo Success Criteria

The demo is on track if:

- Andrea feels like one assistant, not two stitched systems
- replies are answer-first
- simple asks resolve quickly
- reminders/tasks do not get swallowed by heavy orchestration
- `/help` and `/commands` only show the tight safe surface
- no internal route/helper/tool chatter leaks into user replies

## 4) What Not To Demo Today

Do not demo these unless you validated them again the same day:

- Alexa voice ingress
- live Amazon ordering
- marketplace/community skill flows
- remote-control flows
- deep Cursor cloud job creation/follow-up flows

## 5) If Something Feels Off

Use these in order:

1. `/ping`
2. `/help`
3. `/cursor_status`
4. `npm run setup -- --step verify`
5. `npm run services:restart`

If the runtime is healthy but a reply looks brittle, keep the demo on simple direct asks, reminders, and `/cursor_status`.
