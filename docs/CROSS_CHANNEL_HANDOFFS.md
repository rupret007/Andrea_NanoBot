# Andrea Cross-Channel Handoffs

Andrea has a bounded cross-channel handoff layer that lets BlueBubbles conversations continue in Telegram with the same context.

This is not a background notification system.
It is not a generic automation bus.
It is an explicit, user-visible handoff and action-completion layer built on the existing shared capability graph.

## What It Does

Andrea can now:

- offer a fuller Telegram continuation when more detail is useful
- send a bounded text continuation into the configured owner Messages self-thread when the user explicitly asks for it
- turn a conversation into a concrete action using the existing reminder, thread, library, and ritual systems
- keep the handoff explicit and honest if delivery fails

## Flagship Handoff Journeys

The current signature handoff journeys are:

- BlueBubbles -> Telegram escalation when the fuller answer is better there

In all of these, Andrea should feel like one assistant continuing the same thought, not two channels re-answering from scratch.
The current productization bar is that the richer continuation preserves the same lead, next step, and why-line rather than rephrasing the answer as a separate module.

Current handoff targets:

- bounded research summaries and comparisons
- Knowledge Library summaries with richer source detail
- image-generation delivery when the media path already has an artifact
- daily and household companion answers when the user wants the fuller text in Telegram
- communication-companion summaries, owed-reply views, and relationship-aware drafts when the user wants the richer text review on Telegram or BlueBubbles
- mission summaries, blocker views, and suggested next actions when the user asks to send the fuller plan

Current completion actions:

- `send me the details`
- `send the full version to Telegram`
- `send that to my messages` (delivered only to the configured owner self-thread)
- `save that to my messages`
- `send me the details in messages`
- `send me the full comparison`
- `give me the deeper comparison in Telegram`
- `also send it to Telegram`
- `save that for later`
- `remember that for later`
- `save that in my library`
- `track that under Candace`
- `keep track of that for tonight`
- `draft that for me`
- `draft a message about that`
- `turn that into a reminder`
- `make that part of my evening reset`

## What It Is Not

Andrea still does **not**:

- silently push content across channels
- retry handoffs forever in the background
- create a second planner or second task system

## Handoff Model

The shared model stores:

- `handoffId`
- origin and target channel
- capability id
- short continuation summary
- rich continuation payload
- status
- creation and expiry timestamps
- related thread / task / knowledge refs
- related communication-thread / subject / life-thread refs when the handoff came from the communication companion
- confirmation requirement
- follow-up suggestions
- delivery receipt or error text

Current statuses:

- `queued`
- `delivered`
- `failed`
- `cancelled`
- `expired`

The storage and delivery logic live in:

- [src/cross-channel-handoffs.ts](../src/cross-channel-handoffs.ts)
- [src/assistant-action-completion.ts](../src/assistant-action-completion.ts)

## Channel Behavior

Typical phrases:

- `Want the fuller version in Telegram?`
- `I can send the details to Telegram.`
- `I can save that for tonight if you want.`
- `I can save that for later.`
- `I can draft that for you.`
- `I can keep track of that under the Candace thread.`

Telegram then receives the richer continuation:

- structured research answer
- richer source-grounded detail
- mission summary, blockers, suggested actions, and next-step focus when the current continuation is a plan
- image artifact or captioned output
- action confirmation for save/remind/track flows

BlueBubbles can now receive:

- the same shared companion tone and context as Telegram
- no operator/admin spillover
- no assistant handoff content in contact or group conversations

The goal is:

- Telegram finishes the deeper part
- Andrea still feels like one assistant

## Safety And Channel Boundaries

The handoff layer reuses existing capability gating instead of bypassing it.

Important boundaries:

- the registered main Telegram chat and configured owner Messages self-thread are the only valid delivery targets in v1
- contact chats, group chats, message-action targets, pilot history, and recent conversation activity can never select a BlueBubbles handoff destination
- failed delivery is surfaced honestly

If no registered main Telegram chat exists for the group, Andrea says so plainly and the handoff is marked failed.
If no owner Messages self-thread is explicitly configured, Andrea says so plainly and the handoff fails closed.

## Testing

Focused tests:

- [src/cross-channel-handoffs.test.ts](../src/cross-channel-handoffs.test.ts)
- [src/assistant-action-completion.test.ts](../src/assistant-action-completion.test.ts)
- [src/assistant-capability-router.test.ts](../src/assistant-capability-router.test.ts)

Operator proof harness:

```bash
npm run debug:cross-channel-handoffs
npm run debug:bluebubbles
```

That harness proves:

- one research handoff
- one knowledge-detail handoff
- one media handoff
- one save-to-library completion
- one reminder completion

The output prints the final handoff status, target chat, and delivered text or artifact receipt.

The harness now seeds an isolated test database for each run so repeated proof passes do not accumulate duplicate saved-source output.

## Intentional Limits

Current intentional limits:

- no generic cross-channel routing beyond Telegram and the configured owner Messages self-thread
- no autonomous follow-up loops
- no background retries
- no silent pushes
