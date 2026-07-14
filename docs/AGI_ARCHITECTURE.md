# Architecture — AGI Layer

> Historical design reference. The current production authority and recovery
> model is documented in [PERSONAL_INTELLIGENCE_AND_VERIFIED_AGENCY.md](PERSONAL_INTELLIGENCE_AND_VERIFIED_AGENCY.md)
> and [ANDREA_DURABLE_AGENCY_PLAN.md](ANDREA_DURABLE_AGENCY_PLAN.md). Do not
> treat the provider names, latency/cost figures, or implementation paths below
> as a current runtime inventory.

## Overview

The AGI layer is a **bolt-on** to the existing NanoClaw / Andrea_NanoBot orchestrator. It does not replace `src/index.ts`, the channel registry, or the container runtime. Channels (WhatsApp, Telegram, Slack, Discord, Gmail, Alexa, BlueBubbles) continue to own message I/O. They now ask the AGI runtime "what should I say?" instead of invoking the agent SDK directly.

```
channel.onMessage(text) ──▶ AgiRuntime.ask({scope, text}) ──▶ string reply
```

That's the whole external surface.

## Key types

| Module | Type | Purpose |
|---|---|---|
| `src/agi-core/types.ts` | `Message`, `ToolDescriptor`, `ToolInvocation`, `ToolResult`, `ThoughtNode`, `CognitionTrace`, `CognitionConfig` | Shared shapes |
| `src/models/router.ts` | `ModelSpec`, `ProviderAdapter`, `ModelRouter` | Provider-agnostic completions |
| `src/memory/types.ts` | `MemoryEntry`, `RecallQuery`, `RecallHit`, `EmbeddingClient` | Memory shapes |
| `src/integrations/types.ts` | `Integration`, `RegisteredTool`, `IntegrationContext` | Plugin shapes |
| `src/safety/policy.ts` | `PolicyDecision` | allow / warn / confirm / deny |

## Lifecycle

1. **Boot** (`agi-bootstrap.ts`)
   - Read env, instantiate embedder, providers, integrations
   - Construct `AgiRuntime` — loads memory + audit log, registers integrations
2. **Per-message** (`AgiRuntime.ask`)
   - Inject scan untrusted message body for prompt-injection
   - Recall semantic memory context for the scope
   - Compose system prompt: constitution + persona + memory
   - Run cognitive core (selects strategy: direct / react / tot / council)
   - Self-refine pass (unless `direct`)
   - Append episode to log; audit `cognition.complete`
3. **Per-tool** (`AgiRuntime.invokeTool`)
   - Look up `RegisteredTool`
   - Run `safety/policy.evaluate` — may demand confirmation
   - If allowed, the registry runs the handler, audit log records latency / errors
4. **Nightly** (scheduled via existing task scheduler)
   - `Reflector.runDaily` reads episodic log, distills facts, writes them as semantic memories, drafts a Markdown PR for prompt/behavior changes — never auto-merges

## Data flow

```
        [user msg]                      [env / secrets / disk]
            │                                      │
            ▼                                      ▼
       ┌─────────┐  inj scan  ┌──────────┐   ┌────────────┐
       │  ask()  ├───────────▶│ memory   │◀──┤ embedder   │
       └────┬────┘            └────┬─────┘   └────────────┘
            │                      │
            ▼                      ▼
      ┌──────────────┐   sys prompt   ┌──────────────┐
      │ cognitive    │◀───────────────│ constitution │
      │ core         │                │   + persona  │
      └────┬─────────┘                └──────────────┘
           │
   ┌───────┴────────┐
   │                │
   ▼                ▼
[tools]        [model router]
   │                │
   ▼                ▼
[integrations]  [providers]
   │                │
   ▼                ▼
[external APIs] [completions] ──▶ usage ──▶ budget ──▶ audit
```

## Why the cognitive core picks a strategy

A single "always run tree-of-thoughts" policy is wasteful — most messages are chitchat or quick lookups where the latency hit is unjustified. A single "always run direct generation" policy is brittle on hard questions. The classifier in `cognitive-core.ts` runs on the cheap model (~350ms latency, fractions of a cent) and routes:

| Class | Path | Typical latency | Typical cost |
|---|---|---|---|
| direct | one Sonnet call | ~1s | ~$0.001 |
| react | Sonnet + tools (≤12 steps) | 3–10s | ~$0.01 |
| tot | beam search ×3 ×2 over 4 levels | 8–30s | ~$0.05 |
| council | 3 panelists + vote + synth | 6–15s | ~$0.10 |

When in doubt the classifier goes to `direct` — it's reversible, the user can always say "think harder" and the runtime will escalate.

## Why we wrote our own router

The repo already had a credential gateway. It didn't have a *capability* router that could pick between Anthropic and OpenAI based on context window, tool-use support, vision support, or cost. The new router is small (one file, ~250 lines) and is the seam through which any future model fits.

## Why memory is split three ways

| Store | Strength | Weakness |
|---|---|---|
| Vector | fuzzy retrieval on natural language | no structure, no traversal |
| Graph | "show me everything connected to X" | doesn't handle paraphrase |
| Episodic | exact replay, audit | not directly searchable |

A real human's memory has all three flavors. So does Andrea's.

## Why a constitution rather than just "be careful"

The model behaves better when its operating principles are *named*. The list in `safety/constitution.ts` is also versioned so the reflector can know that "behavior X was correct under v2026-05-08.1 even though it would be wrong under v2026-08-21.2."

## What still needs work

- **Function-call format unification** — each provider's tool-call schema differs. Today the adapters paper over this; a clean mid-tier translation layer would let us drop more of the routing-time conditionals.
- **Async tool calls** — long-running tools (e.g. `web.fetch` against a slow site) block a reasoning step. We should have a "fire and check later" mode.
- **Backpressure on the council** — when one panelist is much slower than the others, the runtime should answer with what it has rather than wait.
- **Real DB** — JSONL is fine for personal scale (< 100k entries). When this crosses 1M episodes, swap in DuckDB or SQLite-vec.
