# Andrea Testing And Release Runbook

This runbook defines how to validate Andrea end to end before major merges, main-branch pushes, or live deployment changes.

## What This Runbook Separates

This repo has three different validation layers:

- **CI-safe validation**
  - formatting, typecheck, lint, tests, build
  - no assumption of live credentials or channels
- **Operator-host live validation**
  - real runtime, real credentials, real channel behavior
  - restart and verify on the deployed machine
- **Optional integration validation**
  - Cursor Cloud
  - desktop bridge
  - Alexa
  - Amazon
  - marketplace/community skills

Do not treat optional integration checks as baseline unless that integration is actually configured.

## 1. Fast Local Checks

```bash
npm run format:check
npm run typecheck
npm run lint
npm run docs:check
npm run test
npm run build
```

### Build Artifact Reality

The root project currently builds a cross-platform Node runtime artifact at
`dist/index.js`; it does not define Electron, Tauri, `pkg`, `nexe`, or other
native desktop packaging scripts. Treat `npm run build` as the release build
for macOS and Windows service/runtime deployment.

The root build and typecheck do not compile
`container/agent-runner/src/`. The canonical source is mounted read-only at
`/app/src` and compiled into container-local `/tmp` at startup; no per-group
writable runner copy is used. A runner change therefore requires its complete
repository-side gate:

```bash
npm run container:install
npm run typecheck:agent-runner
npm run build:agent-runner
npm run test:agent-runner
```

### Container capability-lane and IPC containment

The container boundary has four session lanes: `direct-assistant`, `protected`,
`control`, and `execution`. Advanced and code routes intentionally share only
`execution`; every other route pair must use a different storage key and Claude
home. For group `main`, the keys are `main::direct_assistant`,
`main::protected`, `main::control`, and `main::execution`, paired with
`.claude-direct-assistant`, `.claude-protected`, `.claude-control`, and
`.claude-execution`. Legacy shared tool-bearing sessions and writable runner
caches remain preserved but inert.

Every run must receive a new host-created inbox below
`data/ipc/<group>/input/<lane>/<runId>`. GroupQueue writes HMAC-SHA256
`provenance:host` envelopes bound to that run and its per-run token. The runner
mounts the inbox read-only and rejects unsigned, altered, cross-run, and replayed
messages without placing the token in diagnostics. Direct-assistant, protected,
and control guidance is host-constant; only execution may read mutable group
`CLAUDE.md`. Canonical runner source, settings, skills, and plugins remain
read-only trusted views.

Run the host and runner contracts together:

```bash
npm run check:container-contract
node scripts/run-with-pinned-node.mjs --import=./scripts/test-network-guard.mjs ./node_modules/vitest/vitest.mjs run src/assistant-session.test.ts src/group-queue.test.ts src/container-ipc-auth.test.ts src/container-runner-controls.test.ts src/mount-security.test.ts
npm run test:agent-runner
npm run build:container
npm run check:container-canary
npm run check:container-mounts
```

Acceptance requires direct-after-execution poisoning rejection, all route-pair
session isolation, authenticated one-run inbox follow-ups, replay rejection,
read-only trusted controls, writable session continuity only inside the same
lane, and a real nested-read-only mount canary. A focused unit pass does not
replace the real-container canary.

Platform-specific release proof means:

- macOS: build from the canonical checkout, restart launchd, and verify the
  Mac mini service reports the serving commit from `$HOME/Andrea_NanoBot`
- Windows: build and verify through `scripts/nanoclaw-host.ps1` on a Windows
  host
- native macOS arm64/x64 or Windows installer artifacts require a future
  packaging project before they can be claimed as produced

Hosted `windows-latest` CI is a cross-platform build/type/test and launcher-
contract boundary. It is not native Windows service restart or integration
proof. Repository validation supports Node `22.x` (`>=22 <23`) and is pinned by
`.nvmrc` to `22.22.2`.

`npm ci` on each deployment host installs platform-specific runtime
dependencies, including the bundled ffmpeg helpers used for media analysis.
The TypeScript build itself remains shared across macOS and Windows.

For the shared assistant core specifically, add these focused checks when Alexa, Telegram, or research orchestration changes:

```bash
node scripts/run-with-pinned-node.mjs ./node_modules/vitest/vitest.mjs run src/assistant-capabilities.test.ts src/assistant-capability-router.test.ts src/research-orchestrator.test.ts
npm run debug:shared-capabilities
npm run debug:research-mode
npm run debug:knowledge-library
```

The shared-capability smoke uses isolated storage plus a process-level network
deny guard. The plain research-mode command is a zero-cost status check. It
performs no provider request and writes no proof marker. Add `-- --live` to
either command only for intentional provider-backed use.

For ordinary companion chat, graceful degraded replies, and no-leakage checks, add:

```bash
node scripts/run-with-pinned-node.mjs ./node_modules/vitest/vitest.mjs run src/conversational-core.test.ts src/direct-quick-reply.test.ts src/assistant-routing.test.ts src/assistant-capability-router.test.ts src/research-orchestrator.test.ts src/user-facing-fallback.test.ts src/alexa.test.ts
npm run debug:conversational-core
```

Treat this conversational-core stack as the fast proof that normal Telegram, Alexa, and BlueBubbles users still get warm ordinary chat plus humane blocked-path behavior instead of operator diagnostics.

For the flagship end-to-end product journeys, add:

```bash
node scripts/run-with-pinned-node.mjs ./node_modules/vitest/vitest.mjs run src/signature-flows.test.ts
npm run debug:signature-flows
```

This is the fastest proof that the best Alexa, Telegram, BlueBubbles, communication, mission, and research journeys still feel coherent end to end.
Treat this flagship-flow suite and harness as the primary product proof. The narrower subsystem suites below are there to debug seams after the flagship proof tells you which journey regressed.

For pilot-mode instrumentation, flagship journey proof, and private issue-capture changes, add:

```bash
node scripts/run-with-pinned-node.mjs ./node_modules/vitest/vitest.mjs run src/pilot-mode.test.ts src/field-trial-readiness.test.ts src/debug-control.test.ts src/assistant-capability-router.test.ts
npm run debug:pilot
```

Treat `debug:pilot` as the operator view for:

- current pilot-readiness proof by surface
- latest proof freshness plus 24h / 7d usage for each flagship journey
- recent flagged outcomes, including degraded-but-usable fallback
- open private pilot issues

For cross-channel handoff and action-completion changes, add:

```bash
node scripts/run-with-pinned-node.mjs ./node_modules/vitest/vitest.mjs run src/cross-channel-handoffs.test.ts src/assistant-action-completion.test.ts src/alexa-conversation.test.ts src/alexa.test.ts src/assistant-capability-router.test.ts
npm run debug:cross-channel-handoffs
```

For BlueBubbles channel changes, add:

```bash
node scripts/run-with-pinned-node.mjs ./node_modules/vitest/vitest.mjs run src/bluebubbles-self-thread.test.ts src/channels/bluebubbles.test.ts src/messages-fluidity.test.ts src/recent-text-review.test.ts src/assistant-capabilities.test.ts src/assistant-capability-router.test.ts src/bluebubbles-control-server.test.ts src/bluebubbles-monitor-state.test.ts src/message-actions.test.ts src/field-trial-readiness.test.ts src/companion-conversation-binding.test.ts src/cross-channel-handoffs.test.ts src/assistant-action-completion.test.ts
npm run debug:bluebubbles
npm run debug:bluebubbles -- --live
npm run openclaw:bridge:status -- --json
```

On the Mac mini, prefer local `127.0.0.1:1234` first and keep the Cloudflare BlueBubbles URL as fallback/diagnostic only. If Andrea cannot reach the local endpoint, `debug:bluebubbles -- --live` should read as `transport_unreachable`, not a generic healthy/degraded blur.

For BlueBubbles communication-summary or suggested-reply changes, verify:

- current-thread and named-thread summaries produce a fuller recap, not only
  activity counts
- wake/control text such as `@Andrea summarize this` is excluded from the
  summarized conversation body
- recent-text review shows two or three suggested replies when useful
- `draft #1`, `draft #1 option 2`, `make #2 warmer`, `send it`, and
  `send it later` remain same-thread and approval-first
- group, low-confidence, and sensitive threads stay draft/caution-first

Restart the macOS service before judging live messaging proof after repo-side
messaging changes:

```bash
npm run build
npm run mac:services:restart
npm run services:status
npm run integrations:status -- --json
```

Optional Mac-offline feasibility check only:

```bash
npm run debug:openbubbles-feasibility
```

For ritual and follow-through changes, add:

```bash
node scripts/run-with-pinned-node.mjs ./node_modules/vitest/vitest.mjs run src/rituals.test.ts src/life-threads.test.ts src/daily-companion.test.ts src/assistant-capabilities.test.ts src/assistant-capability-router.test.ts
npm run debug:rituals
```

### Commitment Intelligence

Whenever commitment strength, ownership, waiting/blocking/delegation,
deferral, ranking, life-thread persistence, or a life-thread consumer changes,
run the focused production path first:

```bash
npm test -- --run src/life-thread-commitment.test.ts src/life-thread-temporal.test.ts src/life-threads.test.ts src/outcome-reviews.test.ts src/rituals.test.ts src/daily-companion.test.ts src/memory-activation.test.ts src/communication-companion.test.ts src/chief-of-staff.test.ts
npm run certify:commitment-intelligence
npm run certify:temporal-truth
npm run certify:life-thread
```

`certify:commitment-intelligence` is the strict release gate for the new model.
Acceptance requires:

- 24/24 primary scenarios and 15/15 structurally different held-out cases
  reported as `PASS`; `PARTIAL`, skipped, or silently omitted cases fail;
- a disposable datastore, deterministic clock and timezone, synthetic
  identities, provider-environment suppression, and process-level non-loopback
  network denial;
- at least two full database close/reopen cycles through the production path,
  including transitions between restarts;
- exact duplicate replay as a no-op and older out-of-order evidence classified
  stale without reactivating superseded truth;
- atomic current state plus legacy projection, immutable transition
  provenance, deterministic ranking, ambiguity refusal, privacy isolation, and
  authority preservation;
- cleanup of the synthetic records, database, WAL, SHM, and manifest, followed
  by an independent production-database residue search.

The older life-thread certification remains valuable regression and before-
state evidence; it is not a substitute for the 24+15 commitment matrix. A
serialization-only test or an in-memory reopen is not durable-restart proof.
See [COMMITMENT_INTELLIGENCE.md](COMMITMENT_INTELLIGENCE.md) for the model and
transition contract.

