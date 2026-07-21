# Grounded Response Intelligence v1

## Purpose

Grounded Response Intelligence turns Andrea's existing shadow cognition into a bounded response-planning advisor. It improves clause coverage, target preservation, memory calibration, follow-through, approval wording, and partial-failure honesty. It does not add execution authority.

The implementation has one authority rule: the advisory packet cannot call a tool, alter a route, grant or consume approval, create durable work, schedule anything, or authorize delivery. Existing action-specific policy, outbound pause, durable work, provider receipts, truth checks, and completion gates remain authoritative.

## Architecture

`src/grounded-response-intelligence.ts` is pure and deterministic. It owns:

1. Conservative clause decomposition that protects quoted conjunctions and only splits ordinary `and` when both sides look like requests.
2. Typed intent classification, target preservation, mutability, approval requirements, supported route hints, and required evidence.
3. Composition of the current user statement, `GroundedContextBundle`, personal context, active goals, route health, blockers, and the grounded executive's posture.
4. A `GroundedResponseContract` describing required coverage, allowed facts, uncertainty disclosures, prohibited claims, approval boundaries, useful read-only work, and the next user decision.
5. A deterministic response evaluator returning `pass`, `repair`, or `block`.
6. One bounded text-only repair. It never retries a tool or action and falls back to non-completion language if a privacy or authority violation remains.

`src/turn-agent-harness.ts` composes the packet after existing context, memory, cognitive, logic, and grounded-executive setup. It records redacted metadata: packet ID, intent count/classes, included/excluded memory counts, contradiction/unknown counts, posture, context size, evaluation scores/issues, repair outcome, latency, and invariant status. Raw message bodies are not added to durable evaluation metadata.

`src/index.ts` injects formatted guidance into the model prompt only in `assistive` mode. The existing pre-send evaluator then evaluates the authorized response. Shadow mode never changes prompt text or replies. Assistive mode permits one text-only repair after existing truth logic and cannot cause another tool call.

## Modes

Set `GROUNDED_ADVISORY_MODE` to:

- `off`: no packet or evaluation work.
- `shadow`: build, evaluate, and record metadata without affecting prompts or replies. This is the default.
- `assistive`: add bounded guidance to response planning and allow one pre-send text repair.

Invalid values resolve to `shadow`. Production configuration is intentionally unchanged by this implementation.

## Evaluation

Run:

```bash
npm run test:grounded-response-intelligence
npm run test:grounded-response-intelligence:unit
```

The frozen counterfactual suite contains 34 synthetic scenarios and compares the same baseline drafts against simulated assistive repair. It covers multi-intent requests, supported and unsupported compound actions, quoted conjunctions, changed/stale/contradictory memory, commitments, ambiguity, missing preconditions, tool-versus-goal truth, partial failures, stale approval, privacy, posture selection, citations, and target preservation.

Acceptance is fail-closed: zero authority/privacy/completion-claim violations, zero clause/target loss, at least 15 points of aggregate improvement, no safety-critical regression, deterministic outputs, p95 under 250 ms, and bounded context. The evaluator thresholds are not relaxed when a gate misses.

## Read-only diagnostics

```bash
npm run debug:grounded-response-intelligence -- --request "Check my calendar, then research lunch options"
npm run debug:grounded-response-intelligence -- --request "Send Sam the report" --reply "I sent it"
```

The diagnostic explains interpreted intents and targets, evidence references and epistemic status, exclusions, goals, contradictions, blockers, posture, prohibited claims, budgets, and draft coverage. It reads local grounded memory and does not journal, mutate, call a provider, or send a message.

## Activation risk

Assistive mode is implemented for owner-reviewed dogfood but remains disabled by default. Before live activation, review false repairs on ordinary conversation, target extraction for domain-specific language, latency in real turns, and ten days of dogfood evidence. The deterministic harness is evidence of bounded behavior, not a substitute for real-world outcomes.
