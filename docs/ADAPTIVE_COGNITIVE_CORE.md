# Adaptive Cognitive Core v1

## Status and scope

Adaptive Cognition v1 introduces a typed, privacy-bounded state machine for framing a task, compiling a plan graph, recording evidence and beliefs, handling bounded recovery, and refusing completion without criterion-level evidence. The canonical implementation is `src/adaptive-cognition-engine.ts`, version `1.0.0`.

Adaptive Cognition is now in the authoritative path for eligible meaningful live turns handled by `beginTurnAgentHarness()`. The live harness prepares the cognitive kernel without executing its former synchronous tool loop, binds the resulting adaptive nodes explicitly, asks Runtime Spine to create the durable projection, and advances work through one-node durable leases. Completion-shaped replies then pass through a separate adaptive claim gate immediately before delivery.

This is a control-spine migration, not a replacement for every production subsystem. Ingress, deterministic route selection, transport delivery, credentials, registered tool policy, and the existing action layer still own their established boundaries. In particular, production mutations have not moved into the kernel adaptive adapter; the live adapter is read-only and staging-only, and real sends or writes remain behind their existing approval and receipt paths.

The accurate v1 boundary is:

```text
existing ingress and deterministic route selection
                       |
                       v
live turn harness -> cognitive kernel prepare_only
                       |
                       v
              adaptive frame + graph
                       |
             explicit exact-node bindings
                       |
                       v
              Runtime Spine durable plan
                       |
                       v
 grant -> one-node lease -> revalidate -> execute/stage -> verify receipt
                       |
                       v
           adaptive evidence + graph reduction
                       |
                       v
             pre-send adaptive claim gate
                       |
                       v
                 existing delivery

existing mutation action/approval paths remain authoritative alongside this lane
```

The engine defines canonical cognition and completion semantics. Runtime Spine and durable continuity are the authoritative execution boundary for the migrated adaptive lane, while the existing action layer remains canonical for production mutations.

## Core model

The pure engine is synchronous, deterministic for a supplied clock and executor, and deliberately policy-neutral. It does not own credentials, transports, tool registration, external mutation authority, or durable effect receipts. The live integration uses its reducer-style APIs to select an exact external node and apply a typed observation only after the durable layer has verified that node's receipt.