### Verified capability acquisition

Whenever the capability-gap ledger, resource broker, acquired-skill projection,
binding registry, sandbox executor, canary gate, or active executor changes,
run the focused boundary first:

```bash
npm test -- --run src/capability-acquisition-ledger.test.ts \
  src/capability-binding-integrity.test.ts \
  src/capability-execution-guard.test.ts \
  src/capability-resource-broker.test.ts \
  src/turn-capability-acquisition.test.ts \
  src/verified-capability-acquisition.test.ts \
  src/council-safety.test.ts
npm run test:skill-library
npm run test:novel-capability:certification-gate
npm run certify:novel-capability-mastery
npm run debug:capability-acquisition
```

The certification must use a disposable on-disk database and fixture root,
provider-environment suppression, and parent/child non-loopback network denial.
It must run all named primary and held-out cases through production acquisition
APIs, preserve public-task/private-oracle separation, exercise durable restart,
and remove the manifest, database, WAL, SHM, fixture root, child processes, and
loopback servers. Missing, partial, skipped, fabricated, leaking, or residual
evidence is a failure. The required inventory is ten primary plus fifteen
structurally separate held-out scenarios. Synthetic execution must stop at
`sandbox_verified`; held-out evidence may request owner review, but a
certification that reports `canary_ready`, `active`, or `monitoring` fails.
The harness is a trusted in-process certification lab over disposable state,
not an OS isolation boundary. Its test-authored task-family adapters and
evaluators exercise the production lifecycle APIs; fixture resource freshness
comes from canonical synthetic resource-discovery observations, not live
provider-health persistence. The current accepted proof is 25/25 scenarios,
88 report mutations across 31 failure codes, fresh adapter/worker contract
rehydration, operation-discovery calls reduced from 2 to 0, total calls reduced
from 4 to 2, and zero provider calls, cost, network escape, or residue.

Acceptance also requires:

- external documentation remains sanitized untrusted data and never becomes a
  prompt instruction, executable binding, credential, or approval;
- every candidate step resolves to the exact compiled resource, operation,
  action class, version, executor declared identity/version digest, and
  independent evaluator declared identity/version digest; these are registry
  identity pins, not callback-byte attestation;
- sandbox success belongs to canonical durable work and its committed
  checkpoint, and follows started/terminal effect receipts, exact scope,
  independent postcondition verification, and cleanup—not the executor's
  success text;
- synthetic and replay evidence cannot activate a skill or manufacture an
  owner review;
- caller-asserted live canary, activation, and production outcome identifiers
  fail closed; only the production apprenticeship's canonical durable-work/
  outcome/owner-review/fresh-health/exact-approval joins may advance them;
- stale versions, missing input, missing approval, uncertain effects,
  dependency degradation, negative outcomes, and safety/privacy failures stop
  or quarantine the candidate without false success;
- acquisition and promotion grant no authority beyond the existing action
  policy.

The strict command is part of the hermetic deterministic sweep and is also an
explicit Ubuntu and Windows CI step. Hosted Windows proves cross-platform
repository behavior, not a native service restart or live integration. See
[VERIFIED_CAPABILITY_ACQUISITION.md](VERIFIED_CAPABILITY_ACQUISITION.md).

For Verified Production Apprenticeship changes, run the focused production
lifecycle coverage plus both strict certification commands:

```bash
npm test -- \
  src/production-capability-apprenticeship.test.ts \
  src/production-capability-apprenticeship-hard-kill.test.ts \
  src/capability-canary-cli.integration.test.ts \
  src/capability-canary-cli.test.ts \
  src/owner-cockpit-server.test.ts \
  src/release-readiness-candidate-preparation.test.ts \
  src/release-readiness-active-reuse.test.ts \
  src/capability-apprenticeship-chat.test.ts \
  src/owner-cockpit-apprenticeship.test.ts \
  src/owner-cockpit-ui.test.ts \
  src/telegram-learning-scope.test.ts \
  src/bluebubbles-self-thread.test.ts \
  src/trusted-owner-review-surface.test.ts
npm run test:production-capability-apprenticeship:certification-gate
npm run certify:production-capability-apprenticeship
```

The released baseline certification reported exactly 22/22 A-V scenarios. The
current action-authority candidate has rerun and re-earned the same complete
22/22 result; focused CLI/chat/cockpit tests alone would not substitute. It must
remain
`deterministic_offline` / `certification_synthetic`. Accept only zero provider
calls, cost, network escapes, external effects, production and production-metric
writes, unauthorized or duplicate effects, privacy leaks, genuine owner
evidence, live children, and isolated or production residue. Parent and child
non-loopback denial, provider-environment suppression, metadata-only output,
synthetic owner-fixture labeling, benchmark isolation, and cleanup are hard
gates. This is repository behavior proof, not evidence that a real canary,
owner review, activation, semantic reuse, provider call, deployment, or service
restart occurred.

Both production-apprenticeship commands are explicit Ubuntu and Windows CI
steps. Scenario T uses two independent child processes that snapshot one
activation head before a parent-owned barrier, then race the same isolated
SQLite database; two promises serialized on one JavaScript event loop are not
accepted as concurrency evidence.

The operator surfaces have different authority:

- `npm run capability:prepare-release-readiness` writes only synthetic
  preproduction acquisition evidence under provider suppression and network
  denial. It must report all live-canary, owner-review, and activation flags
  false.
- `npm run capability:canary` is read-only inspection unless exactly one
  explicit mutation phase is selected. `--stage`, `--authorize-canary`,
  `--stage-action-approval`, `--authorize-action`, `--run-canary`,
  `--stage-activation`, and `--activate` are separate
  invocations bound to expected acquisition/run heads, the exact owner/chat/
  group/channel/target scope, normalized input, and fresh health observations.
- The CLI never approves a cognitive packet and never records an owner verdict.
  A protected plan stages a separate action-specific packet after canary
  authorization. Review the returned summary, version, scope digest, and
  summary digest, then send the returned exact
  `approve capability packet <id> version <n> scope <64hex> summary <64hex>`
  command on the same trusted chat before consuming it with
  `--authorize-action`. The chat handler must exact-query the canonical packet
  and run, reject wrong chat/channel/version/scope/summary/expiry or ambiguous
  bindings, and treat a repeat as an idempotent status response. Neither action
  phase nor the approval command executes the protected plan, and
  canary or activation authority cannot substitute. A verdict for a guided run
  is canonical only from its registered main Telegram chat or configured
  Messages self-thread. The owner cockpit is evidence/control only and rejects
  relabeling a chat-bound packet. Activation is available only after an exact
  `verified` verdict and consumes another separately approved packet.
- Guided execution is restricted to the bundled read-only, zero-egress
  Release-Readiness Brief. After genuine activation, live semantic dispatch is
  deliberately limited to narrow release-readiness questions on the exact
  trusted owner chat and target. Every reuse must revalidate contract identity,
  scope, resource version and health, lease ownership, receipts, and the
  independent postcondition.

Production contracts with credentials, unsupported egress/cost, mixed
authority, or non-empty rollback binding IDs must fail closed. The trusted
in-process synthetic sandbox is not OS isolation or a production rollback
engine; durable cleanup receipts prove only its disposable fixture cleanup.

Do not run a production preparation or mutation command merely to satisfy a
release test. Genuine canary, verdict, activation, and reuse are operator proof
and must remain absent unless the owner intentionally performs each decision.
See
[VERIFIED_PRODUCTION_APPRENTICESHIP.md](VERIFIED_PRODUCTION_APPRENTICESHIP.md).

For personalized setup, groceries, errands, bills, meals, pills, and lightweight list management changes, add:

```bash
node scripts/run-with-pinned-node.mjs ./node_modules/vitest/vitest.mjs run src/everyday-capture.test.ts src/assistant-capabilities.test.ts src/assistant-capability-router.test.ts src/daily-companion.test.ts src/command-surface-registry.test.ts src/alexa-v1.test.ts
npm run telegram:user:smoke
```

Treat that capture/profile suite as the fast proof that Andrea can:

- build a proposed setup from a guided intake while still allowing zero-setup capture on first use
  - keep learned changes suggestion-first
  - capture groceries, errands, bills, meals, household items, and tonight items cleanly
  - reopen recurring bills and household items when they become due again
  - read back the useful slice instead of dumping lists
  - derive practical household views like store run, bills this week, tonight, weekend, dinner gaps, recurring soon, recently completed, and slipping carryover
  - offer bounded Telegram inline actions after grouped list review without turning into a PM tool
  - convert a list item into a reminder, plan, or household thread without collapsing those systems together

For communication-companion and relationship-follow-through changes, add:

```bash
node scripts/run-with-pinned-node.mjs ./node_modules/vitest/vitest.mjs run src/communication-companion.test.ts src/assistant-capabilities.test.ts src/assistant-capability-router.test.ts src/alexa-conversation.test.ts src/daily-companion.test.ts src/channels/bluebubbles.test.ts
npm run debug:communication-companion
```

For chief-of-staff and decision-engine changes, add:

```bash
node scripts/run-with-pinned-node.mjs ./node_modules/vitest/vitest.mjs run src/chief-of-staff.test.ts src/assistant-capability-router.test.ts src/assistant-capabilities.test.ts src/daily-companion.test.ts
npm run debug:chief-of-staff
```

For missions and multi-step execution changes, add:

```bash
node scripts/run-with-pinned-node.mjs ./node_modules/vitest/vitest.mjs run src/missions.test.ts src/assistant-capability-router.test.ts src/assistant-capabilities.test.ts src/cross-channel-handoffs.test.ts
npm run debug:missions -- --dry-run
npm run debug:missions
```

For follow-through review and approval-flow changes, add:

```bash
node scripts/run-with-pinned-node.mjs ./node_modules/vitest/vitest.mjs run src/action-bundles.test.ts src/assistant-action-completion.test.ts src/alexa-conversation.test.ts src/assistant-capabilities.test.ts
npm run telegram:user:smoke
```

Treat that review suite as the fast proof that Andrea can:

- synthesize compact approval items
- approve all or a subset
- execute through existing reminder/draft/thread/library/handoff systems
- report partial success or failure calmly
- keep Alexa and Telegram follow-up semantics aligned

For delegation-rule and safe-automation changes, add:

