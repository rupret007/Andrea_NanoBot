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
- garrytan/gbrain, MIT, Copyright (c) 2026 Garry Tan, commit
  `805814451ec9e962ceed1b931b9b512d80f70024`
  - Adapted: source-attribution conflict/source-coverage guidance
  - Andrea files: `src/cognitive-kernel.ts`,
    `src/agent-source-intelligence.ts`
  - Scope: metadata-only evidence and memory-block source ids, freshness,
    sensitivity, conflict flags, and poisoning-risk reporting for governed
    cognitive workbench runs.
- openai/openai-agents-js, MIT, Copyright OpenAI contributors, commit
  `5ffee5443eeb362fca0dc7195462e355218b5fe0`
  - Adapted: guardrail/tool-guardrail/handoff/trace naming and result-shape
    patterns from `packages/agents-core/src/guardrail.ts`,
    `packages/agents-core/src/toolGuardrail.ts`,
    `packages/agents-core/src/handoff.ts`,
    `packages/agents-core/src/runner/toolExecution.ts`, and
    `packages/agents-core/src/tracing/traces.ts`
  - Andrea files: `src/types.ts`, `src/cognitive-kernel.ts`
  - Scope: Andrea-native governance decisions, action identities, typed
    handoffs, workbench trace spans, and redacted replay packets. No upstream
    runtime dependency was vendored.
- microsoft/agent-governance-toolkit, MIT, Copyright Microsoft contributors,
  commit `e0183314fa0fbaa91a92389d97fb45ac99f03be7`
  - Adapted: adapter/interceptor policy decision shape from
    `policy-engine/sdk/node/src/adapters.ts` and
    `policy-engine/sdk/node/src/adapter-helpers.ts`, plus conformance-case
    taxonomy from `policy-engine/tests/conformance`
  - Andrea files: `src/types.ts`, `src/cognitive-kernel.ts`,
    `scripts/test-cognition-governance.ts`
  - Scope: fail-closed policy pack, risk classes, tripwire decisions,
    approval staging, and governance conformance tests.
- garrytan/gbrain, MIT, Copyright (c) 2026 Garry Tan, commit
  `805814451ec9e962ceed1b931b9b512d80f70024`
  - Adapted: source-attribution gap-analysis and source-coverage posture
  - Andrea files: `src/agent-os.ts`, `src/types.ts`, `src/db.ts`
  - Scope: Agent OS episode source coverage, evidence-id accounting, and
    explicit missing-evidence next actions. No raw private content is stored.
- openai/openai-agents-js, MIT, Copyright OpenAI contributors, commit
  `5ffee5443eeb362fca0dc7195462e355218b5fe0`
  - Adapted: tracing, guardrail, handoff, and human-in-the-loop result-shape
    patterns
  - Andrea files: `src/agent-os.ts`, `scripts/debug-agent-os.ts`
  - Scope: Andrea-native Agent OS episodes, typed handoffs, interrupts,
    resume tokens, and metadata-only replay reports. No upstream runtime
    dependency was vendored.
- microsoft/agent-governance-toolkit, MIT, Copyright Microsoft contributors,
  commit `e0183314fa0fbaa91a92389d97fb45ac99f03be7`
  - Adapted: policy/interceptor taxonomy as a clean TypeScript shape
  - Andrea files: `src/agent-os.ts`, `scripts/test-agent-os-tool-discovery.ts`
  - Scope: capability tool-card policy classes, approval staging, blocked-tool
    reporting, and no-fake-health tests.
- stanfordnlp/dspy, MIT, Copyright DSPy contributors, commit
  `a3b1ab79f58b75045a697eff6802ea2a337084e1`
  - Adapted: metric-driven optimizer posture as a clean-room pattern
  - Andrea files: `src/agent-os.ts`, `scripts/test-agent-os-trajectory.ts`
  - Scope: deterministic trajectory scorecards and candidate-only skill
    proposals. No DSPy code was copied or vendored.

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
- OpenAI Agents SDK human-in-the-loop docs. Reference-only for Agent OS
  interrupt/resume-token behavior in `src/agent-os.ts`; no code copied.
