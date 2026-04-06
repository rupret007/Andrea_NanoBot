# Andrea Proactive Rituals And Follow-Through

Andrea now has a bounded **Rituals and Follow-Through** layer.

The point is not to create a second task system or a noisy push engine.
The point is to help Andrea keep the user's day oriented and stop important threads from quietly slipping.

## What Rituals Are

Rituals are assistant behavior profiles.

They define:

- when Andrea should offer a certain kind of guidance
- what inputs that guidance can draw from
- how proactive it is allowed to be
- how concise or supportive the tone should be

Current ritual types:

- `morning_brief`
- `midday_reground`
- `evening_reset`
- `open_guidance`
- `thread_followthrough`
- `household_checkin`
- `transition_prompt`

Each ritual profile stores:

- `id`
- `ritualType`
- `enabled`
- `triggerStyle`
  - `on_request`
  - `scheduled`
  - `context_triggered`
  - `suggested`
- `scope`
  - `personal`
  - `household`
  - `work`
  - `mixed`
- `timing`
- `toneStyle`
- `sourceInputs`
- `lastRunAt`
- `nextDueAt`
- `optInState`
- optional `linkedTaskId` for Telegram scheduled delivery

## How Rituals Differ From Other Andrea Systems

Keep these boundaries explicit:

- **memory/profile** stores durable facts and preferences
- **life threads** track ongoing matters
- **reminders** schedule future nudges
- **current work** tracks immediate execution focus
- **Knowledge Library** stores saved source material
- **rituals** define when and how Andrea should surface guidance

Rituals can combine those systems.
They do not replace them.

## Default Safety And Opt-In Rules

V1 stays conservative:

- `open_guidance` is available on request by default
- morning and evening rituals can be scheduled, but start inactive until the user opts in
- midday re-grounding starts as suggested or on-request, not active
- household and family automatic surfacing stay off until explicitly enabled
- Alexa stays on-demand only
- scheduled ritual delivery uses Telegram, not Alexa

There is no hidden bulk proactivity and no surprise push behavior.

## Follow-Through Loops

Follow-through loops reuse **life threads** rather than inventing a second backlog.

Each thread can now carry assistant-side surfacing state:

- `followthroughMode`
  - `off`
  - `manual_only`
  - `important_only`
  - `scheduled`
- `lastSurfacedAt`
- `snoozedUntil`
- `linkedTaskId`

This lets Andrea track things like:

- `remind me to talk to Candace about this tonight`
- `don't let me forget this band thing`
- `what follow-ups am I carrying right now`
- `what have I been putting off`

The thread remains the canonical object.
The ritual layer only controls when Andrea should surface it.

## Ritual Inputs

Rituals can draw from:

- `calendar`
- `reminders`
- `life_threads`
- `knowledge_library`
- `profile_facts`
- `current_work`

The answer should stay explainable.
Andrea should be able to say why something surfaced:

- calendar carryover
- reminder due soon
- active life thread
- household context
- saved library material

## Telegram Vs Alexa

Telegram is the richer ritual surface.

Typical Telegram ritual output includes:

- a summary first
- one still-open or slipping thread
- one suggested action or reminder candidate
- optional “why this came up”
- richer control turns

Alexa stays concise and voice-safe.

Typical Alexa ritual output includes:

- one lead sentence
- one or two short support lines
- a natural follow-up prompt when useful
- no long provenance dump

Alexa can use rituals on demand.
Alexa does not become a scheduled push surface.

## Natural Controls

Current control surface includes:

- `what rituals do I have enabled`
- `enable morning brief`
- `enable evening reset`
- `stop doing that`
- `don't remind me like that`
- `make the morning brief shorter`
- `stop surfacing family context automatically`
- `make this part of my evening reset`
- `reset my routine preferences`

These controls write to the right underlying layer:

- ritual timing and opt-in live in ritual profiles
- tone and family-context preference still live in personalization facts
- follow-through surfacing state lives on life threads

## Debug And Validation

Pinned-Node ritual harness:

```bash
npm run debug:rituals
```

Focused suites:

- `src/rituals.test.ts`
- `src/life-threads.test.ts`
- `src/daily-companion.test.ts`
- `src/assistant-capabilities.test.ts`
- `src/assistant-capability-router.test.ts`

Typical validation:

```bash
npm run typecheck
npm run build
npm test
```

## Intentional Limits

- no hidden or surprise proactive behavior
- no Alexa background push
- no generic “productivity score”
- no separate task system beside reminders and life threads
- midday and household automatic surfacing stay conservative unless explicitly enabled
- work rituals stay orientation-focused rather than becoming operator-runtime control
