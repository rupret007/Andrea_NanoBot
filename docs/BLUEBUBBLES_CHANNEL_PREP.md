# BlueBubbles Companion Channel

BlueBubbles is Andrea's optional calm, text-first Messages bridge for personal messaging.

It is not a second operator shell.
It is not a passive inbox bot.
It is one more channel edge on the shared Andrea core.

## Current Truth

Current host reality for the Mac mini operator machine:

- the BlueBubbles desktop app is installed and connected to the local Mac mini server
- Andrea now has live `BLUEBUBBLES_*` config loaded on this host
- Andrea reaches BlueBubbles locally at `http://127.0.0.1:1234`; the Cloudflare BlueBubbles URL is fallback/diagnostic only
- BlueBubbles is `live_proven` while the fresh same-thread inbound, outbound, and `message_action` proof chain remains current on this host
- the canonical proof thread is `bb:iMessage;-;+14695405551`, and alias support remains enabled for `bb:iMessage;-;jeffstory007@gmail.com`
- Telegram remains Andrea's dependable main messaging surface, while BlueBubbles stays an optional bridge with its own proof freshness clock

Use these operator truth surfaces:

- `npm run services:status`
- `npm run setup -- --step verify`
- `npm run debug:status`
- `npm run debug:bluebubbles -- --live`
- `npm run debug:pilot`
- `GET /v1/bluebubbles/status` on the BlueBubbles control API when `BLUEBUBBLES_CONTROL_API_ENABLED=true`
- `GET /v1/bluebubbles/doctor` on the BlueBubbles control API for blocker taxonomy and next action
- `npm run bluebubbles:mcp` for the thin stdio MCP bridge over that authenticated control API
- `npm run openclaw:bridge:status` to verify OpenClaw can see Andrea's BlueBubbles MCP bridge without receiving any Andrea control tokens

OpenBubbles is still an operator-only feasibility track. Andrea does not use it for this Mac mini BlueBubbles bridge.

## OpenClaw Bridge

OpenClaw can call Andrea-hosted BlueBubbles tools through an OpenClaw-managed MCP server named `andrea-bluebubbles`.

Register or refresh the bridge on the Mac mini with:

```bash
npm run openclaw:bridge:install
npm run openclaw:bridge:status -- --json
npm run openclaw:bridge:probe -- --json
```

The installer registers the local stdio command and then applies OpenClaw's native tool filter. It exposes read/status tools, media metadata/analysis tools, and `bluebubbles_execute_message_action`; it intentionally excludes `bluebubbles_send`, so send-like work must still go through Andrea's same-thread message-action gates.

OpenClaw keeps its own auth store. Andrea does not copy OpenClaw secrets, and the OpenClaw MCP config does not store `BLUEBUBBLES_CONTROL_TOKEN`; the MCP process reads Andrea's local `.env` from this checkout.

Required local-only control API env:

```bash
BLUEBUBBLES_CONTROL_API_ENABLED=true
BLUEBUBBLES_CONTROL_HOST=127.0.0.1
BLUEBUBBLES_CONTROL_PORT=4315
BLUEBUBBLES_CONTROL_BASE_URL=http://127.0.0.1:4315
BLUEBUBBLES_CONTROL_TOKEN=<local random token>
```

## V1 Scope

BlueBubbles V1 is intentionally narrower than Telegram, but it is no longer pinned to one linked thread.

Andrea now supports:

- all synced personal and group chats when `BLUEBUBBLES_CHAT_SCOPE=all_synced`
- `@Andrea` mention required, with `@OpenClaw` accepted as the default OpenClaw/helper alias
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

Andrea replies only when the message explicitly mentions `@Andrea` or `@OpenClaw`, for example:

- `@Andrea hi`
- `@Andrea what am I forgetting`
- `@Andrea summarize this`
- `@Andrea what should I say back`
- `@Andrea help me plan tonight`
- `@OpenClaw search for a skill`

Messages that are just normal conversation without an Andrea ask are ignored.

## Current-Chat Summaries

`summarize this` on BlueBubbles should use the current chat's recent context.
Telegram-origin broad asks such as `summarize my texts from the past 48 hours`
summarize across all synced BlueBubbles chats in that requested window.

Behavior:

- use recent stored `bb:` messages first
- ignore the `summarize this` ask itself when looking for the actual text to summarize
- if local context is thin, Andrea now primes recent current-chat history from the live BlueBubbles server on demand
- stay bounded to the current chat only
- produce a fuller recap of the conversation flow and current state, not just activity counts
- suggest useful next actions like draft, revise, remind-later, send-later, save, or Telegram escalation

This keeps BlueBubbles useful for real text-message help without turning it into passive inbox surveillance.

## Media Attachments

Incoming BlueBubbles and Telegram image/video attachments are stored as safe
message metadata plus a local cache file when the provider allows download.
Media-only messages are valid conversation turns; Andrea should treat them as
`[image]`, `[video]`, or `[file]` instead of dropping them for having no text.

