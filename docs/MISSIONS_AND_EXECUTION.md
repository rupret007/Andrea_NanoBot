# Missions And Execution

Andrea now has a bounded `missions.*` layer for turning an explicit goal into a stored plan that can move forward across Alexa, Telegram, and BlueBubbles.

## Where This Shows Up In Signature Flows

Missions are the core of flows like:

- `help me plan tonight`
- `help me prepare for the weekend`
- `turn this into a plan`

The productized journey should feel like:

- Andrea proposes a readable plan
- names the blocker
- suggests one supporting action
- executes that action only after the user says yes
- keeps the same plan alive across Alexa, Telegram, and follow-through

Telegram is the default rich mission surface. Alexa should orient around the next step and blocker, and BlueBubbles should stay concise unless the user explicitly wants the fuller plan elsewhere.

## What Missions Are

Missions are not a second task manager.

They are a small planning layer over the systems Andrea already uses:

- chief-of-staff: what matters and why
- life threads: ongoing matters
- communication companion: people, replies, and open loops
- reminders: concrete nudges
- rituals: when something gets surfaced again
- knowledge library: saved supporting material
- current work: immediate execution pressure

A mission stores:

- title and objective
- category and scope
- status
- linked people, threads, reminders, current work, and saved material
- a short summary
- a suggested next action
- blockers
- a due horizon
- a small ordered step list
- whether the user has confirmed the mission as active

## Proposed vs Active

Explicit planning prompts like:

- `help me plan Friday dinner with Candace`
- `turn this into a plan`
- `help me prepare for tonight`

create a stored `proposed` mission immediately.

That gives Andrea continuity without waiting for a second turn, but proposed missions do not automatically become part of ongoing surfacing.

Only `active` or otherwise confirmed missions should start feeding broader carryover reads.

Useful controls:

- `save this plan`
- `activate this`
- `pause that plan`
- `close that plan`
- `mark this done`

## What Andrea Can Do

Mission synthesis stays bounded and explainable:

- short plan summary
- 3-5 practical steps
- blockers or missing information
- one sensible next move
- suggested supporting actions

Suggested supporting actions can reuse existing systems:

- create a reminder
- draft a follow-up
- save supporting material to the library
- link the mission to a life thread
- pin it into the evening reset
- start a research follow-up
- keep current work context attached

Durable actions still require explicit user intent such as:

- `do it`
- `remind me`
- `draft it`
- `save that`
- `track that`
- `start the research`

## Durable Cognitive Continuity

Meaningful code, research, operator, mission, or approval-gated work can be
projected into one canonical durable work unit. Existing mission, goal,
Runtime Spine, Agent OS, Cognitive Executive, and verified deep-work records
remain their own review surfaces; they link to the durable identity instead of
becoming competing workflow engines.

The durable record carries bounded metadata only:

- owner, chat, group, channel, executor, and exact target-scope hashes;
- current status, work version, plan version, checkpoint head, and retry bound;
- completed, pending, and uncertain plan-node IDs;
- freshness gaps, approval reference, receipt IDs, verification requirements,
  and the safest next action;
- independent execution and reply-delivery states.

A continuation begins only from a committed checkpoint. Andrea issues an
expiring, single-use resume grant for that exact work version, plan version,
checkpoint, action class, inbound message when supplied, and scope. The
plaintext token is returned once and never stored; SQLite retains only its
hash. Atomic consumption both invalidates the grant and acquires one execution
lease, so concurrent consumers cannot both proceed. A lease runs at most one
dependency-ready node before recording a new checkpoint or a bounded replan.

Resume authority is not action authority. Repository writes, external effects,
sends, calendar writes, purchases, deployments, commits, pushes, migrations,
dependency changes, deletions, and administrative changes still need a current
approval packet bound to the exact durable work, current durable checkpoint,
plan version, target scope, action class, packet version, and scope digest.
Andrea stages that immutable packet, a new approval checkpoint, its work link,
and the transition to `awaiting_approval` atomically. Changed or expired
approval, a different checkpoint or plan, stale work state, a different
chat/group/channel/target, or a reused inbound message fails closed.
Action classes also use a closed policy: each recognized action class maps to
one allowed effect class and approval requirement. Unknown or mismatched
action/effect pairs fail before a grant or receipt can authorize execution.