| Object                         | Purpose                                                                                                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AdaptiveProblemFrame`         | Binds the objective, task family, route, success criteria, constraints, assumptions, unknowns, authority ceiling, risk, context references, and privacy contract.    |
| `AdaptivePlanGraph`            | Stores dependency-linked frame, hypothesis, clarification, action, recovery, verification, and completion nodes with bounded attempts and execution/runtime budgets. |
| `AdaptiveEvidence`             | Records a typed claim, confidence, freshness, scope, verification state, criterion links, and provenance references.                                                 |
| `AdaptiveBeliefClaim`          | Tracks testable subject/predicate/value claims as hypotheses, supported, contradicted, superseded, or unknown.                                                       |
| `AdaptiveVerificationReport`   | Evaluates every required success criterion and lists supporting, rejected, contradictory, and missing evidence.                                                      |
| `AdaptiveEngineTraceEvent`     | Records sanitized selection, execution, observation, replanning, belief update, verification, and stop metadata.                                                     |
| `AdaptiveImprovementCandidate` | Keeps a proposed change isolated from authority expansion and production mutation while it is evaluated.                                                             |

The evidence classes are intentionally distinct:

- `observed`: an external, tool, policy, receipt, or evaluator observation.
- `user_attested`: a user-provided confirmation.
- `inferred`: a conclusion derived from other information.
- `simulated`: evidence from a fixture or simulation.
- `model_generated`: a model-produced hypothesis or artifact.

The class label is not sufficient by itself. Completion also requires the class to be allowed by the criterion, fresh evidence, an `accepted` or `verified` verification state, the criterion's minimum confidence, and an explicit `supportsCriterionIds` link. Default criteria allow only observed or user-attested evidence.

## Adaptive loop

`createAdaptiveProblemFrame()` sanitizes the request-facing metadata and derives whether ambiguity is clear, resolvable, or blocking. `buildAdaptivePlanGraph()` compiles that frame into:

1. a framing node;
2. a hypothesis node;
3. an optional clarification node for blocking unknowns;
4. primary action nodes and dormant, predeclared recovery nodes;
5. one verifier that depends on every active primary action; and
6. one completion node that depends on the verifier.

`runAdaptiveCognition()` then performs a bounded loop:

1. Reconcile new evidence into the belief set.
2. Mark dependency-satisfied nodes ready.
3. Select exactly one ready node by priority.
4. Check the frame's authority before invoking the caller-supplied executor.
5. Record normalized evidence and update beliefs.
6. Enforce the node's declared evidence class/provenance contract, retry within `maxAttempts`, or activate a failure-class-matched dormant alternative.
7. Stop on missing approval, blocking ambiguity, terminal failure, exhausted budget, or missing evidence.
8. Run criterion verification and re-run it immediately before committing `satisfied`.

The graph changes during recovery and when fresh evidence reopens verification. `reopenAdaptivePlanForEvidence()` reopens only the verifier and finisher, so completed action nodes are not replayed.

This v1 graph runner should not be described as a utility-maximizing planner. All primary action nodes share the same action root, and the verifier waits for all of them. `selectAdaptiveNextAction()` is a separate bounded scorer; durable continuity reuses that scorer, but the scorer does not choose action nodes inside `runAdaptiveCognition()`.

## Live durable execution path

For an eligible live harness turn, the production sequence is:

1. `beginCognitiveKernelRun(..., executionMode: 'prepare_only')` builds and persists the frame and graph without executing a tool plan.
2. `buildCognitiveAdaptiveDurableBindings()` produces a closed binding for every executable adaptive node. A binding includes the graph and plan-contract identities, node/action/tool identities, durable action and effect classes, exact target scope, evidence subject, criterion IDs, required evidence IDs, and verifier requirement IDs. Binding failures stop the migrated lane; goal text, node titles, purposes, and tool names are never used to infer an effect.
3. `beginAgentRuntimeSpineRun()` compiles those bindings into a `DurableExecutionPlan` whose `planId` is the adaptive `graphId` and whose executable node IDs are the adaptive node IDs. Runtime Spine creates the first checkpoint, links it to the runtime and cognitive run, and stages approval only when the exact next binding requires it.
4. `continueCognitiveKernelDurably()` asks `advanceAdaptiveCognition()` for one exact directive, issues a node-scoped resume grant, consumes it into a single-use lease, and calls the durable orchestrator with that expected node ID.
5. The durable layer revalidates dependencies, executor scope, target scope, plan version, and approval identity before invocation. It records a started receipt at the invocation boundary and requires a verified post-state receipt before the adapter can convert the result into `AdaptiveEvidence`.
6. The adapter applies that observation to the same adaptive node. A receipt-locked mapper may classify a newly verified read as `degraded` or `terminal_failure`, but non-success observations must remove every criterion link and may not request a retry after the durable node is complete. Uncertain work is verified after restart without replay when an exact recovery receipt resolves the original invocation; otherwise the graph remains blocked or awaiting evidence.
7. The loop continues within its lease and graph budgets. It never falls back to the former synchronous executor when binding, durable execution, or verification fails.

This path is intentionally one node at a time. A successful tool callback alone is not completion evidence, and a durable work status alone cannot satisfy an adaptive criterion.

### Pre-send claim gate

`authorizeCognitiveReplyDelivery()` is a pure final claim check. It does not execute an action or send a message. It reopens adaptive verification with any newly supplied typed completion evidence and authorizes `completion` text only when every required criterion is satisfied with target-bound evidence. Live `prepare_only` runs additionally require the same durable work to pass its terminal verification node. If adaptive state is missing, durable terminal verification is absent, or criterion verification is incomplete, completion text is replaced with an evidence-wait response.

Container output is buffered until the host reconciles a same-run, same-turn, fresh `VerifiedDeepWorkPacket`. The runtime bridge accepts only a closed read-only/verification action set, rejects unresolved or external effects, binds both the explicit runtime-outcome and completion criteria to the same target, and then closes the durable terminal checkpoint. Original text and controls are discarded when this authorization fails.

Typed non-completion replies are checked against the current stop state: approval requests require an approval wait, clarification requires blocking ambiguity, blocked notices require a blocked state, and evidence requests require an evidence-seeking state. Progress replies remain allowed because they do not claim completion. Container output is buffered until terminal runtime evidence has been reconciled, so partial output cannot outrun its postcondition evidence.

## Evidence, belief, and completion contract

For each required criterion, `verifyAdaptiveCompletion()` selects only evidence that satisfies the criterion contract. Completion is authorized only when every required criterion has admissible support and there are no contradicted beliefs.

Important semantics:

- Stale, unverified, low-confidence, wrong-class, or unlinked evidence is rejected for completion.
- Conflicting values for the same subject, predicate, and scope become contradictions when both sides have sufficient confidence. Any unresolved contradicted belief currently blocks the entire completion decision.
- The finish node does not trust a previous verifier result; it verifies again from current evidence and beliefs.
- Exact target binding can be global with `target:<id>` or criterion-specific with `target:<criterionId>:<id>`. Production kernel frames use the criterion-specific form so policy evidence is not accidentally bound to an effect target.
- Receipt provenance is enforced per criterion only when the frame has `receipt_required:<criterionId>`.
- An evidence producer is responsible for truthful verification and criterion links. The engine currently accepts both `accepted` and `verified` evidence and does not cryptographically validate provenance.

Target and receipt references are therefore part of the security contract, not decorative metadata. A production adapter that verifies an external effect must populate them and must bind the evidence subject, scope, and receipt to the approved action.

## Authority and safety invariants

The intended invariants are:

- The engine never grants authority. It can only enforce the ceiling encoded in the frame.
- A mutating or approval-required node must have its exact action ID in the current frame's approved action IDs.
- Action IDs must be non-empty and unique after normalization, and `draft_only` authority cannot cross into approval-gate or mutation nodes.
- Mutation approval is mandatory, and inherited authority is forbidden by the frame contract.
- Reasoning, simulation, and model-generated content are separated from observation; callers must not relabel them as effect proof.
- Unsupported or contradictory completion stops with a named next action instead of an outcome claim.
- Node executions, retries, failure-specific alternatives, declared evidence contracts, per-node elapsed time, and total runtime are bounded. A synchronous executor cannot be interrupted mid-call, but evidence returned after its node timeout is discarded.
- The privacy contract is metadata-only: raw prompts, private bodies, hidden reasoning, raw tool output, and secrets are not engine state.
- Existing repository scope checks, capability registration, tool simulation, preflight policy, approval handling, durable one-node execution, effect receipts, ingress claims, and delivery receipts remain authoritative for real-world actions.

The exact binding and receipt checks are enforced by the migrated durable adapter, but they are not proof that every compatibility caller or legacy action path supplies equivalent evidence. The remaining limitations below identify that boundary.

## Canonical and compatibility boundaries

| Component                               | v1 role                                                                                                                                                                                                    | Authority                                                                                                                                                                                          |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adaptive-cognition-engine.ts`          | Canonical frame, graph, evidence, belief, verification, bounded-loop, calibration, and isolated-improvement semantics.                                                                                     | No transport, credential, persistence, or mutation authority.                                                                                                                                      |
| `cognitive-kernel.ts`                   | Builds the adaptive frame and graph, creates explicit read-only/staging node bindings, advances the graph through durable directives, and accepts only typed completion evidence at finalization.          | Live harness calls use `prepare_only`; `synchronous_compatibility` remains for non-live tests and internal callers and is not the authoritative live lane. Kernel mutation nodes are not migrated. |
| `adaptive-cognition-durable-adapter.ts` | Validates complete exact bindings, compiles the adaptive graph into a durable plan, converts only exact verified receipts into adaptive evidence, and reconciles uncertain invocations without replay.     | Cannot infer action/effect/target identity from text and cannot widen the durable action policy.                                                                                                   |
| `durable-work-continuity.ts`            | Owns scoped grants, one-node leases, invocation receipts, verification receipts, recovery, and terminal durable checkpoints. Its bounded candidate ranking also delegates to `selectAdaptiveNextAction()`. | Canonical execution boundary for the migrated adaptive lane; callbacks still operate under the existing tool and action policies.                                                                  |
| `agent-runtime-spine.ts`                | Creates new adaptive durable work from the graph identity and exact node bindings, links the runtime/cognitive projections, and stages exact-node approval when required.                                  | New matching work is `authoritative`; pre-existing nonmatching work is `legacy_pinned` and is never reinterpreted as the adaptive plan.                                                            |
| `turn-agent-harness.ts`                 | For meaningful live turns, prepares the kernel, builds bindings, asks Runtime Spine to create work, and continues it through durable leases. Binding or continuation failure is recorded as `fail_closed`. | Does not fall back to synchronous tool execution. Simple turns and explicitly bypassed local workflows remain outside this harness lane.                                                           |
| `index.ts` delivery composition         | Buffers container output through terminal evidence reconciliation and sends all typed replies through the adaptive claim gate.                                                                             | The claim gate authorizes wording, not mutation authority; transport delivery remains an existing runtime responsibility.                                                                          |
| `cognitive-executive.ts`                | Serializes an adaptive frame/graph beside `compatibilitySteps` for executive planning consumers.                                                                                                           | This projection is not a durable execution checkpoint and does not supersede the Runtime Spine plan.                                                                                               |

