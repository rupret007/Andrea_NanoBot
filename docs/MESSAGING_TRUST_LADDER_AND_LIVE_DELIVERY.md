# Messaging Trust Ladder And Live Delivery

Andrea's messaging trust ladder is the bounded layer that sits on top of the communication companion, BlueBubbles delivery, follow-through reviews, delegation rules, and outcome reviews.

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
   - default for suggested replies and drafts; a direct explicit owner send
     imperative satisfies this approval at request time
4. `schedule_send`
   - `send later` queues a one-off scheduled send for an already approved, existing-thread BlueBubbles reply
   - Andrea revalidates the action at send time and only fires it if it is still safe and valid
5. `delegated_safe_send`
   - only for narrow BlueBubbles same-thread low-risk replies with an explicit saved rule
6. `never_automate`
   - high-risk or privileged sends never cross into automation

## What Can And Cannot Be Sent

The default BlueBubbles flow is:

1. summarize or review the conversation
2. offer one or more suggested replies
3. turn one selected suggestion into a single draft/action record
4. wait for explicit user approval to send now, send later, remind later, save,
   or keep as draft

`send it` and `send it later` apply only to the current same-thread draft/action.
They do not approve unrelated suggestions or older stale reviews.

A separate host-owned execution flow handles direct imperatives such as
`Text Travis Story: Dinner is ready` or `Have BlueBubbles send Travis Story a
message saying ...`. The same utterance selects the exact recipient/body and is
the explicit approval required by the runtime capability registry. It executes
with at most one fenced provider attempt only when the tool is registered and
exposed, the provider is healthy, and write permission is enabled. `Draft...`
and `Prepare...` wording never enters that execution flow.

### Supported in V1

- BlueBubbles same-thread replies after explicit approval
- BlueBubbles same-thread defer/send-later flows
- Telegram-rich management of a BlueBubbles reply draft
- owner-requested Telegram-to-BlueBubbles delivery for an existing synced
  one-to-one conversation, exact BlueBubbles/macOS contact, or explicit
  phone/email address, with the owner send imperative serving as approval and
  the provider receipt bound to the immutable approved recipient/message
  snapshot before success is reported
- self-companion follow-through visibility in Telegram

### Still guarded

- all external sends require explicit owner authorization; a direct send
  imperative supplies it, while a staged draft needs a later send decision
- delegated auto-send is only allowed for narrow low-risk BlueBubbles same-thread 1:1 replies
- high-risk emotional, calendar, money, medical, or commitment-changing messages stay draft/approval-first
- group and ambiguous recipients fail closed; first-contact delivery uses one
  fenced provider POST and verify-before-resend handling
- `send later` is one-off, same-thread, existing-thread only, and revalidated at send time
- failed, stale, unsent, and scheduled sends stay visible in review/outcome surfaces

### Out of scope

- group-chat auto-send
- unapproved or ambiguous first-contact sending
- broad background auto-send outside the bounded scheduled-send queue
- recurring scheduled delivery
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
- send this to an already known BlueBubbles conversation when the target is explicit
- remind me instead
- save it under the thread
- explain why approval is still required
- show what messages are still unsent through review

The registered main Telegram chat can also start a new message to an existing
synced one-to-one BlueBubbles conversation, an exact contact, or an explicit
address. For example:

- `Text Travis Story: Dinner is ready.`
- `Send a text message to Travis Story saying Dinner is ready.`
- `Text +1 202 555 0123: Dinner is ready.`

Andrea resolves the exact conversation/contact/address and executes one send
when the owner used an explicit send imperative. That utterance is the fresh
approval; it is not followed by a redundant confirmation. `Draft a message...`
or `Prepare a message...` instead creates the recipient-bound draft and action
controls without sending. A first-contact message is never queued for later.

Only the registered main Telegram chat or configured Messages self-thread can
create or approve this action. Unknown or ambiguous names fail closed; Andrea
does not guess. A first-contact name must match exactly and must resolve to one
address; multiple addresses are shown as choices and require a new request with
the exact phone/email. BlueBubbles contact hydration may attach a derived
display name to an existing local chat record, but it does not store contact
cards, avatars, or a second address-book archive. For a first contact, only the
selected recipient name/address pair enters the normal message-action record.
After explicit authorization, Andrea permits one fenced BlueBubbles
`/api/v1/chat/new` POST for that action. It requires both the created chat
identifier and message receipt before marking
the action sent. Before the network call, it durably enters a verify-before-
resend state, so a process or machine failure inside the external side-effect
window cannot reopen the action for automatic replay. A timeout, uncertain
response, malformed receipt, or lost response remains `delivery_unverified`;
Andrea tells the owner to inspect the conversation and blocks automatic retry.

### BlueBubbles

BlueBubbles is the real companion delivery surface for external messaging in V1.

Andrea can:

- draft a reply in the same thread
- let the user say `send it`
- let the user say `send it later`
- let the user say `remind me later`
- revise the draft with `shorter` or `make it warmer`
- keep scheduled sends, failed sends, and unsent drafts visible in review instead of dropping them after draft time

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
  - queue one specific approved draft for one-off later delivery in the same known BlueBubbles thread
  - you can still edit, cancel, or convert it to a reminder before it fires
- `save under thread`
  - keep the draft unsent, but attach it to the tracked thread so Andrea can bring it back in follow-through and review
- `keep as draft`
  - keep the text as a draft only, with no send queue and no implied reminder
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
- saved under thread for later follow-through
- deferred to later
- failed to send
- sent successfully

This shows up in daily and weekly review, especially under:

- `Sent Today`
- `Waiting For Approval`
- `Scheduled Sends`
- `Failed Sends`
- `Unsent Drafts`
- `What I Still Owe People`
- `What Changed After Approval`

## Testing

Focused repo-side proof:

```bash
node scripts/run-with-pinned-node.mjs ./node_modules/vitest/vitest.mjs run src/bluebubbles-outbound-request.test.ts src/bluebubbles-recipient-directory.test.ts src/message-actions.test.ts src/action-bundles.test.ts src/outcome-reviews.test.ts src/channels/bluebubbles.test.ts src/field-trial-readiness.test.ts src/task-scheduler.test.ts src/task-scheduler.automation.test.ts
npm run typecheck
npm run build
npm run test
npm run telegram:user:smoke
npm run debug:bluebubbles -- --live
```

Strong near-live proof:

1. from the registered main Telegram chat, request a text to an existing
   synced one-to-one conversation or exact contact
2. confirm the staged card shows the exact recipient and exact body and that no
   outbound message exists yet
3. approve it separately and confirm exactly one BlueBubbles delivery receipt
4. draft a same-thread BlueBubbles reply
5. create one `send later` case and confirm it becomes a scheduled task
6. confirm review shows sent vs scheduled vs failed vs unsent honestly
7. rerun `npm run debug:bluebubbles -- --live` and check the same-thread message-action proof leg
8. if a narrow send rule exists, confirm Andrea explains when it used it
