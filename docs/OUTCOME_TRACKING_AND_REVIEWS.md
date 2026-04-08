# Outcome Tracking And Reviews

Andrea's outcome tracking and review layer is the bounded closure system that sits on top of bundles, missions, reminders, life threads, communication threads, current work, and handoffs.

It exists so Andrea can reason about what actually happened after an action, not just what it suggested or staged.

## What Outcomes And Reviews Are

An outcome is Andrea's current best closure state for one underlying loop.

Examples:

- a reminder was created, so the loop is deferred rather than solved
- a draft reply exists, but the conversation is still open
- a message was deferred to send later, so the reply is still owed
- a mission step was completed, but the mission is still blocked
- a handoff was delivered, but nothing has acted on it yet
- a communication thread was marked handled, so the loop can drop out of review

Reviews then turn that outcome truth into useful answers like:

- what got done today
- what is still open tonight
- what slipped
- what am I carrying into tomorrow
- what should I review this weekend

## What This Layer Is Not

Outcome tracking is intentionally not:

- a second planner
- a second task database
- a recurring review engine
- a silent autonomous follow-through system
- a replacement for missions, reminders, or life threads

Missions still hold the plan.
Bundles still hold approved next actions.
Reminders still hold future nudges.
Life threads still hold ongoing matters.
Outcomes only hold closure truth across those systems.

Delegation rules can influence how an action was handled, but they do not replace closure truth.
If Andrea used a saved rule to create a reminder, for example, the outcome should still usually read as `deferred`, not falsely `completed`.

## Core Outcome Model

Andrea stores one compact outcome row per tracked source.

Important fields include:

- source type
- linked refs
- status
- completion summary
- blocker
- next follow-up
- review horizon
- user-confirmed flag
- daily and weekly review visibility

Current statuses are:

- `completed`
- `partial`
- `skipped`
- `failed`
- `deferred`
- `unknown`

Those statuses are intentionally small and inspectable.
For messaging specifically, outcomes can now link to a first-class message action so Andrea can distinguish drafted, deferred, failed, skipped, and sent follow-through.

## Closure Semantics

Andrea should not assume that action execution means the underlying problem is solved.

Examples:

- reminder created -> usually `deferred`
- bundle executed partially -> `partial`
- delivered handoff with no downstream closure -> `deferred` or `partial`
- communication thread marked handled -> `completed`
- mission progressed but still active -> `partial`

That distinction is the whole point of the layer.

For the draft -> approve -> send boundary itself, see [MESSAGING_TRUST_LADDER_AND_LIVE_DELIVERY.md](MESSAGING_TRUST_LADDER_AND_LIVE_DELIVERY.md).

## Daily And Weekly Reviews

Reviews are on-demand in v1.

Andrea can build a grounded review snapshot that includes:

- completed today
- still open tonight
- carry into tomorrow
- slipping
- blocked
- deferred
- owed replies
- review this week
- lingering
- weekly resolved

The goal is specific closure truth, not motivational fluff.

## Telegram Versus Alexa

### Telegram

Telegram is the richer review surface.

When you explicitly ask for review, Andrea can show grouped sections such as:

- what got done
- what is still open
- what slipped
- what should move into tomorrow

Telegram can also show bounded controls for the top surfaced items:

- `Mark handled`
- `Still open`
- `Remind tomorrow`
- `Hide from review`
- `Show thread/plan again`

### Alexa

Alexa stays brief and orienting.

It should answer prompts like:

- `what actually got done today`
- `what slipped`
- `what should I follow up on tomorrow`
- `what's still open with Candace`

Alexa should mention:

- one main completion or carryover
- one main blocker or slip when present
- one next-step hint if useful

When the review is too dense, Alexa should hand off to Telegram instead of reading a long list.

### BlueBubbles

BlueBubbles stays bounded.

Short review guidance is acceptable, but richer review output should hand off to Telegram.

## Natural Controls

Andrea supports natural closure controls in context, including:

- `mark that handled`
- `that's done`
- `still open`
- `remind me tomorrow instead`
- `don't show that in review`
- `close that out`

These controls update the safest underlying source state when possible, then sync the outcome record.

Review suppression hides an item from review without deleting the underlying source.

## How This Differs From Action Bundles

Action Bundles help Andrea move from advice to explicit approved actions.

Outcome tracking starts after that.

Typical flow:

1. Andrea suggests a few next actions.
2. You approve one or more.
3. Andrea executes those actions through existing systems.
4. Outcome tracking records what actually happened.
5. Daily or weekly review surfaces what is still unresolved.

Bundles are about approval.
Delegation rules are about remembered safe defaults.
Outcomes are about closure.

## Rule-Driven Actions In Review

When a saved delegation rule fires, Andrea should keep that visible in review rather than hiding it.

Examples:

- `Used your usual reminder rule here.`
- `Saved under your usual Candace follow-up rule.`
- `Marked as carryover using your usual evening-review rule.`

That matters for trust:

- you can see that a default was reused
- you can tell when the default was helpful
- you can decide later that Andrea should always ask instead

## How This Connects To Existing Systems

- missions = plan truth
- bundles = approved execution
- reminders = concrete future checkpoint
- life threads = ongoing matter
- communication threads = reply and follow-through truth
- current work = immediate focus
- outcomes and reviews = cross-system closure state

Those systems stay distinct on purpose.

## Testing And Demo Flow

For repo-side validation, run:

```bash
node scripts/run-with-pinned-node.mjs ./node_modules/vitest/vitest.mjs run src/outcome-reviews.test.ts src/alexa.test.ts src/action-bundles.test.ts src/communication-companion.test.ts src/delegation-rules.test.ts
npm run typecheck
npm run build
npm run test
npm run telegram:user:smoke
```

For a practical review proof, use a flow like:

1. create a bundle that only partially executes
2. confirm the outcome is `partial` or `deferred`, not falsely `completed`
3. ask `daily review` in Telegram
4. confirm the unresolved loop appears
5. use `Remind tomorrow` or `Mark handled`
6. ask `what am I carrying into tomorrow` or `what got done today`

For Alexa, use:

1. `what actually got done today`
2. `what's still open with Candace`
3. `remind me tomorrow instead`

## Intentionally Out Of Scope

V1 does not include:

- autonomous review pushes
- recurring review scheduling
- off-platform closure inference Andrea cannot verify
- a new workflow engine
- a hidden audit log product

The goal is honest follow-through, not more system sprawl.
