# Andrea NanoBot — Path to "as close to AGI as exists today"

This roadmap lays out concrete, shippable upgrades that move the existing NanoClaw / Andrea_NanoBot personal assistant toward the most capable general-purpose AI that current research and frontier models can support. It is intentionally ambitious but grounded in techniques with peer-reviewed (or at least widely replicated) evidence of working.

The point of this document is to make the *direction* legible so anyone — Jeff, a future contributor, the assistant itself — can reason about why a given subsystem exists and what would replace it.

## What "as close to AGI as exists today" actually means here

There is no AGI yet. What we *can* build, in 2026, is a personal assistant that approaches the frontier on the dimensions that matter for everyday usefulness:

1. **Reasoning depth** — the assistant deliberates rather than reflexively answering. It can plan, decompose, search, critique itself, and decide when it is or isn't sure.
2. **Persistent, structured memory** — it remembers what you told it, what it did, who's who, and what you care about, across months and channels.
3. **Embodied tool-use** — it can act in the world: send messages, write to Notion, control your home, query Spotify, hit Linear, execute code, browse the web — through a uniform integration layer.
4. **Multi-model intelligence** — it leverages the strongest model for each sub-task and uses heterogeneous models as a council on hard questions.
5. **Self-improvement** — it reflects nightly on what went well and what didn't, distills lessons, and proposes (never auto-applies) prompt and behavior changes.
6. **Aligned by construction** — a constitution, an action policy, a budget, an audit log, and explicit handling of untrusted text.
7. **Calm, low-latency UX** — fast on cheap questions, willing to slow down on hard ones, and explicit about which it's doing.

Each dimension is a separate subsystem in `src/`.

## Subsystem map

```
              ┌────────────────────────┐
              │   Channels (existing)  │
              │ Slack/WhatsApp/Telegram│
              │ Discord/Gmail/Alexa/...│
              └─────────────┬──────────┘
                            │ ask({scope, text})
                  ┌─────────▼──────────┐
                  │   AGI Runtime      │
                  │  src/agi-runtime   │  ← composition root
                  └──┬──────────┬──────┘
                     │          │
          ┌──────────▼──┐    ┌──▼──────────┐
          │  Cognitive  │    │   Safety    │
          │    Core     │    │ constitution│
          │  ToT/ReAct  │    │  policy/log │
          │  council    │    │  injection  │
          │  refine     │    │  budget     │
          └──┬──────────┘    └──────┬──────┘
             │                      │
   ┌─────────▼─────┐        ┌───────▼────────┐
   │ Model Router  │        │ Integrations   │
   │ Anthropic /   │        │ Notion/Linear/ │
   │ OpenAI /      │        │ GitHub/Spotify/│
   │ Google /      │        │ HA/Drive/Web/  │
   │ Ollama        │        │ MCP bridge     │
   └───────────────┘        └────────────────┘
                                    │
                          ┌─────────▼─────────┐
                          │  Memory facade    │
                          │ vector + graph +  │
                          │ episodic + KG     │
                          └─────────┬─────────┘
                                    │
                          ┌─────────▼─────────┐
                          │ Reflection loop   │
                          │ nightly distill   │
                          └───────────────────┘
```

## Phase 1 — Cognitive uplift (this PR)

Already shipped here:

- Tree-of-thoughts beam search (`src/agi-core/tree-of-thoughts.ts`)
- Multi-model council with synthesis fallback (`src/agi-core/council.ts`)
- ReAct + plan-and-execute (`src/agi-core/planner.ts`)
- Self-refine critic loop (`src/agi-core/self-critique.ts`)
- Strategy-selecting cognitive core (`src/agi-core/cognitive-core.ts`)
- Provider-agnostic model router (`src/models/router.ts`)
- Multi-provider adapters: Anthropic, OpenAI, Ollama (`src/models/*-adapter.ts`)
- Vector / graph / episodic memory (`src/memory/*`)
- Reflection / self-improvement loop (`src/reflection/reflector.ts`)
- Constitution + policy + injection scanner + audit log + budget meter (`src/safety/*`)
- Notion, Linear, GitHub, Spotify, Home Assistant, Google Drive, web research integrations (`src/integrations/*`)
- MCP bridge — auto-import any MCP server's tools (`src/integrations/mcp-bridge.ts`)
- Composition root (`src/agi-runtime.ts`, `src/agi-bootstrap.ts`)
- CI workflow (typecheck, lint, vitest, security scan)
- Smoke tests for every new module (`tests/`)

