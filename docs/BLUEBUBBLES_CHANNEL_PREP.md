# BlueBubbles Companion Channel

BlueBubbles is now a real Andrea companion channel, not just a scaffold.

The V1 goal is narrow on purpose:

- one linked BlueBubbles conversation
- shared companion context with Andrea's existing `groupFolder` flow, defaulting to `main`
- inbound and outbound text only
- explicit cross-channel handoffs
- no main-control or operator/admin surface

This is still not a second assistant stack.
It is one more channel edge on the shared Andrea core.
In flagship journeys, BlueBubbles is for calm message help and lightweight follow-through, while Telegram remains the richer escalation surface when the user explicitly asks for more detail.

## Current Truth

Current host reality for the Windows field-trial machine:

- BlueBubbles code and the near-live harness are present in `Andrea_NanoBot`
- the real BlueBubbles server/webhook is **not installed or connected on this PC**
- this means BlueBubbles is currently **externally blocked on the Windows host**, not freshly live-proven
- the exact external next step is to reconnect the Mac-side BlueBubbles server/webhook and point this Windows host's `BLUEBUBBLES_*` config at it again

Implemented now:

- live BlueBubbles config parsing for host, port, linked group folder, and one allowed chat GUID
- a dedicated local BlueBubbles webhook listener
- webhook secret checking through the webhook URL query string
- webhook normalization into Andrea's shared `NewMessage` shape
- `bb:<chatGuid>` and `bb:<handle>` identity mapping
- duplicate-delivery suppression for repeated message GUIDs
- bounded outbound text reply-back to the same linked BlueBubbles conversation
- shared companion routing through the existing capability graph
- explicit BlueBubbles -> Telegram handoff for richer detail when the user asks for it
- Alexa -> BlueBubbles text handoff support for `send that to my messages` style follow-ups

Intentionally out of scope in V1:

- BlueBubbles as a main control chat
- `/cursor`, runtime, logs, or deep admin control from BlueBubbles
- arbitrary new-conversation creation
- media/artifact send
- read receipts, reactions, typing indicators, or background outbound automation

## V1 Scope

BlueBubbles is meant to feel like a personal companion text thread.

Good fits:

- `what am I forgetting`
- `what should I remember tonight`
- `what's still open with Candace`
- `save that for later`
- `turn that into a reminder`
- `save that in my library`
- `draft something for me`
- `what do my saved notes say about this`
- short research summaries

Not a fit by default:

- operator shell commands
- main-control chat setup
- work-cockpit execution
- logs, diagnostics, and provider admin surfaces

## Config

BlueBubbles V1 uses these env settings:

```bash
BLUEBUBBLES_ENABLED=false
BLUEBUBBLES_BASE_URL=
BLUEBUBBLES_PASSWORD=
BLUEBUBBLES_HOST=127.0.0.1
BLUEBUBBLES_PORT=4305
BLUEBUBBLES_GROUP_FOLDER=main
BLUEBUBBLES_ALLOWED_CHAT_GUID=
BLUEBUBBLES_WEBHOOK_PATH=/bluebubbles/webhook
BLUEBUBBLES_WEBHOOK_SECRET=
BLUEBUBBLES_SEND_ENABLED=false
```

Meaning:

- `BLUEBUBBLES_GROUP_FOLDER` binds the linked BlueBubbles chat to an existing Andrea companion folder
- `BLUEBUBBLES_ALLOWED_CHAT_GUID` is the one BlueBubbles conversation V1 will accept
- `BLUEBUBBLES_SEND_ENABLED=true` is required for real reply-back

## Webhook And Send Model

Inbound:

- Andrea listens locally on `http://<host>:<port><webhookPath>`
- if `BLUEBUBBLES_WEBHOOK_SECRET` is set, append it to the webhook URL query string, for example `?secret=...`
- Andrea accepts supported new-message webhook events only
- malformed payloads get `400`
- secret mismatch gets `401`
- unsupported events get `202`
- messages from unlinked chats are ignored with `202`
- if the channel is enabled but not ready for live traffic, Andrea returns `503`

Outbound:

- V1 sends only text replies back to the same linked BlueBubbles conversation
- Andrea uses the documented BlueBubbles REST text-send path: `/api/v1/message/text`
- auth is sent through the documented query-parameter style, with compatibility aliases for `guid`, `password`, and `token`
- if reply threading is rejected, Andrea retries once without reply metadata
- if BlueBubbles does not return a receipt, Andrea treats the send as failed

## Shared Companion Binding

BlueBubbles does not become a second `registered_group`.
Instead, Andrea maps the linked `bb:` conversation into the existing companion folder.

That means:

- Telegram, Alexa, and BlueBubbles can share the same bounded life-thread / reminder / ritual / knowledge context
- BlueBubbles still does **not** inherit `isMain`
- operator gating stays tied to real registered main chats, not BlueBubbles

## Cross-Channel Handoffs

BlueBubbles participates in the shared handoff model in a bounded way.

Supported now:

- Alexa -> BlueBubbles text handoff
  - `send that to my messages`
  - `save that to my messages`
  - `send me the details in messages`
- BlueBubbles -> Telegram rich-detail handoff
  - `send me the fuller version on Telegram`

Not supported:

- silent push across channels
- Telegram -> BlueBubbles fan-out
- BlueBubbles media delivery

## Testing

Focused coverage:

- `src/channels/bluebubbles.test.ts`
- `src/companion-conversation-binding.test.ts`
- `src/cross-channel-handoffs.test.ts`
- `src/assistant-action-completion.test.ts`

Near-live proof harness:

```bash
npm run debug:bluebubbles
```

That harness proves:

- real local BlueBubbles webhook listener startup
- inbound webhook -> normalized companion message
- reply-back into the same linked BlueBubbles conversation through the REST send path
- shared companion binding to `groupFolder=main`
- explicit BlueBubbles -> Telegram handoff for richer detail

## Live Proof Boundary

The strongest truthful proof on a machine without a reachable BlueBubbles server is `npm run debug:bluebubbles`.
That is the current truthful bar on this Windows host.

To claim fully live BlueBubbles proof, you still need:

- a reachable BlueBubbles server
- correct REST password/query auth
- a real webhook URL configured in BlueBubbles
- one linked allowed chat GUID
- one real inbound message and one real reply-back observed on that server

## References

- [BlueBubbles REST API and webhooks](https://docs.bluebubbles.app/server/developer-guides/rest-api-and-webhooks)
- [BlueBubbles Server](https://github.com/BlueBubblesApp/bluebubbles-server)
