# Andrea Chief-of-Staff Mode

Andrea now has a bounded **Chief-of-Staff Mode** for prioritization, planning, preparation, and decision support.

## Where This Shows Up In Signature Flows

Chief-of-staff mode is the front door for journeys like:

- `what matters most today`
- `what am I forgetting`
- `what should I remember tonight`
- `what should I do next`

Its job is to surface one clear read, one thing not to let slip, and one next move.
When that answer needs richer detail or action, missions, reminders, communication follow-through, and handoffs take over without losing the thread.
In practice, the polished version should sound like one lead, one next step, and one short why-line, not a stack of separate subsystem reads.

This is not a second task manager and not an autonomous planner.

It is an on-demand synthesis layer that pulls together:

- calendar timing
- reminders and concrete nudges
- life threads and follow-through pressure
- communication open loops
- current work focus
- household or family context
- saved material only when prep or decision context clearly calls for it

## What It Is For

Chief-of-staff mode is for questions like:

- `what matters most today`
- `what should I do next`
- `what is slipping`
- `what should I handle before tonight`
- `what matters this week`
- `what should I prepare before tonight`
- `what's the tradeoff here`
- `should I handle this tonight or tomorrow`
- `why are you prioritizing that`

## What It Tracks

The shared synthesis model uses explicit signal types instead of a hidden score:

- `commitment`
- `waiting_on`
- `open_loop`
- `deadline`
- `pressure_point`
- `slip_risk`
- `prep_needed`
- `opportunity`
- `focus_candidate`

Each signal keeps:

- scope
- urgency
- importance
- recommended action
- explicit reasons such as time anchor, prep requirement, other-people dependency, overdue follow-up, household impact, or current work pressure

Andrea is allowed to say the read is low-confidence when the signal set is weak or mixed.

## What It Is Not

Chief-of-staff mode does **not**:

- create a second planner database
- auto-reprioritize or auto-reschedule things
- invent new commitments
- auto-send follow-ups
- replace life threads, reminders, rituals, current work, or communication tracking

Those systems stay canonical:

- life threads = ongoing matters
- communication threads = people and reply follow-through
- missions = explicit multi-step plans and bounded execution state
- reminders = concrete nudges
- rituals = timing and surfacing behavior
- knowledge library = saved source material
- current work = immediate execution focus

## Channel Shape

Andrea uses the same chief-of-staff synthesis across channels, but shapes it differently.

### Alexa

- short and calm
- one main thing first
- one or two support lines
- optional handoff when richer detail is needed

### Telegram

- richer priority breakdown
- clearer slip-risk and prep detail
- stronger explainability
- easier action follow-through

### BlueBubbles

- safe text-first parity
- shorter and calmer than Telegram
- not the primary planning surface

## Explainability

Chief-of-staff answers should stay inspectable.

Supported explainability prompts:

- `why are you prioritizing that`
- `what are you using to decide this`

Andrea answers these by naming the real signal sources in play, for example:

- calendar time anchor
- reminders already due or due soon
- open communication loop
- slipping life thread
- current work pressure
- lighter family-context preference

## Controls

Current natural controls include:

- `be less aggressive about surfacing family stuff`
- `don't suggest work right now`
- `be more direct`
- `be calmer`
- `reset my planning preferences`

Important control behavior:

- `don't suggest work right now` is session-scoped
- persistent planning defaults live in one profile preference fact
- chief-of-staff mode remains request-driven and bounded

## Relationship To Daily Companion

Daily companion is still Andrea's time-of-day renderer.

Chief-of-staff mode now feeds that renderer for:

- `what matters most today`
- `what am I forgetting`
- `what should I remember tonight`
- open-guidance prioritization

That keeps the daily companion warm and channel-aware while the underlying prioritization logic stays shared.

## Testing

Focused checks for this layer:

```bash
node scripts/run-with-pinned-node.mjs ./node_modules/vitest/vitest.mjs run src/chief-of-staff.test.ts src/assistant-capability-router.test.ts src/assistant-capabilities.test.ts src/daily-companion.test.ts
npm run debug:chief-of-staff
```

Then run the normal validation stack:

```bash
npm run typecheck
npm run build
npm test
npm run telegram:user:smoke
```
