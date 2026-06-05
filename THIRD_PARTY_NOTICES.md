# Third-Party Notices

Andrea may review open-source agent projects for architecture patterns and small
license-compatible snippets. Direct adaptations must preserve the upstream
project, commit, license, and copied/adapted file information here.

Directly adapted source patterns:

- garrytan/gbrain, MIT, Copyright (c) 2026 Garry Tan, commit
  `f3ade6c0c3e5a1d76d0c29d5b13e61286442d923`
  - Adapted: `src/core/eval-shared/json-repair.ts`
  - Andrea file: `src/council-json.ts`
  - Scope: small best-effort JSON extraction/repair pattern for structured
    council member artifacts.
- garrytan/gbrain, MIT, Copyright (c) 2026 Garry Tan, commit
  `9a0bae8d62cdd1e0dd6655e24e082fe6c69c5dac`
  - Adapted: `docs/guides/source-attribution.md` and
    `src/core/search/evidence.ts`
  - Andrea file: `src/council-evidence-contracts.ts`
  - Scope: Andrea-native evidence cards with source priority,
    create-safety, citation labels, conflict metadata, and privacy-safe
    council availability.
- garrytan/gbrain, MIT, Copyright (c) 2026 Garry Tan, commit
  `9a0bae8d62cdd1e0dd6655e24e082fe6c69c5dac`
  - Adapted: `src/core/eval/metric-glossary.ts`
  - Andrea file: `src/council-metric-glossary.ts`
  - Scope: small static metric glossary pattern used by `/council`,
    `debug:council`, and challenge/task reports.
- garrytan/gbrain, MIT, Copyright (c) 2026 Garry Tan, commit
  `9a0bae8d62cdd1e0dd6655e24e082fe6c69c5dac`
  - Adapted: retrieval-quality family scoring pattern
  - Andrea file: `src/council-task-quality-gates.ts`
  - Scope: task-ease quality gates for route choice, evidence contracts,
    schema validity, verifier participation, outcome capture, privacy, and
    repair-next-action coverage.
- garrytan/gbrain, MIT, Copyright (c) 2026 Garry Tan, commit
  `9a0bae8d62cdd1e0dd6655e24e082fe6c69c5dac`
  - Adapted: `src/core/facts/classify.ts`
  - Andrea file: `src/council-learning-classifier.ts`
  - Scope: deterministic duplicate/supersede/independent fallback
    classification for council-derived learning candidates. Andrea uses
    sanitized text similarity only and persists metadata, not raw private
    content.
- open-multi-agent/open-multi-agent, MIT, Copyright (c) 2025
  open-multi-agent contributors, commit
  `6d382d1bb86b714d0ad25c3f51719ef07723635d`
  - Adapted: redaction/concurrency utility patterns
  - Andrea files: `src/council-safety.ts`, `src/council-run-guards.ts`
  - Scope: Andrea-native secret/contact redaction helpers and a bounded
    semaphore used by provider-council orchestration; deterministic
    repeated-failure signatures and bounded run-budget policy.

Architecture/reference-only sources used for the council evidence and verifier
design:

- Anthropic Claude API docs, extended thinking/adaptive thinking/subagents,
  reviewed June 3, 2026.
- ReAct: Yao et al., "ReAct: Synergizing Reasoning and Acting in Language
  Models", arXiv:2210.03629. Reference-only for visible action summaries and
  read-only evidence stepping; no code copied.
- Reflexion: Shinn et al., "Reflexion: Language Agents with Verbal
  Reinforcement Learning", arXiv:2303.11366. Reference-only for sanitized
  outcome reflection metadata; no code copied.
- Voyager: Wang et al., "Voyager: An Open-Ended Embodied Agent with Large
  Language Models", arXiv:2305.16291. Reference-only for durable skill-card
  promotion/demotion patterns; no code copied.
- OpenAI Agents SDK tracing and guardrails docs. Reference-only for trace,
  guardrail, and safe execution-boundary concepts in `src/cognitive-kernel.ts`;
  no code copied.
- LangGraph persistence, durable execution, time-travel, and human-in-the-loop
  docs. Reference-only for cognitive checkpoints, resume planning, durable goal
  continuity, and benchmarked continuation safety in `src/cognitive-kernel.ts`;
  no code copied.
- SWE-agent Agent-Computer Interface docs/paper. Reference-only for v7 tool
  registry and tool-policy feedback shape in `src/cognitive-kernel.ts`; no code
  copied.
- OpenHands architecture/runtime docs. Reference-only for execution-boundary and
  operator/runtime separation ideas in v7 diagnostics; no code copied.
- Letta/MemGPT memory architecture docs. Reference-only for local-first memory
  tiers, sanitized world-belief metadata, and metadata-only blackboard state in
  cognition; no code copied.
- Blackboard architecture literature and current multi-agent design references.
  Reference-only for v8 cognitive blackboard entries and goal state handoff; no
  code copied.

Reviewed source projects for v15 planning:

- OpenAI Agents SDK, MIT, https://github.com/openai/openai-agents-python
- OpenHands, MIT, https://github.com/All-Hands-AI/OpenHands
- AutoGPT, mixed/file-level review required before direct import,
  https://github.com/Significant-Gravitas/AutoGPT
- LangGraph, MIT, https://github.com/langchain-ai/langgraph
- Letta, Apache-2.0, https://github.com/letta-ai/letta
- LibreChat, MIT, https://github.com/danny-avila/LibreChat
- smolagents, Apache-2.0, https://github.com/huggingface/smolagents
- CrewAI, MIT, https://github.com/crewAIInc/crewAI
- Microsoft Agent Framework, MIT/file-level review required before any direct import,
  https://github.com/microsoft/agent-framework