- OpenAI Agents JS, MIT, https://github.com/openai/openai-agents-js
- Microsoft Agent Governance Toolkit, MIT,
  https://github.com/microsoft/agent-governance-toolkit
- LangGraph persistence, durable execution, time-travel, and human-in-the-loop
  docs. Reference-only for cognitive checkpoints, resume planning, durable goal
  continuity, and benchmarked continuation safety in `src/cognitive-kernel.ts`;
  no code copied.
- SWE-agent Agent-Computer Interface docs/paper. Reference-only for v7 tool
  registry and tool-policy feedback shape in `src/cognitive-kernel.ts`; no code
  copied.
- OpenHands architecture/runtime docs. Reference-only for execution-boundary and
  operator/runtime separation ideas in v7 diagnostics; no code copied.
- OpenHands microagents docs. Reference-only for Agent OS capability-card
  descriptions and discovery posture; no code copied.
- Letta/MemGPT memory architecture docs. Reference-only for local-first memory
  tiers, sanitized world-belief metadata, and metadata-only blackboard state in
  cognition; no code copied.
- OpenAI Evals, MIT, https://github.com/openai/evals. Reference-only for v10
  episode trajectory scorecards and regression harness posture; no code copied.
- open-multi-agent, MIT, https://github.com/open-multi-agent/open-multi-agent,
  reviewed at `7eb3e708d329505ea17b3e037f22fca07310ec67`. Clean-room
  reference for v13 Agent OS goal-to-DAG planning and bounded read-only node
  parallelism; no new code copied in this round.
- GBrain, MIT, https://github.com/garrytan/gbrain, reviewed at
  `805814451ec9e962ceed1b931b9b512d80f70024`. Existing small MIT-safe
  source-attribution/evidence-pattern adaptations are extended by v12 claim
  lifecycle and freshness-aware reconciliation; no full subsystem vendored.
- Harness Bench, https://www.harness-bench.ai/. Reference-only for v14 task
  family trajectory evaluation posture; no code copied.
- RHO paper, https://arxiv.org/abs/2606.05922. Reference-only for
  retrospective replay/optimization posture in `src/harness-lab.ts`; no code
  copied.
- Belief Memory paper, https://huggingface.co/papers/2605.05583.
  Reference-only for probabilistic claim reconciliation and keeping competing
  hypotheses visible; no code copied.
- Agent Planning Benchmark, https://arxiv.org/abs/2606.04874. Reference-only
  for goal-to-DAG planning evaluation criteria; no code copied.
- ATBench, https://arxiv.org/abs/2604.02022. Reference-only for tool
  trajectory safety checks; no code copied.
- MemoryAgentBench, https://arxiv.gg/abs/2507.05257. Reference-only for
  memory retrieval/update/forgetting eval families; no code copied.
- OpenHands skills docs, https://docs.openhands.dev/overview/skills.
  Reference-only for capability-card and skill-description posture; no code
  copied.
- Blackboard architecture literature and current multi-agent design references.
  Reference-only for v8 cognitive blackboard entries and goal state handoff; no
  code copied.

Reviewed source projects for v15 planning:

- OpenAI Agents SDK, MIT, https://github.com/openai/openai-agents-python
- OpenAI Agents JS, MIT, https://github.com/openai/openai-agents-js
- Microsoft Agent Governance Toolkit, MIT,
  https://github.com/microsoft/agent-governance-toolkit
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

Reviewed and adapted source projects for v17 Agent Runtime Spine:

