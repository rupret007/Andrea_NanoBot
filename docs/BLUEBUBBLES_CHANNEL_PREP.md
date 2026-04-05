# BlueBubbles Channel Prep

BlueBubbles is prepared here as a future Andrea text-message channel. It is not a second assistant stack.

The design goal is simple:

- keep one Andrea core
- keep one shared capability graph
- add BlueBubbles as another channel adapter beside Telegram and Alexa

## Current Truth

Implemented in this pass:

- BlueBubbles config types and env parsing
- a scaffolded `bluebubbles` channel registration
- webhook payload normalization into Andrea's shared `NewMessage` shape
- `bb:<chatGuid>` and `bb:<handle>` identifiers for stable channel mapping
- health snapshot reporting for the scaffold
- capability-safety metadata so shared assistant actions can say whether they are safe for BlueBubbles

Not implemented yet:

- no live end-to-end webhook listener is claimed from this pass
- no fully wired outbound REST send path
- no arbitrary new-conversation creation
- no promise of live BlueBubbles transport without a real server and webhook environment

## Official API / Webhook Assumptions

This scaffold is based on official BlueBubbles documentation and design patterns, not copied product logic.

Anchoring assumptions:

- REST API support starts with BlueBubbles Server `0.2.0+`
- webhook support starts with BlueBubbles Server `1.0.0+`
- API auth is query-parameter based in the official docs (`guid`, `password`, or `token` depending on endpoint/server setup)
- webhooks are configured by URL plus selected event subscriptions

Because the official docs do not advertise signed webhook requests, Andrea treats webhook ingress conservatively.

## Safety Model

BlueBubbles defaults are intentionally strict:

- disabled by default
- webhook secret/path required for any future live ingress
- outbound send disabled by default
- future outbound send should stay reply-first to already known `bb:` chats before any broader send surface is considered

That keeps BlueBubbles preparation honest without over-promising transport that has not been live-proven yet.

## Andrea Channel Model

BlueBubbles should fit Andrea's existing channel adapter model:

- incoming webhook payload -> normalized `NewMessage`
- outgoing text send -> channel adapter boundary
- identity/contact mapping stays explicit
- capability execution stays in the shared assistant core
- channel-specific formatting stays at the edge

Current identifier shape:

- chat: `bb:<chatGuid>`
- sender/contact: `bb:<handle>`

## Config Surface

Current scaffold env:

```bash
BLUEBUBBLES_ENABLED=false
BLUEBUBBLES_BASE_URL=
BLUEBUBBLES_PASSWORD=
BLUEBUBBLES_WEBHOOK_PATH=/bluebubbles/webhook
BLUEBUBBLES_WEBHOOK_SECRET=
BLUEBUBBLES_SEND_ENABLED=false
```

Important truth:

- setting these values does not by itself make BlueBubbles live
- `BLUEBUBBLES_SEND_ENABLED=true` should not be used until a verified outbound REST path is added and tested

## Channel Shaping

BlueBubbles is intended to sit between Telegram and Alexa:

- more text-friendly than Alexa
- simpler and less markdown-heavy than Telegram
- no operator-only execution surfaces by default

Shared assistant actions that are good future fits:

- daily guidance
- household-aware guidance
- explicit thread lookup
- memory controls
- research summaries
- Andrea Pulse

Not a fit by default:

- operator-only current-work controls
- runtime shell/log surfaces
- raw admin actions

## Testing The Scaffold

Current truthful checks:

- `src/channels/bluebubbles.test.ts`
- `npm run debug:shared-capabilities`

Those prove:

- config parsing
- webhook normalization
- disabled-send safety behavior
- capability gating alongside Alexa and Telegram

Until a real BlueBubbles server and webhook environment are configured, that is the strongest truthful proof for this channel.
