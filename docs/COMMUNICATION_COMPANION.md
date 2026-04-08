# Andrea Communication Companion

Andrea now has a bounded communication-companion layer for real people, replies, and follow-through.

## Where This Shows Up In Signature Flows

Communication companion is the core of journeys like:

- `What's still open with Candace?`
- `What do I owe people right now?`
- `What should I say back?`
- `Remind me to reply later tonight.`

The flagship product goal is that Andrea can move from open loop -> draft -> approve/send or defer without making the user restate the whole conversation.
Telegram and BlueBubbles should now preserve the same communication-thread context across that journey, with Telegram as the richer review/edit surface and BlueBubbles as the calmer message-help surface.

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
  broader ongoing matters like Candace, the band, the house, or family logistics
- Reminders:
  concrete future nudges
- Knowledge library:
  saved source material and reference notes
- Communication threads:
  explicit conversation-level follow-through about who said what, what still needs a reply, and what next action makes sense

Andrea can connect these systems, but they stay distinct.

## Current Scope

This pass is explicit-only.

Andrea creates or updates communication context only when the user explicitly brings a message or conversation to Andrea in:

- Telegram
- BlueBubbles
- an Alexa handoff / continuation

Out of scope in v1:

- passive inbox crawling
- automatic message sending
- autonomous follow-up spam

BlueBubbles V1 can now work across synced chats, but Andrea should still wake only on explicit `@Andrea` mentions and should not behave like a passive inbox triage bot.

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
  - don't surface this automatically
  - stop tracking that
  - mark that handled

## Channel Behavior

Alexa:

- concise orientation only
- good for `what do I owe people`, `what's still open with Candace`, `draft that for me`, and `remind me to answer later`
- does not read long conversation detail aloud
- can hand richer detail to Telegram or BlueBubbles

Telegram:

- richest communication surface
- better for full summaries, structured open loops, and richer draft review

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

For the draft -> approve -> send boundary itself, see [MESSAGING_TRUST_LADDER_AND_LIVE_DELIVERY.md](MESSAGING_TRUST_LADDER_AND_LIVE_DELIVERY.md).

## Practical Prompts

- `Summarize this message: Candace: Can you let me know if dinner still works tonight?`
- `What should I say back?`
- `Give me a short reply.`
- `Make it warmer.`
- `What do I owe people right now?`
- `What's still open with Candace?`
- `Remind me to reply later tonight.`
- `Save this conversation under the Candace thread.`
- `Don't surface this automatically.`

## Testing

Focused validation:

- `node scripts/run-with-pinned-node.mjs ./node_modules/vitest/vitest.mjs run src/communication-companion.test.ts src/assistant-capabilities.test.ts src/assistant-capability-router.test.ts src/alexa-conversation.test.ts src/daily-companion.test.ts`
- `npm run debug:communication-companion`

Broader validation:

- `npm run typecheck`
- `npm run build`
- `npm test`
- `npm run telegram:user:smoke`
