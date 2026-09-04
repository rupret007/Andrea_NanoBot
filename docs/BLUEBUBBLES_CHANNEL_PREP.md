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
- BlueBubbles transport is ready, but the current host proof is
  `degraded_but_usable`/`needs_proof` until the configured canonical self-thread
  has a fresh inbound, outbound, continuity, and `message_action` chain
- canonical and alias self-thread identifiers come from local configuration;
  do not copy personal addresses or raw thread IDs into documentation or logs
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

The installer registers the local stdio command and then applies OpenClaw's native tool filter. It exposes read/status tools, media metadata/analysis tools, and `bluebubbles_execute_message_action` for non-send operations. Ordinary recipient actions allow only `remind_instead` and `save_to_thread`; `defer` is reserved for the special proof-drill action, where it records a no-send decision. The MCP schema and control API reject `send` and `send_again`, reject ordinary external `defer`, and require every operable action to be presented in the explicitly configured owner self-thread. An autonomous client therefore cannot deliver its own card and then dispatch or schedule an external message. A real send requires a fresh owner-authored approval in the registered Telegram chat or configured Messages self-thread. The MCP server no longer registers `bluebubbles_send`, and the legacy exclusion remains in the OpenClaw filter as defense in depth. The old direct-send HTTP route returns `410 Gone` without contacting the provider.

In the explicitly configured private self-thread, an `@OpenClaw` ask may use
those filtered tools and return the result in that same Messages conversation.
Phone and email aliases for one physical self-thread are canonicalized for
ingress deduplication: identical direction/content within two seconds of
provider timestamp is one delivery even when BlueBubbles assigns different
message IDs. Repeating the same text outside that narrow mirror window remains
an intentional new turn. Other chats do not become OpenClaw owner surfaces.

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

BlueBubbles V1 is intentionally narrower than Telegram. Its private control
surface is one explicitly configured owner self-thread, while synced contact
and group threads are communication data and outbound destinations.

Andrea now supports:

- all synced personal and group chats as data/destinations when
  `BLUEBUBBLES_CHAT_SCOPE=all_synced`
- bounded owner controls from the configured self-thread, with `@Andrea` and
  `@OpenClaw` accepted there as explicit assistant/helper aliases
- ordinary contact text, including text containing those alias strings, stored
  for summaries and reviews without ever waking Andrea in the contact thread
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

Outbound Messages sends use the BlueBubbles AppleScript path only. Private API
is never selected, including when the server advertises it or the server-info
probe fails. The Private API probe is diagnostic only; it never chooses a send
method. That send-path rule does not replace the existing approval fence: a
real contact send still requires a fresh owner-authored `send it` /
`send it now` / `send now` in the registered Telegram front-door chat
(Bob / `@andrea_nanobot`) or the configured Messages self-thread. QA, Karen, and ordinary contact threads never
authorize a send, even if they reply `yes` or `send it`, and a `tg:qa` or
`tg:karen` JID cannot borrow the main group record. A numeric Telegram JID
that is not that registered front-door fails closed the same way, including
when no front-door is registered yet, no title is stored yet, or a provided
title tries to hide a stored QA/Karen canary. An empty `tg:` prefix,
sentinel Telegram JIDs such as `tg:undefined` / `tg:null` / `tg:NaN`
(including when stored as the main chat), control-character Telegram JIDs,
and named or short Telegram fixture JIDs outside the hermetic test
boundary (including when stored as the main chat) fail closed the same
way. A BlueBubbles contact or
group GUID that is not the configured Messages self-thread fails closed
the same way, including when no self-thread is recorded yet. A missing
caller JID cannot authorize. Stored QA/Karen titles on numeric Telegram
JIDs and on BlueBubbles chats still fail closed without parsing
BlueBubbles addresses as labels, and those callers cannot defer or fire a
scheduled send. Unknown channel prefixes cannot authorize.

Handoff-only or blocked:

- work cockpit
- general runtime, logs, and provider diagnostics; the configured private
  self-thread may still request the bounded read-only BlueBubbles status tool
  through `@OpenClaw`
- `registermain` and main-chat control flows
- slash-command operator internals
- artifact-heavy delivery

If a BlueBubbles chat tries to use operator-only controls, Andrea should answer calmly and point that work back to Telegram.

## Reply Gate

