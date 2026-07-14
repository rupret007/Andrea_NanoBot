# Andrea — Grounded Intelligence And Verified Agency Roadmap

Status basis: July 2026. This is a product and engineering direction, not an
AGI claim or a release checklist. For exact repository, runtime, integration,
and evidence status, use [CURRENT_STATUS.md](CURRENT_STATUS.md) and the live
diagnostic commands documented there.

## What “As Close To AGI As Practical” Means Here

Andrea should become a broadly useful personal assistant that can understand a
goal, retrieve relevant context, choose an appropriate route, use tools within
delegated boundaries, verify the result, and learn from reviewed outcomes.
Progress is measured through real task success, adaptation, grounding,
reliability, latency, and safety—not by calling the system AGI or maximizing a
synthetic score.

The target loop is:

```text
understand -> ground -> plan -> stage approval when required
           -> act -> verify -> ask for outcome review -> learn cautiously
```

The daily-assistant and deep-work experiences should share that loop without
becoming one unrestricted autonomous agent.

## Implemented And Verified Foundations

The repository contains substantial foundations that are exercised by its
primary, AGI, deterministic, security, and container test gates:

- route-scoped assistant, control, and execution lanes, including a tool-free
  ordinary-chat lane and explicit container capability boundaries;
- approval-aware message, calendar, reminder, purchase, repository, and
  operator workflows, with sensitive effects kept behind fresh authority;
- durable goals, missions, work units, checkpoints, resume grants, receipts,
  postconditions, outcome reviews, and owner-facing status surfaces;
- bounded personal context assembled from distinct memory and knowledge
  sources with provenance, citations, freshness, contradiction handling, and
  source controls;
- research orchestration, provider-health evidence, capability-based model
  routing, and a protected multi-provider council for explicit deep or
  high-risk reasoning;
- action preflight, tool reliability, cognitive and runtime evidence, replay
  fixtures, deterministic offline evaluation, and human-governed improvement
  proposals;
- Telegram, BlueBubbles, Alexa, Google Calendar, OpenClaw, and other configured
  integration surfaces, with transport state kept separate from fresh
  end-to-end proof;
- cross-platform shared builds and hosted Windows validation, plus a canonical
  Mac service and container runner.

There are also research-oriented modules under `src/agi-core/`, `src/models/`,
`src/memory/`, `src/reflection/`, `src/safety/`, and `src/integrations/`.
Their presence and unit coverage do not by themselves prove that every module
is active in the production turn path, that every listed provider or
integration is configured, or that an end-to-end user workflow is live.

## Measured Gaps And Proof Debt

The main limitation is not a lack of subsystem names. It is incomplete proof
that the subsystems compose reliably in ordinary use.

- The reviewed real-world learning baseline is still below its five-distinct-
  outcome minimum, and the ten-working-day deep-work dogfood sequence is not
  complete. Synthetic and proof-drill results do not substitute for either.
- The current latency sample is small and slow. Route, provider, tool,
  orchestration, delivery, and post-delivery time need clearer attribution
  before Andrea can feel consistently immediate.
- Released code supports bounded calendar-plus-research and
  reminder-plus-research paths with deterministic planning and sequencing.
  Neither is arbitrary multi-action orchestration, and a genuine user journey
  remains separate runtime evidence.
- The council and model router have strong deterministic coverage but need more
  current, cost-bounded, provenance-rich live comparisons before promotion
  decisions can rely on them.
- Configured provider credentials or healthy transports do not prove a current
  provider response or user-path roundtrip. Several channel and device proofs
  remain time-sensitive operator evidence.
- Goals, missions, action bundles, cognitive subgoals, and deep-work packets
  exist, but they are not a general autonomous workflow engine. Cross-system
  execution remains deliberately bounded.
- The repository includes experimental memory, reflection, model, and
  integration implementations that must not be described as production
  learning, nightly autonomous improvement, or universally available tools
  without end-to-end evidence.

## Near-Term Priorities

### 1. Prove And Carefully Extend Multi-Intent Assistance

Released code has conservative typed decomposition for both
calendar-plus-research and reminder-plus-research. Prove a genuine user journey
before extending the pattern to another action class.

- Preserve each original clause and its target instead of passing the whole
  utterance to one parser. The released compound paths do this.
- Start independent read-only work promptly without holding the primary turn
  open. The released calendar path confirms response delivery, then starts one
  caught background research leg so an immediate confirmation is not queued
  behind provider latency.
- Keep approval scoped to the exact state-changing action. Calendar writes
  still require their stored-draft confirmation; compound drafts require the
  targeted phrase `confirm calendar event`, and research grants no authority.
- Minimize outward context. Generic personalization language does not authorize
  sending tasks, profile facts, life threads, or Calendar entries to a research
  provider; the user must name the personal source to opt it in.
- Continue useful read-only work when one side-effecting action is awaiting
  approval, and report partial failure honestly. Prove this through one genuine
  runtime interaction after release.
- Drain active sidecars before graceful shutdown and measure their delivery as
  a distinct leg. If real use shows that hard-crash recovery matters, promote
  long-running work into the existing durable mission/checkpoint system rather
  than inventing another workflow engine.
- Add regression cases for conjunctions that are part of a title, ambiguous
  requests, retries, stale state, and duplicate confirmation before expanding
  beyond the bounded first pair.

This is bounded intent composition, not permission to infer arbitrary work or
fan every request out to every available tool.

### 2. Establish The Real-World Baseline

- Collect five distinct owner-reviewed outcomes before presenting the first
  baseline for review.