The default cache is privacy-bounded: each downloaded file is capped at 20 MiB,
vision input is capped at 24 MiB per request, cached inbound and derived files
expire after 7 days, and the combined cache is capped at 1 GiB. Operators can
override those defaults with the `ANDREA_MEDIA_*` settings in `.env`.

Expected behavior:

- `@Andrea analyze this photo`, `@Andrea what is in this video`, and similar
  asks use the most recent current-chat image/video attachments
- images are sent to the OpenAI vision path directly from the local cache
- videos are summarized by sampling frames with the bundled `ffmpeg-static` and
  `ffprobe-static` binaries before sending those frames to vision
- analysis fails closed with a clear blocker when the attachment is missing,
  not cached, oversized, unsupported, or no OpenAI provider is configured
- OpenClaw can inspect attachment metadata with
  `bluebubbles_get_media_metadata` and request analysis with
  `bluebubbles_analyze_media`
- OpenClaw still cannot bypass Andrea's send gates; direct BlueBubbles media
  sending remains excluded from the OpenClaw bridge

## Suggested Replies

BlueBubbles communication asks such as `@Andrea what should I say back`,
`@Andrea summarize this`, and recent-text review follow-ups should show grounded
reply options when a reply appears useful.

Expected behavior:

- show two or three options when enough context exists, usually labeled `warm`,
  `direct`, `brief`, or `careful`
- keep suggestions separate from sending; suggestions are not approvals
- let the user choose follow-ups such as `draft #1`, `draft #1 option 2`,
  `make #2 warmer`, `shorter`, or `more direct`
- create one approval-gated draft/message action from the selected option
- keep group chats, low-confidence identity matches, sensitive messages, and
  ambiguous threads draft-first with explicit caution

Andrea can use configured provider-backed refinement for fuller recaps and
suggestions. The fallback path remains local and deterministic. Provider prompts
must use bounded, sanitized context and must redact phone numbers, JIDs, emails,
and token-like secrets.

## Native Feedback Reactions

Andrea links assistant-authored replies in the bound BlueBubbles self-thread to
the existing outcome-learning ledger. Native tapbacks are consumed as structured
control signals before ordinary chat routing:

- Like or Love records an accepted owner outcome.
- Dislike records a rejected outcome and opens the existing bounded repair
  review path.
- Laugh, Emphasize, Question, reaction removals, and reactions without an exact
  assistant-message link do not train Andrea.
- Reaction events never become assistant prompts and do not trigger a second
  acknowledgement message.

The link stores route/run provenance and fixed privacy placeholders, not the
private iMessage request or response body. Untouched links expire after 30 days
and are capped at 500; reviewed outcomes and issue-linked corrections remain in
the normal review ledger. This is a feedback bridge, not a passive Messages
archive, and it does not grant any additional action authority.

The configured self-thread also accepts a narrow set of standalone natural
verdicts (`that worked`, `that was helpful`, `that didn't work`, and `not
helpful`) for the immediately preceding unreviewed Andrea reply. They expire
after 30 minutes, preserve `natural_language` provenance, and are rejected when
mixed with action language. For example, `that worked, send it` is ordinary
conversation—not feedback and never send approval.

## Private Identity Review

The configured BlueBubbles self-thread can run the same explicit relationship
grounding review as Telegram with `review communication identities`. Andrea may
propose a person only when the safe chat label exactly matches one existing
eligible individual profile person. The private review returns a stable opaque
key such as `R-12AB34CD`; use `link identity R-12AB34CD to "Person"`, mark a
single-person link not applicable with `dismiss identity R-12AB34CD`, or
reverse a decision with `clear identity review R-12AB34CD`. Phone/JID-shaped
labels are rendered as unlabeled conversations, and generic-self or collective
category records are not offered as people.

Telegram adds one-at-a-time Link/Leave Unlinked buttons for this same workflow.
Messages remains text-only so BlueBubbles does not gain a callback or control
surface beyond the configured self-thread and the existing command parser.

