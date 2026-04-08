# Delegation Rules And Safe Automation

Andrea's delegation rules are the bounded layer that lets repeated, explicitly approved action patterns become smoother over time.

They exist so Andrea can remember safe defaults like reminder timing, save targets, ritual carryover, or Telegram handoff preferences without turning into a silent workflow engine.

## What Delegation Rules Are

A delegation rule is an inspectable record of:

- what kind of situation triggered the rule
- what action Andrea should prefer
- whether Andrea should still ask, ask once then remember, auto-apply when safe, or only suggest it
- where the rule applies
- how often it has been used or overridden

Examples:

- when I say `save that`, use tomorrow morning by default
- if Candace follow-through needs a reminder, use tonight
- always send the full version to Telegram
- don't ask me every time about saving this kind of thing to the thread

## What Delegation Rules Are Not

Delegation rules are intentionally not:

- unrestricted autonomy
- a workflow DSL
- a second planner
- a second task database
- silent background behavior

Andrea only evaluates rules while it is already handling a user-visible flow.

## Safety Boundary

### Safe To Auto-Apply After Explicit Delegation

- save to thread
- save for later or mark carryover
- save to library
- pin to ritual
- reference current work
- send fuller detail to Telegram
- create a bounded reminder such as tonight or tomorrow morning
- generate a draft artifact that is not sent

### Safe To Suggest Only

- broader multi-action follow-through when the best next step is not precise
- low-confidence household or thread auto-linking
- ambiguous research follow-through

### Always Requires Fresh Approval

- calendar-event creation
- sending a message externally
- changing commitments
- closing or archiving important threads or missions
- deleting saved context or disabling important tracking

### Never Automate

- operator or admin actions
- runtime or work-cockpit controls
- destructive privileged operations

The rule engine can reduce friction, but it cannot bypass those safety classes.
Messaging now uses that boundary explicitly through the Messaging Trust Ladder, including the rule that external send stays approval-first unless an extremely narrow BlueBubbles same-thread safe-send rule is in play.

## Rule Model

Each rule is stored as a compact DB record with fields such as:

- title
- trigger type
- trigger scope
- structured conditions
- delegated actions
- approval mode
- status
- channel applicability
- safety level
- times used
- times auto-applied
- times overridden
- last outcome status

The goal is inspectable defaults, not hidden behavior.
When a rule touches messaging, the resulting send/defer state should still remain visible in message actions and outcome review.

## Natural Rule Creation

Andrea should understand phrases like:

- `do this automatically next time`
- `remember this as my default`
- `when this happens, save it for later`
- `don't ask me every time about that`
- `always ask before doing that`
- `stop doing that automatically`

The normal flow is:

1. Andrea resolves the in-focus action or context.
2. Andrea previews the rule in plain language.
3. You confirm it.
4. Andrea saves it and explains it when it fires later.

If the request is too ambiguous, Andrea asks one short narrowing question first.

## Telegram Versus Alexa

### Telegram

Telegram is the rich rule-management surface.

Use it for:

- creating rules
- showing active rules
- pausing or disabling rules
- changing `always ask` versus `auto-apply when safe`
- seeing why a rule fired

Telegram can also show inline controls such as:

- `Pause`
- `Disable`
- `Always ask`
- `Auto-apply when safe`
- `Why this fired`
- `Use only here`

### Alexa

Alexa stays concise.

It can:

- propose remembering a new default
- confirm a simple rule
- mention that it used your usual rule
- switch a focused rule back to `always ask`

If management or inspection gets detailed, Alexa should hand off to Telegram.

### BlueBubbles

BlueBubbles stays bounded.

It can honor safe delegated defaults, but richer rule management should hand off to Telegram.

## How Rules Affect Bundles, Missions, And Reviews

Delegation rules do not replace bundles, missions, or reviews.

Instead:

- bundles can arrive with some safe actions already approved because of a saved rule
- missions and follow-through flows can reuse preferred reminder and save defaults
- reviews can say when Andrea used a usual rule so behavior stays explainable

That means the product boundary stays clear:

- missions = plan structure
- action bundles = explicit approved actions
- delegation rules = remembered safe defaults
- outcomes and reviews = what actually happened

## Rule Quality And Overrides

Andrea records lightweight signals about each rule over time:

- how often it was used
- how often it auto-applied
- how often you overrode it
- the last outcome state tied to it

This helps Andrea surface whether a rule seems:

- useful
- mixed
- in need of revision

The goal is to avoid silently carrying a bad default forever.

## Testing

For repo-side validation, run:

```bash
node scripts/run-with-pinned-node.mjs ./node_modules/vitest/vitest.mjs run src/delegation-rules.test.ts src/action-bundles.test.ts src/assistant-action-completion.test.ts src/alexa.test.ts src/outcome-reviews.test.ts
npm run typecheck
npm run build
npm run test
npm run telegram:user:smoke
```

For a practical near-live proof, use:

1. trigger a flow that naturally suggests a safe action
2. say `do this automatically next time`
3. confirm Andrea previews the rule before saving it
4. trigger the same kind of flow again
5. confirm the safe delegated action is explained and reused
6. say `always ask before doing that`
7. confirm the next flow stops auto-applying that default

## Intentionally Out Of Scope

V1 does not include:

- auto-sending external messages
- auto-creating calendar events
- silent background automations
- a recurring workflow engine
- privileged operator automation

The point is smoother bounded follow-through, not less user control.

For the live messaging boundary layered on top of these rules, see [MESSAGING_TRUST_LADDER_AND_LIVE_DELIVERY.md](MESSAGING_TRUST_LADDER_AND_LIVE_DELIVERY.md).