- Complete ten working days of bounded, evidence-rich deep-work missions.
- Record accepted recommendations, corrections, verified completion, false
  proactive suggestions, citations, tool outcomes, latency, and cost.
- Keep synthetic, duplicate, telemetry-only, and proof-drill evidence out of
  promotion decisions.

### 3. Make Ordinary Interaction Fast

- Keep local control and review commands near-instant.
- Target ordinary non-tool model replies under ten seconds.
- Move reflection, evaluation, memory enrichment, and nonessential council work
  behind delivery unless safety requires them first.
- Report p50/p95 latency and the slowest stage by route rather than relying on
  one aggregate duration.

### 4. Make Deep Research And Deep Work Explicit

Ordinary questions should use one capable route. Explicit requests such as
`deep dive`, `ultrathink`, or `use all models` may invoke a larger,
budget-aware effort when provider health and policy permit it. The current
compound research sidecar uses configured provider routing and request
controls; it is not yet a dedicated per-turn dollar-cap contract.

A deep task should produce a bounded packet containing:

- objective and decomposed subquestions;
- sources, citations, artifacts, and tool outcomes;
- provider/model provenance, latency, and cost;
- evidence gaps, confidence, verifier result, and unresolved risks;
- the next user decision or exact approval request.

“Use all resources” must never mean “use every provider and tool regardless of
relevance.” The planner should select the smallest capable set, add specialists
only when they improve evidence, and stop at configured time and cost limits.

### 5. Make Routing And Learning Empirical

- Maintain a capability and health registry from configured model identifiers,
  current probes, and pinned operator overrides.
- Compare routes on verified task success, evidence quality, latency, tool
  correctness, and cost—not prose style.
- Create skill candidates only from repeated reviewed outcomes, and require
  deterministic replay plus the existing promotion gates.
- Quarantine candidates after correction, rejection, stale-state, privacy,
  approval, or verification violations.
- Let promotion improve planning or routing only; it must never grant new
  authority.

### 6. Keep The Execution Foundation Healthy

- Maintain container isolation, immutable controls, secret-safe credential
  handoff, deterministic network denial, exact-SHA CI, and dependency/security
  scans.
- Keep runtime SHA, disk headroom, provider health, and integration proof debt
  visible instead of hiding them behind a readiness score.
- Refresh Telegram, BlueBubbles, Alexa, Calendar, and other operator proofs
  through genuine user paths rather than synthetic substitutions.

## Future Candidates After The Baseline

These are candidates, not committed capabilities. Each needs a threat model,
owner-visible controls, bounded cost, deterministic fixtures, and a reversible
canary before activation.

| Candidate                         | Earliest useful form                                                        | Prerequisite                                                  |
| --------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Computer use                      | One allowlisted application and one reversible workflow                     | Trustworthy baseline plus one promoted workflow               |
| Richer voice                      | Low-latency streaming conversation with the same approval rules             | Fresh Alexa/voice proof and latency budget                    |
| Document and visual understanding | Cited extraction from explicitly supplied files and images                  | Source isolation, redaction, and artifact verification        |
| Specialist delegation             | Ephemeral research or coding specialists supervised by one task packet      | Reliable decomposition, cost limits, and verifier evidence    |
| Strong local-first mode           | Selected assistant and retrieval paths that operate without cloud providers | Quality baseline, supported local models, and resource budget |
| Counterfactual evaluation         | Redacted replay comparing two routes without changing production state      | Reviewed fixtures and metric governance                       |
| Encrypted recovery                | Tested export and restore of bounded configuration and durable state        | Key management and restore drills                             |

Persistent background agents, automatic fine-tuning, unrestricted computer
use, and autonomous self-modification are not near-term defaults. They add
authority, privacy, cost, and recovery risks before current real-world evidence
justifies them.

## Acceptance Bar For Meaningful Progress

A roadmap item counts as progress only when:

- the user-facing workflow works end to end with truthful partial-failure
  behavior;
- approvals bind the exact action, target, state, and expiry;
- output claims cite current evidence where appropriate;
- deterministic fixtures and relevant repository gates pass;
- a genuine canary is reviewed when external behavior changes;
- latency and cost are recorded for live provider work;
- no privacy, authority, data-integrity, or verification boundary regresses;
- documentation distinguishes implemented behavior, current proof, and future
  intent.

## Anti-Goals

- Claiming AGI, consciousness, or general autonomy from synthetic scores.
- Automatically modifying behavior, merging code, deploying, sending,
  purchasing, deleting, or writing calendars without the required fresh
  approval.
- Building a passive archive of personal messages or duplicating raw channel
  history into a new memory store.
- Treating learned preferences, promoted skills, resume grants, or council
  confidence as expanded authority.
- Invoking every provider, agent, or tool on routine requests merely to appear
  sophisticated.
- Running hidden persistent agents that can accumulate scope or act without an
  owner-visible task and stop control.
- Adding integrations, dependencies, or abstractions without a demonstrated
  workflow and validation plan.
- Optimizing engagement instead of usefulness, reliability, and user control.

## Research Influences

The following work informs the direction but is not evidence that a production
feature is implemented or effective:

- Yao et al. — _Tree of Thoughts_ and _ReAct_
- Madaan et al. — _Self-Refine_
- Wang et al. — _Plan-and-Solve Prompting_
- Bai et al. — _Constitutional AI_
- Lewis et al. — _Retrieval-Augmented Generation_
- Shinn et al. — _Reflexion_
- Park et al. — _Generative Agents_
- Hong et al. — _MetaGPT_