## Phase 2 — Embodied & sensory upgrades

| Capability | What to add | Why |
|---|---|---|
| Voice in/out | Whisper or Deepgram for STT + ElevenLabs / OpenAI realtime TTS, wired through the existing Alexa channel | Andrea is already voice-aware via Alexa; layering a "real" voice mode lets you talk to her on any phone or laptop. |
| Vision | Re-use the channels' image attachments → multimodal model in the router | Read screenshots, whiteboards, recipes; describe photos. |
| Computer use | Anthropic's computer-use API as a router-bound capability | Long-horizon UI tasks ("re-arrange my Drive", "fill out this form for me"). |
| Code execution sandbox | Run untrusted code in the existing container layer with no network and a 30s budget | True "show your work" + the ability to verify reasoning numerically. |
| Document understanding | Layoutlm-style extraction for PDFs, slide decks, Excel sheets — already partially supported via skills | Quotes, contracts, statements. |

## Phase 3 — Continual learning

| Capability | What to add | Why |
|---|---|---|
| Distillation pipeline | Reflector's nightly summaries become a lightweight LoRA adaptation target on a local model | Personal "fine-tune" without leaving the box. |
| Episodic clustering | DBSCAN over episode embeddings → episode "themes" | Better summaries, surface forgotten topics. |
| Skill induction | Detect repeated 3+ step procedures the user runs through the agent → propose a new skill | Compounds over time. |
| Counterfactual replay | Re-run a past interaction with a different model / prompt to score the change | Treat the agent like a system you A/B test. |

## Phase 4 — Multi-agent civility

| Capability | What to add | Why |
|---|---|---|
| Sub-agents | `dispatcher` agent that spawns specialised sub-agents (researcher, coder, scheduler) and supervises them | Cheaper than running the frontier model on everything; closer to how teams actually work. |
| Debate mode | When the council disagrees, escalate to a multi-turn debate between two panelists with the third adjudicating | Much higher correctness on contested factual claims. |
| Persistent agents | A "household manager" sub-agent runs continuously with its own scratchpad, handing off only when needed | Long-horizon planning over weeks. |

## Phase 5 — Trustworthiness & ops

| Capability | What to add | Why |
|---|---|---|
| Differential privacy on memory | Apply DP noise to embeddings before sharing across scopes | Group/team memory without leaking personal info. |
| Verifiable audit log | Hash-chain → Merkle tree → optional anchor on a public chain | Tamper-evident provenance. |
| Disaster recovery | Encrypted nightly export of memory + audit + config | Move between machines without losing months of context. |
| Local-first mode | Ollama + sentence-transformers + sqlite-vec — no cloud calls when the user wants strict privacy | Sometimes the right model is the one that never leaves the laptop. |

## Anti-goals

A few things we explicitly *don't* try to do:

- **Auto-apply self-modifications.** The reflector proposes; humans dispose. The set of changes an LLM can suggest to its own prompts is much smaller than the set of changes that are actually safe.
- **Pretend to be human.** The constitution's `P-9` says don't be cagey about being an AI. That stays.
- **Maximize engagement.** This is a tool, not a feed. The principles in `safety/constitution.ts` privilege user flourishing over interaction count.
- **Re-implement what MCP already does.** Built-in integrations are for the half-dozen things Jeff uses every day. Everything else rides the MCP bridge.

## Citations & reading

- Yao et al. 2023 — *Tree of Thoughts: Deliberate Problem Solving with Large Language Models*
- Yao et al. 2022 — *ReAct: Synergizing Reasoning and Acting in Language Models*
- Madaan et al. 2023 — *Self-Refine: Iterative Refinement with Self-Feedback*
- Wang et al. 2023 — *Plan-and-Solve Prompting*
- Bai et al. 2022 — *Constitutional AI: Harmlessness from AI Feedback*
- Lewis et al. 2020 — *Retrieval-Augmented Generation for Knowledge-Intensive NLP*
- Schick et al. 2023 — *Toolformer: Language Models Can Teach Themselves to Use Tools*
- Shinn et al. 2023 — *Reflexion: Language Agents with Verbal Reinforcement Learning*
- Park et al. 2023 — *Generative Agents: Interactive Simulacra of Human Behavior* (memory + reflection patterns)
- Hong et al. 2023 — *MetaGPT: Meta Programming for Multi-Agent Collaborative Framework*