```bash
node scripts/run-with-pinned-node.mjs ./node_modules/vitest/vitest.mjs run src/delegation-rules.test.ts src/action-bundles.test.ts src/assistant-action-completion.test.ts src/alexa.test.ts src/outcome-reviews.test.ts
npm run telegram:user:smoke
```

Treat that delegation suite as the fast proof that Andrea can:

- preview and confirm a delegation rule from natural language
- auto-apply only safe delegated actions
- keep guarded actions on fresh approval
- explain when a usual rule fired
- keep rule-driven actions visible in outcome review

For the personal-intelligence production loop, also run:

```bash
node scripts/run-with-pinned-node.mjs ./node_modules/vitest/vitest.mjs run src/personal-context-packet.test.ts src/runtime-tool-evidence.test.ts src/runtime-tool-evidence-collector.test.ts src/container-runner.test.ts src/turn-runtime-evidence-scope.test.ts src/verified-deep-work.test.ts src/deep-work-apprenticeship.test.ts src/turn-agent-harness.test.ts src/turn-agent-intelligence-boundary.test.ts src/routine-promotion.test.ts src/personal-assistant-metrics.test.ts src/intelligence-regression-harness.test.ts
npm run typecheck:agent-runner
npm run test:agent-runner
npm run test:intelligence -- --no-record --quiet
npm run debug:assistant-intelligence
npm run debug:grounded-agency
```

The focused runtime-evidence suite proves only the aggregate action/state
contract: strict metadata validation, result correlation, retry merge,
turn/approval binding, and fail-closed deep-work reconciliation. It does not
claim a named artifact or semantic postcondition from raw output. A repository
write can complete only when a verification succeeded after the final write.
An aggregate external-action observation cannot complete, even with approval,
until a dedicated receipt binds the exact approved action. A terminal runtime
error blocks regardless of successful receipt counts, and a stale-session retry
must retain the suppressed attempt's evidence. Coding packets stay blocked on
`runtime_repository_scope_unbound`; operator packets stay blocked on
`runtime_operator_scope_unbound` until exact target, action, and postcondition
binding exists.

### Durable continuity and outage recovery

Run this focused suite whenever durable work, cognitive approval, repository
scope, startup recovery, owner-cockpit approval, Runtime Spine wiring, or
deep-work completion changes:

```bash
node scripts/run-with-pinned-node.mjs ./node_modules/vitest/vitest.mjs run src/durable-work-continuity.test.ts src/durable-work-adversarial-invariants.test.ts src/db-durable-lease-invariants.test.ts src/durable-work-migration.test.ts src/repository-execution-scope.test.ts src/verified-deep-work.test.ts src/owner-cockpit-server.test.ts src/index-continuity.test.ts src/agency-convergence-loop.test.ts src/agent-runtime-spine.test.ts src/turn-agent-harness.test.ts
npm run test:continuity:hard-kill
npm run test:continuity:heldout
```

The focused suite must prove:

- ordinary direct-assistant turns do not create durable work;
- canonical work, plan, checkpoint, and target identity use compare-and-set
  transitions and cannot cross owner/chat/group/channel/target scope;
- a plaintext resume token is never persisted, logged, or placed in an error;
- one atomic consume both invalidates the token and acquires one lease;
- the action class and an inbound-message binding, when supplied, cannot change
  at consume time;
- a resume grant cannot satisfy a mutation approval;
- approval staging atomically writes the immutable packet, a new approval
  checkpoint, its durable-work link, and the `awaiting_approval` work
  transition;
- owner approval echoes the stored group, summary, packet version, and scope
  digest, while a durable mutation also binds the exact work ID, current
  durable checkpoint ID, plan version, target digest, and action class;
- effect receipts are created before invocation, progress monotonically, and
  cannot rewrite successful or failed execution truth;
- every approval-bound receipt carries the consumed grant plus exact approval
  packet/version/scope provenance for the same
  work/checkpoint/plan/target/action, including approval-bound local operator
  changes;
- every completed DAG node has a referenced, same-work/same-plan succeeded
  receipt with verification and post-state evidence;
- an expired lease or a lease from another process generation cannot invoke a
  callback, persist a receipt, or complete work;
- checkpoint compare-and-set cannot silently remove completed or uncertain
  nodes or promote a pending node to completed without verified proof;
- malformed stored checkpoint JSON fails closed with a bounded error that does
  not echo stored content;
- uncertain effects enter verification-only recovery and are never blindly
  replayed;
- expired leases reconcile before new work, with unknown external delivery
  kept separate from execution completion;
- repository scope rejects a non-canonical root, path escape, symlink traversal,
  stale state, cross-work/plan/checkpoint/turn evidence, reused action ID, and
  failed postcondition;
- positive coding completion requires persisted receipts from the current
  leased, host-bound durable repository scope;
- unavailable storage is reported honestly while unrelated continuity errors
  still propagate;
- legacy Runtime Spine and Agent OS resume IDs remain non-executable
  projections; and
- migration is idempotent and preserves historical approval rows. A legacy row
  may still be decided through its legacy lifecycle, but it cannot authorize a
  durable continuation while work/checkpoint/plan/target bindings remain null;
  current authority requires a freshly staged exact durable approval.

The hard-kill command uses real child processes and force-terminates one at each
of 12 declared boundaries: before/after checkpoint commit, after lease
acquisition, before invocation, after tool start, after effect/before receipt,
after receipt/before checkpoint, after final write/before verification, after
verification/before completion, after completion/before reply, after reply/
before learning, and during replan. Every recovered boundary must finish with
exactly one isolated repository effect, one reply, one learning attempt, clean
SQLite integrity/foreign keys, no production mutation, and network denial.

That command also races eight independent processes against one grant. Accept
only one winner, seven `already_consumed` rejections, zero duplicate effects,
and hash-only token storage across the SQLite database, WAL, and SHM files. It
tests termination immediately after schema initialization, clean reopen,
idempotent migration, preservation of an unrelated legacy row, and fail-closed
handling of a deliberately malformed partial durable schema. It does **not**
kill inside an individual SQLite DDL statement and must never be reported as
in-DDL crash proof.

The held-out command runs ten disposable, network-denied scenarios: coding
after edit, research before synthesis, message before send, transport-unknown
message, stale calendar, local save, provider fallback, contradicted evidence,
ordinary question, and high-risk approval. Require 100% expected outcomes, zero
duplicate effects, no council calls, no production-state touch, unchanged
fixture learning counters, and no live provider call. Its latency
output is a deterministic regression signal, not a production p50/p95 claim.

Both commands operate on isolated databases, repositories, files, and fake
adapters. They do not prove a live channel, provider, service restart, owner
verdict, personal baseline, routine canary, skill promotion, or recovery of an
actual production mission. Never backfill those proofs from fixture output.

The intelligence harness must prove cited local context and a verified or
honestly blocked synthetic deep-work outcome without public network access.
The grounded-agency command must report twelve redacted cases and zero cost in
deterministic mode. Live mode requires an explicit positive estimated-cost
threshold, does not claim to cap provider billing, and remains outside CI.

For messaging trust-ladder and live-delivery changes, add:

```bash
node scripts/run-with-pinned-node.mjs ./node_modules/vitest/vitest.mjs run src/channel-delivery.test.ts src/channels/telegram.test.ts src/interaction-delivery-metrics.test.ts src/in-flight-turn-cursors.test.ts src/group-queue.test.ts src/message-actions.test.ts src/channels/bluebubbles.test.ts src/action-bundles.test.ts src/outcome-reviews.test.ts src/delegation-rules.test.ts src/alexa.test.ts src/field-trial-readiness.test.ts src/task-scheduler.test.ts src/task-scheduler.automation.test.ts src/job-status-card.test.ts src/job-dispatch.test.ts src/runtime-card-delivery.test.ts
npm run telegram:user:smoke
npm run debug:bluebubbles -- --live
```

Treat that messaging suite as the fast proof that Andrea can:

- require a non-empty receipt for complete primary delivery
- keep a definite pre-receipt rejection retryable while preventing automatic
  replay after a confirmed prefix or transport-unknown attempt
- exclude `partial` and `unknown` delivery evidence from successful p50/p95
- fail durable message workflows closed on partial, unknown, malformed, or
  receiptless delivery
- persist message actions/handoffs as `delivery_unverified` without resend
  controls, and preserve an already-created runtime job when only its status
  notification is blocked
- rewind a failed turn's persisted cursor before queue retry
- measure v3 `queue_wait` from valid inbound time while preserving v2 records
- record only aggregate dequeue-time host pressure and never use it to alter
  routing, approval, or latency targets
- drain a fresh pending turn when the prior container becomes idle without
  interrupting a busy container or closing an IPC-piped continuation
- persist a tracked message action from a draft
- require approval before external send by default
- send a BlueBubbles same-thread reply without the Andrea prefix
- keep one-off scheduled send distinct from remind-later
- keep save-under-thread distinct from remind-later and scheduled send
- surface sent vs deferred messaging honestly in review

Artifact delivery is a separate residual-risk check. A file/media transport
timeout may be unconfirmed even when the server accepted it; tests must not
equate a thrown artifact send with proof of non-delivery or automatically replay
it. Inspect the real target thread before any operator resend.

For Google Calendar create, follow-through, or calendar-routing changes, add:

```bash
node scripts/run-with-pinned-node.mjs ./node_modules/vitest/vitest.mjs run src/google-calendar.test.ts src/google-calendar-create.test.ts src/google-calendar-followthrough.test.ts src/assistant-routing.test.ts setup/google-calendar.test.ts
npm run setup -- --step google-calendar validate
```

Treat that calendar stack as the fast proof that Andrea can:

- keep calendar create distinct from reminders and save-for-later
- classify `missing_config` versus `invalid_refresh_token` honestly on the operator host
- keep user-facing calendar failure copy humane without leaking OAuth or env jargon
- preserve real calendar-write truth instead of masking a calendar failure as a reminder or save success

For outcome tracking, carryover, and review-flow changes, add:

```bash
node scripts/run-with-pinned-node.mjs ./node_modules/vitest/vitest.mjs run src/outcome-reviews.test.ts src/alexa.test.ts src/action-bundles.test.ts src/communication-companion.test.ts src/missions.test.ts
npm run telegram:user:smoke
```

Treat that review suite as the fast proof that Andrea can:

- record execution as `completed`, `partial`, or `deferred` honestly
- surface unresolved loops in daily and weekly review
- carry work into tomorrow without pretending it is closed
- keep Alexa review orientation short and grounded
- keep Telegram review controls bounded and inspectable

