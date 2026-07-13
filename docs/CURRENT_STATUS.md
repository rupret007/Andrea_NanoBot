# Andrea Current Status

Generated from local operator and repository checks on 2026-07-13. This is a
candidate snapshot, not post-release runtime proof.

## Recovery Context

- Recovered Codex thread: `Set up project on this Mac`
- Recovered thread id: `019e86f7-3449-7112-802d-3b10f8707ceb`
- Canonical repo root: `/Users/jeffstory/Andrea_NanoBot`
- Convenience path: `/Users/jeffstory/Documents/Andrea_NanoBot` is a symlink to the canonical repo root.
- This thread is the current recovery context. The recovered setup thread should remain reference-only unless there is a specific reason to inspect older history.

## Repo And Runtime

- Git branch: `codex/andrea-durable-cognitive-continuity-v1`
- Candidate base: local `HEAD` and `origin/main` were both `adbc5fb4` with zero
  ahead/behind divergence at the documentation audit. The workspace is dirty
  with the preserved release candidate; fetch again immediately before
  publication.
- Workspace and serving identity: use `npm run debug:status` for the exact
  current SHA; every release must report `Serving commit aligned: yes`
- Modernization work: the preserved container-authority candidate and new
  durable-cognitive-continuity candidate are uncommitted. The final local
  release matrix passes, including 2,605 primary tests, 282 AGI tests, the
  93/93 deterministic sweep, container canaries, and a 100% zero-cost offline
  scorecard. Publication, hosted branch checks, and runtime proof remain
  pending; the serving runtime predates both candidates.
- Process/runtime state: `running_ready`, serving an intermediate
  `dirty_source` artifact built before the latest candidate edits
- Host disk headroom was healthy at the latest check after the owner-authorized
  regenerable-cache cleanup, but a later sample still showed material RAM/load
  pressure; use `npm run debug:status` for exact current capacity
- Serving artifact aligned with the current candidate: no. After the combined
  candidate passes every gate and is committed, this round permits one Andrea
  LaunchAgent rebuild/restart and read-only provenance check. It does not
  permit an OpenClaw restart or external action.
- Open pilot issues: check `npm run debug:pilot`
- Learning evidence (`main`, latest read-only snapshot): one of five required
  distinct owner-reviewed outcomes, no saved personal baseline, and one blocked
  coding deep-work packet with no real artifacts or checks. Six live delivery
  samples average about 45.2 seconds; the three newer stage-attributed samples
  show that the slow path is dominated before delivery by the turn harness and
  answer preparation. Their paired detached reflections average 136 ms and peak
  at 568 ms, so reflection is not the measured tens-of-seconds cause. Cost
  evidence remains $0.3042 of recorded estimates plus one $0.75 fixed estimate
  reservation; provider billing is not reconciled. Genuine owner outcomes must
  not be backfilled from prior conversation history.
- The repository candidate keeps V2 execution packets open until aggregate
  runtime action/state evidence is validated and bound to the source turn.
  Post-send reflection cannot finalize execution. Repository writes require a
  successful verification after the final write; aggregate external-action
  evidence cannot complete without a dedicated exact-action binding. These are
  candidate semantics, not proof from the older serving artifact or
  the current blocked production packet.
- Future live deep-work packets retain their originating cognitive run, so a
  mission verdict in chat or the authenticated cockpit contributes to the same
  trajectory; partial and honestly blocked reviews remain neutral rather than
  inflating promotion acceptance. New repository implementation and test work
  is routed into the coding apprenticeship ledger; runtime operations remain
  separate and non-coding reviews cannot create repository-skill evidence. The
  owner cockpit prioritizes unreviewed outcomes and exposes the evidence gaps,
  replay state, and honest verdict set needed for the remaining genuine samples.
  Telegram and the BlueBubbles self thread use the same selection and gap
  contract; other chat surfaces cannot write owner verdicts, and incomplete
  verification requests fail with actionable guidance rather than a runtime
  exception. Helpful feedback on a linked mission invites a separate explicit
  review without auto-verifying it or creating a duplicate learning sample.
  Response sentiment and the later mission verdict share one canonical packet
  identity; the latest explicit verdict controls acceptance metrics, while the
  underlying events remain auditable.

