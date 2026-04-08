# Action Bundles

Andrea's Action Bundles are the bounded approval layer that sits between advice and execution.

They exist so Andrea can say, "here are the best next steps," let you approve the ones you want, and then run them through the systems Andrea already has.

## What Bundles Are

An Action Bundle is a small proposed set of next steps, usually two to four actions, that Andrea synthesizes from an answer you just got.

Examples:

- a Candace follow-through answer can become:
  - draft the reply
  - remind me later
  - save it under the Candace thread
- a mission answer can become:
  - draft the follow-up
  - set a reminder
  - save the mission context to the thread
- a research answer can become:
  - send the fuller version to Telegram
  - save the result to the library
  - remind me to revisit it

## What Bundles Are Not

Bundles are intentionally not:

- a second planner
- a replacement for missions
- a replacement for reminders
- a workflow engine
- autonomous execution

Missions still hold the plan.
Life threads still hold the ongoing matter.
Reminders still hold the concrete nudge.
Bundles only hold explicit user-approved next actions.

## Supported V1 Action Types

The first bundle layer only wraps existing Andrea actions:

- create reminder
- draft follow-up
- save to thread
- save to library
- pin to ritual
- send fuller version to Telegram
- keep current work in view for a mission

If Andrea cannot express the next step through one of those bounded actions, it should not invent a bundle action for it.

## Where Bundles Show Up

### Telegram

Telegram is the rich approval surface.

Andrea sends a compact card with:

- a short bundle title
- one why line
- a numbered list of actions
- inline buttons:
  - `Approve all`
  - `Pick actions`
  - `Not now`

Selection mode then lets you:

- toggle individual actions
- run only the selected actions
- skip only the selected actions
- show the full bundle again

Conversational follow-ups still work for common phrases like:

- `just the reminder`
- `do the first two`
- `save but don't remind`
- `show me the actions again`
- `not now`

### Alexa

Alexa keeps bundles short and orienting.

Andrea does not read a full checklist by voice unless it is small enough to stay usable.
Instead, Alexa says that a few next steps are ready and supports simple follow-ups like:

- `do that`
- `just the reminder`
- `save it for later`
- `show me the actions again`
- `send the details to Telegram`

When the full approval surface would be too detailed for voice, Andrea should hand the bundle to Telegram.

### BlueBubbles

BlueBubbles stays bounded.

Andrea can mention that next steps are ready, but rich bundle approval stays Telegram-first.
If you want the full bundle from BlueBubbles, the intended path is an explicit Telegram handoff.

## Approval And Execution Rules

- Durable actions require explicit approval before execution.
- A bundle never claims an action ran unless Andrea persisted that result.
- Executed actions do not rerun just because the same bundle card is tapped again.
- Skipped, failed, and deferred actions stay visible in bundle state.
- Partial execution is normal and must be reported honestly.

## Partial Success And Failure

Andrea should sound calm and plainspoken when bundle execution is mixed.

Target style:

- `Andrea: Done — I set the reminder and saved the thread.`
- `Andrea: I handled the reminder, but the draft still needs attention.`
- `Andrea: Okay — I left that bundle for later.`

Normal companion replies should stay human and useful.
Technical detail belongs in logs and operator diagnostics, not in the bundle reply itself.

## How Bundles Differ From Other Systems

- Missions: the plan layer
- Life threads: the ongoing-matter layer
- Communication companion: the people/reply layer
- Rituals: the timing and proactive layer
- Reminders: the concrete nudge layer
- Action Bundles: the explicit approval-and-execution layer across those systems

Keeping those boundaries clear is part of the design.

## Persistence Model

Bundles are stored in Andrea's existing SQLite DB as compact records:

- one bundle record
- one row per action

Andrea tracks:

- bundle title and source
- presentation channel
- approval state
- per-action status
- timestamps
- related refs to missions, threads, reminders, and saved knowledge

The goal is inspectable execution state, not a new task database.

## Testing

For repo-side validation, run:

```bash
node scripts/run-with-pinned-node.mjs ./node_modules/vitest/vitest.mjs run src/action-bundles.test.ts src/assistant-action-completion.test.ts src/alexa-conversation.test.ts
npm run typecheck
npm run build
npm run test
npm run telegram:user:smoke
```

For a practical Telegram proof, use a flow that naturally produces multiple next steps, such as:

1. `what's still open with Candace`
2. confirm Andrea sends a bundle in Telegram
3. tap `Pick actions`
4. run one action
5. skip or defer another
6. confirm Andrea reports partial success or deferral honestly

For Alexa, use:

1. ask for a flow that produces a bundle
2. say `do that`
3. or say `send the details to Telegram`

## Intentionally Out Of Scope

V1 Action Bundles do not include:

- uncontrolled autonomous execution
- recurring workflows
- nested bundles
- media-heavy approval UX
- operator/admin execution controls
- a second task or project database

The point is better execution help, not less user control.