- OpenAI Agents JS, MIT, https://github.com/openai/openai-agents-js,
  reviewed at `5ffee5443eeb362fca0dc7195462e355218b5fe0`.
  Small TypeScript result-shape and naming patterns from
  `packages/agents-core/src/guardrail.ts`,
  `packages/agents-core/src/toolGuardrail.ts`,
  `packages/agents-core/src/runner/runLoop.ts`,
  `packages/agents-core/src/runner/streamReconciliation.ts`,
  `packages/agents-core/src/tracing/spans.ts`, and
  `packages/agents-core/src/tracing/traces.ts` are adapted in
  `src/agent-runtime-glue.ts` and `src/agent-runtime-spine.ts` for guardrail
  behavior, safe trace events, and abort/replay metadata. No framework runtime
  code or provider internals are vendored.
- Microsoft Agent Governance Toolkit, MIT,
  https://github.com/microsoft/agent-governance-toolkit, reviewed at
  `e0183314fa0fbaa91a92389d97fb45ac99f03be7`. Small policy decision and
  transform-only mutation patterns from
  `policy-engine/sdk/node/src/adapter-helpers.ts` and
  `policy-engine/sdk/node/src/adapters.ts` are adapted in
  `src/agent-runtime-glue.ts` and `src/agent-runtime-spine.ts` so guardrails
  fail closed and only explicit transform decisions can alter draft metadata.
- LangGraphJS, MIT, https://github.com/langchain-ai/langgraphjs, reviewed at
  `c41878187014ff58a4ee8371fa8361edc97b2e84`. The SQLite checkpoint and
  pending-writes storage pattern from `libs/checkpoint-sqlite/src/index.ts` is
  adapted in `src/agent-runtime-glue.ts`, `src/agent-runtime-spine.ts`, and
  `src/db.ts` as Andrea-native `agent_runtime_checkpoints` and
  `agent_runtime_writes` metadata tables. No LangGraph runtime dependency is
  added.
- GBrain, MIT, https://github.com/garrytan/gbrain, reviewed at
  `805814451ec9e962ceed1b931b9b512d80f70024`. Small utility patterns from
  `src/core/search/recency-decay.ts`, `src/core/facts/decay.ts`,
  `src/core/output/validators/citation.ts`,
  `src/core/eval-contradictions/cross-source.ts`, and
  `src/core/search/return-policy.ts` are adapted in
  `src/agent-runtime-glue.ts` for World Model freshness scoring, claim
  confidence decay, citation coverage, contradiction tiering, and adaptive
  evidence-return summaries.
- OpenHands, MIT, https://github.com/All-Hands-AI/OpenHands, reviewed at
  `03aab93625079c24d6f43655c9506931cf43bc17`. Small event summary/truncation
  patterns from
  `frontend/src/components/features/chat/event-content-helpers/shared.ts`,
  `frontend/src/components/features/chat/event-content-helpers/get-action-content.ts`,
  and
  `frontend/src/components/features/chat/event-content-helpers/get-observation-content.ts`,
  plus skill frontmatter precedence posture from the public skills/microagents
  surface, are adapted in `src/agent-runtime-glue.ts` for operator-visible
  runtime event summaries and candidate skill manifests.

Reviewed and adapted source projects for v18 Supervisor Core:

- OpenAI Swarm, MIT, https://github.com/openai/swarm, reviewed at
  `6af0b4caf37dca4526dfd98e9fbd8ce36e7eeb22`. Small handoff/response/context
  variable patterns from `swarm/core.py` and `swarm/types.py` are ported into
  `src/supervisor-kernel.ts` as Andrea-native participant, handoff, blackboard
  patch, and replay metadata shapes. No Python runtime code is vendored.
- Microsoft AutoGen, MIT, https://github.com/microsoft/autogen, reviewed at
  `027ecf0a379bcc1d09956d46d12d44a3ad9cee14`. The "next speaker from explicit
  handoff first" and max-turn/termination posture from
  `python/packages/autogen-agentchat/src/autogen_agentchat/teams/_group_chat/_swarm_group_chat.py`
  and
  `python/packages/autogen-agentchat/src/autogen_agentchat/teams/_group_chat/_base_group_chat.py`
  is adapted in `src/supervisor-kernel.ts` for deterministic supervisor routing
  and bounded loop termination.
