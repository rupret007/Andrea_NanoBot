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
- household-aware prompts
- open thread inspection
- memory explain / remember / forget / manual-only controls
- bounded research prompts

Channel shaping still happens at the edge:

- Alexa:
  - one lead sentence
  - one or two short support lines
  - optional Telegram handoff when a research answer is too long
- Telegram:
  - richer text
  - stronger explainability
  - operator-only follow-through where appropriate

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
- `openai_responses`
  - only when concrete OpenAI credentials are present
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

Important truth:

- if OpenAI credentials are not present, the orchestrator still works from local context where possible
- it does not invent hidden provider support
- it does not promise web or file search unless those inputs are actually wired

## Media Capability Preparation

Media is now capability-gated, but not broadly enabled.

Prepared capabilities:

- `media.image_generate`
- `media.image_edit`
- `media.video_generate`

Current truth:

- no general media provider is wired in NanoBot yet
- no broad Telegram media-delivery workflow is promised from this pass
- Alexa should treat future media requests as request-and-deliver workflows, not spoken output

So media is **architecturally prepared, not broadly enabled**.

## Testing And Debugging

Focused test files for the shared core:

- [src/assistant-capabilities.test.ts](../src/assistant-capabilities.test.ts)
- [src/assistant-capability-router.test.ts](../src/assistant-capability-router.test.ts)
- [src/research-orchestrator.test.ts](../src/research-orchestrator.test.ts)

Useful pinned-Node debug commands:

- `npm run debug:daily-companion`
- `npm run debug:alexa-conversation`
- `npm run debug:shared-capabilities`

`debug:shared-capabilities` is the quickest operator-side smoke path for:

- Telegram daily guidance through the shared graph
- Alexa household guidance through the shared graph
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

Andrea keeps the shared capability graph as its own product abstraction instead of adopting any third-party framework wholesale.
