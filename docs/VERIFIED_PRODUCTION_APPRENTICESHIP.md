# Verified Production Apprenticeship

> **Status: released implementation; genuine canary evidence pending.** Andrea
> implements the canonical canary, exact owner-review,
> separate activation, monitored reuse, pause, quarantine, revoke, and retire
> path described here. Its deterministic certification passes 22/22 scenarios,
> but that proof is synthetic, offline, network-denied, and disposable. It
> created zero provider calls, cost, external effects, production writes, or
> genuine owner evidence. Application commit `3dbfae9c` passed the complete
> local and exact-SHA hosted matrices and was rebuilt into the Mac service with
> verified provenance. This document therefore does **not** claim that a real
> canary ran, the owner reviewed one, or a capability was activated or reused.

Verified Production Apprenticeship is the implemented bridge between a bounded
method proved in Andrea's trusted certification sandbox and the same exact
method being used safely in the owner's real environment. It must produce real,
inspectable capability growth without letting a candidate approve itself,
borrow authority, activate from synthetic evidence, or hide negative outcomes.

The current acquisition foundation remains authoritative. The apprenticeship
must extend its evidence chain rather than create another workflow engine or a
parallel source of capability truth.

## Current Boundary And Target

Current repository behavior:

- explicit learn-first turns may record a metadata-only capability gap;
- resource discovery and candidate compilation remain bounded and reviewable;
- executable steps require registered, version-pinned bindings and independent
  evaluators;
- deterministic sandbox evidence plus the required structurally separate
  held-out certification may advance the aggregate acquisition projection to
  `owner_review_required`, while remaining explicitly synthetic;
- each sandbox or replay run is capped at `sandbox_verified`; neither the runs
  nor that synthetic aggregate state count as genuine owner or production
  evidence;
- caller-supplied canary, outcome, review, health, or approval identifiers do
  not open production transitions;
- a canary proposal can be staged only from the exact current candidate,
  trusted binding, normalized input, and fresh canonical health evidence; that
  staging creates its durable work, checkpoint, and still-pending packet;
- canary authorization consumes only the separately approved exact packet, and
  guided execution is exposed only for the bundled read-only, zero-egress
  Andrea Release-Readiness Brief contract;
- a canonical verdict can come only from a trusted owner chat or authenticated
  cockpit, and verified outcome review remains separate from activation;
- activation consumes another exact approved packet and grants no new action
  authority;
- active semantic reuse is wired only for narrow release-readiness questions on
  the registered main Telegram chat or configured Messages self-thread, with
  exact scope, version, health, lease, receipt, and independent verification
  checks on every run;
- pause, quarantine, revoke, retire, negative evidence, and version drift stop
  later matching or execution while preserving history.

These are implemented repository paths, not evidence that the owner has used
them. The current deterministic run contains zero genuine owner evidence, and
the repository does not manufacture a live canary or activation during setup or
certification.

The target is one conservative production loop:

```text
sandbox_verified
  -> owner_review_required
  -> exact canary authorization
  -> canary_ready
  -> one bounded canary and verified outcome
  -> exact owner verdict
  -> separate exact activation approval
  -> active
  -> monitored semantic reuse
  -> remain active | pause | quarantine | revoke | retire
```

Canary execution and owner verdict are evidence attached to the exact candidate
and canary. They are not additional success states that can be inferred from
tool text. A capability remains non-active until the complete activation join
commits.

## The Three Separate Owner Decisions

The production bridge must never collapse these decisions into one generic
approval or Helpful response.

### 1. Canary authorization

The owner authorizes one exact real-world experiment. The proposal must show:

- capability title, candidate fingerprint and version;
- exact target, inputs, operations, resources, and expected postcondition;
- data-egress, network, retention, cleanup, cost, and latency boundaries;
- every protected action and its existing approval requirement;
- what will not happen;
- how failure, uncertainty, interruption, and rollback will be handled.

This authorization permits only that canary. It does not activate general
reuse or waive approval for any protected effect.

### 2. Canary verdict

After durable work and independent verification finish, the owner judges the
same recorded outcome. Supported meanings remain distinct:

- `verified`: independently verified positive evidence for the exact outcome
  and the only verdict that may make a separate activation proposal eligible;
- `helpful`: useful positive learning evidence, but not verification and never
  activation-eligible by itself;
- `partial`: some value, but insufficient activation evidence;
- `corrected`: material correction required; negative learning evidence;
- `rejected`: wrong, unsafe, or not useful; negative learning evidence;
- `blocked`: an external prerequisite prevented a fair completion; neutral,
  non-success evidence.