Every effect records a metadata-only `started` receipt before invocation.
Terminal receipts advance monotonically and cannot be rewritten into a
different claimed outcome. After a crash, unresolved or uncertain effects are
verified first and never replayed merely because the prior process disappeared.
An uncertain external effect becomes `delivery_unverified`; changed inputs or
targets cause bounded replanning while preserving already verified steps. New
approval-bound receipts—including approved local operator changes—must retain
the consumed grant ID and exact approval packet/version/scope provenance for
the same work, checkpoint, plan, target, and action class.

Repository adapters add a host-enforced scope over the canonical, non-symlinked
Git worktree. The scope binds repository identity, Git/worktree identity,
branch, HEAD, staged-index state, dirty path set, dirty content digest, allowed
root, action class, plan/checkpoint, invocation, and source turn. A content
change at an already-dirty path changes the state fingerprint. Paths outside
the root, symlink traversal, cross-work evidence, stale state, and postcondition
failure are rejected. Only fingerprints and opaque receipt IDs cross into
durable storage—never raw paths, commands, or result bodies.

At startup Andrea reconciles expired leases before new work is accepted.
Unknown local work returns to verification; uncertain external work remains
delivery-unverified; work with no unresolved effect becomes interrupted at its
last committed checkpoint. Legacy Runtime Spine and Agent OS continuation IDs
remain projection and diagnostic references only and cannot execute work.

Natural recovery questions such as `what survived the restart`, `where did you
stop`, `what is verified`, and `what still needs approval` read the canonical
metadata report. They do not create an approval, consume a grant, replay an
effect, or fabricate an owner review. Explicit continuation reads use phrases
such as `resume the durable mission` or `continue the durable work`; bare
`keep going` and `resume that` are not durable-recovery commands.

Container session continuity follows capability, not merely chat identity.
Direct-assistant, protected, control, and execution work use separate session
stores and Claude homes; advanced and code missions intentionally share only
the execution lane. Each run receives a unique host-authenticated, read-only
IPC inbox, so a writable execution transcript or stale shared session cannot
silently become control- or direct-assistant context. Mutable group
`CLAUDE.md` guidance is execution-only; canonical runner, settings, skills, and
plugins remain read-only trusted views.

Focused adversarial, hard-kill, held-out, repository-content, and legacy
projection checks pass on the final local candidate. The deterministic
inventory contains 108 commands: 93 selected by the release sweep and 15
explicitly excluded; all 93 selected commands pass. The complete local release
matrix passes, while hosted branch-SHA checks and committed runtime proof remain
pending. Local fixtures are not a deployed recovery claim.

## Channel Shape

Alexa:

- short orientation only
- lead summary
- next step
- main blocker
- optional handoff to Telegram

Telegram:

- full mission summary
- step list
- blocker view
- suggested actions
- richer explainability

BlueBubbles:

- concise parity for mission reads
- can continue the same mission context
- not the primary mission-editing surface in this pass

## Explainability And Control

Natural controls include:

- `what's the plan`
- `why this plan`
- `what's blocking this`
- `what should I do first`
- `make it simpler`
- `break it down more`
- `stop suggesting that`

Andrea should always be able to point back to the actual signals shaping the plan: calendar pressure, communication loops, linked threads, chief-of-staff pressure, saved material, or missing information.

## Out Of Scope

- no giant planner UI
- no autonomous project management
- no passive inbox or project ingestion
- no automatic execution of durable actions
- no replacement of life threads, reminders, or current work

## Testing

Focused validation for this layer:

```bash
node scripts/run-with-pinned-node.mjs ./node_modules/vitest/vitest.mjs run src/missions.test.ts src/assistant-capability-router.test.ts src/assistant-capabilities.test.ts src/cross-channel-handoffs.test.ts
npm run test:continuity:hard-kill
npm run test:continuity:heldout
npm run debug:missions -- --dry-run
npm run debug:missions
npm run typecheck
npm run build
npm test
npm run telegram:user:smoke
```