Andrea does **not** reply inside ordinary contact or group threads. Those
threads are data sources and explicit owner-selected destinations only; body
text such as `@Andrea` never turns one into a control surface.

Use the registered main Telegram chat or the configured private Messages
self-thread for controls. In the self-thread, examples include:

- `@Andrea hi`
- `@Andrea what am I forgetting`
- `@Andrea summarize my recent texts`
- `summarize Candace from the last 2 days`
- `@Andrea what should I say back`
- `@Andrea help me plan tonight`
- `@OpenClaw search for a skill`

The mention is optional for bounded direct asks and fresh continuations in the
configured self-thread. Contact-thread activity is synced, not ignored; it is
simply never routed as an assistant prompt.

## Contact And Cross-Chat Summaries

From Telegram or the configured self-thread, a named ask such as `summarize
Candace from the last 2 days` stays bounded to that synced contact thread.
Broad asks such as `summarize my texts from the past 48 hours` summarize across
synced BlueBubbles contact and group chats in that requested window, excluding
the private self-thread control conversation. Named-thread and recent-text
`today` / `yesterday` / `this week` windows use the configured owner
`TIMEZONE`, not the process host calendar. Relative `last N hours` and the
default 24-hour window stay duration-based.

Behavior:

- use recent stored `bb:` messages first
- exclude the configured self-thread and its control prompts from contact summaries
- preserve ordinary contact text even if its body contains `@Andrea` or `@OpenClaw`
- if local context is thin, prime bounded recent contact history from the live BlueBubbles server on demand
- keep a named summary bounded to the selected contact chat only
- produce a useful thread-grounded gist of the conversation and current
  state for Jeff, not a quote dump or activity counts
- answer named who-do-I-owe asks (`what's still open with Bob`) from that
  same gist, and keep a `what do I owe people` follow-up on the named thread
  after summarize; generic who-do-I-owe stays explicit-only and does not
  crawl unnamed inbox threads
- already-replied named threads report `Nothing open`
- suggest useful next actions like draft, revise, remind-later, send-later, save, or Telegram escalation
- keep suggested replies unsent; after a named owed-reply, `draft Bob` or a
  seed-bound `yes` creates an unsent `requiresApproval` draft and does not
  send. The only send approvals are standalone `send it` / `send it now` /
  `send now`. Bare `yes` / `ok` never authorize a send. Karen cannot read
  those Messages bodies or authorize a send. Jeff talks to Bob, Andrea is
  the engine

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

- media attached to a Telegram or configured-self-thread owner ask can be
  analyzed from that trusted control surface; media observed in ordinary
  contact threads remains synced data and never wakes Andrea there
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

Communication asks from Telegram or the configured self-thread, such as
`review my recent texts`, `what should I say back to Candace`, and numbered
recent-text review follow-ups, should show grounded reply options when useful.
The registered owner Telegram chat and configured Messages self-thread share
the short-lived recent-summary continuation seed only when they resolve to the
same companion group folder. Contact/group threads and other Telegram chats
cannot access or mutate that seed, and an expired seed is removed for both
owner surfaces.

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
category records are not offered as people. BlueBubbles group metadata is
already sufficient to exclude that conversation from single-person identity
review; this never creates a relationship link, and group audience checks still
apply before drafting or sending.