## Durable Continuity Candidate

- Meaningful coding, research, operator, mission, and approval-gated turns link
  to one canonical durable work identity. Ordinary direct-assistant questions
  do not create durable work.
- Work/checkpoint state is compare-and-set and bound to owner, chat, group,
  channel, executor, exact target, plan version, and bounded node/evidence IDs.
- Resume grants expire, are single-use, and are stored only as hashes. Atomic
  consumption acquires one lease; the latest concurrency proof produced one
  winner and seven safe rejections from eight processes.
- Durable continuation reads must explicitly name the durable mission or work.
  Bare `keep going` and `resume that` are not durable-recovery commands.
- A resume grant is not approval. Mutations require a current approval for the
  exact work ID, current durable checkpoint ID, plan version, target-scope
  digest, action class, packet version, and scope digest. Staging atomically
  creates the immutable packet, approval checkpoint, durable link, and
  `awaiting_approval` work transition. Cockpit confirmation also compares the
  exact stored summary and group and advances the work version atomically; it
  does not execute or consume a grant.
- Action authority is a closed mapping from a recognized action class to its
  allowed effect class and approval requirement. Unknown classes and mismatched
  action/effect pairs fail closed at planning, grant, orchestration, and receipt
  boundaries.
- Effects receive metadata-only receipts before invocation. Unknown effects are
  verified after restart and never blindly replayed. External uncertainty stays
  `delivery_unverified`. Every approval-bound receipt, including approved local
  operator changes, binds the consumed grant and exact approval
  packet/version/scope provenance to the same work, checkpoint, plan, target,
  and action class.
- Repository proof is bound on the host to the canonical Git worktree, allowed
  root, repository identity, branch/HEAD, staged-index state, dirty path set,
  dirty content digest, action, plan/checkpoint, invocation, source turn, and
  verified postcondition. A content change at an already-dirty path invalidates
  the state fingerprint. Raw paths, commands, outputs, prompts, replies,
  credentials, and token values are not persisted.
- Legacy Runtime Spine and Agent OS resume identifiers are now projection-only;
  they cannot consume a grant, approve, interrupt, or execute work.
- The latest completed isolated hard-kill proof recovered 12/12 declared crash
  boundaries with zero duplicate effects. The latest held-out proof passed all
  ten scenarios with no external network, council call, production mutation,
  or isolated learning event. The complete local exact-tree matrix now passes;
  hosted branch checks and committed runtime provenance still gate handoff.
- The schema-initialization proof does not claim a kill inside an individual
  SQLite DDL statement. It proves reopen after initialization, idempotent
  migration, legacy-row preservation, and fail-closed malformed-schema handling;
  exact in-DDL termination remains unclaimed.
- No deterministic fixture has created or replaced an owner verdict, baseline,
  routine canary, skill candidate, promotion, or live mission result. The
  existing one-of-five production snapshot above remains historical operator
  evidence and must not be inferred from these tests.
- Focused adversarial continuity checks passed for same-work/same-plan receipt
  evidence, expired and wrong-generation leases, checkpoint monotonicity,
  malformed checkpoint state, multi-uncertain recovery, closed action policy,
  and same-path repository-content drift. The local full matrix passes; hosted
  checks and runtime proof remain pending.

## Container Capability Containment Candidate

- Session and transcript state is divided into `direct-assistant`, `protected`,
  `control`, and `execution` lanes. Advanced and code routes intentionally share
  only `execution`; all other lane pairs have distinct storage keys and Claude
  homes. Preserved legacy shared session rows remain inert.
- Each run gets a unique host-created inbox at
  `data/ipc/<group>/input/<lane>/<runId>`, mounted read-only for the runner.
  Follow-ups are HMAC-SHA256 host envelopes bound to the run ID and per-run
  token; unsigned, altered, cross-run, and replayed files are rejected, and the
  token is excluded from diagnostics.
