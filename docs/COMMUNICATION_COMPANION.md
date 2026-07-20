# Andrea Communication Companion

Andrea now has a bounded communication-companion layer for real people, replies, and follow-through.

## Where This Shows Up In Signature Flows

Communication companion is the core of journeys like:

- `What's still open with Candace?`
- `What do I owe people right now?`
- `What should I say back?`
- `Remind me to reply later tonight.`

The flagship product goal is that Andrea can move from open loop -> draft -> approve/send or defer without making the user restate the whole conversation.
The registered owner Telegram chat and explicitly configured Messages self-thread share the same short-lived recent-summary continuation seed when both are bound to the same companion group folder. That lets a recent-text review or summary started on either owner surface continue on the other without restating it. Ordinary Messages contacts/groups, non-owner Telegram chats, unconfigured self-thread placeholders, and differently bound folders cannot read, write, or clear that owner seed. Generic seeds expire after ten minutes; review-backed seeds retain only their independently validated review window. Other conversation state remains scoped according to its own feature contract.

This is not a full inbox app, not a CRM, and not an auto-reply system.

## What Communication Threads Are

Communication threads are Andrea's lightweight record of a conversation the user explicitly brought in.

Each communication thread tracks:

- linked person or people
- linked life thread ids when relevant
- source channel
- last inbound summary
- last outbound summary or draft summary
- unresolved follow-up state
- urgency
- suggested next action
- tone hints
- last contact time
- whether the state is user-confirmed or assistant-inferred
- whether tracking is default, manual-only, or disabled

Andrea stores analyzed state and references, not a second full copy of the raw chat history. Raw message bodies stay in the existing message history store when the channel already provided them.

## How This Differs From Other Systems

- Memory/profile facts:
  durable facts and preferences about the user or people
- Life threads:
  broader ongoing matters like Candace, the band, the house, or family
  logistics; their canonical commitment state records ownership, waiting,
  delegation, blockers, deferral, and conditional follow-up
- Reminders:
  concrete future nudges
- Knowledge library:
  saved source material and reference notes
- Communication threads:
  explicit conversation-level follow-through about who said what, what still needs a reply, and what next action makes sense

Andrea can connect these systems, but they stay distinct.

When a message completes one user action and starts a wait—for example, `I sent
Brandon the file and now I'm waiting`—communication companion must use the
life thread's canonical waiting state. It must not keep recommending the send.
A later `follow up Friday if he has not replied` remains connected to the same
thread. Clear delegation changes current ownership without marking the
conversation complete; ambiguous ownership changes ask for clarification.
See [COMMITMENT_INTELLIGENCE.md](COMMITMENT_INTELLIGENCE.md).

## Current Scope

This pass is explicit-only.

Andrea creates or updates communication context only when the user explicitly brings a message or conversation to Andrea in:

- Telegram
- BlueBubbles
- an Alexa handoff / continuation

Out of scope in v1:

- passive inbox crawling
- unapproved or automatic first-contact message sending
- autonomous follow-up spam

BlueBubbles V1 can sync contact and group chats as communication data, but only the explicitly configured owner self-thread can wake Andrea. Alias text in ordinary contact or group messages never turns those threads into control surfaces.

## What Andrea Can Do

Current communication capabilities:

- `communication.understand_message`
  - summarize a message
  - identify if a reply or follow-up is still needed
  - explain why
- `communication.draft_reply`
  - draft a reply
  - make it warmer
  - make it more direct
  - keep it short
  - turn the draft into a tracked message action for send/defer/review
- `communication.open_loops`
  - answer `what do I owe people`
  - answer `anything I need to reply to`
  - answer `what conversations are still open`
- `communication.manage_tracking`
  - save under a life thread
  - remind me to reply later
  - keep the draft unsent while saving it under the thread for later follow-through
  - don't surface this automatically
  - stop tracking that
  - mark that handled
- `communication.manage_identity_links`
  - list unresolved conversation identities with `review communication identities`
  - use the returned opaque key without exposing a raw identifier, for example
    `link identity R-12AB34CD to "Existing person"`
  - in Telegram, choose from bounded buttons for the first unresolved
    conversation; each explicit choice returns the next item without granting a
    new authority path
  - prioritize safe exact-profile-name matches before labeled unknowns and
    opaque identifier-shaped conversations, while preserving stable order
    within each class
  - skip threads that already have an explicit person link even when they do
    not have a separate identity-review row
  - treat authoritative channel group metadata as single-person identity not
    applicable, without creating a person link or pretending the owner reviewed
    it; audience confirmation still applies before drafting or sending
  - exclude configured Messages owner self-threads automatically; a private
    control thread is not another person and must not consume identity-review
    work
  - in the text-only Messages self-thread, return exact link/dismiss commands
    for the next unresolved item after every decision
  - aggregate unresolved identity work into one daily-context gap and retain at
    most the two most urgent unknown-audience reply candidates, so generic
    threads cannot crowd grounded people and life threads out of daily guidance
  - give an explicit dismissal narrower audience-review credit without treating
    the conversation as a known person; relationship-aware credit still
    requires a confirmed person link
  - propose a person only when the safe label exactly matches one eligible
    existing individual profile person
  - mark unknown direct conversations not applicable with
    `dismiss identity R-12AB34CD`; the UI calls this `Keep without person link`
    because it resolves the review as intentionally unlinked rather than
    leaving it pending; known group conversations need no identity decision
  - reverse a decision with `clear identity review R-12AB34CD`
  - exclude generic self labels and collective categories from one-person choices
  - withhold ambiguous duplicate profile names until the profile itself is
    disambiguated, so every displayed choice is actionable