For Cognitive Executive route-selection, world-snapshot, and everyday executive-loop changes, add:

```bash
npm run test:cognitive-executive
npm run test:cognitive-executive:routing
npm run test:cognitive-executive:snapshot
npm run test:cognitive-executive:tool-selection
npm run test:cognitive-executive:explainability
npm run test:tool-reliability
npm run test:repair
npm run test:critic-agent
npm run test:agentic
npm run test:goal-planning
npm run test:causal-planner
npm run test:proactive-opportunities
npm run test:autonomy
npm run test:action-lifecycle
npm run test:action-preflight
npm run test:blackboard
npm run test:episodes
npm run test:capabilities
npm run test:strategy-evals
npm run test:agi-gauntlet
node scripts/run-with-pinned-node.mjs ./node_modules/vitest/vitest.mjs run src/assistant-capability-router.test.ts src/daily-companion.test.ts src/communication-companion.test.ts src/missions.test.ts src/everyday-capture.test.ts src/outcome-reviews.test.ts
npm run debug:executive -- --refresh
npm run debug:goals
npm run debug:planner
npm run debug:opportunities
npm run debug:repair
npm run debug:agentic
npm run debug:pilot
```

Treat that executive suite as the fast proof that Andrea can:

- classify the first eight high-value everyday flows
- build a bounded current-world snapshot without dumping unrelated context
- select an existing route instead of inventing a new feature path
- ask one clarifying question before ambiguous or approval-risk actions
- record route confidence, fallback, result, and repeated-friction signals
- explain a route briefly without raw prompts, private bodies, hidden reasoning, raw tool output, or secrets
- cap route confidence when dependent tools/providers are degraded
- record bounded repair attempts and cooldowns without hidden side effects
- convert durable multi-step asks into proposed goals with milestones and approval-aware steps
- compare `do nothing`, `verify first`, and `safe next step` options without exposing hidden reasoning
- surface at most one reply-coupled proactive opportunity and respect dismiss/snooze controls
- pass deterministic agentic simulations before broader live proof

For repair/status work, `integrations:fix` remains guidance-only. Use `integrations:heal -- --id <integration> --dry-run` to create a bounded repair trace; use `--apply` only for playbooks that explicitly stay safe, reversible, or metadata-only.

## 2. Major Suite

```bash
npm run test:major
```

This is the standard pre-release validation stack on a real operator machine.

It includes:

1. formatting check
2. typecheck
3. lint
4. unit tests
5. production build
6. `setup -- --step verify`

Implementation note:

- `.nvmrc` pins the repository and CI runtime to Node 22.22.2. On Windows, `scripts/run-with-pinned-node.mjs` provisions and validates that exact runtime; on macOS and Linux it uses the active Node process, which must satisfy the supported Node 22.x contract
- if the host default `node` is not 22, do not use that runtime for DB-backed Alexa checks; unsupported runtimes can fail `better-sqlite3` with ABI mismatch errors that are not Alexa feature failures

`test:major` includes `setup -- --step verify`, which is intentionally live: it
may make a real, potentially billable model reachability request and start
container execution probes. Use `test:major:ci` for offline release validation
and do not run the live suite without intentional credentials, cost awareness,
and operator authorization.

## 3. Stability Gate

```bash
npm run test:stability
```

Use this when you want release confidence, not just a single clean pass. One
invocation performs all three stability rounds; do not run the command three
times and describe that as three additional gates.

For live environments where credential/runtime probes should be exercised each round:

```bash
npm run test:stability:live
```

For a long deterministic script inventory after the standard gate:

```bash
npm run test:deterministic:sweep -- --list
npm run test:deterministic:sweep
```

This continues through independent `test:*` scripts, reports all failures at the end, and intentionally excludes interactive, aggregate, live, baseline-writing, and cloud-provider council tiers.

On the current 2026-07-15 tree, the sweep inventories **112** scripts:
**97 selected** deterministic commands and **15 explicitly excluded** commands.
Those counts are derived from the current package inventory and must be
regenerated after script changes. Final evidence for this tree must distinguish
the 97 selected commands from the 112-command inventory. The exact candidate
passes 97/97, including the nested one-command 3/3 stability gate. The 90/91,
94/94, and 96/96 counts in older modernization snapshots are historical and
must not be reused.

The deterministic runner is hermetic at both external boundaries: it suppresses
provider environment fallback, denies non-loopback network requests, and forces
any production-style `initDatabase()` call into an in-memory test database.
Every TypeScript `scripts/test-*` entrypoint also uses the isolated test
initializer directly. A test that needs an on-disk migration fixture must use a
generated disposable path; deterministic tests must never read or write
`store/messages.db`.

## 4. CI-Safe Suite

```bash
npm run test:major:ci
```

Use this in CI runners that do not have live credentials, channels, or operator-only integrations.

### Hosted exact-SHA gates

Branch and pull-request validation comes first. The normal CI, container, AGI,
and CodeQL workflows run on pull requests and establish review-candidate
evidence, but the manually dispatched security workflow is intentionally not a
pre-merge branch scanner. Its release-SHA resolver accepts only commits already
reachable from `origin/main`; an unmerged branch SHA must fail closed.

After the reviewed change is merged or otherwise published on `main`, require
the hosted Ubuntu, Windows, container, AGI, and CodeQL push jobs for that exact
main commit. Then dispatch the security workflow from `main` with the same full
40-character SHA:

```bash
RELEASE_SHA=$(git rev-parse HEAD)
gh workflow run agi-security.yml --ref main -f release_sha="$RELEASE_SHA"
```

The workflow rejects malformed SHAs and commits outside `origin/main`, checks
out that exact commit in every job, and runs dependency audit, full-history
verified-secret scanning, and Semgrep independently. Scheduled runs use the
latest default-branch SHA and the same main-ancestry policy. A passing scan for
a branch SHA, merge-preview SHA, or different main commit is not release
evidence. Do not restart production until all of these post-main exact-SHA jobs
pass.

The Semgrep container may trust only the checked-out `$GITHUB_WORKSPACE` as a
Git `safe.directory`. Never use wildcard `safe.directory` trust to make a
scanner pass; that would broaden the container trust boundary beyond the exact
release checkout.

## 5. Operator-Host Live Validation

Run this on the real deployed host.

### Preconditions

- a supported Node runtime (`>=22 <23`) is available; `.nvmrc` pins repository
  and CI validation to 22.22.2
- one healthy container runtime
- model credentials configured
- at least one configured channel
- at least one registered chat or `/registermain` completed
- `npm run services:status` shows `assistant_name=Andrea` and the expected Telegram DM as `registered_main_chat_jid`

### Baseline Runtime Checks

Run:

```bash
npm run setup -- --step verify
```

This is a **live, potentially billable** operator command. It may probe a
configured model and container runtime; it is not part of the offline gate.

If Google Calendar writes are part of the release bar on that host, also run:

```bash
npm run setup -- --step google-calendar validate
npm run debug:google-calendar
```

Confirm:

- `SERVICE: running_ready`
- `ACTIVE_REPO_ROOT` matches `$HOME/Andrea_NanoBot`
- `SERVING_COMMIT_MATCHES_WORKSPACE_HEAD: true` after the final restart into the release-candidate commit
- `HOST_INSTALL_MODE` and `HOST_ACTIVE_LAUNCH_MODE` are both truthful and understandable
- `CONFIGURED_CHANNELS: telegram`

Important truth for this host:

- `setup -- --step verify` now follows **pass core, warn extras**
- on the current host, `STATUS: success` is the normal outcome when launch readiness is `core_ready`, `core_ready_with_manual_surface_sync`, or `provider_blocked_but_core_usable`
- use `LAUNCH_CANDIDATE_STATUS`, `CORE_STATUS`, `MANUAL_SYNC_STEPS`, `OPTIONAL_PROVIDER_BLOCKERS`, `OPTIONAL_PROVIDER_NEXT_ACTIONS`, and `PROOF_FRESHNESS_GAPS` as the primary operator truth
- keep `EXTERNAL_BLOCKERS` and `MISSING_REQUIREMENTS` only as compatibility aliases, not as the whole product story
- Alexa can be `live_proven` while the latest repo interaction-model hash still needs one local sync confirmation; that should read as `core_ready_with_manual_surface_sync`, not `near_live_only`
- if Alexa ages out later, the likely blocker becomes `alexa_live_signed_turn_missing` or `alexa_live_signed_turn_stale`, not a broken service
- BlueBubbles may now surface `transport_unreachable` separately when the configured endpoint itself is not reachable from the Andrea host; do not confuse that with same-thread proof freshness
- when hostname resolution is brittle, prefer `BLUEBUBBLES_BASE_URL_CANDIDATES` with `127.0.0.1` first on the Mac mini and the Cloudflare URL as fallback/diagnostic only
- after repo-side messaging changes, restart the local services before judging live proof so `SERVING_COMMIT_MATCHES_WORKSPACE_HEAD: true` reflects the current candidate
- if `SERVICE: running_ready` and the blocker is external, treat that as an exact release-candidate caveat rather than a host failure
- for Google Calendar specifically, `FAILURE_KIND: missing_config` means the current repo lacks usable credentials, and `FAILURE_KIND: invalid_refresh_token` means the stored refresh token is stale or revoked; if the Google OAuth app is still in Testing, Calendar refresh tokens can expire after 7 days, so publish/verify it in Google Cloud Console before rerunning the current repo auth flow once
- if the browser reaches the OAuth callback but `auth` still times out, finish the same run with `npm run setup -- --step google-calendar auth-complete --callback-url "http://127.0.0.1:PORT/?state=...&code=..."`
- on this host, `npm run debug:google-calendar` is now the canonical live read/write proof surface and should report `PROOF_STATE: live_proven` when Google Calendar is healthy
- if you changed `docs/alexa/interaction-model.en-US.json`, finish the console import/build and then run `npm run setup -- --step alexa-model-sync mark-synced`

Then validate the public-safe Telegram surface:

- `/start`
- `/help`
- `npm run telegram:user:smoke`
- `/commands`
- `/thinking`
- `/council`
- `/cognition`
- `/memory`
- `/learning`
- simple quick reply prompt
- `ultrathink what I should prioritize tomorrow`
- `think harder about what I should prioritize tomorrow`
- `quick answer: what should I remember tonight`
- simple factoid prompt
- one blocked-path prompt that should stay free of setup/runtime/operator wording
- reminder prompt
- `npm run debug:council`
- `npm run debug:council -- --metrics`
- `npm run debug:council -- --evidence --json`
- `npm run test:real-world-intelligence:heldout` before any live proof. It uses
  isolated storage, asserts the non-loopback network guard, compares the old
  timing heuristic with five synthetic explicit-route fixtures, and exercises
  strict council acceptance without credentials or cost. It also creates a
  disposable local Git repository, observes a real failed write and recovery,
  fingerprints the resulting state transition, and runs a syntax test after
  the final write. Reconciliation must remain blocked on
  `runtime_repository_scope_unbound` because this local fixture does not bind
  every repository action to a host-enforced target. It is collector and
  fail-closed reconciliation proof, not a container/mount/IPC end-to-end canary
  or production-target proof. The accepted result is 6/6 execution-truth cases
  plus an intentionally scope-blocked disposable proof with no production-state
  touch.
- `npm run debug:council:live-proof -- --live --max-cost-usd=1.00 --ack-estimate-only`
  only when an explicitly budgeted live diagnostic is authorized. The
  threshold is a fixed estimate reservation, not an
  enforceable provider billing maximum; the extra acknowledgement is required
  so it cannot be mistaken for cost-cap acceptance evidence. The result is
  marked `acceptanceEligible: false` and `actualBillingCapEnforced: false` until
  provider calls support pre-call monetary reservation and complete reconciled
  usage. The command writes the estimate reservation before outbound calls and
  replaces it with a terminal blocked record if execution throws. It makes
  live, potentially billable provider/search calls and persists redacted
  health, council, and metric evidence locally. It performs no user-facing send
  or user/world mutation on the current coordinator-disabled runtime; an
  enabled coordinator can receive council-record POSTs. Evidence gaps, provider
  failure, timeout, substitution, platform-record fallback, and cost-control
  proof debt remain separate.
- `npm run debug:cognition -- --json`
- `npm run debug:cognition -- --config-only --json`
- `npm run debug:cognition -- --resume`
- `npm run debug:cognition -- --trace`
- `npm run debug:cognition -- --governance --json`
- `npm run debug:cognition -- --workbench --json`
- `npm run debug:agent-os -- --json`
- `npm run debug:agent-os -- --episode <id> --json`
- `npm run debug:agent-os -- --discover-tools --json`
- `npm run debug:agent-os -- --task-drill --json`
- `npm run debug:agent-os -- --plan-only "show the plan first for a safe integration check" --json`
- `npm run debug:agent-os -- --replay-plan <planId> --json`
- `npm run debug:logic -- --json`
- `npm run debug:logic -- --subject "<query>" --json`
- `npm run debug:logic -- --seed --json`
- `npm run debug:logic -- --reconcile --json`
- `npm run debug:truth -- --json`
- `npm run debug:truth -- --subject "<query>" --json`
- `npm run debug:truth -- --answer "<draft>" --json`
- `npm run debug:world -- --json`
- `npm run debug:world -- --stale --json`
- `npm run debug:world -- --verify-safe --json`
- `npm run debug:reality -- --json`
- `npm run debug:perception -- --json`
- `npm run proof:guided`
- `npm run debug:runtime-spine -- --json`
- `npm run debug:runtime-spine -- --events <runId>`
- `npm run debug:supervisor -- --json`
- `npm run debug:supervisor -- --blackboard <blackboardId> --json`
- `npm run debug:session-graph -- --json`
- `npm run debug:session-graph -- --cockpit --json`
- `npm run debug:session-graph -- --suggestions --json`
- `npm run debug:agency-loop -- --json`
- `npm run debug:agency-loop -- --agenda --json`
- `npm run debug:agency-loop -- --resume --json`
- `npm run debug:agency-loop -- --execute --json`
- `npm run debug:cognitive-workspace -- --json`
- `npm run debug:cognitive-workspace -- --optimize --json`
- `npm run debug:harness -- --json`
- `npm run debug:harness -- --rho --json`
- `npm run debug:cognition -- --task-drill`
- `npm run debug:cognition -- --execute-drill calendar`
- `npm run debug:cognition -- --execute-drill research`
- `npm run debug:cognition -- --execute-drill bluebubbles`
- `npm run debug:cognition -- --execute-drill operator`
- `npm run debug:cognition -- --trajectory --json`
- `npm run test:world`
- `npm run test:world:verification`
- `npm run test:world:turn-integration`
- `npm run test:runtime-spine`
- `npm run test:runtime-checkpoints`
- `npm run test:runtime-guardrails`
- `npm run test:supervisor`
- `npm run test:supervisor:blackboard`
- `npm run test:supervisor:handoffs`
- `npm run test:supervisor:loop`
- `npm run test:session-graph`
- `npm run test:session-graph:cockpit`
- `npm run test:session-graph:linking`
- `npm run test:session-graph:privacy`
- `npm run test:session-graph:turn-integration`
- `npm run test:agency-loop`
- `npm run test:agency-loop:resume`
- `npm run test:agency-loop:providers`
- `npm run test:agency-loop:privacy`
- `npm run test:cognitive-workspace`
- `npm run test:cognitive-workspace:context`
- `npm run test:cognitive-workspace:programs`
- `npm run test:cognitive-workspace:optimizer`
- `npm run debug:cognition -- --benchmarks`
- `npm run test:council:tasks`
- `npm run test:council:ultrathink`

Council source-pattern coverage counts only implemented patterns assigned to
the executable council challenge ladder. Cross-subsystem fixtures and
reference-only research ideas are not part of that denominator. Run the tier
named by `npm run debug:council`; a complete offline ladder reports 8/8 without
being treated as live-provider evidence.

- `npm run test:cognition`
- `npm run test:cognition:skills`
- `npm run test:cognition:benchmarks`
- `npm run test:cognition:traces`
- `npm run test:cognition:executor`
- `npm run test:cognition:execution`
- `npm run test:cognition:meta`
- `npm run test:cognition:loop`
- `npm run test:cognition:adapters`
- `npm run test:cognition:trajectory`
- `npm run test:cognition:governance`
- `npm run test:cognition:memory-blocks`
- `npm run test:cognition:workbench`
- `npm run test:agent-os`
- `npm run test:agent-os:interrupts`
- `npm run test:agent-os:tool-discovery`
- `npm run test:agent-os:trajectory`
- `npm run test:logic`
- `npm run test:logic:reconciliation`
- `npm run test:truth`
- `npm run test:truth:harness`
- `npm run test:agent-os:planner`
- `npm run test:agent-os:dag-executor`
- `npm run test:harness`
- `npm run test:harness:rho`
- `/cursor_status`

The empirical council gate must also be exercised independently of provider
quality. Ordinary coding, status, diagnostics, drafting, calendar, research,
approval, and learn-first fixtures must select one capable model. Explicit deep
controls and a material close-score route disagreement must select council.
Confirmed high-risk production, security, privacy, credential, deployment,
migration, deletion, or payment planning must still select council under a
quick control. These routing assertions are deterministic and cannot be
replaced by a synthetic quality score or a successful live provider call.

The cognition benchmark ladder must prove more than answer quality: each drill
should persist a redacted goal lifecycle row, a metadata-only blackboard trail,
an autonomy budget with mutating actions disabled by default, checkpoint/resume
state, tool-policy validation, approval gating, loop-state metadata, evidence
artifacts, step verification, trajectory scoring, and outcome metadata.
The harness trace checks must also prove sanitized trace spans, provider
cooldown snapshots, deterministic tool-plan simulation, bounded read-only
execution rounds, replayable checkpoints, typed approval packets, and a next
safe action without storing raw prompts, private message bodies, hidden
reasoning, secrets, or raw tool output.
For v9 governed workbench changes, the same ladder must also prove source-
attributed governance policies, pre-tool guardrail decisions, replayable role
handoffs, sanitized memory blocks with conflict/poisoning-risk metadata, and
approval packets for every mutating or send-adjacent path.
For v10 Agent OS changes, the same ladder must also prove durable episodes,
linked cognitive/council/tool evidence, resumable interrupts, typed role
handoffs, capability tool cards, source coverage scoring, trajectory evals,
candidate-only skill proposals, and privacy-preserving reports.
For v12-v14 changes, it must also prove stale/conflicting claim reconciliation,
saved goal-to-DAG planning, replay from persisted plans without replanning,
approval-staged mutating nodes, local harness trajectories, deterministic
scorecards, and candidate-only improvement proposals.

Council provider participation should be explicit in `/council` and
`debug:council`: `full` means all planned roles participated, `degraded` means
optional roles were skipped or a verifier fallback was used, `minimal` means a
required non-verifier route is blocked, and `none` means no replayable council
run exists yet. A fallback like `verifier:gemini_cloud->openai_cloud` is useful
but should be read as reduced provider independence, not full multi-provider
agreement.
The estimated-threshold live diagnostic may report `completed_degraded` when
direct providers and the verifier succeed but the external platform council
record falls back to Andrea's local ledger. That is diagnostic-only evidence,
not a passing strict proof, a fully healthy platform handoff, or permission to
rerun repeatedly. The threshold does not meter provider billing.
When the external coordinator is intentionally disabled, Andrea's canonical
local ledger is reported as `platformRecordLocalRuntime=true` and is not a
degradation. Only an expected coordinator that fails to return a record is
classified as `platformRecordFallback=true`.

For pilot-mode and daily dogfooding specifically, also validate:

- `npm run debug:pilot`
- `npm run debug:learning`
- `npm run debug:skills`
- `npm run debug:improvement`
- `npm run debug:improvement -- --persist` only when intentionally recording
  one improvement generation; ordinary debug, shadow, and workbench inspection
  is read-only by default, and `--dry-run` overrides `--persist`
- `npm run debug:improvement -- --shadow`
- `npm run test:world-learning`
- `npm run test:memory-distillation`
- `npm run test:skill-library`
- `npm run test:learning-controls`
- `npm run test:learning-privacy`
- `npm run test:self-improvement`
- `npm run test:synthetic-gauntlet`
- `npm run test:shadow-improvement`
- one flagship ordinary-chat turn: `hi` or `what's up`
- one daily-guidance turn: `what am I forgetting`
- one Candace follow-through chain:
  - `what's still open with Candace`
  - `what should I say back`
  - `save that for later`
- one mission chain:
  - `help me plan tonight`
  - `what's the next step`
  - `what's blocking this`
- one work-cockpit chain:
  - `/cursor`
  - `Current Work`
  - one reply-linked continuation
