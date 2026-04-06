# Andrea Assistant Capability Graph

Andrea now has a shared assistant-action layer that sits above the Telegram and Alexa channel edges.

The goal is not to flatten Andrea into one blob. The goal is to let both channels call the same assistant capabilities where that is safe, while keeping:

- memory facts separate from life threads
- reminders separate from current work
- Alexa session state separate from Telegram context
- operator/runtime controls separate from public assistant actions

## What The Capability Graph Is

The capability graph is the Andrea-side registry for assistant actions.

Each capability descriptor records:

- `id`
- `label`
- `category`
- required and optional inputs
- whether account linking is required
- whether explicit confirmation is required
- whether it is safe for Alexa
- whether it is safe for Telegram
- whether it is safe for BlueBubbles
- whether it is operator-only
- preferred output shape by channel
- follow-up actions
- handler kind
- execution binding to existing Andrea logic

The registry lives in [src/assistant-capabilities.ts](../src/assistant-capabilities.ts).

## Capability Categories

Andrea now seeds the graph from existing working behavior rather than inventing a second product layer.

Current seeded categories:

- `daily`
  - morning brief
  - what's next
  - loose ends / what am I forgetting
  - evening reset
- `household`
  - Candace upcoming / open loops
  - family open loops
- `followthrough`
  - remind me before that
  - save that for later
  - draft a follow-up
- `threads`
  - list open threads
  - explicit thread lookup
- `memory`
  - explain memory use
  - remember
  - forget
  - manual-only surfacing
- `pulse`
  - interesting thing
  - surprise me / Andrea Pulse
- `rituals`
  - ritual status
  - ritual control
  - follow-through guidance
  - `knowledge`
    - save source
    - list sources
    - summarize saved material
    - compare saved sources
    - explain source usage
    - disable, delete, and reindex saved sources
  - `communication`
    - understand message
    - draft reply
    - open communication loops
    - manage communication tracking
  - `staff`
    - prioritize
    - plan horizon
    - prepare
    - decision support
    - explain prioritization
    - configure planning defaults
  - `research`
    - research topic
  - compare options
  - summarize findings
  - recommend best choice
- `work`
  - current work summary
  - current work output
  - current work logs
- `media`
  - image generation
  - image editing
  - video generation

## Channel Safety Rules

The graph is explicit about channel safety.

- Alexa-safe capabilities are voice-first, bounded, and safe to answer through a linked personal assistant surface.
- Telegram-safe capabilities can return richer structure and fuller text.
- BlueBubbles-safe capabilities are text-first, concise, and simpler than Telegram operator flows, and they now run through a real linked BlueBubbles companion channel.
- Operator-only capabilities remain excluded from Alexa even when they exist in the graph.

Current intended split:

- Alexa-safe:
  - daily guidance
  - household and thread-aware guidance
  - explicit memory controls
  - bounded research briefs
  - save/remind/follow-up flows when the channel edge confirms them safely
- Telegram-safe:
  - the same shared assistant actions
  - richer formatting and longer research output
  - operator/runtime surfaces that are intentionally not exposed on Alexa
- BlueBubbles-safe:
  - daily guidance
  - rituals and follow-through prompts
  - household guidance
  - explicit thread lookup and save-for-later style follow-through
  - memory controls
  - Knowledge Library summaries
  - draft follow-up
  - Andrea Pulse
  - bounded research summaries
- Operator-only:
  - current work summary/output/logs
  - runtime and work-cockpit execution controls

In code, the graph can say a capability is allowed on Telegram but still keep execution on the operator/runtime lane. That is how `work.current_*` behaves today.

## Alexa Natural Action Router

Alexa still needs an interaction model and explicit intents, but those intents now map into shared capabilities where possible instead of branching into separate logic trees.

Current shape:

- explicit Alexa intents remain for high-signal voice asks
- `ConversationalFollowupIntent` and `AnythingElseIntent` first try shared capability continuation
- natural phrases can also match the shared capability router directly
- bounded conversation state carries the active capability, subject, last recommendation, and safe follow-up hints

That means both of these can now land in the same Andrea action:

- Telegram: `what am I forgetting`
- Alexa: `What am I forgetting?`

The Alexa router and matcher live in:

- [src/assistant-capability-router.ts](../src/assistant-capability-router.ts)
- [src/alexa-dialogue.ts](../src/alexa-dialogue.ts)
- [src/alexa.ts](../src/alexa.ts)

## Telegram And Alexa Shared Actions

Telegram and Alexa are not made identical.

Instead, they now share the same underlying assistant action when the action is channel-safe.

