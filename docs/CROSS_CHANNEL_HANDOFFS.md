# Andrea Cross-Channel Handoffs

Andrea now has a bounded cross-channel handoff layer so one conversation can start on Alexa and finish on Telegram without feeling like two different assistants.

This is not a background notification system.
It is not a generic automation bus.
It is an explicit, user-visible handoff and action-completion layer built on the existing shared capability graph.

## What It Does

Andrea can now:

- answer briefly on Alexa
- offer a fuller Telegram continuation when the result is richer than voice should carry
- turn a voice conversation into a concrete action using the existing reminder, thread, library, and ritual systems
- keep the handoff explicit and honest if delivery fails

Current Alexa-to-Telegram handoff targets:

- bounded research summaries and comparisons
- Knowledge Library summaries with richer source detail
- image-generation delivery when the media path already has an artifact
- daily and household companion answers when the user wants the fuller text in Telegram

Current voice-triggered completion actions:

- `send me the details`
- `send the full version to Telegram`
- `also send it to Telegram`
- `save that in my library`
- `track that under Candace`
- `turn that into a reminder`
- `make that part of my evening reset`

## What It Is Not

Andrea still does **not**:

- silently push content across channels
- retry handoffs forever in the background
- expose work cockpit or admin/runtime controls through Alexa
- create a second planner or second task system

Telegram remains the rich continuation surface.
Alexa remains the concise conversational surface.

## Handoff Model

The shared model stores:

- `handoffId`
- origin and target channel
- capability id
- short voice summary
- rich Telegram-ready payload
- status
- creation and expiry timestamps
- related thread / task / knowledge refs
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

## Voice And Telegram Behavior

Alexa aims for natural offers, not menus.

Typical phrases:

- `Want the fuller version in Telegram?`
- `I can send the details to Telegram.`
- `I can save that for tonight if you want.`
- `I can keep track of that under the Candace thread.`

Telegram then receives the richer continuation:

- structured research answer
- richer source-grounded detail
- image artifact or captioned output
- action confirmation for save/remind/track flows

The goal is:

- Alexa starts the interaction
- Telegram finishes the deeper part
- Andrea still feels like one assistant

## Safety And Channel Boundaries

The handoff layer reuses existing capability gating instead of bypassing it.

Important boundaries:

- only Alexa-to-Telegram handoffs are in scope for v1
- only the registered main Telegram chat for the linked Andrea group is used as the delivery target
- work cockpit, logs, runtime controls, and other operator-only flows remain out of scope for Alexa
- failed delivery is surfaced honestly

If no registered main Telegram chat exists for the linked account, Andrea says so plainly and the handoff is marked failed.

## Testing

Focused tests:

- [src/cross-channel-handoffs.test.ts](../src/cross-channel-handoffs.test.ts)
- [src/assistant-action-completion.test.ts](../src/assistant-action-completion.test.ts)
- [src/alexa.test.ts](../src/alexa.test.ts)
- [src/alexa-conversation.test.ts](../src/alexa-conversation.test.ts)
- [src/assistant-capability-router.test.ts](../src/assistant-capability-router.test.ts)

Operator proof harness:

```bash
npm run debug:cross-channel-handoffs
```

That harness proves:

- one research handoff
- one knowledge-detail handoff
- one media handoff
- one save-to-library completion
- one reminder completion

The output prints the final handoff status, target chat, and delivered text or artifact receipt.

## Intentional Limits

Current intentional limits:

- no generic cross-channel routing beyond Alexa to Telegram
- no autonomous follow-up loops
- no background retries
- no silent pushes
- no broadening of Alexa into unrestricted Telegram/operator behavior
