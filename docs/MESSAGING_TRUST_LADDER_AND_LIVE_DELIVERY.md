# Messaging Trust Ladder And Live Delivery

Andrea's messaging trust ladder is the bounded layer that sits on top of the communication companion, BlueBubbles delivery, action bundles, delegation rules, and outcome reviews.

It exists so Andrea can move from:

- understanding a conversation
- to drafting a reply
- to explicit approval
- to real delivery
- to defer/send-later tracking
- to honest follow-through review

without becoming an inbox client or an auto-reply bot.

## What This Layer Adds

Andrea now has a first-class `MessageActionRecord` for live messaging state.

That means a reply can be tracked as:

- drafted
- approved
- sent
- deferred
- failed
- skipped

instead of disappearing as plain draft text.

## The Trust Ladder

Andrea uses these messaging levels:

1. `draft_only`
   - use this for sensitive, ambiguous, group, or higher-stakes communication
2. `suggest_and_ask`
   - use this when Andrea can help but should not pretend the draft is send-ready
3. `approve_before_send`
   - default for real external messaging
4. `schedule_send`
   - `send later` keeps the draft and schedules it to come back for final approval
5. `delegated_safe_send`
   - only for narrow BlueBubbles same-thread low-risk replies with an explicit saved rule
6. `never_automate`
   - high-risk or privileged sends never cross into automation

## What Can And Cannot Be Sent

### Supported in V1

- BlueBubbles same-thread replies after explicit approval
- BlueBubbles same-thread defer/send-later flows
- Telegram-rich management of a BlueBubbles reply draft
- self-companion follow-through visibility in Telegram

### Still guarded

- all external sends require approval by default
- delegated auto-send is only allowed for narrow low-risk BlueBubbles same-thread 1:1 replies
- high-risk emotional, calendar, money, medical, or commitment-changing messages stay draft/approval-first

### Out of scope

- Telegram-to-other-people sending
- group-chat auto-send
- first-contact auto-send
- background auto-send at a scheduled time
- inbox/CRM behavior
- operator/admin/runtime automation

## Telegram Versus BlueBubbles Versus Alexa

### Telegram

Telegram is the rich message-management surface.

Andrea can:

- show the draft
- make it shorter
- make it warmer
- make it more direct
- send now
- send later
- remind me instead
- save it under the thread
- explain why approval is still required
- show what messages are still unsent through review

### BlueBubbles

BlueBubbles is the real companion delivery surface for external messaging in V1.

Andrea can:

- draft a reply in the same thread
- let the user say `send it`
- let the user say `send it later`
- let the user say `remind me later`
- revise the draft with `shorter` or `make it warmer`

Important rule:

- Andrea-authored companion/status replies keep the `Andrea:` label
- approved real outbound user messages do **not** get the `Andrea:` label

### Alexa

Alexa stays an orientation surface.

Andrea can:

- help decide what to say
- draft the reply
- remind you to reply later
- hand richer editing or sending to Telegram or BlueBubbles

Alexa does not directly execute external sends in V1.

## Send Later Versus Remind Later Versus Save For Later

These are intentionally different:

- `save for later`
  - preserve the thought or follow-through context
- `remind me later`
  - create a reminder without treating the message as scheduled-to-send
- `send later`
  - keep a specific draft message and resurface it later for final approval
- `approve and send now`
  - real delivery through the live channel

Andrea should not blur these together.

## Rule-Aware Messaging

Delegation rules can smooth messaging only inside the trust ladder.

They may:

- auto-draft
- auto-save
- auto-remind
- auto-mark a send as ready in a narrow safe case

They may not bypass the messaging safety boundary.

If Andrea uses a rule, reviews and outcomes should say so plainly, for example:

- `Used your usual rule here.`

## Outcomes And Review

Message actions feed the closed-loop outcome layer.

That means Andrea can now distinguish:

- draft exists
- approved but unsent
- deferred to later
- failed to send
- sent successfully

This shows up in daily and weekly review, especially under:

- owed replies
- still open tonight
- carry into tomorrow

## Testing

Focused repo-side proof:

```bash
node scripts/run-with-pinned-node.mjs ./node_modules/vitest/vitest.mjs run src/message-actions.test.ts src/action-bundles.test.ts src/outcome-reviews.test.ts src/channels/bluebubbles.test.ts
npm run typecheck
npm run build
npm run test
npm run telegram:user:smoke
```

Strong near-live proof:

1. draft a BlueBubbles reply
2. approve and send it in the same thread
3. create one `send later` case
4. confirm review shows sent vs deferred honestly
5. if a narrow send rule exists, confirm Andrea explains when it used it
