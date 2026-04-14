# BlueBubbles Companion Channel

BlueBubbles is Andrea's optional calm, text-first Messages bridge for personal messaging.

It is not a second operator shell.
It is not a passive inbox bot.
It is one more channel edge on the shared Andrea core.

## Current Truth

Current host reality for the Windows operator machine:

- the BlueBubbles desktop app is installed and connected to the Mac-side server
- Andrea now has live `BLUEBUBBLES_*` config loaded on this host
- Andrea can currently reach the configured BlueBubbles endpoint from this Windows host and the webhook is still registered
- BlueBubbles is currently **live_proven** as a Messages bridge on this host because the bridge is healthy and the canonical same-thread `message_action` proof chain was recorded on April 14, 2026
- the canonical proof thread is `bb:iMessage;-;+14695405551`, and alias support remains enabled for `bb:iMessage;-;jeffstory007@gmail.com`
- Telegram remains Andrea's dependable main messaging surface, while BlueBubbles is now a proven optional bridge

Use these operator truth surfaces:

- `npm run services:status`
- `npm run setup -- --step verify`
- `npm run debug:status`
- `npm run debug:bluebubbles -- --live`
- `npm run debug:pilot`

OpenBubbles is still an operator-only feasibility track on this PC. Its official docs support the Mac-offline goal after activation or renewal, but Andrea does not yet have a supported Windows-native observation/reply surface to bind to there.

## V1 Scope

BlueBubbles V1 is intentionally narrower than Telegram, but it is no longer pinned to one linked thread.

Andrea now supports:

- all synced personal and group chats when `BLUEBUBBLES_CHAT_SCOPE=all_synced`
- `@Andrea` mention required
- ordinary chat when it is clearly directed at Andrea
- daily guidance
- communication-companion help like:
  - `summarize this`
  - `do I owe a reply`
  - `draft a response`
  - `send it`
  - `send it later`
  - `remind me to reply later`
- Candace and household follow-through
- mission / chief-of-staff follow-through
- knowledge-library lookups and source explanations
- explicit save to thread / reminder / library
- explicit BlueBubbles -> Telegram escalation when the fuller answer belongs there

Andrea should feel:

- calm
- personal
- concise but not clipped
- less operator-ish than Telegram

## Safety Model

BlueBubbles remains companion-safe only.

Allowed directly:

- ordinary companion conversation
- daily guidance
- communication-companion flows
- mission guidance
- knowledge lookups
- save / remind / track flows
- explicit text handoffs

Handoff-only or blocked:

- work cockpit
- runtime, logs, and provider diagnostics
- `registermain` and main-chat control flows
- slash-command operator internals
- artifact-heavy delivery

If a BlueBubbles chat tries to use operator-only controls, Andrea should answer calmly and point that work back to Telegram.

## Reply Gate

Andrea does **not** auto-reply to ordinary social chatter on BlueBubbles.

Andrea replies only when the message explicitly mentions `@Andrea`, for example:

- `@Andrea hi`
- `@Andrea what am I forgetting`
- `@Andrea summarize this`
- `@Andrea what should I say back`
- `@Andrea help me plan tonight`

Messages that are just normal conversation without an Andrea ask are ignored.

## Current-Chat Summaries

`summarize this` on BlueBubbles should use the current chat's recent context.

Behavior:

- use recent stored `bb:` messages first
- ignore the `summarize this` ask itself when looking for the actual text to summarize
- if local context is thin, Andrea now primes recent current-chat history from the live BlueBubbles server on demand
- stay bounded to the current chat only
- suggest useful next actions like draft, remind-later, or Telegram escalation

This keeps BlueBubbles useful for real text-message help without turning it into passive inbox surveillance.

## Cross-Channel Handoffs

BlueBubbles -> Telegram is explicit and supported:

- `send me the fuller version on Telegram`

Alexa / Telegram -> BlueBubbles is also explicit, but the target is now:

- the most recent Andrea-engaged BlueBubbles chat on this host
- only if that engagement is fresh within 12 hours

Andrea does **not** silently target the currently active BlueBubbles desktop chat.
If there is no recent Andrea-engaged BlueBubbles chat, Andrea should say so plainly and ask the user to start from BlueBubbles first.

## Config

BlueBubbles V1 uses these env settings:

```bash
BLUEBUBBLES_ENABLED=true
BLUEBUBBLES_BASE_URL=
BLUEBUBBLES_BASE_URL_CANDIDATES=
BLUEBUBBLES_PASSWORD=
BLUEBUBBLES_HOST=0.0.0.0
BLUEBUBBLES_PORT=4305
BLUEBUBBLES_GROUP_FOLDER=main
BLUEBUBBLES_WEBHOOK_PUBLIC_BASE_URL=
BLUEBUBBLES_CHAT_SCOPE=all_synced
BLUEBUBBLES_ALLOWED_CHAT_GUIDS=
BLUEBUBBLES_ALLOWED_CHAT_GUID=
BLUEBUBBLES_WEBHOOK_PATH=/bluebubbles/webhook
BLUEBUBBLES_WEBHOOK_SECRET=
BLUEBUBBLES_SEND_ENABLED=true
```