Identity review is private to the registered main Telegram chat and the
configured BlueBubbles self-thread.
It stores a metadata-only owner decision separately from inferred urgency,
summaries, and follow-through state. It never creates a person, matches a phone
number or raw identifier, reads message bodies to infer identity, or treats a
group chat as one person.

## Calendar vs Reminder vs Save

Communication follow-through should keep these paths distinct:

- `put this on my calendar` should go to the calendar create path when Google Calendar is configured
- `remind me later` should create a reminder, not a calendar event
- `save that for later` or `save that under the thread` should keep the follow-through unsent and non-calendar

Andrea should never talk as if a calendar event was created when the real result was only a reminder or saved thread follow-through.

## Channel Behavior

Alexa:

- concise orientation only
- good for `what do I owe people`, `what's still open with Candace`, `draft that for me`, and `remind me to answer later`
- does not read long conversation detail aloud
- can hand richer detail to Telegram or BlueBubbles

Telegram:

- richest communication surface
- better for full summaries, structured open loops, and richer draft review
- can send or stage a recipient-bound text to an existing synced one-to-one
  BlueBubbles conversation, exact contact, or explicit phone/email from the
  registered main chat
- treats a direct owner send imperative as recipient/body selection only; all
  `Text`, `draft`, and `prepare` wording stays unsent until a separate fresh
  `Send now` or `send it` approval is bound to the presented action
- reports success only after binding a provider receipt to the immutable
  approved recipient/body snapshot; missing, partial, group, or ambiguous
  recipients fail closed
- creates a new direct chat in one BlueBubbles request after explicit
  authorization and
  blocks automatic replay when delivery cannot be verified

BlueBubbles:

- calmer text-first communication surface
- good for explicit message understanding, reply drafting, and quick relationship follow-through

## Safety And Trust

- no outbound send without explicit user intent
- live delivery now follows the Messaging Trust Ladder rather than ad hoc draft text
- no passive message surveillance
- no auto-reply
- communication tracking can be turned manual-only or disabled
- `mark that handled` and `stop tracking that` are first-class controls
- a life thread may support a draft only when it is explicitly carried into the
  conversation, topically relevant, recipient-safe, normal-sensitivity,
  confirmed, actionable, and not suppressed; shared people alone are not enough
- accepted profile facts may select only a closed style such as `short`,
  `warmer`, or `direct`; their text is never copied into a draft or provider
  payload
- sensitive or legacy planning titles are replaced before persistence and are
  omitted from provider prompts; the optional recent-text cloud pass does not
  receive unrelated profile or life-thread memory
- a fresh direct imperative such as `Text Avery Example: Dinner is ready.`
  selects and displays the exact recipient/body but does not send; only a
  separate fresh `Send now`/`send it` approval on that presented action may
  enter provider dispatch
- style or authoring instructions remain review-staged. Andrea never appends a
  generic canned joke or other unrelated recipient-facing prose

For the draft -> approve -> send boundary itself, see [MESSAGING_TRUST_LADDER_AND_LIVE_DELIVERY.md](MESSAGING_TRUST_LADDER_AND_LIVE_DELIVERY.md).

## Practical Prompts

- `Text Avery Example: Dinner is ready.`
- `Send a text message to Avery Example saying Dinner is ready.`
- `Summarize this message: Candace: Can you let me know if dinner still works tonight?`
- `What should I say back?`
- `Give me a short reply.`
- `Make it warmer.`
- `What do I owe people right now?`
- `What's still open with Candace?`
- `Remind me to reply later tonight.`
- `Save this conversation under the Candace thread.`
- `Keep that as a draft for now.`
- `Don't surface this automatically.`
- `Review communication identities.`

## Testing

Focused validation:

- `node scripts/run-with-pinned-node.mjs ./node_modules/vitest/vitest.mjs run src/communication-companion.test.ts src/assistant-capabilities.test.ts src/assistant-capability-router.test.ts src/alexa-conversation.test.ts src/daily-companion.test.ts`
- `npm run debug:communication-companion`

Broader validation:

- `npm run typecheck`
- `npm run build`
- `npm test`
- `npm run telegram:user:smoke`