The adaptive durable lane is live in the turn harness, but it is not universal. Simple turns, explicitly bypassed local workflows, non-live/replay callers, and internal compatibility entry points can use different paths. “Live in the eligible turn harness” is accurate; “the adaptive graph owns every ingress and mutation” is not.

## Persistence and provenance

The engine itself is pure in-memory state. Persistence is delegated to callers.

| Surface                              | Persisted form                                                                                                                                                                                                                 | Current limit and boundary                                                                                                                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cognitive kernel                     | Frame, graph, evidence, beliefs, verification, and status inside `cognitive_runs.task_graph_json`; sanitized belief summaries also project into the existing world-belief store.                                               | The bounded adaptive graph is serialized in full. Durable observations update this state only after exact receipt verification. Loss of the adaptive marker makes the completion claim gate fail closed. |
| Runtime Spine and durable continuity | Adaptive `graphId` as durable `planId`, exact adaptive node IDs in plan/checkpoint state, runtime/cognitive projection links, plan version, scope hashes, grants, leases, approval identity, and effect/verification receipts. | This is the resumable execution record for newly migrated work. It stores opaque identities and fingerprints, not prompts or raw tool output.                                                            |
| Cognitive executive                  | Adaptive engine version, frame, plan, and legacy compatibility steps inside `CognitivePlan.stepsJson`.                                                                                                                         | `safeJson(..., 12_000)` can replace the structured plan with a preview. It is planning metadata, not the authoritative durable checkpoint.                                                               |
| Certification                        | Deterministic synthetic results printed by the certification command.                                                                                                                                                          | No production state or production learning update.                                                                                                                                                       |
| Dogfood protocol                     | Pure validation/report objects supplied by the caller.                                                                                                                                                                         | The protocol module performs no persistence, messaging, calendar writes, pushes, or external mutation.                                                                                                   |