Meaning:

- `BLUEBUBBLES_GROUP_FOLDER` binds BlueBubbles companion state into Andrea's shared companion folder, usually `main`
- prefer `BLUEBUBBLES_BASE_URL_CANDIDATES` with a stable IP first and `.local` only as a fallback candidate on Windows
- `BLUEBUBBLES_WEBHOOK_PUBLIC_BASE_URL` is the Mac-reachable Andrea URL, not the local bind address
- `BLUEBUBBLES_CHAT_SCOPE=all_synced` allows all synced personal and group chats
- `BLUEBUBBLES_ALLOWED_CHAT_GUIDS` and `BLUEBUBBLES_ALLOWED_CHAT_GUID` are only for optional allowlist mode
- `BLUEBUBBLES_SEND_ENABLED=true` is required for real reply-back

## Webhook And Send Model

Inbound:

- Andrea listens locally on `http://<host>:<port><webhookPath>`
- the Mac-side BlueBubbles server should call the public webhook URL, not `127.0.0.1`
- if `BLUEBUBBLES_WEBHOOK_SECRET` is set, append it as `?secret=...`
- Andrea accepts supported new-message webhook events only
- messages from chats outside the configured scope are ignored
- messages from the user that do not explicitly mention `@Andrea` are stored but do not wake Andrea

Outbound:

- Andrea sends bounded text replies only
- send path is `/api/v1/message/text`
- auth is sent with compatible `guid`, `password`, and `token` query parameters
- Andrea includes both `text` and `message` fields in the payload for compatibility
- if reply threading is rejected, Andrea retries once without reply metadata
- approved real outbound user messages bypass the `Andrea:` prefix so the delivered text reads like the user's reply, while Andrea-authored companion/status messages keep the label

## Proof Bar

BlueBubbles is `live_proven` only after all of these happen on this host:

1. one real inbound BlueBubbles message reaches Andrea
2. Andrea replies into that same BlueBubbles conversation
3. one same-thread follow-up preserves continuity
4. the flow stays companion-safe
5. one same-thread message-action decision is recorded in the same chat, such as `send it`, `send it later tonight`, `remind me instead`, or `save under thread`
6. if the user approves a real reply, that same-thread outbound send lands without the companion prefix

If config is present and the server, webhook, and recent-activity shadow poll are ready but the fresh same-thread proof chain is still incomplete, BlueBubbles stays below `live_proven` and should read as `degraded_but_usable` on that host. If Windows cannot reach the configured endpoint at all, the bridge should read as `externally_blocked` with `transport_unreachable`, and Telegram should be treated as the dependable main path.

On this host, that proof bar was satisfied on April 14, 2026 in `bb:iMessage;-;+14695405551` with a real same-thread ask, a fresh drafted message action, and a same-thread `send it` continuation.

## Operator Proof Steps

Use this exact proof sequence:

1. Confirm `npm run debug:bluebubbles -- --live` shows:
   - `transport: ready`
   - `webhook_registration: registered`
2. Send a real BlueBubbles message in any synced chat:
   - `@Andrea hi`
3. Confirm Andrea replies in that same Messages thread.
4. Send a same-thread follow-up:
   - `@Andrea what am I forgetting`
5. Send:
   - `@Andrea what should I say back`
6. Make one same-thread message-action decision:
   - `@Andrea send it`
   - or `@Andrea send it later tonight`
   - or `@Andrea remind me later`
   - or `@Andrea save that under the thread`
7. Optionally send:
   - `send me the fuller version on Telegram`
8. Run:
   - `npm run debug:bluebubbles -- --live`
9. Then run:
   - `npm run services:status`

Success should show:

- `bluebubbles_proof=live_proven`
- a recent `bluebubbles_most_recent_chat`
- non-`none` `bluebubbles_last_inbound`
- non-`none` `bluebubbles_last_outbound`
- `message_action_proof_state=fresh`
- `message_action_proof_chat` matching the same BlueBubbles thread

If the proof still says `degraded_but_usable` or `near_live_only`, treat that as honest host truth rather than a soft failure:

- Andrea is still below live-proven if transport, webhook, and ordinary same-thread chat are healthy but the fresh same-thread message-action leg has not happened on this host yet
- do not mark BlueBubbles `live_proven` until that same-thread message-action leg is actually recorded

## Testing

Focused coverage:

- `src/channels/bluebubbles.test.ts`
- `src/bluebubbles-companion.test.ts`
- `src/companion-conversation-binding.test.ts`
- `src/communication-companion.test.ts`
- `src/cross-channel-handoffs.test.ts`

Repo-side harnesses:

```bash
npm run debug:bluebubbles
npm run debug:bluebubbles -- --live
```

Use the default harness for stubbed transport/regression checks.
Use `--live` for the current host truth, webhook registration state, the same-thread message-action proof leg, and the exact remaining blocker.

## References

- [BlueBubbles REST API and webhooks](https://docs.bluebubbles.app/server/developer-guides/rest-api-and-webhooks)
- [BlueBubbles Server](https://github.com/BlueBubblesApp/bluebubbles-server)