This surface is denied in every other Messages chat so it cannot expose private
profile names to another person or group. It uses chat metadata and existing
profile subjects only—never message bodies, phone numbers, raw JIDs, or generic
words such as “you”—and group chats cannot be confirmed as one person.

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
BLUEBUBBLES_BASE_URL=http://127.0.0.1:1234
BLUEBUBBLES_BASE_URL_CANDIDATES=http://127.0.0.1:1234,http://localhost:1234,https://ensemble-mercy-population-spending.trycloudflare.com
BLUEBUBBLES_PASSWORD=
BLUEBUBBLES_HOST=127.0.0.1
BLUEBUBBLES_PORT=4305
BLUEBUBBLES_GROUP_FOLDER=main
BLUEBUBBLES_WEBHOOK_PUBLIC_BASE_URL=http://127.0.0.1:4305
BLUEBUBBLES_SERVER_PUBLIC_URL=https://ensemble-mercy-population-spending.trycloudflare.com
BLUEBUBBLES_LOCAL_PORT=1234
BLUEBUBBLES_IMESSAGE_ACCOUNT_LABEL=jeffstory007@gmail.com
BLUEBUBBLES_COMPUTER_ID=jeffstory@Jeffs-Mac-mini.local
BLUEBUBBLES_CANONICAL_SELF_THREAD_JID=bb:iMessage;-;+14695405551
BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS=bb:iMessage;-;+14695405551,bb:iMessage;-;jeffstory007@gmail.com
BLUEBUBBLES_CHAT_SCOPE=all_synced
BLUEBUBBLES_ALLOWED_CHAT_GUIDS=
BLUEBUBBLES_ALLOWED_CHAT_GUID=
BLUEBUBBLES_WEBHOOK_PATH=/bluebubbles/webhook
BLUEBUBBLES_WEBHOOK_SECRET=
BLUEBUBBLES_SEND_ENABLED=true
```

Meaning:

- `BLUEBUBBLES_GROUP_FOLDER` binds BlueBubbles companion state into Andrea's shared companion folder, usually `main`
- prefer local `127.0.0.1` first; keep the Cloudflare BlueBubbles URL as fallback/diagnostic only
- `BLUEBUBBLES_WEBHOOK_PUBLIC_BASE_URL` stays local/private on this Mac mini
- `BLUEBUBBLES_CANONICAL_SELF_THREAD_JID` and `BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS` keep proof drills and follow-ups aligned with the live Messages self-thread
- `BLUEBUBBLES_CHAT_SCOPE=all_synced` allows all synced personal and group chats
- `BLUEBUBBLES_ALLOWED_CHAT_GUIDS` and `BLUEBUBBLES_ALLOWED_CHAT_GUID` are only for optional allowlist mode
- `BLUEBUBBLES_SEND_ENABLED=true` is required for real reply-back

## Webhook And Send Model

Inbound:

- Andrea listens locally on `http://<host>:<port><webhookPath>`
- the Mac mini BlueBubbles server can call Andrea's local webhook at `127.0.0.1`
- if `BLUEBUBBLES_WEBHOOK_SECRET` is set, append it as `?secret=...`
- Andrea accepts supported new-message webhook events only
- messages from chats outside the configured scope are ignored
- messages from the user that do not explicitly mention `@Andrea` or `@OpenClaw` are stored but do not wake Andrea

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

If config is present and the server, webhook, and recent-activity shadow poll are ready but the fresh same-thread proof chain is still incomplete, BlueBubbles stays below `live_proven` and should read as `degraded_but_usable` on that host. If this host cannot reach the configured endpoint at all, the bridge should read as `externally_blocked` with `transport_unreachable`, and Telegram should be treated as the dependable main path.

On this host, that proof bar was refreshed on July 6, 2026 in `bb:iMessage;-;+14695405551` with a real same-thread ask, a fresh drafted message action, and a same-thread `send it later tonight` continuation.

## Operator Proof Steps

Use this exact proof sequence:

1. Confirm `npm run debug:bluebubbles -- --live` shows:
   - `transport: ready`
   - `webhook_registration: registered`
2. Send a real BlueBubbles message in any synced chat:
   - `@Andrea hi`
   - or `@OpenClaw search for a skill` when proving the OpenClaw/helper alias
3. Confirm Andrea replies in that same Messages thread.
4. Send a same-thread follow-up:
   - `@Andrea what am I forgetting`
5. Prove the summary/suggested-reply leg:
   - `@Andrea summarize this`
   - then `@Andrea what should I say back`
   - or, after a recent-text review, `@Andrea draft #1 option 2`
6. Confirm Andrea shows a fuller recap plus suggested replies and does not
   treat the `@Andrea` wake text as part of the conversation.
7. Send:
   - `@Andrea what should I say back`
8. Make one same-thread message-action decision:
   - `@Andrea send it later tonight`
   - or `@Andrea remind me later`
   - or `@Andrea save that under the thread`
9. Optionally send:
   - `send me the fuller version on Telegram`
10. Run:

- `npm run debug:bluebubbles -- --live`

11. Then run:

- `npm run services:status`

Success should show:

- `bluebubbles_proof=live_proven`
- a recent `bluebubbles_most_recent_chat`
- non-`none` `bluebubbles_last_inbound`
- non-`none` `bluebubbles_last_outbound`
  - `message_action_proof_state=fresh`

Use `npm run debug:bluebubbles -- --proof-timeline` when the proof state does
not promote. It prints a metadata-only reconciliation of the canonical
self-thread, aliases, inbound/outbound shapes, active action, last safe
decision, confirmation, blocker category, and next step. It never prints raw
private message bodies.

- `message_action_proof_chat` matching the same BlueBubbles thread

If the proof still says `degraded_but_usable` or `near_live_only`, treat that as honest host truth rather than a soft failure:

- Andrea is still below live-proven if transport, webhook, and ordinary same-thread chat are healthy but the fresh same-thread message-action leg has not happened on this host yet
- do not mark BlueBubbles `live_proven` until that same-thread message-action leg is actually recorded

## Testing

Focused coverage:

- `src/channels/bluebubbles.test.ts`
- `src/bluebubbles-companion.test.ts`
- `src/messages-fluidity.test.ts`
- `src/recent-text-review.test.ts`
- `src/assistant-capabilities.test.ts`
- `src/assistant-capability-router.test.ts`
- `src/media-analysis.test.ts`
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