- Direct-assistant, protected, and control guidance is host-constant. Only the
  execution lane may read mutable group `CLAUDE.md`; canonical runner source,
  settings, skills, and plugins remain read-only trusted views.
- Focused containment checks passed during development, but the final
  exact-tree host/runner rerun, nested-read-only container canary, 93-command
  selected deterministic sweep, and complete release matrix are still pending.
  The inventory contains 108 commands total; 15 are explicitly excluded from
  that sweep and must remain visible in its report.
- Branch publication and production release are separate. This round targets a
  commit, push, and draft pull request for the continuity branch. PR CI,
  container, AGI, and CodeQL checks can validate that branch SHA; the manual
  security workflow is main-only and cannot become exact-SHA release evidence
  until a separately authorized merge makes the commit reachable from
  `origin/main`.

## Live Proof Truth

- Launch status: `near_live_only` while Telegram roundtrip and life-thread proof
  gaps remain
- Core status: usable with healthy persistence headroom
- Live proof gauntlet: use `npm run services:status` and `npm run integrations:status -- --json`
- Proof debt: a fresh Telegram user-session roundtrip, one life-thread control
  turn, and a fresh signed Alexa turn
- Operator action required: complete the explicit Telegram, life-thread, and Alexa proof
  turns; no disk cleanup is currently required
- Repo work required for disk detection: complete

Current live-proven surfaces:

- BlueBubbles canonical same-thread message-action proof in `bb:iMessage;-;+14695405551`
- Google Calendar
- OpenAI, Anthropic, Gemini, MiniMax, Brave Search, research, and image generation

Current blocked or proof-stale surfaces:

- Telegram user-session proof: `near_live_only`; configured transport is
  healthy, but the last successful roundtrip is outside the freshness window
- Alexa signed IntentRequest proof: `manual_action_required` until a fresh signed handled turn reaches this host
- Life-thread proof: `near_live_only` until one genuine save/thread-control turn occurs

## Next Proof Actions

1. Preserve persistence headroom.
   - Host disk pressure is currently healthy and above the warning threshold;
     keep the existing health monitor active and avoid automatic deletion of
     Docker images, containers, evaluation evidence, or user files.

2. Ground communication identities explicitly.
   - Run `review communication identities` in the registered main Telegram chat or configured Messages self-thread.
   - Confirm or dismiss unresolved direct conversations; authoritative group
     metadata is excluded automatically, and people are never inferred from
     phone numbers or message bodies.

3. Keep Telegram proof fresh.
   - Run `npm run telegram:user:smoke`.
   - Send `hi` or `what's up` in Telegram on this host before demos.

4. Keep Google Calendar proof fresh.
   - Run `npm run debug:google-calendar` and `npm run services:status`.
   - If the host later reports `invalid_grant`, rerun the current-repo OAuth flow.

5. Keep BlueBubbles same-thread proof fresh.
   - In canonical self-thread `bb:iMessage;-;+14695405551`, ask what to say back or send back.
   - Use `send it later tonight` to prove the message-action leg without loosening send safety.
   - Confirm with `npm run debug:bluebubbles -- --live`.

6. Close Alexa proof.
   - Use a real device or authenticated simulator: `Open Andrea Assistant`, then `What am I forgetting?`.
   - Confirm with `npm run services:status`.

7. Refresh flagship journeys.
   - In Telegram, exercise ordinary chat, Candace follow-through, mission planning, `/cursor` work cockpit, and cross-channel handoff.
   - Rerun `npm run debug:pilot`.

8. Establish the first real learning baseline.
   - Review at least five genuine Andrea responses with `Helpful`, `Not helpful`,
     a Messages tapback, or a fresh standalone success/failure reply.
   - Save a baseline only after the fifth genuine review; never synthesize or
     backfill these outcomes.

## Guardrail

Do not start new repo repair work for current proof gaps unless a fresh operator surface reports `repo_work=yes`. Disk cleanup, manual Alexa proof, proof freshness, credentials, OAuth, and provider account limits stay classified as external/operator state. Andrea may diagnose and guide disk recovery but must never delete owner-controlled data automatically.