Examples now routed through the shared graph first:

- daily companion prompts
- chief-of-staff priorities, prep, and planning prompts
- household-aware prompts
- ritual inspection and opt-in control
- follow-through prompts such as `what follow-ups am I carrying right now`
- open thread inspection
- memory explain / remember / forget / manual-only controls
- Knowledge Library controls and source-grounded summaries
- Andrea Pulse requests
- bounded research prompts

Channel shaping still happens at the edge:

- Alexa:
  - one lead sentence
  - one or two short support lines
  - chief-of-staff reads stay orienting instead of list-heavy
  - optional Telegram handoff when a research answer is too long
- Telegram:
  - richer text
  - stronger explainability
  - richer chief-of-staff planning and prep detail
  - operator-only follow-through where appropriate
- BlueBubbles:
  - concise text-first replies
  - less markdown-heavy than Telegram
  - safe text-first chief-of-staff parity
  - no operator-only execution controls in this scaffold

## Chief-of-Staff Mode

Andrea now has a dedicated `staff.*` capability family for bounded prioritization, preparation, and decision support.

This layer is request-driven and derived:

- no second planner database
- no hidden scoring system
- no autonomous reprioritization

It synthesizes the current read from:

- calendar timing
- reminders
- life threads
- communication loops
- current work
- household and profile preferences
- optional saved material when prep or decision context clearly calls for it

Direct people or reply questions stay on their existing authoritative paths and are fed into chief-of-staff mode as inputs rather than being replaced by it.

## Cross-Channel Handoffs And Action Completion

Andrea now has a bounded companion handoff layer on top of the shared capability graph.

The current model is intentionally narrow:

- only Alexa-to-Telegram handoffs are supported
- only explicit user-visible handoffs are allowed
- only the registered main Telegram chat for the linked account is used as the target
- no speculative or background cross-channel push is performed

High-value handoff targets in this pass:

- research summaries that are too rich for voice
- knowledge-library summaries with supporting source detail
- image-generation delivery when an artifact is already available
- daily or household follow-up detail when the user asks for it explicitly

Voice-triggered completion flows reuse existing systems instead of inventing new ones:

- `save that for later` / `remember that for later` -> shared continuation -> existing follow-through persistence
- `save that in my library` -> `knowledge.save_source`
- `track that under Candace` -> life threads
- `keep track of that for tonight` -> thread tracking plus bounded evening follow-through
- `draft that for me` / `draft a message about that` -> shared continuation -> existing draft follow-up path
- `turn that into a reminder` -> reminders
- `make that part of my evening reset` -> rituals

The shared handoff/completion layer lives in:

- [src/cross-channel-handoffs.ts](../src/cross-channel-handoffs.ts)
- [src/assistant-action-completion.ts](../src/assistant-action-completion.ts)

This keeps channel-specific delivery at the edge while shared action mapping stays in one place.

## Rituals And Follow-Through

Andrea now has an explicit `rituals` category in the shared capability graph.

This category exists to keep assistant behavior and timing separate from reminders, life threads, and memory.

Current ritual capabilities:

- `rituals.status`
- `rituals.configure`
- `rituals.followthrough`

Practical meaning:

- `rituals.status` answers things like `what rituals do I have enabled`
- `rituals.configure` handles bounded control turns like `enable morning brief`, `make the morning brief shorter`, `stop doing that`, and `stop surfacing family context automatically`
- `rituals.followthrough` gives richer carryover guidance without inventing a second task system

The actual ongoing matters still live in life threads.
The ritual layer only decides how and when Andrea should surface them.

## Bounded Research Orchestrator

Andrea now has a bounded research orchestrator in [src/research-orchestrator.ts](../src/research-orchestrator.ts).

It is not a freeform swarm.

It makes one planning decision for each request:

- `summary`
- `compare`
- `recommend`
- `deep_research`

Then it chooses a primary source:

- `local_context`
  - life threads
  - reminders/tasks
  - accepted memory facts
  - optional calendar signal
- `knowledge_library`
  - explicitly saved notes
  - imported text-like files
  - saved research results
  - manually added reference material
- `openai_responses`
  - only when concrete OpenAI credentials are present and the provider account is usable
  - optional web-backed synthesis when the question is outward-facing or comparative
- `runtime_delegate`
  - only for execution-heavy or operator-like requests that belong on the runtime lane

Current behavior by channel:

- Alexa:
  - short spoken answer
  - optional Telegram handoff when the result is comparison-heavy or too long
- Telegram:
  - fuller answer
  - richer synthesis text
  - explicit route explanation and next-step suggestions