- one knowledge-library turn:
  - `use only my saved material for ...`
  - or `save this to my library: ...`

If something feels off during pilot use, capture it explicitly with one of these shared assistant phrases:

- `this felt weird`
- `that answer was off`
- `this shouldn't have happened`
- `save this as a pilot issue`
- `mark this flow as awkward`

Main-control-chat feedback loop:

- substantive Andrea replies in the registered main Telegram control chat can also show `Not helpful`
- tapping it saves a private `downvoted_response` pilot issue and offers `Start fix`, `Why`, and `Not now`

## Shadow-Mode Improvement Checks

The v27 Shadow-Mode Improvement Runner turns v26 hypotheses into before/after eval evidence. It is Plan + Eval only: it can select low-risk repo-side candidates, run the synthetic-user gauntlet, compare baseline versus candidate-plan scores, and create patch reports for human review. It must not apply patches, create worktrees, restart services, mutate live integrations, commit, push, send messages, write calendars, change credentials, or learn synthetic data as confirmed user memory.

Use this ladder when evaluating improvement work:

- `npm run debug:improvement -- --dry-run`
- `npm run debug:improvement -- --shadow --dry-run`
- `npm run debug:agentic`
- `npm run test:synthetic-gauntlet`
- `npm run test:shadow-improvement`

Expected outcome: external/manual proof debt such as Telegram user-session credentials, Alexa signed `IntentRequest` proof, and BlueBubbles same-thread proof stays classified as proof debt. Repo-side candidates may get patch reports, but implementation still requires an explicit human/Codex coding pass and the normal validation gate.

## Approval-Gated Patch Workbench And Live Proof Gauntlet

The v28 patch workbench is the first approval-gated bridge from shadow reports to isolated patch evaluation. Its default mode is still dry-run: it records candidate workspaces, patch attempts, patch reviews, git safety, and proof-debt separation without modifying main.

Use this ladder:

- `npm run debug:improvement -- --workbench --dry-run`
- `npm run improvement:patch-plan`
- `npm run improvement:patch-dry-run`
- `npm run debug:proof-gauntlet`
- `npm run test:reality-grounding`
- `npm run test:active-perception`
- `npm run test:truth-maintenance`
- `npm run test:patch-workbench`
- `npm run test:proof-gauntlet`

Only explicitly requested low-risk workspace commands may prepare a local candidate branch/worktree. The default allowlist is docs, debug/status copy, eval additions, harmless wording, synthetic-gauntlet/report formatting, operator report formatting, and proof-debt wording clarity. Message sending, calendar writes, credentials/auth, restarts/deploys, destructive operations, privacy/memory behavior, runtime execution behavior, and approval gates are blocked by default.

The first real patch recipe is `proof-debt-report-clarity`; it writes a docs/report artifact inside an isolated candidate workspace. It does not change routing, providers, message sending, calendar writes, credentials, services, runtime behavior, or approval gates.

The live proof gauntlet separates proof debt from repo bugs:

- missing Telegram user-session env is `missing_config`, not a repo failure
- missing Alexa signed `IntentRequest` is manual proof debt
- missing BlueBubbles same-thread message-action proof is live proof debt
- provider quota/billing blockers remain external/provider blockers
- repeated failure after config/proof prerequisites are present may become a repair hypothesis

Reality Grounding sits above proof gauntlet and world/truth metadata:

- `debug:reality` answers what is observed, believed, stale, contradicted, blocked, or unknown right now
- `debug:perception` shows request-coupled read-only probes and manual proof steps; it must not run uncontrolled polling
- `proof:guided` lists exact proof-closure steps and must never print secrets
- stale proof and missing config create verification/proof tasks first, not repo patch hypotheses
- durable or external actions should be staged or clarified when reality confidence is too low

The live dogfood gauntlet exercises real-world-feeling requests through existing
routers in operator-safe mode:

- `npm run dogfood:live` runs ten natural scenarios such as next action, forgetting,
  texting status, tonight planning, reply help, calendar ambiguity, self-fix, and
  confidence checks
- it may record metadata-only pilot outcomes, but these are marked as
  operator-safe dogfood and do **not** count as live proof closure
- it never sends messages, writes calendars, restarts services, pushes code,
  changes credentials, or mutates live integrations
- `npm run test:dogfood-gauntlet` checks scoring, proof classification, privacy,
  and consistency with proof/capability/reality truth

When this Mac host must restart Andrea after a validated repo change, use:

```bash
npm run build
npm run mac:services:restart
npm run mac:services:status
npm run services:status
```

Require a changed process identity/PID, matching ready/health PIDs, verified
build provenance, and the expected serving commit. The current boot-ID marker
is not an authoritative independent restart proof, so do not accept it alone.

Hierarchical Goal Planning sits above Reality Grounding and Cognitive Executive:

- `debug:goals` shows proposed/active/blocked goals, milestones, steps, causal beliefs, counterfactual comparisons, opportunities, and the next safe action
- `debug:planner` runs one request through the goal-directed planner
- `debug:opportunities` shows reply-coupled opportunities and suppression state
- `test:goal-planning`, `test:causal-planner`, and `test:proactive-opportunities` are the focused v30 gate
- goals do not replace missions, reminders, skills, follow-through reviews, communication companion, or improvement lab; they orchestrate those existing systems
- sends, calendar writes, restarts, commits, pushes, purchases, deletes, and credentials remain approval-gated

Never treat proactive opportunities as background autonomy. They are normal-reply suggestions only.

Metacognitive Workspace sits above the Cognitive Executive and Goal Planner:

- `debug:working-memory` shows the current bounded working-memory frame, selected context, ignored context, focus reason, freshness, confidence, and next safe action
- `debug:metacognition` shows the selected reasoning mode, confidence calibration, warnings, and recent strategy signals
- `debug:deliberation` shows candidate routes, critic objections, final recommendation, fallback, approval boundary, and confirms hidden reasoning is not stored

All ordinary `debug:*` state inspection is read-only by default. For the
goal/planner, opportunity, working-memory, metacognition, deliberation,
blackboard, capability, reality, perception, agentic, improvement, and patch
workbench reports, add `-- --persist` only when intentionally recording a
diagnostic generation. `--dry-run` and the legacy `--no-persist` override
persistence. Explicit `--apply`, `--execute-*`, baseline-save, retention, and
live-proof modes remain separately named mutations and keep their own approval
or safety gates.

- focused v31 gate: `test:working-memory`, `test:metacognition`, `test:deliberation`, and `test:confidence-calibration`
- natural checks such as `are you sure?`, `what context are you using?`, `think harder`, and `don't overthink it` should affect mode/confidence without bypassing existing approval gates

The v32 General Intelligence Control Plane sits above all of it:

- focused v32 gate: `test:autonomy`, `test:action-lifecycle`, `test:action-preflight`, `test:blackboard`, `test:episodes`, `test:capabilities`, `test:strategy-evals`, and `test:agi-gauntlet`
- `debug:agi-readiness` runs the ten-scenario whole-assistant gauntlet against an isolated synthetic database by default; its score is a bounded-readiness signal, never an AGI claim
- `debug:agi-lab` combines proof freshness, integration health, intelligence regression stability, council quality, cognitive trajectory, pilot feedback, and improvement-pipeline readiness into one metadata-only promotion gate
- every action intent carries an autonomy level (0–7); levels 5+ always require explicit approval, level 6 adds operator context, level 7 is never executed
- the action preflight composes critic review, autonomy policy, reality/truth state, and tool reliability into one verdict; the strictest signal always wins and nothing in v32 executes side effects itself

Never claim `live_proven` from harness-only evidence. Mainline changes remain human-governed; the workbench does not auto-merge, auto-push, restart services, send messages, write calendars, change credentials, or mutate live integrations.

- queued remediation prefers Codex local, then Codex cloud, then Cursor Cloud
- if the miss is primarily an external blocker or manual sync step, Andrea should keep the issue saved and explain that honestly instead of auto-starting a repo fix
- local hotfixes may validate and restart on-host, but commit/push still require explicit approval

Important pilot-mode limits:

- pilot issue capture is explicit only; Andrea does not silently file issues
- raw transcripts are not stored in pilot instrumentation
- `degraded_but_usable` means Andrea stayed useful on a bounded fallback path and should be treated as a refinement target, not a clean live-proof pass
- set `ANDREA_PILOT_LOGGING_ENABLED=0` on a host if you need to disable pilot journey logging and explicit issue capture entirely

If BlueBubbles is configured on that host, add:

- one real inbound BlueBubbles message
- one real reply back into that same BlueBubbles conversation
- one safe companion flow such as `what am I forgetting`
- one same-thread message-action decision such as `send it` or `send it later tonight`
- one explicit BlueBubbles -> Telegram handoff if you are validating cross-channel continuity
- one explicit communication-companion flow such as:
  - `summarize this`
  - `what should I say back`
  - `what do I owe people`
  - `remind me to reply later`

If you are validating chief-of-staff behavior on the live host, add:

- `what matters most today`
- `what am I forgetting`
- `what should I remember tonight`
- `what should I do next`
- `why are you bringing that up`

Preferred proof shape:

- one concise Alexa chief-of-staff answer
- one richer Telegram chief-of-staff answer
- one explainability turn
- one daily-companion answer that still shows the shared chief-of-staff read

If you are validating the closed-loop review layer on the live host, add:

- `daily review`
- `what got done today`
- `what slipped`
- `what am I carrying into tomorrow`
- one review control such as `Mark handled` or `Remind tomorrow`
- one person-scoped follow-through question such as `what's still open with Candace`

Preferred proof shape:

- one loop that is honestly `partial` or `deferred`
- one review answer that surfaces it clearly
- one control that changes the carryover state without deleting the source

If you are validating delegation rules on the live host, add:

- one natural rule-creation ask such as `do this automatically next time`
- one confirmation turn where Andrea previews the rule before saving it
- one second flow where the saved rule fires on a safe action
- one explainability turn such as `why did that fire`
- one override turn such as `always ask before doing that`

Preferred proof shape:

- one safe delegated default is reused without mystery
- one guarded action still asks despite a related rule existing
- one review or outcome surface shows that a rule fired

## 6. Cursor Validation

### Cursor Cloud Validation

Only run this if `CURSOR_API_KEY` is configured.

Expected meaning:

- `Cloud coding jobs: ready` means Cursor Cloud queued heavy-lift workflows are ready now

Run:

