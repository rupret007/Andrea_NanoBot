# Verified Capability Acquisition

Andrea's capability-acquisition layer is a fail-closed way to record a real
capability gap, compare resources already available to the application, compile
a bounded candidate, and prove its bounded sandbox behavior. The
released acquisition foundation alone intentionally stops before live
promotion: no caller-asserted canary, activation, or production outcome can
make a candidate active. Verified Production Apprenticeship adds the canonical
live path above that foundation, while preserving the same fail-closed joins
and separate owner decisions. Neither layer is a claim of AGI, unrestricted
self-improvement, or permission to install and run arbitrary instructions.

## What It Does

The acquisition record keeps one group-scoped, provenance-aware lifecycle for
an unmet outcome. It records:

- the target outcome, task family, required postconditions, and gap class;
- known and missing prerequisites;
- considered and selected resource references;
- risk, data-egress, cost, latency, and authority requirements;
- the immutable compiled candidate contract and exact resource versions;
- sandbox, held-out, canary, owner-review, and outcome evidence;
- a versioned transition history with idempotency keys and integrity digests.

An explicit live capability-learning request or learn-first turn may create the
initial observation. That turn boundary derives only bounded task-family,
route, scope, intent-fingerprint, resource-count, and provenance metadata. It
does not persist the request body, scope the acquisition, compile a candidate,
approve an action, execute a tool, or activate a skill. Direct callers of the
observation API must explicitly classify their payload as `derived_metadata`;
the API is not a raw request-ingestion surface.

The persisted head is a projection of its transition history. Reads rebuild and
verify the chain, and malformed JSON, identity drift, version drift, an illegal
transition, or a mismatched projection fails closed.

The state machine is deliberately explicit:

```text
observed -> scoped -> resource_discovery -> candidate_designed
         -> sandbox_ready -> sandbox_running -> sandbox_verified
         -> owner_review_required -> canary_ready -> active -> monitoring
```

`paused`, `quarantined`, `retired`, `externally_blocked`, `failed`, and
`indeterminate` preserve non-success truth. They are not alternate success
states. A quarantined candidate can only retire; remediation requires a new
reviewable contract instead of silently rehabilitating the old one.

`canary_ready`, `active`, and `monitoring` are reserved lifecycle states, not a
statement that a real promotion has occurred. Certification sandbox and replay
evidence stop at `sandbox_verified`. The separately labeled synthetic
preproduction preparation command may advance its canonical local candidate to
`owner_review_required` for inspection, but it creates no live canary, owner
verdict, approval, activation, or production-use evidence. The production
apprenticeship permits later real states only through its canonical
live/owner/durable/outcome/health/approval joins.

## Resource Broker And Research Boundary

The resource broker inventories existing assistant capabilities, verified
active playbooks, Agent OS tool cards, reliability evidence, and explicitly
supplied resources. It ranks compatible resources under task-family,
postcondition, input, risk, data-egress, authority, version, and health
constraints, then selects the smallest sufficient set when one exists. The
broker classifies the remaining gap; it does not execute a resource or create
authority.

External documentation and research are always untrusted data. The broker
stores a bounded, sanitized representation and source provenance, rejects
instruction-like or malicious content, and never turns prose from a document
into a system prompt, executable step, credential, approval, or tool binding.
Research may explain how a resource might work; only an existing registered
binding can make a candidate executable.

## Exact Executable Bindings

A candidate compiles only when every executable step resolves to a registered,
version-pinned resource binding. Its contract binds:

- input and output schemas;
- binding, operation, evaluator, resource, and step identities;
- independent executor and evaluator declared identity/version digests;
- one closed durable action class per step;
- exact resource versions and allowed compatible versions;
- preconditions, postconditions, failure classes, and cleanup behavior;
- approval requirements derived from the action class;
- registered evaluators and evidence requirements.

Executor and evaluator implementations live in separate registry entries. A
declared identity/version digest mismatch invalidates the binding. These
digests are registry identity pins; they do not hash function bytes, closure
state, a binary artifact, or a signed manifest, so unchanged declarations
cannot attest to otherwise-hidden callback drift.

Descriptive playbooks, manifests, documentation, or model text without a stable
binding remain non-executable. A matching skill preview is a proposal, not an
execution receipt, and cannot increase reliability or usage evidence.

## Sandbox, Canary, And Activation

Sandbox execution resolves only the bindings in the immutable contract. Before
any effect, Andrea binds the acquisition to canonical durable work, a committed
checkpoint, owner/chat/group/channel/target scope hashes, the complete plan, and
the exact input digest. It preflights every step, records a canonical `started`
effect receipt before invocation, and records terminal post-state and
verification fingerprints only after the independent evaluator and cleanup
succeed. Protected steps also require the matching canonical approval packet,
consumed grant, and active lease. An attempted effect with uncertain outcome is
not replayed blindly, and a changed input or scope cannot borrow an old receipt.
If a process stops after committing the completed checkpoint but before durable
work completion, restart recovery validates the checkpoint's exact
parent-checkpoint receipts, finishes the durable verification transition, and
does not invoke the effect again.

This sandbox is a trusted in-process certification harness over disposable
state, with parent and child non-loopback denial and provider suppression. It
is not an OS isolation or hostile-code boundary. Test-authored task-family
adapters and evaluators are inside the trusted lab; untrusted documents cannot
register callbacks.

Promotion remains evidence- and owner-gated:

1. deterministic sandbox execution must verify its postcondition with
   non-loopback network denial and no unauthorized or duplicate effects;
2. independently authored held-out cases must pass every safety invariant;
3. a real canary must use fresh dependency health and completed canonical
   durable-work receipts;
4. a confirmed canonical outcome, exact owner-review signal, and exact-scope
   activation approval must be joined atomically before activation.

Steps 3 and 4 are implemented by the Verified Production Apprenticeship as
canonical database-backed joins. APIs still reject caller-supplied evidence
that is disconnected, stale, cross-scope, cross-version, unapproved, or missing
its active lease. The deterministic apprenticeship proof uses labeled synthetic
owner fixtures and cannot create genuine owner evidence or a live activation.

The production bridge is specified in
[Verified Production Apprenticeship](VERIFIED_PRODUCTION_APPRENTICESHIP.md).
It keeps exact canary authorization, the owner's verdict on the
completed canary, and later activation approval as three distinct decisions;
defines the canonical evidence join and monitored-reuse boundary; and requires
pause, quarantine, revocation, and historical negative evidence to remain
enforceable. Its 22/22 synthetic certification is repository evidence, not a
claim that any of those production states occurred through real owner use.

Isolated certification fixtures can exercise the full repository state machine,
including synthetic owner-review and activation branches, but remain labeled,
disposable, and incapable of activating a production capability, creating a
genuine owner-reviewed outcome, or counting as a live learning baseline.
Negative owner outcomes quarantine a candidate according to the production
policy, and any safety, privacy, stale-state, approval, or verification
violation blocks promotion.

## Authority And Privacy

Capability acquisition grants **no new authority**. A candidate, successful
sandbox, canary, active skill, high reliability score, or model confidence
cannot approve its own action. External sends, calendar writes, purchases,
canonical repository changes, deployments, migrations, dependency changes,
deletions, and other protected effects keep their existing fresh, exact-scope
approval requirements. The only unapproved file-write class is a certification
sandbox write inside an exactly marked disposable root under the system
temporary directory; it cannot target the canonical repository or become a
production action.

Durable records keep bounded metadata, opaque references, hashes, and redacted
structured evidence. They do not store raw research bodies, messages, prompts,
tool output, credentials, approval secrets, or private paths. HTTP(S) source
references retain a sanitized host/port and hashed path; local, `file:`,
Windows, UNC, traversal, and unknown-scheme references are reduced to opaque
hashes. Group scope and
source provenance remain part of the acquisition identity and every executable
scope.

## Operator Commands

Inspect the metadata-only ledger without changing capability state:

```bash
npm run debug:capability-acquisition
npm run debug:capability-acquisition -- --json
npm run debug:capability-acquisition -- --group main
```

Run the focused policy and acquisition tests:

```bash
npm run test:novel-capability:certification-gate
npm test -- src/capability-acquisition-ledger.test.ts \
  src/capability-binding-integrity.test.ts \
  src/capability-execution-guard.test.ts \
  src/capability-resource-broker.test.ts \
  src/turn-capability-acquisition.test.ts \
  src/verified-capability-acquisition.test.ts
```

Run the strict deterministic certification:

```bash
npm run certify:novel-capability-mastery
```

The strict certification is offline and disposable. It suppresses provider
credentials, denies non-loopback network access in the parent and spawned
processes, separates public tasks from private oracles, runs ten named primary
and fifteen structurally separate held-out scenarios through production
acquisition APIs, verifies restart and cleanup behavior, and exits nonzero for
a missing scenario, partial result, false success, authority violation, privacy
leak, residue, or unclassified failure. The companion policy gate mutation-
tests the evidence parser so incomplete or fabricated reports cannot pass. A
pass is bounded repository evidence only; it is not live-provider,
production-runtime, owner-acceptance, activation, or AGI evidence.

The current strict result is 25/25: ten primary plus fifteen held-out cases.
The policy gate also passes 88 report mutations spanning all 31 failure codes.
A fresh adapter and worker rehydrate the canonical learned CLI contract;
operation-discovery calls fall from 2 to 0 and total calls from 4 to 2 with
equal correctness and safety. Provider calls, cost, network escapes, and
isolated or production residue are all zero. This is deterministic randomized
lifecycle/framework integration evidence through production acquisition APIs,
not proof that Andrea autonomously generalizes to every unfamiliar task.

## Deliberate Limits

- No arbitrary package installation, code execution, provider enrollment, or
  credential acquisition is implied.
- No model may synthesize a binding or verifier from untrusted prose.
- No production candidate becomes active from synthetic evidence or an
  automatic review. Certification sandbox/replay evidence stops at
  `sandbox_verified`; the labeled preproduction preparation path may stop at
  `owner_review_required` but supplies no genuine review or later authority.
- Live canary, activation, and production learning fail closed unless their
  canonical atomic evidence join verifies every required record.
- The release-readiness-brief implementation and deterministic certification
  exist; its genuine owner canary, verdict, activation approval, and monitored
  semantic reuse remain operator proof debt, not current live evidence.
- Any active capability must remain within its compiled action, network,
  data-egress, approval, version, and declared identity/version-digest
  boundaries.
- Synthetic resource freshness comes from the canonical fixture resource-
  discovery observation. It is not persisted live provider-health evidence.
- Fundamental blockers and missing external prerequisites are reported
  honestly rather than relabeled as learned capability.