- BlueBubbles:
  - concise summary
  - lighter route explanation
  - no operator-only research surfaces

Important truth:

- if OpenAI credentials are not present, the orchestrator still works from local context where possible and returns the exact blocker when the web-backed path is unavailable
- if the user explicitly asks for saved material, the orchestrator can stay entirely inside the Knowledge Library and surface the supporting sources it used
- it does not invent hidden provider support
- it uses `web_search` only when the request is outward-facing or comparison-heavy
- it does not promise generic file search unless that plumbing is actually wired

## Knowledge Library

Andrea now has a bounded Knowledge Library as a separate capability family.

This is intentionally distinct from:

- memory facts
- life threads
- reminders
- current work

The v1 library path is explicit and inspectable:

- user-approved ingestion only
- text-first storage and retrieval
- lexical-first indexing with SQLite FTS5
- chunk-level provenance for retrieved material
- disable, delete, and reindex controls

Current knowledge capabilities:

- `knowledge.save_source`
- `knowledge.list_sources`
- `knowledge.summarize_saved`
- `knowledge.compare_saved`
- `knowledge.explain_sources`
- `knowledge.disable_source`
- `knowledge.delete_source`
- `knowledge.reindex_source`

By channel:

- Telegram:
  - summary first
  - supporting sources section
  - route explanation
  - structured follow-up suggestions
- Alexa:
  - short saved-material summary
  - source-aware phrasing
  - Telegram handoff when the source detail is too large for voice
- BlueBubbles:
  - concise text-first source summaries

## Media Capability Preparation

Media is now capability-gated, but not broadly enabled.

Prepared capabilities:

- `media.image_generate`
- `media.image_edit`
- `media.video_generate`

Current truth:

- `media.image_generate` now has a bounded Telegram delivery path when OpenAI credentials are configured
- Alexa treats image requests as request-and-deliver handoffs, not spoken media output
- `media.image_edit` and `media.video_generate` remain prepared-only
- if OpenAI credentials are missing, Andrea reports the exact blocker instead of pretending the provider is live

So media is **partly real, but still intentionally narrow**.

## Testing And Debugging

Focused test files for the shared core:

- [src/assistant-capabilities.test.ts](../src/assistant-capabilities.test.ts)
- [src/assistant-capability-router.test.ts](../src/assistant-capability-router.test.ts)
- [src/research-orchestrator.test.ts](../src/research-orchestrator.test.ts)

Useful pinned-Node debug commands:

- `npm run debug:daily-companion`
- `npm run debug:alexa-conversation`
- `npm run debug:shared-capabilities`
- `npm run debug:research-mode`
- `npm run debug:cross-channel-handoffs`

`debug:shared-capabilities` is the quickest operator-side smoke path for:

- Telegram daily guidance through the shared graph
- Alexa household guidance through the shared graph
- Alexa and BlueBubbles Pulse behavior through the shared graph
- Alexa and Telegram research shaping
- operator-only safety gating

## External Pattern Sources And License Logic

This architecture adapts patterns from permissively licensed or official sources. It does **not** paste large third-party code into Andrea.

- [Alexa Skills Kit SDKs for Node.js](https://developer.amazon.com/en-US/docs/alexa/sdk/alexa-skills-kit-sdks.html)
  - official Amazon documentation
  - useful pattern: thin request edge, request handling, interceptors, and session attributes
  - adopted as design only
- [alexa-samples / skill-sample-nodejs-fact](https://github.com/alexa-samples/skill-sample-nodejs-fact)
  - Apache-2.0
  - useful pattern: explicit intent-to-domain mapping and concise voice-first response builders
  - adapted as design only
- [openai/openai-agents-js](https://github.com/openai/openai-agents-js)
  - MIT
  - useful pattern: explicit tool/capability registry, sessions, handoffs, and bounded orchestration
  - adapted as design only
- [telegraf/telegraf](https://github.com/telegraf/telegraf)
  - MIT
  - useful pattern: middleware/context layering and clean channel-edge adapters over shared core behavior
  - adapted as design only
- [BlueBubbles API docs](https://docs.bluebubbles.app/server/api)
  - official documentation
  - useful pattern: REST plus webhook channel adapter with explicit auth/config boundaries
  - adapted as design only
- [BlueBubbles Server](https://github.com/BlueBubblesApp/bluebubbles-server)
  - Apache-2.0
  - useful pattern: server/channel separation and stable chat/message abstractions
  - adapted conceptually only

Andrea keeps the shared capability graph as its own product abstraction instead of adopting any third-party framework wholesale.