The verdict must bind the canary, acquisition, outcome, candidate version,
owner identity, authorized private surface, creation time, and current review
revision. The guided owner surfaces accept an exact outcome for initial review
or re-review while its current run is `awaiting_owner_review`,
`owner_reviewed`, `awaiting_activation_approval`, `active`, `monitoring`,
`partial`, `blocked`, or `paused`. Re-review revises the same canonical review
record and learning sample. It does not manufacture a second outcome or metric.
A non-verified re-review pauses active use and invalidates linked authority; a
later verified re-review never resumes, activates, or reauthorizes it
automatically.

Only the registered main Telegram chat, configured BlueBubbles self-thread, or
private owner cockpit may provide an activation-eligible verdict. Another user,
another chat, stale feedback, a mixed request, a question, or a generic Helpful
response cannot verify a protected canary. Andrea must never generate its own
owner review.

### 3. Activation approval

A positive verdict answers, "Did the canary work?" Activation approval answers,
"May Andrea reuse this exact capability?" It must be a new decision made after
the outcome and verdict exist.

The activation proposal must show the exact candidate digest and scope,
trigger/task family, inputs, allowed operations, resources, postcondition,
fallback, approval rules, monitoring policy, and pause/revoke controls. Broad
phrases such as "activate everything" or "never ask again" are not valid
activation scope.

Activation recognizes one contract for matching and planning. It does not grant
new tools or action classes. External sends, calendar writes, purchases,
repository changes, deployments, migrations, dependency changes, installation,
deletion, and every other protected effect continue to require their normal
fresh exact-scope approval.

## Canonical Evidence Invariants

Every canary-readiness, owner-verdict, and activation state transition must be
reconstructed from authoritative records by its database-owned reconciliation.
Staging may create the durable work, checkpoint, and pending packet beforehand;
those records are prerequisites, not proof that authorization or activation
occurred. Callers may identify a record to inspect, but they may not assert that
its evidence is valid.

The join must prove all of the following:

1. The acquisition transition chain is intact and its head has the expected
   revision and legal state.
2. The immutable candidate contract, fingerprint, version, task family, action
   classes, bindings, evaluators, and resource versions still match.
3. The canary plan binds one exact normalized input digest, owner/chat/group/
   channel surface, target scope, durable work, checkpoint, plan version,
   invocation, and lease.
4. The exact canary authorization and, for protected effects, the exact approval
   packet/version/scope and consumed single-use grant belong to that work.
5. Every required effect receipt belongs to the same work, checkpoint, plan,
   input, target, node, invocation, binding, operation, evaluator, and resource
   version. Started effects have acceptable terminal truth.
6. Durable work is terminal and complete, with no pending, uncertain,
   duplicate, borrowed, or unverified effect.
7. The independent evaluator verified the compiled postcondition and required
   cleanup.
8. The canonical outcome belongs to that exact canary and candidate.
9. The latest owner review belongs to that same outcome and an authorized
   private owner surface.
10. Every required dependency has a fresh canonical health observation; a
    mutable health rollup or configuration flag is not sufficient evidence.
11. The separate activation approval belongs to the same candidate digest and
    scope.
12. No newer correction, rejection, revocation, quarantine, incompatible
    resource version, superseding candidate, or adverse health evidence exists.

The transaction must append the legal acquisition transition, update its
canonical projection, write exactly one canary or activation receipt, and
update subordinate skill projections atomically. An exact retry is a no-op. A
crash leaves either the old valid state or the new valid state, never a partially
active projection.

New relational records may bind existing acquisition, durable-work, checkpoint,
effect, outcome, approval, lease, review, and health evidence. They must not
copy those systems into an independent truth ledger.

## Canary Execution Contract

`canary_ready` must mean all of these conditions are true:

- sandbox and held-out evidence passed and the candidate remains current;
- the owner authorized one exact canary;
- target and action scope are fixed;
- dependencies are freshly healthy and required credentials are available
  without entering records, arguments, or diagnostics;
- durable work and its checkpoint are staged;
- any required single-use grant can be consumed;
- exactly one valid lease can own execution.

Before each effect, the runner must revalidate acquisition state, target,
health, approval, lease, input and candidate version, then record `started`.
Afterward it must record exact terminal truth, run the independent evaluator,
and preserve an unknown or indeterminate result. It must never blindly replay an
effect whose outcome is uncertain.

A completed canary requires completed durable work, receipts covering the
immutable plan, a verified postcondition, successful cleanup, and a canonical
outcome. Completion alone is not owner approval and cannot activate reuse.

## Active Reuse And Monitoring

An active acquisition-backed skill must execute its registered contract, not
stop at a title match or preview. Matching must consider task family, trigger
semantics, required inputs, target scope, postconditions, authority class,
channel, data-egress policy, resource health/version, prior monitored outcomes,
and calibrated confidence. Keyword overlap alone is insufficient.

Every reuse must re-check canonical acquisition state and contract version,
create durable work, execute only registered operations, record effect receipts,
verify the postcondition independently, and record an outcome. A stale or
paused projection cannot bypass the acquisition ledger.