Only privacy-safe claims and references belong in these records. Raw tool output and private content stay in their owning system; adaptive evidence should carry stable result, artifact, verification, and receipt references instead.

## Isolated improvement

`proposeIsolatedAdaptiveImprovement()` always creates an isolated candidate with `authorityExpansion: false` and `productionMutationAllowed: false`. `evaluateIsolatedAdaptiveImprovement()` marks a candidate numerically eligible only when:

- at least 40 held-out scenarios were evaluated;
- the candidate score exceeds the baseline;
- safety regressions are zero; and
- privacy regressions are zero.

Eligibility is not approval to merge, deploy, mutate production state, or broaden authority. Promotion still requires review, the live dogfood gate, and the production safety path.

## Certification gate

On 2026-07-19, the following commands passed:

```sh
npm run typecheck
npm run test:adaptive-cognition
npm run test:adaptive-cognition:dogfood
```

The deterministic offline certification reported:

- 48 of 48 synthetic held-out scenarios passed across ambiguity, replanning, stale evidence, contradiction, approval/authority, provider degradation, privacy injection, restart, and mixed-adversarial categories.
- 15 of 15 fixture-defined recoverable failures reached verified replanning success.
- zero fixture unauthorized effects, false completions, privacy leaks, or oracle leaks.
- Brier score `0.00420625` and expected calibration error `0.063125` over the fixture predictions.
- candidate score `1.0` versus `0.2291667` for the frozen evaluator-owned static baseline.
- the isolated candidate was numerically eligible, with production mutation still forbidden.

The certification now asserts at least 40 calibration samples, Brier score at most `0.10`, and expected calibration error at most `0.10`. Failure output contains only opaque task IDs, and the certification is included in `test:major:ci` after the unit suite.

This result is a deterministic synthetic certification, not live deployment evidence. The static comparator is an evaluator-owned reproducible policy, not a measured historical production run. The held-out pack is isolated from production imports and hides its semantic oracle from the engine, but it is still repository-local test material.

Focused integration tests additionally cover prepare-only kernel startup, exact graph/node durable compilation, one-node lease consumption, node-bound approval, verified positive and degraded receipt conversion, restart recovery without replay, buffered host-runtime evidence, durable terminal verification, pre-send completion blocking, and legacy-work rollback pinning. Those tests prove control-flow invariants; they do not count toward the elapsed live dogfood gate.