Telegram adds one-at-a-time Link/Leave Unlinked buttons for this same workflow.
Messages remains text-only so BlueBubbles does not gain a callback or control
surface beyond the configured self-thread and the existing command parser. Each
decision returns the exact opaque-key commands for the next unresolved item;
threads with an existing explicit person link are skipped.

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
BLUEBUBBLES_BASE_URL_CANDIDATES=http://127.0.0.1:1234,http://localhost:1234,<optional-https-fallback>
BLUEBUBBLES_PASSWORD=
BLUEBUBBLES_HOST=127.0.0.1
BLUEBUBBLES_PORT=4305
BLUEBUBBLES_GROUP_FOLDER=main
BLUEBUBBLES_WEBHOOK_PUBLIC_BASE_URL=http://127.0.0.1:4305
BLUEBUBBLES_SERVER_PUBLIC_URL=<operator-configured-public-url>
BLUEBUBBLES_LOCAL_PORT=1234
BLUEBUBBLES_IMESSAGE_ACCOUNT_LABEL=<configured-account-label>
BLUEBUBBLES_COMPUTER_ID=<configured-host-identifier>
BLUEBUBBLES_CANONICAL_SELF_THREAD_JID=<canonical-self-thread-jid>
BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS=<comma-separated-self-thread-alias-jids>
BLUEBUBBLES_CHAT_SCOPE=all_synced
BLUEBUBBLES_ALLOWED_CHAT_GUIDS=
BLUEBUBBLES_ALLOWED_CHAT_GUID=
BLUEBUBBLES_WEBHOOK_PATH=/bluebubbles/webhook
BLUEBUBBLES_WEBHOOK_SECRET=<required-random-secret>
BLUEBUBBLES_SEND_ENABLED=true
BLUEBUBBLES_RECEIPT_INBOX_ENABLED=true
BLUEBUBBLES_RECEIPT_INBOX_HOST=127.0.0.1
BLUEBUBBLES_RECEIPT_INBOX_PORT=4306
BLUEBUBBLES_RECEIPT_INBOX_BASE_URL=http://127.0.0.1:4306
BLUEBUBBLES_RECEIPT_INBOX_WEBHOOK_PUBLIC_BASE_URL=http://127.0.0.1:4306
BLUEBUBBLES_RECEIPT_INBOX_PATH=/bluebubbles/receipt-inbox
BLUEBUBBLES_RECEIPT_INBOX_HEALTH_PATH=/health
# Defaults to ${ANDREA_STATE_DIR:-~/.andrea}/bluebubbles/receipt-inbox.sqlite3
# BLUEBUBBLES_RECEIPT_INBOX_DB_PATH=~/.andrea/bluebubbles/receipt-inbox.sqlite3
```

Meaning:

- `BLUEBUBBLES_GROUP_FOLDER` binds BlueBubbles companion state into Andrea's shared companion folder, usually `main`
- prefer local `127.0.0.1` first; keep the Cloudflare BlueBubbles URL as fallback/diagnostic only
- `BLUEBUBBLES_WEBHOOK_PUBLIC_BASE_URL` stays local/private on the configured host
- `BLUEBUBBLES_CANONICAL_SELF_THREAD_JID` and `BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS` keep proof drills and follow-ups aligned with the live Messages self-thread
- configure the canonical self-thread and aliases explicitly before self-thread
  drafts, proof, or sends; source defaults are reserved fictional placeholders
  and do not identify a real destination
- every trusted self-thread JID must be a direct/private BlueBubbles JID in
  `bb:<service>;-;<identifier>` form; group (`;+;`) and opaque JIDs are rejected
  even if they are mistakenly placed in the self-thread environment variables
- treat those configured JIDs as a security trust root: BlueBubbles uses the
  same direct-JID shape for an ordinary person. Before enabling sends, verify
  in Messages that every canonical/alias identifier is one of the owner's own
  reachable handles and that a message to it opens the owner's private
  self-conversation—not a conversation with another person. Code cannot infer
  that ownership from the JID shape alone; if the check is uncertain, leave
  the self-thread unconfigured and use Telegram only
- `BLUEBUBBLES_CHAT_SCOPE=all_synced` allows all synced personal and group chats
- `BLUEBUBBLES_ALLOWED_CHAT_GUIDS` and `BLUEBUBBLES_ALLOWED_CHAT_GUID` are only for optional allowlist mode
- `BLUEBUBBLES_SEND_ENABLED=true` is required for real reply-back
- the receipt-inbox host/path are independent of the main webhook; its listener
  accepts only `127.0.0.1` or `::1`, never a wildcard or LAN address
- `BLUEBUBBLES_RECEIPT_INBOX_BASE_URL` is the main process's health-probe base,
  while `BLUEBUBBLES_RECEIPT_INBOX_WEBHOOK_PUBLIC_BASE_URL` is the provider-facing
  base used to verify the second BlueBubbles registration

## Webhook And Send Model

Inbound:

- Andrea listens locally on `http://<host>:<port><webhookPath>`
- the Mac mini BlueBubbles server can call Andrea's local webhook at `127.0.0.1`
- `BLUEBUBBLES_WEBHOOK_SECRET` is required; without it the listener is never ready and outbound sending is not exposed as enabled
- append the configured secret to the BlueBubbles callback URL as `?secret=...`
- Andrea accepts supported new-message webhook events only
- messages from chats outside the configured scope are ignored
- ordinary contact/group messages are stored as data but never wake Andrea,
  regardless of whether their body contains `@Andrea` or `@OpenClaw`