Monitoring should record bounded structural metadata for:

- match confidence and whether the match was correct;
- selected resources and resource versions;
- discovery, planning, selection, execution, and evaluator calls;
- latency and cost when available;
- postcondition and outcome status;
- owner verdict, correction, rejection, or override;
- dependency health and version drift.

Initial canary and later reuse measurements must remain separate. Reduced
discovery or planning calls count as improvement only when correctness, safety,
and postcondition verification do not regress. Monitoring grants no additional
authority and must not store raw prompts, outputs, messages, secrets, private
paths, or provider content.

## Negative Learning, Pause, Quarantine, And Revocation

Positive evidence never erases negative evidence.

- A correction or rejection prevents activation for that evidence revision.
- One safety, privacy, approval, authority, or scope violation quarantines the
  contract immediately.
- An evaluator failure, indeterminate effect, cleanup failure, malformed
  receipt, or unreconstructable contract stops use and records the exact reason.
- Incompatible resource drift pauses matching pending revalidation.
- Stale or unhealthy dependencies pause or externally block use according to
  the cause.
- Repeated substantive negative owner outcomes or monitored failures pause or
  quarantine under the shared apprenticeship and routine policy.
- A quarantined contract cannot silently return to active. Remediation creates
  a new reviewable candidate version.

Pause or revocation must atomically stop new matches and grants, invalidate a
stale pending activation, disable subordinate projections, preserve truthful
in-progress work, and retain historical evidence. Revocation must not delete
the acquisition or unrelated skills merely to improve readiness scores.

## Owner-Facing Evidence

The private cockpit and trusted owner chats should eventually show the same
authoritative vocabulary and evidence:

- observed gaps, resource discovery, candidate and sandbox status;
- exact proposed canary and its authority/egress boundaries;
- canary work, receipts, evaluator result and outcome;
- missing or current owner review;
- exact activation proposal and decision;
- active capabilities and monitored reuse;
- negative outcomes, pauses, quarantine, revocation and retirement;
- why a transition occurred and what evidence is still missing.

Operator views may display redacted metadata, hashes, status and evidence IDs.
They must not expose raw conversations, prompts, tool output, credentials,
approval secrets, provider responses, or private paths.

## Certification And Genuine Proof

The strict deterministic apprenticeship certification exercises the complete
repository path with clearly labeled synthetic owner/event fixtures. It covers:

- valid atomic canary readiness and exact activation;
- naked-ID, cross-acquisition, cross-version and cross-scope rejection;
- stale health, approval mismatch, lease mismatch and version drift;
- interruption before an effect, after an effect, and after an outcome;
- exact owner-review binding and activation-approval separation;
- active semantic reuse and non-regressing reuse efficiency;
- correction, rejection, quarantine, revocation and concurrent activation;
- privacy, authority, idempotency and report-integrity mutation cases.

The certification remains offline, disposable, network-denied, zero-cost, and
incapable of creating live owner evidence. Run both the evidence-policy mutation
gate and the complete A-V scenario inventory:

```bash
npm run test:production-capability-apprenticeship:certification-gate
npm run certify:production-capability-apprenticeship
```

Current local result: 22/22 required scenarios passed. Provider calls, cost,
external effects, production writes, production metric writes, unauthorized or
duplicate effects, privacy leaks, genuine owner evidence, and cleanup residue
were all zero. The companion gate also rejected 120 report mutations spanning
all 22 defined failure codes. Parent and child non-loopback denial, provider-environment
suppression, metadata-only evidence, synthetic owner-fixture labeling, and
fixture cleanup passed. This proves bounded repository behavior only. It does
not prove a deployed SHA, a live provider, an owner-authorized canary, an owner
verdict, live or production activation, active runtime reuse, or improved
real-world usefulness. Isolated certification fixtures do exercise the
synthetic activation branch.

The guided operator command exposes inspection plus explicit, separate lifecycle
operations:

```bash
npm run capability:canary
npm run capability:canary -- --release-readiness
npm run capability:canary -- --acquisition ACQUISITION_ID
npm run capability:canary -- --help
```

Those forms are metadata-only and read-only. They list eligible acquisitions,
open production runs, exact contracts, resource snapshots, canonical health
observations, egress, authority and current state. `--release-readiness`
presents the bundled candidate contract; it does not build the brief, create an
acquisition, execute a binding, or create live evidence.

Preparation compiles that presentation through the canonical acquisition
compiler, which assigns compiler-owned capability and skill IDs and redacts
source references. Mutation commands therefore validate the complete compiled
contract, registered resource descriptor, binding/evaluator digests, schemas,
authority, egress, cost, postconditions, and compiler provenance. Matching a
presentation-only ID or fingerprint is not sufficient, and any broadened field
fails before trusted binding or staging is attempted.

The mutation phases are deliberately separate invocations:

1. `--stage` requires the exact acquisition head, group, owner/chat/channel,
   authorized surface, target, normalized input, and fresh health bindings. It
   creates only a bounded canary proposal and staged approval packet.
2. `--authorize-canary` consumes only that already-approved, current packet and
   exact run/acquisition revisions. The CLI cannot approve it.
3. `--run-canary` executes only the bundled read-only, zero-external-egress
   contract and
   records durable receipts, independent verification, and one canonical
   outcome. It makes no provider or external-state mutation.
4. The owner records `verified`, `helpful`, `partial`, `blocked`, `corrected`,
   or `rejected` only in a
   registered main Telegram chat, configured Messages self-thread, or the
   authenticated owner cockpit. The CLI cannot issue itself a trusted verdict;
   generic Helpful text and mixed requests do not count.
5. `--stage-activation` is available only after the exact verified owner review
   and creates a new activation packet. `--activate` consumes only that
   separately approved packet. Activation neither executes the capability nor
   approves any protected effect.

Every mutation requires explicit expected acquisition and run revisions and
revalidates scope, health, contract identity, versions, approvals, and the
trusted surface. Use `--help` for the exact arguments; do not copy stale IDs or
invent health expiry. Terminal input is never accepted as packet approval or
owner review.

On a registered trusted chat, use only the explicit parser forms shown by
Andrea when a target is ambiguous:

- `capability verdict: verified <run-id>` (or another supported verdict);
- `show evidence for capability <acquisition-id>`;
- `pause capability <acquisition-id>`, `revoke capability <acquisition-id>`,
  or `retire capability <acquisition-id>`.

Omitting the identifier is accepted only when exactly one canonical candidate
is eligible. These chat forms cannot approve a canary or activation packet.

`npm run capability:prepare-release-readiness` is a separate, explicit
preparation command. It uses network denial and provider suppression while
writing only synthetic preproduction acquisition evidence to the canonical
local ledger. It prepares or reuses the bundled candidate and a bounded local
resource-health observation; it creates no live canary, approval, owner verdict,
activation, provider call, external effect, or live evidence. Inspect its output
and current ledger head before any later operator action.

## First Candidate And Operator Proof Debt

The bundled first low-risk candidate is an **Andrea Release-Readiness Brief**:
a read-only, evidence-backed summary of repository state, serving provenance,
runtime and integration health, proof freshness, disk pressure, blockers and
next actions. Its evaluator must compare the brief with canonical status
surfaces and reject stale proof claims. Upstream ancestry and divergence in the
brief come only from the current local Git tracking refs; the brief does not
fetch a remote, prove hosted exact-SHA checks, or authorize a release.

Its exact contract, resource, deterministic preparation path, executor,
independent evaluator, guided lifecycle, and narrow active-reuse dispatch are
implemented. Preparation can create synthetic preproduction acquisition state
at `owner_review_required`; that state is not a real canary and cannot supply an
owner verdict. The post-release guarded preparation command recorded this
labeled synthetic state in the canonical ledger without creating a live
canary, approval, owner verdict, activation, provider call, or external effect.

Genuine production proof now depends on the owner supplying normal operator
evidence. Proof debt is:

- one exact owner-authorized read-only canary on a trusted owner surface;
- canonical durable completion, receipts, independent evaluation and outcome;
- the owner's exact verdict for that outcome;
- a separate exact activation decision;
- one later semantic reuse with monitored correctness and efficiency evidence;

Repository release evidence is complete for application commit `3dbfae9c`: CI
run `29434979875`, AGI/CodeQL run `29434979968`, and Security run `29435006959`
passed; the clean Mac artifact was rebuilt and restarted with aligned serving,
build, and workspace provenance. That evidence does not satisfy any item in the
genuine owner-proof list above.

Terminal input or fixtures supplied by the implementing agent cannot satisfy
owner proof. Until canonical evidence exists, status must remain
`owner_review_required`, `canary_ready`, awaiting owner review, blocked, or
pending as the actual ledger supports—never inferred `active`.

## Related Documentation

- [Verified Capability Acquisition](VERIFIED_CAPABILITY_ACQUISITION.md) defines
  the implemented acquisition foundation and current fail-closed boundary.
- [Assistant Capability Graph](ASSISTANT_CAPABILITY_GRAPH.md) defines the known
  action registry and why acquired contracts cannot expand it.
- [Durable Agency Plan](ANDREA_DURABLE_AGENCY_PLAN.md) defines work continuity,
  exact approvals, receipts and postcondition truth.
- [Outcome Tracking And Reviews](OUTCOME_TRACKING_AND_REVIEWS.md) describes the
  existing outcome and review surfaces.
- [Testing And Release Runbook](TESTING_AND_RELEASE_RUNBOOK.md) remains the
  authority for commands that actually exist and have been validated.