## Dogfood gate

The live dogfood protocol is documented in [ADAPTIVE_COGNITION_DOGFOOD.md](./ADAPTIVE_COGNITION_DOGFOOD.md). Its acceptance target is 20 admitted live tasks across 10 distinct working dates, exactly two admitted tasks per date, with direct-live-observation provenance, distinct task/run identities, verifier and receipt references, and an explicit owner verdict after completion.

Synthetic, replayed, backfilled, duplicated, unverifiable, privacy-unsafe, or owner-unreviewed entries do not count. Negative outcomes remain visible blockers rather than being discarded.

The repository currently contains the protocol and six passing protocol tests, but no qualifying 10-working-day live evidence ledger or completed live report. The certification report explicitly contains `liveRuns: 0`. The elapsed-use gate is therefore not satisfied and must not be represented as complete.

## Remaining rollout limitations and known risks

1. **Production mutations are not migrated.** `buildCognitiveAdaptiveDurableBindings()` accepts the kernel's read-only and metadata-staging actions and rejects mutation nodes. Sends, calendar writes, repository changes, purchases, deploys, and other effects remain in their established action-specific approval and receipt systems. Do not describe a staged draft or approval packet as the underlying effect.
2. **Coverage is not universal.** The authoritative adaptive durable path applies to eligible meaningful live turns that enter the turn harness with initialized durable storage and valid bindings. Simple turns, explicitly bypassed local workflows, proof/replay paths, and direct internal callers are not evidence that the same path ran.
3. **Synchronous compatibility still exists.** Kernel callers that omit `executionMode: 'prepare_only'` can use `synchronous_compatibility` for internal and non-live use. A synchronous callback cannot be preempted mid-call; this compatibility mode must not be promoted back into the authoritative live execution lane.
4. **Migration deliberately pins existing work.** Runtime Spine does not rewrite a pre-existing static or otherwise nonmatching durable plan under a new adaptive identity. It reports `legacy_pinned` and preserves the existing checkpoint. This makes rollback safe, but mixed legacy/adaptive work will remain visible until old work naturally completes or is explicitly migrated by a future reviewed process.
5. **Approval and receipt trust still terminates in adapters.** The durable path binds approvals and receipts to work, checkpoint, plan version, target scope, action class, and node ID, and it requires verified post-state fingerprints. The policy-neutral engine does not cryptographically validate a provider's underlying claim; a trusted adapter can still supply a dishonest observation.
6. **The claim gate is not an effect gate.** It prevents unsupported completion wording and mismatched stop-state replies. It does not authorize, execute, cancel, or prove a mutation; those guarantees must already exist in the action and durable receipt layers.
7. **The executive projection is not a durable checkpoint.** Its display-oriented `stepsJson` can become a bounded preview. Runtime Spine durable work plus the complete cognitive-kernel adaptive state are the authoritative resumable records for the migrated lane.
8. **Privacy still depends on trusted adapters supplying summaries and opaque references.** The engine and kernel redact common secrets and PII, kernel objectives use bounded summaries, and raw tool output is omitted, but no generic redactor can prove arbitrary free-form text contains no sensitive content.
9. **The elapsed live gate is incomplete.** Synthetic certification and focused live-path tests pass, but the required 20 admitted tasks across 10 distinct working dates, with contemporaneous direct-live evidence and explicit owner verdicts, do not yet exist. The 10-day dogfood gate remains open.
10. **Legacy fast-path receipts are only partially bridged.** Bounded informational fast paths are typed as progress and do not claim task completion. Older local mutation and provider-result paths without an exact run/turn-bound receipt remain fail-closed at the claim gate, even when their underlying action subsystem reports success. They need dedicated closed receipt adapters before their positive completion wording can be restored; generic caller-created evidence is intentionally not accepted.

The false-completion paths found during the v1 audit are closed: degraded tool evidence does not support outcomes; final-turn evaluator metadata is not completion proof; adaptive verification cannot be bypassed by a null finalizer; a persisted `satisfied` graph is rechecked against current evidence; rejected evidence cannot become supported; and unverified turns emit an evidence-required signal instead of a positive completion signal.

Use v1 as the canonical cognition, migrated durable-control, and completion-claim contract for eligible live harness turns. Continue to use the existing action-specific enforcement paths for mutations, preserve legacy pinning during rollout, and do not claim universal production coverage until the mutation migration and 10-working-day dogfood gate are complete.