- only owner-authored traffic in the explicitly configured self-thread enters
  native BlueBubbles control routing

BlueBubbles must retain the main callback and have a **second** webhook whose
URL is exactly
`http://127.0.0.1:4306/bluebubbles/receipt-inbox?secret=<URL-encoded-secret>`
and whose only event is **New Messages** (literal API event `new-message`). Do
not select all events. The provider registration, independently supervised
LaunchAgent, private SQLite path, login-time limitation, and lifecycle commands
are specified in
[BlueBubbles Receipt Inbox LaunchAgent](./BLUEBUBBLES_RECEIPT_INBOX_SERVICE.md).

Outbound:

- Andrea sends bounded text replies only
- every new recipient/body instruction is staged unsent; provider dispatch
  requires a separate fresh `send it`, `send it now`, or `send now` approval
  bound to that card
- live Messages send uses AppleScript only; Private API stays off, including
  when the server advertises it or the server-info probe fails
- BlueBubbles local HTTP is only the transport that requests AppleScript send;
  it is not a Private API or alternate send method, and group send is not
  implemented
- auth is sent with compatible `guid`, `password`, and `token` query parameters
- if reply threading is rejected, Andrea retries once without reply metadata
- approved real outbound user messages bypass the `Andrea:` prefix so the delivered text reads like the user's reply, while Andrea-authored companion/status messages keep the label

Emergency owner pause:

- a trusted owner instruction such as `stop sending messages` or `stop texting
real people` records a durable outbound pause before normal command routing
- the pause blocks BlueBubbles text, artifact, immediate-action, and scheduled
  delivery before provider dispatch while leaving inbound sync and Telegram
  review/summaries available
- acknowledgements like `okay` or `yes` never clear it; only an explicit command
  such as `resume message sending` does

## Proof Bar

BlueBubbles is `live_proven` only after all of these happen on this host:

1. one real owner-authored message in the configured self-thread reaches Andrea
2. Andrea replies into that configured self-thread
3. one self-thread follow-up preserves continuity
4. the flow stays companion-safe
5. one self-thread message-action decision is recorded there, such as `send it`, `send it later tonight`, `remind me instead`, or `save under thread`
6. if the user approves a real reply, that same-thread outbound send lands without the companion prefix

If config is present and the server, webhook, and recent-activity shadow poll are ready but the fresh same-thread proof chain is still incomplete, BlueBubbles stays below `live_proven` and should read as `degraded_but_usable` on that host. If this host cannot reach the configured endpoint at all, the bridge should read as `externally_blocked` with `transport_unreachable`, and Telegram should be treated as the dependable main path.

This host previously cleared that proof bar on July 6, 2026. That evidence has
aged out: current status is `degraded_but_usable`/`needs_proof` until the same
configured canonical thread completes the proof bar again. Historical success
must not be promoted into a fresh host claim.

## Operator Proof Steps

This is a future verification checklist, not permission to send. Do not run it
while an owner stop/pause is active. It requires a new explicit owner
authorization for live proof, an explicit resume command recorded through the
trusted owner surface, and `BLUEBUBBLES_SEND_ENABLED=true`; never infer a
resume from ordinary conversation or from this document.

After those conditions are independently satisfied, use this exact proof
sequence:

1. Confirm `npm run debug:bluebubbles -- --live` shows:
   - `transport: ready`
   - `webhook_registration: registered`
2. Send a real BlueBubbles message in the explicitly configured self-thread:
   - `@Andrea hi`
   - or `@OpenClaw search for a skill` when proving the OpenClaw/helper alias
3. Confirm Andrea replies in that self-thread and nowhere in an ordinary
   contact conversation.
4. Send a self-thread follow-up:
   - `@Andrea what am I forgetting`
5. Prove the summary/suggested-reply leg:
   - `@Andrea review my recent texts`
   - then `@Andrea what should I say back to #1`
   - or, only when the review actually offers numbered reply options,
     `@Andrea draft #1 option 2`
6. Confirm Andrea shows a fuller contact recap, offers suggested replies only
   when the available message evidence supports a real answer, excludes the
   self-thread controls, and preserves ordinary contact text that happens to
   contain `@Andrea` as message data.
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