- Semantic Kernel, MIT, https://github.com/microsoft/semantic-kernel, reviewed
  at `417d62f8b1131e94058488396b670d32661a9318`. Group orchestration lifecycle
  and report naming from
  `python/semantic_kernel/agents/orchestration/group_chat.py` is adapted in
  `src/supervisor-kernel.ts` for supervisor doctor reports and participant
  lifecycle vocabulary.
- OpenAI Agents JS, MIT, https://github.com/openai/openai-agents-js, reviewed
  at `5ffee5443eeb362fca0dc7195462e355218b5fe0`, and LangGraphJS, MIT,
  https://github.com/langchain-ai/langgraphjs, reviewed at
  `133d0bd52ec0effbc9ac6d4b2c3050f4b0dabb72`, were re-reviewed for existing
  guardrail/run-loop/checkpoint primitives already adapted by v17. v18 extends
  those primitives into supervisor checkpoints and pending handoff replay
  metadata without adding either framework as a dependency.

Reviewed source patterns for v19 Session Graph:

- No new third-party code is copied in v19. The Session Graph is an
  Andrea-native TypeScript/SQLite layer that reuses the previously noticed v17
  Runtime Spine and v18 Supervisor Core primitives. Its deterministic-ID,
  checkpoint/resume, evidence/freshness, and event-summary behavior is
  clean-room informed by the already reviewed OpenAI Agents JS, LangGraphJS,
  GBrain, and OpenHands patterns listed above.

Reviewed source patterns for v20 Continuity Cockpit:

- No new third-party code is copied in v20. The continuity cockpit is an
  Andrea-native ranking and deduplication layer over v19 Session Graph metadata.
  It is clean-room informed by the already noticed guardrail, checkpoint,
  freshness, evidence-return, and event-summary patterns, but no additional
  upstream files are imported.

Reviewed source patterns for v22 Cognitive Workspace:

- No new framework dependency or sidecar is added in v22. The Cognitive
  Workspace is an Andrea-native TypeScript/SQLite layer that composes existing
  v17-v21 metadata into one source-attributed packet.
- Existing direct MIT-compatible adaptations from OpenAI Agents JS, Microsoft
  Agent Governance Toolkit, LangGraphJS, GBrain, OpenHands, OpenAI Swarm,
  Microsoft AutoGen, and Semantic Kernel remain the underlying glue primitives.
  v22 reuses their already noticed guardrail, trace, checkpoint, freshness,
  event-summary, and handoff patterns through Andrea-local modules.
- OpenAI Evals and DSPy are clean-room references for deterministic scorecards
  and candidate-only program/policy proposals in `src/cognitive-workspace.ts`.
  No OpenAI Evals or DSPy source code is copied or vendored.
- Letta memory-block documentation and Microsoft Agent Framework workflow
  concepts are clean-room references for context-block boundaries and workflow
  composition. No source code is copied or vendored.

Reviewed source patterns for v24 Agent Intelligence and Repair Runtime:

- No new third-party source code is copied in v24. The tool reliability,
  bounded repair playbook, critic gate, and agentic simulation harness are
  Andrea-native TypeScript/SQLite modules.
- OpenAI Agents JS guardrails/tracing/HITL, Microsoft Agent Governance Toolkit
  policy/intervention shapes, LangGraph checkpoint/resume semantics, OpenHands
  run-review-fix lifecycle, AutoGen/CrewAI role orchestration, MCP tool-card
  schema posture, and AutoGPT failure-mode lessons were used as clean-room
  architecture references only.
- AutoGPT platform code, Code2MCP, EffGen, and OpenClaw are research/reference
  inputs for this pass. No source from those projects is imported or vendored.
