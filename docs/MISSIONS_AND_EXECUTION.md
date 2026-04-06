# Missions And Execution

Andrea now has a bounded `missions.*` layer for turning an explicit goal into a stored plan that can move forward across Alexa, Telegram, and BlueBubbles.

## Where This Shows Up In Signature Flows

Missions are the core of flows like:

- `help me plan tonight`
- `help me prepare for the weekend`
- `turn this into a plan`

The productized journey should feel like:

- Andrea proposes a readable plan
- names the blocker
- suggests one supporting action
- executes that action only after the user says yes
- keeps the same plan alive across Alexa, Telegram, and follow-through

## What Missions Are

Missions are not a second task manager.

They are a small planning layer over the systems Andrea already uses:

- chief-of-staff: what matters and why
- life threads: ongoing matters
- communication companion: people, replies, and open loops
- reminders: concrete nudges
- rituals: when something gets surfaced again
- knowledge library: saved supporting material
- current work: immediate execution pressure

A mission stores:

- title and objective
- category and scope
- status
- linked people, threads, reminders, current work, and saved material
- a short summary
- a suggested next action
- blockers
- a due horizon
- a small ordered step list
- whether the user has confirmed the mission as active

## Proposed vs Active

Explicit planning prompts like:

- `help me plan Friday dinner with Candace`
- `turn this into a plan`
- `help me prepare for tonight`

create a stored `proposed` mission immediately.

That gives Andrea continuity without waiting for a second turn, but proposed missions do not automatically become part of ongoing surfacing.

Only `active` or otherwise confirmed missions should start feeding broader carryover reads.

Useful controls:

- `save this plan`
- `activate this`
- `pause that plan`
- `close that plan`
- `mark this done`

## What Andrea Can Do

Mission synthesis stays bounded and explainable:

- short plan summary
- 3-5 practical steps
- blockers or missing information
- one sensible next move
- suggested supporting actions

Suggested supporting actions can reuse existing systems:

- create a reminder
- draft a follow-up
- save supporting material to the library
- link the mission to a life thread
- pin it into the evening reset
- start a research follow-up
- keep current work context attached

Durable actions still require explicit user intent such as:

- `do it`
- `remind me`
- `draft it`
- `save that`
- `track that`
- `start the research`

## Channel Shape

Alexa:

- short orientation only
- lead summary
- next step
- main blocker
- optional handoff to Telegram

Telegram:

- full mission summary
- step list
- blocker view
- suggested actions
- richer explainability

BlueBubbles:

- concise parity for mission reads
- can continue the same mission context
- not the primary mission-editing surface in this pass

## Explainability And Control

Natural controls include:

- `what's the plan`
- `why this plan`
- `what's blocking this`
- `what should I do first`
- `make it simpler`
- `break it down more`
- `stop suggesting that`

Andrea should always be able to point back to the actual signals shaping the plan: calendar pressure, communication loops, linked threads, chief-of-staff pressure, saved material, or missing information.

## Out Of Scope

- no giant planner UI
- no autonomous project management
- no passive inbox or project ingestion
- no automatic execution of durable actions
- no replacement of life threads, reminders, or current work

## Testing

Focused validation for this layer:

```bash
node scripts/run-with-pinned-node.mjs ./node_modules/vitest/vitest.mjs run src/missions.test.ts src/assistant-capability-router.test.ts src/assistant-capabilities.test.ts src/cross-channel-handoffs.test.ts
npm run debug:missions
npm run typecheck
npm run build
npm test
npm run telegram:user:smoke
```