- `/cursor_status`
- `/cursor-create --repo https://github.com/rupret007/Andrea_NanoBot --ref main Reply with exactly: live cloud smoke ok. Do not modify files, branches, or PRs.`
- reply to the fresh Cursor task card with plain text
- tap `Refresh`
- tap `View Output`
- `/cursor`
- tap `Current Work`
- `/cursor-conversation current 5`
- tap `Results` when the provider has produced files

Check:

- the direct task card keeps the authoritative Cursor id visible
- reply-to-card continuation stays on the same Cursor task
- direct `/cursor-*` replies point back to exact-id fallbacks when needed
- if `current` points at a stale Cursor task, Andrea clears that selection honestly instead of cross-routing the turn

Optional if safe:

- `/cursor-followup <agent_id|current> ...`
- `/cursor-stop <agent_id>` on a disposable job only

### Desktop Bridge Validation

Only run this if all of these are configured:

- `CURSOR_DESKTOP_BRIDGE_URL`
- `CURSOR_DESKTOP_BRIDGE_TOKEN`
- a live bridge process on your normal machine

Expected meaning:

- `Desktop bridge terminal control: ready` means operator-only session recovery and line-oriented terminal control are ready
- `Desktop bridge agent jobs: conditional|unavailable` means desktop terminal control can still be real while local queued desktop-agent execution is not the baseline promise on that machine

Run:

- `/cursor_status`
- `/cursor`
- tap `Jobs`
- tap a desktop session
- tap `Sync` if a recoverable session exists
- `/cursor-terminal <agent_id> echo operator smoke ok`
- tap `Current Work` or `Current Job` -> `Terminal Status`
- tap `Current Work` or `Current Job` -> `Terminal Log`
- `/cursor-terminal-stop <agent_id>` if appropriate

Do not confuse desktop bridge readiness with Cursor Cloud readiness.

## 7. Codex/OpenAI Runtime Validation

Only run a live runtime acceptance pass if all of these are true:

- `ANDREA_OPENAI_BACKEND_ENABLED=true` in NanoBot
- `ANDREA_OPENAI_BACKEND_URL=http://127.0.0.1:3210`
- `npm run services:status` shows:
  - `runtime_backend_health=healthy`
  - `runtime_backend_local_execution_state=available_authenticated`
  - `runtime_backend_auth_state=authenticated`
- the registered main chat is healthy in Telegram

If the backend is reachable but `runtime_backend_local_execution_state=available_auth_required`, stop and do the real Codex login step on the host running `Andrea_OpenAI_Bot`. Do not treat that as a generic runtime failure.

Run:

- `/runtime-status`
- `/runtime-create Append the exact text <PROOF_LINE> on a new line at the end of proof.txt in the current workspace. Do not change anything else.`
- `/runtime-job <jobId>`
- `/runtime-logs <jobId> 60`
- reply directly to the fresh runtime card with one safe follow-up
- `/cursor`
- tap `Current Work`
- tap `View Output`

Check:

- the runtime card keeps the authoritative backend `jobId` visible
- no `Not logged in` failure appears
- the proof file actually changes on disk
- reply-to-card continuation stays on the same runtime thread when available
- `/cursor` shows the live runtime task as `Current Work` while it is active
- `Current Work -> View Output` still works even after the runtime task finishes

## 8. Alexa Validation

Only run a real Alexa acceptance pass if all of these are configured:

- a supported Node runtime (`>=22 <23`) on the host; the repository and CI pin
  22.22.2 through `.nvmrc`
- `ALEXA_SKILL_ID`
- local Alexa listener config
- local Andrea OAuth config:
  - `ALEXA_OAUTH_CLIENT_ID`
  - `ALEXA_OAUTH_CLIENT_SECRET`
  - `ALEXA_OAUTH_SCOPE`
- HTTPS ingress or tunnel
- Alexa console skill endpoint
- Alexa console Authorization Code Grant account linking
- a valid Andrea group for the OAuth target `groupFolder`

If any of those are missing, record Alexa as **code-ready but setup-blocked** instead of failing the release gate for missing external setup.

Status-led closeout rules:

- Read `npm run services:status`, `npm run integrations:status -- --json`, and
  the integration-specific debug command immediately before making a live
  claim. Documentation is not a durable proof ledger.
- In the JSON integration report, `summary.stateCounts` is the exhaustive,
  mutually exclusive arithmetic over all status rows and must sum to
  `summary.total`. `actionNeeded`, `needsProof`, and `manualOrExternal` are
  overlapping operator convenience counters; never add them together or use
  their sum as a readiness denominator.
- A healthy Telegram transport is not an end-to-end reply proof; run
  `npm run telegram:user:smoke` only when a real `/ping` send to the registered
  Telegram chat is authorized.
- Alexa listener, OAuth, public ingress, and pinned Node 22 can be healthy while Alexa proof is still `manual_action_required`; do not claim Alexa `live_proven` until a fresh handled custom-skill proof lands
- after restart, operator surfaces may credit that Alexa proof either from the persisted handled signed-request markers or from a recent same-host `alexa_orientation` pilot success that already recorded the qualifying handled turn
- if the repo Alexa model changed, the remaining release-candidate step is to import `docs/alexa/interaction-model.en-US.json`, run `Build Model`, and then run `npm run setup -- --step alexa-model-sync mark-synced`
- if `npm run services:status` later shows `alexa_live_proof=near_live_only`, the remaining Alexa blocker is one human-operated voice or authenticated simulator run
- BlueBubbles transport, webhook registration, recent-activity polling, and
  canonical same-thread `message_action` proof are separate checks. Claim
  `live_proven` only when the current status command reports a fresh complete
  chain.
- Research and image generation are live only when their dedicated current
  probes pass. Provider configuration or cached health alone is insufficient.
- if the Anthropic-compatible LiteLLM gateway degrades later, report that separately as the core-runtime compatibility lane rather than as a direct OpenAI billing problem
- typed Alexa+ app chat is not an authoritative proof surface unless Andrea logs a real signed follow-up `IntentRequest` after launch
- interaction-model changes require a fresh import of `docs/alexa/interaction-model.en-US.json` plus `Build Model` in the Alexa Developer Console before live utterance failures count against the repo
- after this model update, re-test at least one simple local ask like `what's up` or `what time is it` and one broad routed ask like `what should I say back`, `what bills do I need to pay this week`, or `help me figure out tonight`
- if live voice still falls into `AMAZON.FallbackIntent` after that rebuild, use the Alexa Developer Console Utterance Profiler or Intent History to capture the exact recognized phrase before changing repo code
- `npm run debug:daily-companion` is the local pinned-Node smoke path for comparing canonical daily-companion prompts like `what am I forgetting` or `what's still open with Candace` against real `groupFolder=main` data
- `npm run debug:alexa-conversation` is the repo-side pinned-Node harness for checking Alexa-style follow-ups like `anything else`, `what about Candace`, `remember that`, `why`, or `be a little more direct` against the real local routing stack before blaming the live voice surface
  - include practical assistant turns like `what's on my calendar tomorrow`, `remind me to take my pills at 9`, `what bills do I need to pay this week`, `add dinner with Candace tomorrow at 6:30 PM`, `move dinner to 7`, `what's up`, `what time is it`, `what about that`, `what should I say back`, `help me plan meals this week`, and `save that` when validating recent Alexa router changes
  - `npm run debug:alexa-conversation -- --review` now groups Alexa misses by blocker class, including no-context references, follow-up binding failures, and communication/planning should-route misses

Dogfood handoff for this week:

- Use daily this week:
  - calendar
  - reminders / save-for-later
  - groceries / errands / bills / meals
  - daily guidance
  - reply help
  - household follow-through
- Manual steps still remaining:
  - import `docs/alexa/interaction-model.en-US.json` in the Alexa Developer Console if the console model is not current
  - run `Build Model`
  - run `npm run setup -- --step alexa-model-sync mark-synced`
  - run one fresh Alexa daily-guidance turn: `Open Andrea Assistant` then `What am I forgetting?`
  - run one fresh Telegram daily-guidance turn: `what am I forgetting` or `what should I remember tonight`
- Recheck rather than assume:
  - outward research and image generation may be live, provider-blocked, or
    stale; use their dedicated current probes
  - the local Anthropic-compatible gateway is a separate compatibility lane
    whose quota and transport state must be reported independently
- Watch for during dogfooding:
  - awkward wording
  - repeated phrasing
  - weak confirmations
  - household smart-view usefulness
  - save/remind/handoff clarity

When configured, validate in this order:

1. `npm run services:status` and confirm `alexa_listener_health=healthy` plus `alexa_oauth_health=healthy`
   - also note the `alexa_last_signed_request_*` fields before the attempt
2. `/alexa-status`
3. public `GET /alexa/oauth/health`
   - if the live host is an `ngrok` `*.ngrok-free.dev` tunnel, use the `ngrok-skip-browser-warning: 1` header for browser-style checks
   - if the skill endpoint uses that host, confirm the Alexa console SSL setting is the wildcard-certificate option
4. authoritative voice launch
   - use a **real device** or the **authenticated Alexa Developer Console simulator**
   - say `Open Andrea Assistant`
   - then say `What am I forgetting?`
   - for the practical assistant lane, also test at least:
     - `What's on my calendar tomorrow?`
     - `Add dinner with Candace tomorrow at 6:30 PM`
     - `Move it to 7`
     - `Remind me at 4 to text Candace`
5. rerun `npm run services:status`
   - success:
     - `alexa_last_signed_request_type=IntentRequest`
     - `alexa_last_signed_intent=WhatAmIForgettingIntent`
     - `alexa_last_signed_response_source=` a handled source such as `local_companion`
     - `alexa_live_proof=live_proven`
     - `alexa_live_proof_kind=handled_intent`
     - `alexa_live_proof_freshness=fresh`
   - stale:
     - `alexa_live_proof=near_live_only`
     - `alexa_live_proof_kind=handled_intent`
     - `alexa_live_proof_freshness=stale`
   - partial / missing:
     - `alexa_last_signed_request_type=none`
     - `alexa_last_signed_request_type=LaunchRequest`
     - `alexa_last_signed_response_source=received_trusted_request`
     - `alexa_last_signed_response_source=barrier`
     - `alexa_last_signed_response_source=fallback`
6. if the proof still does not upgrade, check in this order:
   - stale interaction model -> re-import `docs/alexa/interaction-model.en-US.json` and run `Build Model`
   - endpoint/account-link mismatch
   - signed request never reached the current host

## 9. Research And Media Validation

Run this when research orchestration, Telegram research rendering, or media capability wiring changes.

Pinned-Node smoke path:

```bash
npm run debug:research-mode -- --live
```

This is an intentional live provider and image proof, not a deterministic or
cost-free validation command. The default command remains read-only.

Expect:

- one clearly local-context research result
- one outward-facing research result that either uses OpenAI-backed synthesis or reports the exact blocker honestly
- an explicit route explanation in the output
- `media.image_generate` either returns a Telegram-deliverable artifact or reports the exact provider blocker honestly

Important truth:

- OpenAI-backed research is only live when `OPENAI_API_KEY` is configured and the provider account has usable quota/billing
- do not infer current provider health from configuration or an older proof;
  the dedicated live research probe must succeed in the current validation
  window before the path is reported as live
- `web_search` is in scope for research; file search is not promised unless separate file-search plumbing is added
- Telegram is the rich research and media surface
- Alexa should stay concise and use handoffs when the result is too long or not voice-safe

## 10. Shared Capability Graph Validation

Use this when the shared assistant core changes:

1. Run:
   - `npm run debug:shared-capabilities`
2. Confirm:
   - Telegram daily guidance runs through the shared graph
   - Alexa household guidance runs through the shared graph
   - research returns a bounded voice-safe answer on Alexa
   - Telegram gets the richer research shape
   - `work.current_logs` remains blocked on Alexa and allowed only on the Telegram/operator side

If `OPENAI_API_KEY` is configured and the provider account is usable, a comparative or outward-facing research prompt may use the OpenAI Responses path. If it later becomes missing or quota-blocked again, the shared research proof should report that blocker honestly instead of pretending the external answer is live.

Check:

- concise spoken output
- one clarification at a time
- daily guidance sounds specific and useful, not generic
- no personal data without linking
- no Telegram/operator wording leaks
- no fake calendar or reminder content

## 11. Cross-Channel Handoff Validation

Run this when Alexa-to-Telegram continuation, voice-triggered save flows, or companion action completion changes.

Pinned-Node proof harness:

```bash
npm run debug:cross-channel-handoffs
```

Expected proof points:

- one research handoff reaches Telegram
- one knowledge-detail handoff reaches Telegram
- one media handoff records artifact delivery
- one voice-triggered save-to-library flow completes
- one voice-triggered reminder completion creates a scheduled task

Important truth:

- handoffs are explicit, not background pushes
- only the registered main Telegram chat is used as a handoff target
- work cockpit and other operator-only flows stay out of Alexa
- failed delivery must surface honest blocker text instead of pretending the continuation was sent

### Optional Amazon Validation

Only run this if Amazon Business credentials are configured.

Run from the main control chat:

- `/amazon-status`
- `/amazon-search ergonomic keyboard`

Optional if safe:

- `/purchase-request <asin> <offer_id> 1`
- `/purchase-approve <request_id> <approval_code>` only in trial mode or another intentionally disposable validation setup

## 12. Knowledge Library Validation

Run this when the Knowledge Library model, ingestion, retrieval, or source-grounded research behavior changes.

Focused tests:

```bash
node scripts/run-with-pinned-node.mjs ./node_modules/vitest/vitest.mjs run src/knowledge-library.test.ts src/research-orchestrator.test.ts src/assistant-capabilities.test.ts src/assistant-capability-router.test.ts
```

Pinned-Node proof harness:

```bash
npm run debug:knowledge-library

`debug:knowledge-library` always uses isolated in-memory storage. Its realistic
sample notes exercise save/import/retrieval/citation behavior but never enter
the live personal Knowledge Library, and its temporary import directory is
removed when the command exits.
```

Expected proof points:

- one explicit note saves into the library
- one approved local text file imports cleanly
- Telegram can summarize saved material with supporting sources
- Telegram can compare saved sources with provenance
- Telegram can list or explain the relevant saved items
- Alexa can produce a short saved-material summary without dumping source detail
- `use only my saved material` stays grounded in the library path

Important truth:

- the library is explicit/manual only in v1
- retrieval is lexical-first with FTS5, not embeddings-driven
- disabled or deleted sources must stop contributing to future answers
- the library stays distinct from memory, life threads, reminders, and current work

## 13. Restart And Verify

After meaningful runtime or operator-surface changes:

```bash
npm run build
npm run mac:services:restart
npm run mac:services:status
npm run setup -- --step verify
```

Important rule:

- run restart and verify sequentially, not in parallel
- require a changed process identity/PID, matching ready/health PIDs, verified
  build provenance, and the expected serving/build commit; the current boot-ID
  marker is not authoritative independent restart evidence
- a nonzero restart timeout is a failure, not permission to verify stale state
- `setup -- --step verify` is live and potentially billable; run it only with
  intentional credentials, cost awareness, and operator authorization

Then rerun a small live smoke:

- `/ping`
- `/mainchat`
- `/help`
- `/cursor_status`
- `npm run telegram:user:smoke`

The Telegram smoke command performs a real `/ping` send to the registered chat.
It is not a read-only transport check and requires explicit live-send authority.

For registration and recovery hardening, run:

```bash
npm run hardening:registration
npm run debug:providers
npm run test -- src/provider-expansion.test.ts src/provider-council-runner.test.ts src/turn-agent-harness.test.ts src/assistant-personalization.test.ts src/channels/telegram.test.ts
```

Then complete one live user-path proof in Telegram:

- run `/mainchat` in the main DM and confirm it says this chat is the registered main control chat
- run `/mainchat` in any other DM or chat you are testing and confirm it names the registered main
- ask `What's on my calendar tomorrow?` from the registered main DM

If the change touched direct work-lane commands, also rerun one live lane-specific proof:

- one `/cursor-*` proof that includes `current` plus one exact-id fallback
- one `/runtime-*` proof that includes `current` plus one exact-id fallback

If `/cursor_status` or a calendar ask still behaves like an unregistered shell, run `/mainchat` first, then compare the real DM against `registered_main_chat_jid`, `latest_telegram_chat_jid`, and `main_chat_audit_warning` in `npm run services:status` before assuming a code rollback.

Telegram live-testing truth:

- the dedicated Telegram smoke command is explicit and credentialed on purpose
- it is not part of the default unit/full suite
- it is the canonical proof that Telegram is actually replying end to end rather than only polling successfully

## 14. Failure Handling

### `CREDENTIAL_RUNTIME_PROBE: failed`

- rerun `npm run setup -- --step verify`
- check `CREDENTIAL_RUNTIME_PROBE_REASON`
- check `NEXT_STEPS`

### Cloud coding jobs unavailable

- `CURSOR_API_KEY` is missing, rejected, or not loaded
- fix `.env`
- restart
- rerun `/cursor_status`

### Desktop bridge terminal control unavailable

- `CURSOR_DESKTOP_BRIDGE_URL` and/or `CURSOR_DESKTOP_BRIDGE_TOKEN` are missing
- or the configured bridge is unreachable/unhealthy
- confirm the bridge process and tunnel
- restart Andrea
- rerun `/cursor_status`

### Runtime route unavailable

- treat it as optional unless you specifically want Cursor-backed runtime routing
- check 9router endpoint/auth/model settings separately from Cloud/desktop

## 15. Release Gate

Use this copy-pastable offline/exact-tree matrix before branch publication. Do
not add `--live`, credentials, channel sends, or production storage:

```bash
npm run check:node
npm run format:check
npm run typecheck
npm run lint
npm run test
npm run build
npm run container:install
npm run typecheck:agent-runner
npm run build:agent-runner
npm run test:agent-runner
npm run check:container-contract
npm run build:container
npm run check:container-canary
npm run check:container-mounts
npm run typecheck:agi
npm run test:agi
npm run test:continuity:hard-kill
npm run test:continuity:heldout
npm run test:real-world-intelligence:heldout
npm run test:novel-capability:certification-gate
npm run test:production-capability-apprenticeship:certification-gate
npm run test:stability
npm run test:deterministic:sweep -- --list
npm run test:deterministic:sweep
npm run certify:commitment-intelligence
npm run certify:novel-capability-mastery
npm run certify:production-capability-apprenticeship
npm run certify:life-thread
npm run certify:temporal-truth
npm run agi:scorecard -- --no-write --no-dogfood
npm run debug:signature-flows
npm run docs:check
npm audit --omit=dev --audit-level=high
npm audit --audit-level=high
npm --prefix container/agent-runner audit --omit=dev --audit-level=high
npm --prefix container/agent-runner audit --audit-level=high
git diff --check
git status --short
```

The focused durable and containment suites above are additional required gates;
the deterministic sweep's 112-script inventory does not substitute for AGI
tests, container canaries, audits, or hosted scanners. Review `git status`
manually for generated artifacts, unexpected files, and secret-like values.

Before pushing a release:

1. `npm run test:major:ci` passes without using live credentials.
2. The runner typecheck/build/tests, host container contract, image canary, and
   isolated mount canary pass.
3. AGI typecheck/tests, deterministic sweep and stability rounds, held-out
   execution truth, the production-apprenticeship certification when that
   lifecycle changes, offline scorecard, signature flows, docs checks, and
   dependency audits pass.
4. Docs and help surfaces match the changed behavior, and final diff,
   whitespace, generated-artifact, and secret reviews are clean.
5. A fresh remote fetch proves `main` is non-diverged and its ancestry has not
   changed since the candidate review.

For a review branch, publish a coherent reviewed commit and require its normal
CI, container, AGI, and CodeQL checks plus any focused invariants for the
changed boundary. Branch publication is not a production release and cannot
satisfy the main-only security gate. After an authorized merge or direct-main
release, use the resulting `main` commit—not a pre-merge branch SHA or GitHub
pull-request merge preview—for push-job, security-scan, build-provenance, and
production evidence.

After publishing the final release commit on `main`:

1. Require the Ubuntu, Windows, container, AGI, CodeQL, dependency-audit,
   secret-scan, and Semgrep jobs for the exact release SHA.
2. Build from that committed SHA and verify clean provenance before stopping a
   service.
3. Restart in dependency order and require a changed process identity/PID,
   ready/health PID agreement, verified build provenance, and a serving SHA
   that matches the release commit. Do not use the current boot-ID marker as
   authoritative independent proof.
4. Run only the operator-host and optional-integration probes authorized for
   that release. `setup -- --step verify` is live, potentially billable, and
   not implied by the offline gate.
5. Capture exact results, external proof debt, and caveats in the release notes
   or delivery summary without promoting missing operator evidence to success.
