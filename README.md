<p align="center">
  <img src="assets/andrea-banner.svg" alt="Andrea hero banner" width="1100">
</p>

<p align="center">
  Andrea_NanoBot is the merged home for Andrea's Telegram-first orchestration shell, built on NanoClaw isolation and expanded with curated OpenClaw skills.
</p>

<p align="center">
  This repository is now the canonical Andrea codebase. The older <code>ANDREA/nanoclaw</code> checkout is reference-only and should not be used as the runtime root.
</p>

<p align="center">
Andrea is designed to be practically useful every day: schedule help, reminders, groceries and errands, meal and week planning, reply drafting, pill and bill follow-through, personalized daily setup, research, coding help, guarded shopping approvals, and secure chat-based automation across multiple backend lanes.
</p>

<p align="center">
  Andrea now also has a bounded chief-of-staff layer for priorities, prep, and explainable decision support across Alexa, Telegram, and BlueBubbles.
</p>

<p align="center">
  Andrea can also remember explicitly delegated safe defaults, so repeated reminder, save, ritual, and handoff patterns become smoother without turning into silent automation.
</p>

<p align="center">
  Andrea now also has a bounded messaging trust ladder, so draft, approve, send, defer, and review can happen in one explainable flow without slipping into uncontrolled auto-send.
</p>

<p align="center">
  Andrea's personal-intelligence loop now compiles cited opt-in context, promotes only canary-verified reversible routines, keeps execution-heavy deep work open until bounded runtime action and state evidence is reconciled, and learns from redacted outcome metrics.
</p>

The loop is wired into real assistant turns: daily and deep-work planning share
one local context packet, approval turns bind a pending verification packet to
that turn, and post-send reflection can assess reply quality but cannot prove
execution. Repository writes also require a successful verification observed
after the final write. Aggregate external-action evidence cannot complete a
mission until a dedicated receipt binds the exact approved action. The operator
can inspect outcome quality with `npm run debug:assistant-intelligence`.

The durable-continuity layer gives meaningful coding, research, operator,
mission, and approval-gated work one canonical work identity. It binds that
identity to the owner, chat, group, channel, executor, plan version, checkpoint,
and exact target scope. Resume grants are expiring, single-use capabilities;
their plaintext values are returned once and only a hash is stored. Consuming a
grant and acquiring an execution lease is one database transaction, and a
grant never substitutes for fresh approval. Fresh-approval action classes
atomically stage an immutable approval packet, a new approval checkpoint, its
durable-work link, and the transition to `awaiting_approval`. The decision must
still match the exact durable work ID, current checkpoint ID, plan version,
action class, target-scope digest, packet version, and immutable scope digest.

Recovery is verification-first. A started, partial, or unknown effect is
inspected after restart and is never blindly replayed. Repository completion
requires host-bound metadata receipts for the canonical Git worktree and a
successful postcondition check after the final write; raw commands, paths,
tool output, prompts, replies, and resume-token values are not stored. Ordinary
direct-assistant questions do not create durable work. Mutation receipts also
retain the consumed grant ID and exact approval packet/version/scope
provenance, so a receipt cannot borrow authority from another work item,
checkpoint, plan, target, or action class. The operator can run
`npm run test:continuity:hard-kill` and `npm run test:continuity:heldout` for
the isolated, network-denied recovery proofs. Deployment and real-owner outcome
evidence remain separate from those deterministic fixtures.

Andrea also has a fail-closed verified capability-acquisition path for a
genuinely unsupported task. An explicit live capability-learning or
learn-first turn records only a bounded metadata-derived gap: the request body
is neither copied into the ledger nor executed. The direct observation API
separately requires callers to classify input as `derived_metadata`. Resource
discovery compares existing resources under health, version, privacy, risk,
and authority constraints. A candidate can compile only from exact registered
executor and independent evaluator bindings, including declared implementation
identity/version digests. Those digests pin registry identity; they are not
byte-level attestation of callback code. External research is untrusted data,
not executable instruction.

Sandbox proof is bound to canonical durable work, a checkpoint, scope hashes,
and started/terminal effect receipts. The acquisition certification runs ten
named primary scenarios plus fifteen structurally separate held-out scenarios
and can advance synthetic acquisition evidence no farther than
`sandbox_verified`. The production apprenticeship then implements the
database-backed canary, a separate action-specific approval before any
protected plan, exact owner review, separate activation, monitored reuse,
pause, quarantine, revoke, and retire lifecycle. The released baseline's
deterministic certification passed 22/22 synthetic scenarios with provider
calls, cost, external effects, production writes, and genuine owner evidence
all at zero. The action-authority implementation has passed formatting,
typecheck, build, 250 primary files / 3,079 tests, the focused acquisition,
production/hard-kill, cockpit/chat, and continuity suites, container runner and
real-container canaries, plus AGI typecheck and 28 files / 286 tests. All 97
selected deterministic commands pass from the 112-command inventory, including
the nested 3/3 stability gate; the offline scorecard is 100.0% A+ at $0, and
certification, signature, documentation, and dependency-audit gates pass.
Publication, exact-SHA hosted checks, and runtime identity are time-sensitive;
query GitHub and `npm run services:status` rather than inferring them here.
Neither certification is an OS-isolation boundary, live canary, owner verdict,
live or production activation, deployment, or proof of universal autonomous
learning. Isolated fixtures do exercise the synthetic activation branch.

`npm run capability:prepare-release-readiness` writes labeled synthetic
preproduction records for the bundled read-only, zero-egress release-readiness
candidate to Andrea's canonical local ledger; it creates no live canary or
approval. Plain `npm run capability:canary` is read-only inspection. Its
explicit flags expose separate `--stage`, `--authorize-canary`,
`--stage-action-approval`, `--authorize-action`, `--run-canary`,
`--stage-activation`, and `--activate` phases. An action-specific packet is
required only for a protected plan; canary or activation approval cannot
substitute for it. Staging grants no authority, consumption requires the
separately approved current packet, and neither action-approval phase executes
the protected plan. The command never approves its own packet or records an
owner verdict. Guided mutations remain bound to the registered main Telegram
chat or configured Messages self-thread. The owner cockpit is a bounded
evidence/control view, not an executable reuse lane, and cannot relabel or
approve those chat-bound capability packets. Capability review uses six explicit verdicts
(`verified`, `helpful`, `partial`, `blocked`, `corrected`, or `rejected`);
ordinary Helpful feedback is not a capability verdict. Re-review revises the
same canonical sample, and only `verified` can make a separate activation
proposal eligible. Activation still requires its own later exact approval.
Every canary, protected-action, or activation staging result prints the
reviewable packet summary, staged version, scope digest, summary digest, and one
exact same-chat command:
`approve capability packet <packet-id> version <n> scope <64hex> summary <64hex>`.
Only that complete command is an approval intent. Andrea re-queries the packet
and production binding, requires the same registered Telegram or BlueBubbles
conversation, and uses the canonical compare-and-set; phrases such as “approve
the capability” remain ordinary non-mutating chat.
One deliberately narrow chat route can reuse the release-readiness contract
only after that exact contract is genuinely active and freshly healthy. No
such real canary, review, activation, or reuse is claimed by repository tests.
Acquisition still grants no new authority. Production plans with credentials,
unsupported egress/cost, mixed authority, or rollback bindings fail closed;
the trusted in-process certification harness is not OS isolation or a
generalized rollback executor. See
[Verified Capability Acquisition](docs/VERIFIED_CAPABILITY_ACQUISITION.md) and
[Verified Production Apprenticeship](docs/VERIFIED_PRODUCTION_APPRENTICESHIP.md).

Andrea also includes an opt-in private owner cockpit: a calm, responsive view of
today's focus, open loops, goals, staged approvals, and verified outcomes. It
reuses the same database and approval lifecycle as chat, binds only to loopback,
and is intended to be exposed remotely only through a protected Tailscale Serve
route. See [the owner cockpit runbook](docs/OWNER_COCKPIT.md).

The cockpit's generic approval queue never includes capability packets bound to
Telegram or BlueBubbles; those remain decidable only on their exact trusted
conversation and appear in the cockpit as opaque apprenticeship evidence.

<p align="center">
  <a href="docs/USER_GUIDE.md">User Guide</a>&nbsp; | &nbsp;
  <a href="docs/ADMIN_GUIDE.md">Admin Guide</a>&nbsp; | &nbsp;
  <a href="docs/ANDREA_OPENAI_BACKEND.md">OpenAI Backend</a>&nbsp; | &nbsp;
  <a href="docs/SETUP_AND_FEATURES_GUIDE.md">Setup Guide</a>&nbsp; | &nbsp;
  <a href="docs/KNOWLEDGE_LIBRARY.md">Knowledge Library</a>&nbsp; | &nbsp;
  <a href="docs/COMMUNICATION_COMPANION.md">Communication Companion</a>&nbsp; | &nbsp;
  <a href="docs/ACTION_BUNDLES.md">Action Bundles</a>&nbsp; | &nbsp;
  <a href="docs/DELEGATION_RULES_AND_SAFE_AUTOMATION.md">Delegation Rules</a>&nbsp; | &nbsp;
  <a href="docs/PERSONAL_INTELLIGENCE_AND_VERIFIED_AGENCY.md">Verified Agency</a>&nbsp; | &nbsp;
  <a href="docs/VERIFIED_CAPABILITY_ACQUISITION.md">Capability Acquisition</a>&nbsp; | &nbsp;
  <a href="docs/VERIFIED_PRODUCTION_APPRENTICESHIP.md">Production Apprenticeship</a>&nbsp; | &nbsp;
  <a href="docs/MESSAGING_TRUST_LADDER_AND_LIVE_DELIVERY.md">Messaging Trust Ladder</a>&nbsp; | &nbsp;
  <a href="docs/OUTCOME_TRACKING_AND_REVIEWS.md">Reviews</a>&nbsp; | &nbsp;
  <a href="docs/CHIEF_OF_STAFF_MODE.md">Chief-of-Staff Mode</a>&nbsp; | &nbsp;
  <a href="docs/MISSIONS_AND_EXECUTION.md">Missions</a>&nbsp; | &nbsp;
  <a href="docs/PROACTIVE_RITUALS.md">Proactive Rituals</a>&nbsp; | &nbsp;
  <a href="docs/CROSS_CHANNEL_HANDOFFS.md">Cross-Channel Handoffs</a>&nbsp; | &nbsp;
  <a href="docs/BLUEBUBBLES_CHANNEL_PREP.md">BlueBubbles</a>&nbsp; | &nbsp;
  <a href="docs/CHANNEL_COMMANDS_AND_ONBOARDING.md">Chat Commands</a>&nbsp; | &nbsp;
  <a href="docs/COMMAND_SURFACE_REFERENCE.md">Command Surface</a>&nbsp; | &nbsp;
  <a href="docs/BACKEND_LANES_ARCHITECTURE.md">Backend Lanes</a>&nbsp; | &nbsp;
  <a href="docs/ASSISTANT_CAPABILITY_GRAPH.md">Capability Graph</a>&nbsp; | &nbsp;
  <a href="docs/DEMO_CHECKLIST.md">Demo Checklist</a>&nbsp; | &nbsp;
  <a href="docs/ADDONS_AND_FEATURE_MATRIX.md">Add-On Matrix</a>&nbsp; | &nbsp;
  <a href="docs/CURSOR_API_KEYS.md">Cursor API Keys</a>&nbsp; | &nbsp;
  <a href="docs/TESTING_AND_RELEASE_RUNBOOK.md">Testing Runbook</a>&nbsp; | &nbsp;
  <a href="PRIVACY.md">Privacy Policy</a>
</p>

---

## Flagship Journeys

Andrea should be presented as a practical personal assistant with proof-gated channels and bounded action. Lead with five journeys:

- ordinary chat and daily guidance
- reminders, calendar, and list capture
- communication follow-through
- mission and chief-of-staff planning
- work cockpit continuity

Advanced lanes such as research, image generation, self-improvement, and broad provider diagnostics are useful, but they are not the core launch story.

Work cockpit continuity also distinguishes an unavailable Codex/OpenAI backend
from a confirmed missing task. A temporary outage keeps the exact selection,
labels execution status unknown, and offers a read-only **Check again** action.
It does not restart work or turn cached history into current execution proof.
See [work cockpit recovery](docs/WORK_COCKPIT_RECOVERY.md) for the behavior and
offline verification boundary.

These flows are now backed by one shared capability graph, one continuation/handoff layer, and one productized proof harness:

```bash
npm run debug:signature-flows
```

Treat that flagship-flow suite and harness as the main product proof. The subsystem harnesses are still useful, but they are supporting checks now.

## Field-Trial Truth

Static docs are not the source of truth for launch readiness. Use this order whenever surfaces disagree:

1. `npm run debug:status`
2. `npm run setup -- --step verify`
3. `npm run debug:pilot`
4. docs

Release and host truth are deliberately not pinned to a commit, process, or
free-space value in this README. Before a release or demo:

- require a clean, non-diverged `main` with `git status --branch` and
  `git rev-list --left-right --count main...origin/main`;
- require `npm run services:status` to report `running_ready`, healthy disk
  pressure, verified build provenance, zero dirty build paths, and a serving
  commit aligned with workspace `HEAD`;
- rebuild and restart with the platform-specific service command whenever the
  serving commit is stale, even when the old process still responds;
- use [docs/CURRENT_STATUS.md](docs/CURRENT_STATUS.md) for the latest dated
  evidence summary, then rerun the commands above because integration proof
  and disk capacity expire independently of repository documentation;
- treat BlueBubbles, Telegram, Alexa, life-thread, and provider states exactly
  as the live status surfaces classify them. Configured transport, stale
  proof, and current end-to-end proof are different claims.
- Integration status keeps configuration, transport health, and proof freshness separate. For example, an overdue Telegram `/ping` may be `near_live_only` while the configured long-polling transport remains healthy; the stale success timestamp is proof debt, not a transport failure.
- In `npm run integrations:status -- --json`, `summary.stateCounts` is the
  exhaustive per-state classification and sums to `summary.total`. The
  `actionNeeded`, `needsProof`, and `manualOrExternal` counters answer
  overlapping operator questions and must not be added together.
- Model-provider configuration is not live health. OpenAI, Anthropic, Gemini,
  MiniMax, and Brave Search remain `unknown` when only configuration is
  present; only a bounded current probe or capped evaluation may promote an
  observed provider state.
- Successful or failed live provider probes persist only bounded health metadata (provider, state, failure class, model, and timestamp) in an owner-only local file for 30 minutes. Operator reality/readiness reports and the council doctor may reuse that explicitly labeled cached observation without another paid/network call; recorded council-run quality is unchanged by later provider recovery, and `npm run agi:readiness -- --config-only` ignores the cache for a strict configuration-only view. Prompts, outputs, credentials, request IDs, and raw provider errors are never cached.
- `externally_blocked`: work cockpit execution can be blocked when the Andrea OpenAI backend lane is intentionally disabled; report that separately from host health.
- `npm run services:status`, `npm run setup -- --step verify`, and `npm run debug:status` are the operator truth surfaces and should agree on the same proof/config blocker story
- `npm run debug:metacognition` recomputes a current, non-persisted operator assessment; add `-- --latest` only when inspecting the last persisted turn frame rather than current reality
- `npm run debug:pilot` is the proof-freshness and dogfooding surface for flagship journeys, degraded-but-usable fallback, and exact next steps

For the current demo/field-trial script, use [docs/DEMO_CHECKLIST.md](docs/DEMO_CHECKLIST.md).

## Pilot Mode

Andrea has a bounded pilot and dogfooding loop on configured hosts:

- flagship journey proof is recorded privately in local SQLite as sanitized journey events
- operator review now distinguishes `live_proven`, `degraded_but_usable`, and externally blocked pilot states so dogfooding does not confuse a bounded fallback with a clean live proof
- explicit pilot issue capture is available from shared assistant chat with phrases like:
  - `this felt weird`
  - `that answer was off`
  - `this shouldn't have happened`
  - `save this as a pilot issue`
  - `mark this flow as awkward`
- in the registered main Telegram control chat, substantive Andrea replies show `Helpful` and `Not helpful`
  - tapping either records one idempotent owner-reviewed outcome; `Not helpful` also saves a private `downvoted_response` pilot issue
  - each accepted/rejected acknowledgement shows truthful progress toward the five-outcome baseline gate; reaching five makes the baseline reviewable but never saves it automatically
  - responsiveness metrics stop at actual live reply delivery and exclude replay drills, provider evaluations, deep-work routing, and post-send reflection
  - memory, citation, and tool-reliability metrics count only provenance-tagged real assistant interactions; live evaluations and unclassified legacy telemetry remain auditable but cannot inflate production evidence
  - the five-outcome baseline gate counts only explicit owner-review events, and several actions accepted or rejected in one bundle remain one reviewed decision
  - personal-context queries fail closed for content-free prompts and combine lexical matches with an offline concept fallback; empty lookups do not count as citation failures, and `that memory was correct/incorrect` records a packet-linked correctness judgment
  - a fresh standalone `that worked`, `that was helpful`, `that didn't work`, or `not helpful` can review the immediately preceding response without a button
  - questions, vague sentiment, stale replies, and mixed feedback/action text such as `that worked, send it` never count as a verdict or approval
  - Andrea can then prepare one queued self-fix job, preferring Codex local, then Codex cloud, then Cursor Cloud
  - external/manual blockers stay captured honestly instead of auto-starting a repo fix
  - local hotfixes may validate and restart on-host, but Andrea still asks before any commit or push
  - pilot review counts only actionable issues: linked regression coverage, recorded landings, cancellations, and explicit keep-local decisions close the derived issue view, while a landing prompt appears only for a genuinely new dirty path
- pilot review stays operator-only through `npm run debug:pilot`
- raw private transcripts are not stored in pilot instrumentation; only short sanitized summaries and linked artifact ids are retained
- set `ANDREA_PILOT_LOGGING_ENABLED=0` on the host if you need to disable both journey logging and explicit pilot issue capture

## What Andrea Is

Andrea is one public assistant identity built on a secure NanoClaw runtime.
The product is conversation-first in Telegram, with deeper operator tooling behind a narrower admin surface.

What normal users should expect:

- calendar help, reminders, follow-ups, and simple task support
- daily planning, meal planning, what-next guidance, and open-loop review
- pill reminders, bill follow-through, groceries, errands, meals, recurring household obligations, and save-for-later capture
- guided personalized setup so Andrea can learn what to track, which lists matter, and where richer detail should go
- quick reply help and message summaries
- research, summaries, and project help
- fast direct replies for simple questions, playful prompts, and basic math
- warm ordinary chat plus graceful degraded replies when deeper runtime or live research is unavailable
- a small safe Telegram command set
- `/cursor_status` as the only public-safe Cursor command

What operators should expect:

- setup, restart, verify, and troubleshooting
- Cursor Cloud job workflows through the primary `/cursor` dashboard
- a secondary `andrea_runtime` lane for Codex/OpenAI execution truth
- desktop bridge session and terminal workflows
- live `/debug-*` troubleshooting controls plus host-side `npm run debug:*` fallbacks
- a loopback-backed Codex/OpenAI runtime lane with reply-linked follow-up and current-task selection
- optional integrations only after same-day validation

The runtime is still based on NanoClaw, which means the security model matters:

- agents run in isolated containers
- each registered chat keeps four isolated capability contexts:
  `direct-assistant`, `protected`, `control`, and `execution`; advanced and
  code routes intentionally share only the execution context, and no other
  lane reuses transcripts or sessions
- community skills are cached globally but enabled explicitly per chat
- ordinary direct-assistant turns have no container tool surface; protected, control, advanced, and code routes receive only the tools required by their route
- every container run receives one unique host-created, HMAC-authenticated IPC
  inbox bound to its lane and run ID; the runner sees that inbox read-only and
  rejects unsigned, altered, or replayed follow-ups
- host-owned policy, runner, settings, skills, plugins, and non-execution
  guidance stay immutable in containers; only the execution lane may read the
  mutable group `CLAUDE.md`, and only explicit per-lane session,
  group-workspace, and host IPC state is writable
- legacy shared tool-bearing sessions and runner caches remain preserved but
  inert; they are not reused as capability-lane state
- host Codex home, auth, and config are not mounted or copied into agent containers
- OneCLI Agent Vault is the preferred credential boundary; environment inheritance is an explicitly degraded fallback and must pass only key names in container arguments, never secret values
- model access can run through OneCLI or an Anthropic-compatible gateway
- shopping credentials stay on the host behind a narrow approval-aware boundary

## Why This Repo Exists

The upstream NanoClaw project provides a strong secure runtime.
This fork turns that foundation into Andrea: a more opinionated, more polished personal assistant with stronger Telegram UX, better operator docs, reliable direct replies, and a more intentional day-to-day assistant experience.

In short:

- NanoClaw gives Andrea the safety model
- OpenClaw skills give Andrea breadth
- this repo focuses on making the whole package feel usable, personal, and reliable

## Quick Start

Clone this repo, install dependencies, and open Claude Code:

```bash
git clone https://github.com/rupret007/Andrea_NanoBot.git
cd Andrea_NanoBot
npm ci
claude
```

If you are on Windows PowerShell, create `.env` like this:

```powershell
Copy-Item .env.example .env
```

Then use this setup flow:

1. In Claude Code, run `/setup`
2. In Claude Code, add Telegram with `/add-telegram`
3. Run `/init-onecli` to preflight an existing operator-provisioned vault. It
   does not install or migrate OneCLI; if the vault is absent, make that
   operator decision separately or use `.env` inheritance as an explicitly
   degraded fallback.
4. Start the bot and open a DM with Andrea in Telegram
5. In Telegram, run `/start`
6. In Telegram, run `/registermain`
7. In Telegram, run `/mainchat`
8. In Telegram, run `/help`

After `/registermain`, that exact DM should become Andrea's main control chat.
If operator-only surfaces later feel flat or unavailable, run `/mainchat` first, then run `npm run services:status` and confirm `registered_main_chat_jid` matches the real Telegram DM you use.

## Pick Your Guide

If you only read one doc, use the one that matches your role:

- User: [docs/USER_GUIDE.md](docs/USER_GUIDE.md)
- Operator/Admin: [docs/ADMIN_GUIDE.md](docs/ADMIN_GUIDE.md)
- Full setup and runtime details: [docs/SETUP_AND_FEATURES_GUIDE.md](docs/SETUP_AND_FEATURES_GUIDE.md)

## Cursor In One Minute

Andrea now documents Cursor as three separate surfaces:

- **Cursor Cloud**
  - requires `CURSOR_API_KEY`
  - current validated heavy-lift queued coding path
- **Cursor desktop bridge**
  - requires `CURSOR_DESKTOP_BRIDGE_URL` and `CURSOR_DESKTOP_BRIDGE_TOKEN`
  - operator-only session recovery plus line-oriented terminal control on your own machine
  - does not automatically mean queued desktop-agent execution is validated on Windows
- **Cursor-backed runtime route**
  - optional diagnostic/runtime-routing surface
  - separate from both Cloud jobs and desktop bridge readiness

## Backend Lanes

Andrea_NanoBot now owns the shared shell while backend lanes own execution truth.

- **Shell ownership stays here**
  - Telegram UX
  - `/cursor` tile dashboard
  - selection state, wizard state, and reply-linked operator behavior
- **Cursor lane stays first-class**
  - current rich operator lane
  - primary taught dashboard and job workflow
- **`andrea_runtime` is now a backend-backed secondary lane**
  - uses the local `Andrea_OpenAI_Bot` loopback backend for Codex/OpenAI execution truth
  - now has a `Codex/OpenAI` surface inside the primary `/cursor` work cockpit
  - `/runtime-*` remains the explicit runtime fallback shell
  - does not replace Cursor or the `/cursor` dashboard
  - the shell now presents one chat-scoped current-work model with lane-specific capabilities, not two separate operator products
  - direct `/cursor-*` and `/runtime-*` replies now mirror the cockpit more closely: they render richer single-task cards, keep exact backend ids visible, and point back to explicit fallback commands when you want to stay out of the dashboard

On this host, the unified Telegram work cockpit is now live-proven across both first-class execution lanes:

- Cursor Cloud task creation, refresh/output controls, explicit fallback commands, and reply-to-card continuation
- Codex/OpenAI runtime creation, follow-up, logs, stop, and reply-to-card continuation

Shared shell handles now resolve as `{ laneId, jobId }`.
The imported `imported/andrea_openai_bot` subtree is temporary staging plus history preservation, not the long-term runtime home.

Under the hood, the current Codex/OpenAI lane now resolves through the local `Andrea_OpenAI_Bot` loopback backend when that lane is enabled. `npm run setup -- --step verify` (and the host start/restart output) surfaces `runtime_backend_health`, `runtime_backend_local_execution_state`, and `runtime_backend_auth_state` so host truth matches `/runtime-status` and the `/cursor` cockpit. See [docs/ANDREA_OPENAI_BACKEND.md](docs/ANDREA_OPENAI_BACKEND.md) for the ownership split and the current auth/bootstrap flow.

## Alexa Companion Mode

Alexa is now a bounded companion channel for Andrea rather than a novelty skill.

- it reuses the same Andrea core, account-linking, and trust boundaries
- it now maps core daily, household, memory, thread, and bounded research asks through the shared assistant capability graph
- it now captures broader natural speech through a small set of carrier-phrase intent families instead of leaning only on narrow one-off intents
- it is shorter, warmer, more spoken-first, and less menu-like than Telegram
- it now has a small bounded personality layer for softer transitions in low-stakes moments
- it supports daily guidance like morning brief, what matters most today, anything important, what am I forgetting, evening reset, and family-upcoming flows
- it keeps short-lived conversational continuity for turns like `anything else`, `what about Candace`, `what about Travis`, `say more`, `why`, `remember that`, `make that shorter`, `be a little more direct`, and `remind me before that`
- it supports request-driven Andrea Pulse asks such as `Andrea Pulse`, `tell me something interesting`, `give me a weird fact`, or `surprise me`
- it can handle bounded research or comparison asks briefly by voice and keep longer follow-through on Telegram when needed
- it can now orient you around open conversations, owed replies, and communication follow-through without turning Alexa into a full messaging client
- personalization remains explicit and consent-based
- use a supported Node `22.x` runtime (`>=22 <23`) for Alexa on macOS/Linux;
  reproducible CI, Windows provisioning, and the container image use the exact
  repository pin `22.22.2`
- use `npm run debug:alexa-conversation -- --review` to see repeated Alexa misses, weak clarifiers, and carrier phrases worth adding from real use

Alexa proof is status-led on each host:

- treat `npm run services:status`, `npm run debug:status`, and `npm run setup -- --step verify` as the live authority
- Alexa only becomes `live_proven` while a fresh handled Andrea custom-skill proof remains inside the 24-hour window
- operator surfaces can satisfy that proof either from the persisted handled signed-request markers or, after restart, from a recent same-host `alexa_orientation` pilot success that already recorded the qualifying handled turn
- if that handled proof ages out or no fresh qualifying proof remains on this host, Alexa should read as `near_live_only`
- if the latest repo interaction-model hash has not been marked synced yet, launch-readiness should read `core_ready_with_manual_surface_sync` even while Alexa proof itself remains `live_proven`

When you want to refresh Alexa proof freshness, this is the validation flow:

- `Open Andrea Assistant`
- `What am I forgetting?`
- `Anything else?`
- `What about Candace?`
- `Be a little more direct.`
- optional `What should I remember tonight?`

If that handled signed proof ages past 24 hours, operator surfaces will intentionally drop Alexa back to `near_live_only` until you run this flow again.

Typed Alexa+ app chat is diagnosis-only right now. It may trigger a skill launch, but it does not count as live proof unless Andrea logs a real signed follow-up `IntentRequest` after launch.

After any interaction-model change, re-import `docs/alexa/interaction-model.en-US.json` in the Alexa Developer Console, run `Build Model`, then run `npm run setup -- --step alexa-model-sync mark-synced` before treating live fallback as a repo bug.

For repo-side conversation tuning on the operator host, use `npm run debug:alexa-conversation`.

## Andrea Pulse

Andrea Pulse is a separate request-driven personality feature. It is not a health check, not a replacement for `/ping`, and not a source of proactive spam.

- `/ping` remains pure operational health
- Pulse is currently request-only
- examples: `Andrea Pulse`, `tell me something interesting`, `give me a weird fact`, `surprise me`
- Pulse uses a small local curated catalog instead of adding a new provider dependency just for facts
- `say more` stays on the same Pulse item, while `anything else` can move to a different one

## BlueBubbles Companion Channel

BlueBubbles is now Andrea's optional bounded Messages bridge, not a core requirement for day-to-day use.

- BlueBubbles V1 syncs personal and group chats as communication data and
  explicit outbound destinations when `BLUEBUBBLES_CHAT_SCOPE=all_synced`
- ordinary contact and group threads are never assistant control surfaces, even
  when their text contains `@Andrea` or `@OpenClaw`; their activity remains
  available to trusted summaries, reviews, explicit direct-thread identity
  review, and explicit sends
- owner controls run from the registered main Telegram chat or the explicitly
  configured private Messages self-thread; in that self-thread, `@Andrea`
  addresses Andrea and `@OpenClaw` selects the helper lane, while bounded direct
  asks and fresh follow-ups may omit the mention
- self-thread asks such as `summarize my recent texts` or
  `summarize Candace from the last 2 days` use synced `bb:` contact history and can prime bounded
  recent history from the live BlueBubbles server when local context is thin
- a recent-summary continuation can move between the registered owner Telegram chat and configured Messages self-thread when both use the same companion group folder; the seed stays unavailable to contact/group and non-owner surfaces and retains its normal freshness limit
- communication asks now favor a useful thread-grounded gist (`Bob told you: Practice at eight tonight. You haven't replied yet.`) plus unsent person- and thread-grounded suggested replies for informational updates; `what's still open with Bob` and a `what do I owe people` follow-up after that named thread use the same gist so Jeff can draft for a Bob yes. After that owed-reply, `draft Bob` or `yes` creates one approval-gated unsent draft, `remind me later` / `remind me to reply later tonight` creates a local tonight reminder for Jeff, `save under thread` / `save that` keeps the owed turn under that named person, and `look at that` / `what's in that photo` tries to read unseen inbound image/video from that named thread. Photo-only owed turns say `Bob sent you a photo` and withhold yes-to-draft. None of those paths send. Generic who-do-I-owe asks do not crawl unnamed inbox threads; when no explicitly tracked open loop is available, Andrea gives one next prompt that names a single person instead of stopping at the privacy boundary, and a leftover `yes`, `remind me later`, `save under thread`, or `look at that` there does not draft, remind, save, or look. Already-replied named threads report `Nothing open`. Withheld questions and unseen photo-only turns still offer `remind me later` and `save under thread` but not yes-to-draft. Karen and other non-owner surfaces get no Messages bodies, attachments, seed, reminders, saves, media looks, or actions. The only send approvals are standalone `send it` / `send it now` / `send now`. Bare `yes` / `ok` never authorize a send. Jeff talks to Bob; Andrea is the engine.
- after a named owed reply, `remind me to reply tomorrow at 9am`, `remind me at 9:30pm today`, `remind me Friday at 9am`, or `remind me next Friday at 9am` sets an exact reminder to the owner control chat. The confirmation shows its date and configured timezone; invalid, past today/tomorrow, or ambiguous daylight-saving times ask for another time without creating a task. A weekday whose clock has already passed uses the next occurrence. `next Friday` is the Friday of the following week. This keeps the reply unsent. See [reply reminder timing](docs/COMMUNICATION_COMPANION.md#exact-reply-reminder-times).
- incoming BlueBubbles and Telegram images/videos are cached as bounded local message attachments (20 MiB per file, 7-day / 1 GiB retention by default) so Andrea can answer asks like `analyze this photo` or `what is in this video` when OpenAI vision is configured
- broad asks from Telegram such as `use BlueBubbles and summarize my texts from the past 48 hours` summarize the available local synced contact/group snapshot in that window, exclude the owner self-thread, redact raw identifiers, cap each conversation to its newest 80 in-window messages, and state that sync completeness was not independently verified
- BlueBubbles keeps companion-safe capabilities like daily guidance, communication help, follow-through, Knowledge Library summaries, draft follow-up, and short research summaries
- in the configured self-thread, native Like/Love/Dislike tapbacks provide privacy-safe accepted/rejected outcome signals; ambiguous reactions and removals never train Andrea
- the same narrow natural verdict phrases work in the configured self-thread; they retain route/run provenance only and never expand Messages authority
- `review communication identities` starts a private, explicit identity-link review in the registered main Telegram chat or configured Messages self-thread; only user-confirmed direct-thread links are skipped, while assistant-inferred direct links remain reviewable and can never supply high-confidence relationship context on their own; platform-declared groups are excluded and never retain person/life links; Telegram presents one genuinely unresolved direct conversation at a time with bounded Link/Leave Unlinked controls, and Messages returns exact text commands for the next item; both channels use stable opaque review keys instead of requiring raw phone/JID labels and may propose only unique exact-name matches—never message-body, identifier, generic-self, collective-category, or similarity inference
- richer details still hand off explicitly to Telegram when that is the better surface
- BlueBubbles does **not** become a main control chat and does not expose work-cockpit or admin/runtime controls

On a configured Mac, keep the Messages bridge local-first: prefer the local
BlueBubbles endpoint, register the webhook, and treat any public tunnel as a
fallback or diagnostic path. Telegram remains the dependable main messaging
surface. BlueBubbles is `live_proven` only while a fresh same-thread inbound,
outbound, and `message_action` proof chain is current. See
[docs/CURRENT_STATUS.md](docs/CURRENT_STATUS.md) for the dated operator-host
state instead of inferring live configuration from this README.

OpenBubbles is a future/provider-feasibility track, not the active Andrea
Messages provider described here.

See [docs/BLUEBUBBLES_CHANNEL_PREP.md](docs/BLUEBUBBLES_CHANNEL_PREP.md) for the live V1 scope, config, webhook/send model, media analysis behavior, summary/suggested-reply behavior, and exact current limits. See [docs/MESSAGING_TRUST_LADDER_AND_LIVE_DELIVERY.md](docs/MESSAGING_TRUST_LADDER_AND_LIVE_DELIVERY.md) for the approval-first send boundary.

## Relationship-Centered Communication Companion

Andrea now has a bounded communication-companion layer for real conversations and follow-through.

- communication threads are explicit conversation-level state, not a CRM
- Andrea can summarize a message, decide whether it still needs a reply, suggest next actions, and draft a reply in a warmer or more direct tone
- Telegram and BlueBubbles are the richer communication surfaces
- Alexa stays concise and can orient you around `what do I owe people`, `what's still open with Candace`, or `draft that for me`
- open conversations can feed into daily guidance and evening carryover without creating passive inbox surveillance
- after reviewing one local conversation, the standalone `forget this conversation thread completely` removes its tracking record and directly derived history from the same trusted owner control chat; original messages, saved profiles/life threads, reminders, and drafts remain. Changed, expired, or ambiguous reviews cannot authorize removal. `stop tracking that` still retains a disabled record.
- relationship-aware guidance counts a conversation identity as resolved only after an existing person is explicitly linked or the owner dismisses the single-person link as not applicable; every decision is reversible

Communication threads stay distinct from:

- memory facts
- life threads
- reminders
- the Knowledge Library

See [docs/COMMUNICATION_COMPANION.md](docs/COMMUNICATION_COMPANION.md) for the exact model, prompts, and testing flow.

## Missions And Multi-Step Execution

Andrea now has a bounded missions layer for turning an explicit goal into a stored plan that can move forward across Alexa, Telegram, and BlueBubbles.

- explicit planning asks like `help me plan Friday dinner with Candace` create a stored `proposed` mission immediately
- missions stay distinct from chief-of-staff, life threads, reminders, and current work
- each mission keeps a short summary, 3-5 steps, blockers, and one suggested next action
- durable follow-through still requires explicit approval such as `remind me`, `draft it`, `save that`, `track that`, or `start the research`
- Alexa gives a short orientation read, while Telegram gets the fuller plan and action surface

See [docs/MISSIONS_AND_EXECUTION.md](docs/MISSIONS_AND_EXECUTION.md) for the model, controls, and testing flow.

## Shared Assistant Core

Andrea now has a shared assistant capability graph so Alexa and Telegram feel like two expressions of the same assistant rather than separate route trees.

- shared capabilities now cover daily guidance, household-aware answers, explicit thread lookup, memory controls, and bounded research
- shared capabilities now also cover explicit Knowledge Library controls such as saving sources, listing relevant sources, explaining source choice, and summarizing saved material
- shared capabilities now also cover ritual status, ritual control, and follow-through guidance
- shared capabilities now also include explicit Andrea Pulse actions
- Alexa can now hand richer results off to Telegram explicitly instead of pretending voice should carry everything
- voice follow-ups like `send me the details`, `save that in my library`, and `turn that into a reminder` now map into the same shared completion layer
- Alexa keeps voice-safe shaping and bounded follow-ups
- BlueBubbles is now a real companion channel with its own safety gate and output-shaping policy
- Telegram keeps richer rendering and deeper operator-side actions
- operator-only current-work controls stay out of Alexa even though they live in the same registry

## Proactive Rituals And Follow-Through

Andrea now has a bounded rituals layer that sits above daily companion, reminders, life threads, calendar, personalization, and the Knowledge Library.

- rituals define assistant behavior and timing, not a second task system
- follow-through loops stay attached to life threads instead of spawning a parallel backlog
- morning and evening rituals can be scheduled on Telegram, but stay off until you opt in
- Alexa stays on-demand only and voice-first
- family and household automatic surfacing stay conservative unless you explicitly enable them

Typical prompts now include:

- `What rituals do I have enabled?`
- `Enable morning brief`
- `What follow-ups am I carrying right now?`
- `What have I been putting off?`
- `Make this part of my evening reset`
- `Stop doing that`

See [docs/PROACTIVE_RITUALS.md](docs/PROACTIVE_RITUALS.md) for the model, controls, and limits.

- bounded research now returns a summary first, structured findings, route explanation, and exact blocker truth when web-backed OpenAI research is unavailable
- bounded research can now use local context, the Knowledge Library, optional OpenAI-backed synthesis with `web_search` when configured, and runtime delegation only when the request is clearly execution-heavy
- Telegram image generation is now wired through the shared media capability when OpenAI credentials are present and the provider account is usable; Alexa keeps media at the handoff layer

See [docs/ASSISTANT_CAPABILITY_GRAPH.md](docs/ASSISTANT_CAPABILITY_GRAPH.md) for the descriptor model, safety rules, research provider boundaries, and license-safe pattern sources.

For operator-side smoke testing of the shared core, use `npm run debug:shared-capabilities`, `npm run debug:research-mode`, and `npm run debug:knowledge-library`.
For the missions layer specifically, use `npm run debug:missions`.
For the ordinary conversational surface and no-leakage degraded-response policy, use `npm run debug:conversational-core`.

## Approval Center And Action Bundles

Andrea now has a bounded Action Bundle layer so good advice can turn into explicit next steps without taking control away from you.

- bundles are small, explainable sets of actions built on top of existing reminders, drafts, thread saves, library saves, rituals, handoffs, and mission follow-through
- Telegram is the rich approval surface with inline actions like `Approve all`, `Pick actions`, and `Not now`
- Alexa stays concise and can orient you around the bundle, approve simple subsets, or send the full bundle to Telegram
- BlueBubbles stays bounded and hands richer bundle approval back to Telegram
- bundle execution is explicit, tracked, and honest about partial success or failure

See [docs/ACTION_BUNDLES.md](docs/ACTION_BUNDLES.md) for the model, approval flow, and current limits.

## Outcome Tracking And Reviews

Andrea now has a bounded closed-loop review layer so execution does not stop at "I created a reminder" or "I ran that bundle."

- outcomes track what actually happened after bundles, reminders, missions, communication follow-through, handoffs, and current-work moves
- daily and weekly review stay on-demand and grounded in real state Andrea owns or can safely infer
- Telegram is the richer review surface with grouped sections and bounded controls
- Alexa stays concise and can orient you around what got done, what slipped, and what is carrying into tomorrow
- BlueBubbles stays bounded and should hand off dense review to Telegram

This layer stays distinct from:

- missions as the plan structure
- bundles as the approval-and-execution layer
- reminders as future nudges
- life threads as ongoing matters

See [docs/OUTCOME_TRACKING_AND_REVIEWS.md](docs/OUTCOME_TRACKING_AND_REVIEWS.md) for the model, controls, and testing flow.

## Cross-Channel Companion Handoffs

Andrea now has a bounded cross-channel handoff layer so a conversation can start briefly on Alexa, continue in BlueBubbles or Telegram when appropriate, and still feel like one assistant.

- handoffs are explicit and user-visible
- Telegram remains the richer artifact/detail surface, while BlueBubbles can now receive bounded text continuations
- no silent push behavior was added
- voice-triggered completion actions reuse existing reminder, thread, ritual, and Knowledge Library systems instead of creating a second planner

Typical follow-ups now include:

- `send me the details`
- `send the full version to Telegram`
- `send that to my messages`
- `save that in my library`
- `track that under Candace`
- `turn that into a reminder`

The registered main Telegram chat can also stage a new text to an existing
synced one-to-one BlueBubbles conversation, an exact BlueBubbles/macOS contact,
or an explicit phone/email address:

- `Text Avery Example: Dinner is ready.`
- `Send a text message to Avery Example saying Dinner is ready.`

Andrea displays the exact Messages recipient and body, then waits for a
separate `Send now`/`send it` approval. The initial request never sends by
itself. Unknown or ambiguous names fail closed; an exact phone number or email
address can select a direct recipient even before a conversation exists. This
lane is private to the registered owner Telegram chat or configured Messages
self-thread and does not store a second contact archive. First-contact delivery
uses the same recipient-bound card and separate fresh approval as every other
send. After approval, an existing thread uses the normal message endpoint; a
new recipient uses one atomic BlueBubbles chat-creation request. If
BlueBubbles does not return both the created thread and message receipt, Andrea
marks delivery unverified and will not retry automatically.

Use `npm run debug:cross-channel-handoffs` and `npm run debug:bluebubbles` for the operator-side near-live proof harnesses, and see [docs/CROSS_CHANNEL_HANDOFFS.md](docs/CROSS_CHANNEL_HANDOFFS.md) for the delivery model and limits.

## Knowledge Library

Andrea now has a bounded **Knowledge Library** for saved source material.

- it is explicit, inspectable, and source-labeled
- it is separate from memory facts, life threads, reminders, and current work
- it supports manual notes, saved research, and approved local text-file imports
- retrieval is lexical-first with chunk-level provenance instead of silent blob matching
- Telegram is the richer source-grounded surface, while Alexa stays concise and source-aware

Useful prompts include:

- `save this to my library`
- `what do my saved notes say about this`
- `compare these saved sources`
- `what sources are you using`
- `use only my saved material`
- `combine my notes with outside research`

See [docs/KNOWLEDGE_LIBRARY.md](docs/KNOWLEDGE_LIBRARY.md) for the library model, ingestion rules, retrieval behavior, privacy boundaries, and testing path.

For day-to-day operator checks, use `/alexa-status` inside the registered main control chat and `npm run services:status` for the local Alexa listener, OAuth health, public-ingress hinting, and the last signed Alexa request markers on the host. Public HTTPS ingress and live signed utterances remain separate acceptance checks. If the live host is an `ngrok` `*.ngrok-free.dev` tunnel, the Alexa console endpoint SSL setting must use the wildcard-certificate option.

## Two Command Surfaces

This is one of the easiest places for new users to get confused, so the split is important:

### Claude Code Skills

These run inside the `claude` terminal session while you are operating the repo:

- `/setup`
- `/add-telegram`
- `/add-whatsapp`
- `/add-discord`
- `/init-onecli`
- `/debug`
- `/update-nanoclaw`
- `/update-skills`

### Telegram Bot Commands

These run inside Telegram after the bot is live:

- `/start`
- `/help`
- `/commands`
- `/features`
- `/ping`
- `/chatid`
- `/registermain`
- `/cursor_status`

Andrea Pulse is deliberately separate from this command surface. It does not replace `/ping`, and it only runs when explicitly requested in conversation.

Advanced operator workflows still exist, but they are operator-only, live in the admin guide, and should stay out of the default demo unless they were validated the same day.

Preferred operator command style:

- public-safe commands stay documented exactly as shown above
- deeper operator examples use hyphen aliases in Telegram, such as `/cursor`, `/cursor-jobs`, and `/cursor-create`
- operator examples use `/cursor-results` for output files and `/cursor-download` for one-file retrieval
- the normal Telegram operator flow is now `/cursor` -> `Current Work`/`Jobs`/`New Cloud Job` or `Codex/OpenAI` tiles -> tap a task/action -> reply with plain text only when you are supplying a follow-up prompt or a new-job prompt
- replying to a fresh work card always continues that exact task; otherwise Andrea uses the current work selected in the lane you opened
- if a work-card reply is stale or missing, Andrea now says so explicitly and points you back to `Current Work` or the lane-specific explicit command fallback
- underscore aliases still work for compatibility, but the docs now standardize on the hyphen form for operator workflows
- older `/cursor-artifacts` and `/cursor-artifact-link` aliases still work for compatibility, but they are no longer the preferred operator examples

## Demo-Ready Surface

For a reliable demo, keep the story tight:

- Telegram onboarding and `/registermain`
- direct questions, fast quick replies for simple asks, reminders, and light research
- stable health checks, `/help`, and `/cursor_status`
- secure per-chat isolation and clean user-facing replies

Optional integrations such as Cursor Cloud job control, desktop bridge control, Alexa, shopping flows, marketplace skills, and calendar-oriented skills exist, but they should be treated as operator-enabled extras unless they were validated the same day. Alexa in particular is now code-complete as a bounded personal-assistant channel, but live use still depends on Node 22, HTTPS ingress, Alexa console setup, and account linking being configured on that host.

## Calendar Integration

Andrea now has a local fast path for plain-language calendar reads such as:

- `What's on my calendar tomorrow?`
- `What's on my schedule this week?`
- `Am I free Friday afternoon?`
- `Do I have anything at 3pm tomorrow?`

Supported provider paths:

- Google Calendar with an access token or refresh token plus explicit calendar ids
- Apple Calendar directly on a Mac running Andrea
- Apple/iCloud-style CalDAV using calendar collection URLs plus credentials
- Outlook calendars through Microsoft Graph

These are optional operator-enabled integrations. Google Calendar is the best first setup when your real family events already live there, and Andrea answers truthfully when no provider is configured instead of pretending a calendar is connected.

Google Calendar now supports two practical operator flows on a configured host:

- read real events from explicit selected calendars such as `primary` plus family/shared calendars
- create simple one-time Google Calendar events after a clear confirmation in chat
- on Alexa, store the event draft and ask for confirmation even when only one
  writable calendar exists; choosing a calendar selects the destination but
  does not authorize the write
- split a clear calendar-plus-research ask into an approval-bound event draft and
  a separately reported read-only research result; the research clause is never
  copied into the event title, compound drafts require `confirm calendar event`,
  and generic `for me` wording does not opt private local context into an
  outward research request
- split a clear reminder-plus-research ask into one local reminder and a
  separately reported, bounded read-only research leg. The reminder is
  persisted before its acknowledgement; retrying the same inbound Telegram,
  BlueBubbles, or Alexa request converges on that reminder instead of creating
  another one. Research starts only after the primary reply is delivered and
  is never replayed automatically after an interrupted run. A natural
  “what happened with that?” asks Andrea for the separately persisted reminder
  and research states without executing either leg again.

Use the Google setup flow on the host instead of trying to give Andrea your Google account password:

```powershell
npm run setup -- --step google-calendar auth --client-secret-json "C:\path\to\client_secret.json"
npm run setup -- --step google-calendar discover --select all
npm run setup -- --step google-calendar validate
```

Notes:

- while the Google OAuth app stays in Testing, the Google account must be listed as a test user, and Google can expire Calendar refresh tokens after 7 days
- for durable Calendar auth, publish/verify the OAuth app in Google Cloud Console, then rerun `auth`, `discover`, and `validate` once
- `GOOGLE_CALENDAR_IDS` should stay explicit so Andrea only reads the calendars you selected
- `npm run setup -- --step google-calendar validate` is the operator truth surface for calendar access on the host being checked
  - `FAILURE_KIND: missing_config` means the current repo does not have usable Google Calendar credentials yet
  - `FAILURE_KIND: invalid_refresh_token` means the stored refresh token is stale or revoked; if the OAuth app is still in Testing, publish/verify it first, then rerun `auth` in the current repo instead of copying legacy tokens forward
- if the browser reaches the Google callback but `auth` still times out, finish the same current-repo OAuth run with `npm run setup -- --step google-calendar auth-complete --callback-url "http://127.0.0.1:PORT/?state=...&code=..."`
- reminder phrasing still creates reminders, not Google Calendar events
- a host is only live-proven for Google Calendar writes after `auth`, `discover`, `validate`, and one disposable create-event proof all succeed on that host
- use [docs/CURRENT_STATUS.md](docs/CURRENT_STATUS.md) for the dated operator-host
  proof; if validation reports `invalid_grant`, rerun the current-repo OAuth
  setup before claiming calendar launch readiness

## What Andrea Can Do

### Personal Assistant Work

- track tasks and simple to-do lists
- set reminders and recurring follow-ups
- keep compact ongoing life threads for people, household, and work continuity
- summarize conversations and notes
- run lightweight personal workflow automation

## Life Threads And Ongoing Context

Andrea now has a bounded **life thread** layer for ongoing matters like Candace, family logistics, band follow-ups, home errands, health routines, or work continuity.

- threads track what is still open across days
- each thread now has one canonical commitment state that distinguishes an
  idea, tentative intent, firm commitment, explicit request, waiting, blocked,
  delegated, deferred, completed, cancelled, and superseded work
- ownership is explicit: Andrea does not assign the user's action to them when
  another person owns the next step, and delegation does not mean completion
- waiting and blocked threads preserve the downstream objective without
  repeating a completed or currently impossible action
- a conditional follow-up stays attached to its original thread and becomes
  actionable only when its evidence and time condition warrant it
- speculative and tentative items remain available in relevant context but do
  not become firm overdue obligations or automatic reminders
- threads are not the same thing as long-term memory facts
- reminders are still the place for a specific future nudge
- current work is still the immediate execution focus in the cockpit
- explicit prompts like `save this under the band thread`, `remember I need to talk to Candace about dinner plans tonight`, `what's still open with Candace`, and `what threads do I have open` work in plain language
- inferred continuity stays confirmation-first; Andrea does not silently turn every recurring topic into durable memory
- a clearly targeted date, deadline, or time correction replaces the stale
  active value everywhere the thread is used; the old value remains only as
  explicitly superseded history
- relative corrections use the accepted profile timezone, exact correction
  replay is idempotent, and an ambiguous `move it` request asks which active
  obligation to update instead of guessing
- commitment transitions use stable identities and revisions: duplicate replay
  is a no-op, stale evidence cannot revive superseded truth, and ambiguous
  ownership or targets mutate nothing
- `don't bring this up automatically` moves a thread into manual-only use without deleting it
- `forget that thread` is the explicit hard-delete path

See
[docs/COMMITMENT_INTELLIGENCE.md](docs/COMMITMENT_INTELLIGENCE.md) for the
canonical model, transitions, ranking, privacy, migration, certification, and
intentional limits. Repository, hosted-CI, runtime, and live-channel evidence
remain separately recorded in
[docs/CURRENT_STATUS.md](docs/CURRENT_STATUS.md).

### Research And Knowledge Work

- research a topic and summarize the result
- compare options, explain tradeoffs, and recommend a choice with route explanation
- save source material into a bounded Knowledge Library and ask source-grounded follow-up questions later
- compare saved notes, summaries, and imported reference material with visible provenance
- keep Alexa concise while Telegram carries the richer structured research surface
- monitor or re-check information through scheduled tasks
- capture groceries, errands, bills, meal ideas, and household checklists without setup friction
- reopen recurring bills and household items when they come due, then convert the current cycle into a reminder, plan, or household thread when that helps
- turn those lists into practical household views like store run, bills this week, tonight, weekend, recurring soon, recently completed, and slipping carryover
- use Telegram as the richer list-management surface with grouped sections and bounded inline actions, while Alexa and BlueBubbles stay concise
- organize output per chat or group context

### Coding And Operator Work

- help with repos, debugging, and code tasks
- use `/cursor_status` as the safe Cursor readiness check
- operators can create, continue, stop, inspect, and recover **Cursor Cloud** coding tasks from the main control chat
- operators use `Refresh`, `View Output`, and `Results` in `/cursor`, while `/cursor-conversation`, `/cursor-results`, and `/cursor-download` stay available as explicit fallbacks
- operators can sync and inspect **desktop bridge sessions**, then run line-oriented terminal commands against tracked bridge sessions on their own machine
- operators can also open the integrated **Codex/OpenAI runtime** lane from `/cursor` to review or continue runtime tasks when that lane is enabled and validated on the host
- `/runtime-*` remains available as the explicit runtime fallback shell for direct control, logs, and stop actions
- when `current` or a lane selection points at a dead task, Andrea now clears the stale selection honestly and tells you to reopen `Current Work` or use the exact-id fallback command
- keep optional integrations behind explicit operator setup instead of treating them as default demo features

Important Cursor rule:

- `/cursor_status` now splits Cloud coding jobs, desktop bridge terminal control, desktop agent-job compatibility, and Cursor-backed runtime routing into separate lines
- if it says `Cloud coding jobs: unavailable`, treat `/cursor-create`, `/cursor-followup`, `/cursor-stop`, `/cursor-models`, `/cursor-results`, and `/cursor-download` as unavailable until `CURSOR_API_KEY` is configured
- if it says `Desktop bridge terminal control: unavailable`, treat `/cursor-terminal*` and desktop session recovery as unavailable until the bridge is configured and reachable
- if it says `Desktop bridge agent jobs: conditional` or `unavailable`, keep using Cursor Cloud for queued heavy-lift work and treat the bridge as terminal/session control only on that machine
- Cursor desktop bridge control is operator-only. It can inspect bridge-known sessions and run line-oriented shell commands for tracked bridge sessions, but it is not a live PTY or remote desktop surface.

## Using Andrea In Chat

In a direct message:

- use `/start` for quick onboarding
- use `/registermain` to make that DM your main control chat
- ask normal requests in plain English

In a group:

- mention Andrea when you want her to act
- keep high-trust admin tasks in the main control chat when possible

Examples:

```text
@your_bot_username add "renew passport" to my to-do list
@your_bot_username remind me every Monday at 9am to send updates
@your_bot_username research the best standing desks for small apartments
@your_bot_username what's the meaning of life?
```

## Model And Runtime Support

Andrea currently supports:

- Node.js 22.x; repository validation is pinned by `.nvmrc` to 22.22.2
- Docker and Podman for verified agent execution; Apple Container detection is
  retained but agent runs fail closed until its nested read-only mount behavior
  passes the same isolated canary
- Anthropic-compatible model endpoints
- first-class provider council roles for OpenAI, Anthropic/Claude, Gemini, MiniMax, and Brave Search when configured
- OpenAI-key-backed gateways exposed through Anthropic-compatible APIs
- optional 9router / Cursor-backed runtime-routing paths
- optional Cursor Cloud Agents API control via `CURSOR_API_KEY` and optional `CURSOR_API_AUTH_MODE=auto|bearer|basic`
- optional integrations only after operator validation

The root TypeScript artifact is shared across macOS and Windows. Hosted Windows
CI is a cross-platform build/type/test and launcher-contract boundary; it is not
evidence that a native Windows service was rebuilt, restarted, or integration-
tested on a Windows host.

If you need to create or verify a real Cursor Cloud key, see [docs/CURSOR_API_KEYS.md](docs/CURSOR_API_KEYS.md).

Useful runtime validation commands:

```text
/ping
/cursor_status
/debug-status
/debug-level debug chat 60m
/debug-logs current 120
/debug-reset all
```

Useful local validation commands:

```bash
npm run test:major:ci
npm run docs:check
npm run test:major
npm run test:stability
npm run services:status
npm run setup -- --step verify
npm run debug:status
npm run debug:level -- verbose component:container 30m
npm run debug:logs -- stderr 120
npm run debug:reset -- all
```

`npm run services:status` is cross-platform. Lifecycle commands are
platform-specific:

```bash
# Windows
npm run services:start
npm run services:stop
npm run services:restart

# macOS launchd host
npm run mac:services:start
npm run mac:services:stop
npm run mac:services:restart
```

## Verify And Troubleshooting

`npm run setup -- --step verify` now checks two different things:

- `CREDENTIAL_RUNTIME_PROBE`
  - endpoint/auth/model reachability
- `ASSISTANT_EXECUTION_PROBE`
  - whether Andrea's main direct-assistant container path can actually start and produce first output

This verify step is not passive: when configured, it can perform a real model
reachability request and start container execution probes. Use CI-safe and
deterministic commands for offline release gates; run live verification only
with intentional credentials, cost awareness, and operator authorization.

That distinction matters during incidents:

- a passing credential probe does **not** guarantee the assistant lane can answer
- an `initial_output_timeout` is a runtime-startup/output problem, not automatically a missing-key problem
- `/debug-*` commands are operator-only and let you turn log volume up or down live without restarting the service
- `npm run services:status`, `npm run debug:status`, and `npm run setup -- --step verify` now show the serving commit, the local workspace `HEAD`, installed artifact mode, current launch mode, and exact external blockers so host truth and dependency truth do not get mixed together
- if `SERVING_COMMIT_MATCHES_WORKSPACE_HEAD: false`, restart into the current repo before treating any live proof as current
- when you need both restart and verify, run the Windows
  `npm run services:restart` or macOS `npm run mac:services:restart` command,
  wait for it to finish, then run `npm run setup -- --step verify`

## Documentation Map

Use the docs based on what you are trying to do:

- [docs/USER_GUIDE.md](docs/USER_GUIDE.md)
  for daily usage, command examples, and what Andrea can do for end users
- [docs/ADMIN_GUIDE.md](docs/ADMIN_GUIDE.md)
  for setup ownership, security rails, service operations, and release steps
- [docs/SETUP_AND_FEATURES_GUIDE.md](docs/SETUP_AND_FEATURES_GUIDE.md)
  for operator setup, runtime config, and day-to-day operations
- [docs/CHANNEL_COMMANDS_AND_ONBOARDING.md](docs/CHANNEL_COMMANDS_AND_ONBOARDING.md)
  for Telegram onboarding, chat UX, and command reference
- [docs/BACKEND_LANES_ARCHITECTURE.md](docs/BACKEND_LANES_ARCHITECTURE.md)
  for shell-versus-lane ownership, the `{ laneId, jobId }` handle model, and the temporary imported subtree boundary
- [docs/AMAZON_SHOPPING_AND_APPROVALS.md](docs/AMAZON_SHOPPING_AND_APPROVALS.md)
  for Amazon Business setup, safety rails, and shopping commands
- [docs/CURSOR_DESKTOP_BRIDGE.md](docs/CURSOR_DESKTOP_BRIDGE.md)
  for operator-only desktop session recovery and terminal commands on your own machine while Andrea controls it remotely
- [docs/CURSOR_API_KEYS.md](docs/CURSOR_API_KEYS.md)
  for where `CURSOR_API_KEY` comes from, what it enables, and how it differs from the desktop bridge
- [docs/ALEXA_VOICE_INTEGRATION.md](docs/ALEXA_VOICE_INTEGRATION.md)
  for Alexa v1 setup, account-linking rules, Node 22 validation requirements, and the final live-acceptance runbook
- [docs/KNOWLEDGE_LIBRARY.md](docs/KNOWLEDGE_LIBRARY.md)
  for the Knowledge Library model, explicit save/import rules, lexical-first retrieval, and source-grounded answer behavior
- [docs/COMMITMENT_INTELLIGENCE.md](docs/COMMITMENT_INTELLIGENCE.md)
  for commitment strength, ownership, waiting/blocking/delegation, ranking,
  persistence, migration, privacy, and strict certification
- [docs/VERIFIED_CAPABILITY_ACQUISITION.md](docs/VERIFIED_CAPABILITY_ACQUISITION.md)
  for metadata-only capability gaps, resource brokering, exact executable
  bindings, canonical sandbox proof, the synthetic `sandbox_verified` limit,
  authority boundaries, and certification
- [docs/BLUEBUBBLES_CHANNEL_PREP.md](docs/BLUEBUBBLES_CHANNEL_PREP.md)
  for the live BlueBubbles companion channel scope, config, safety model, and current limits
- [docs/ADDONS_AND_FEATURE_MATRIX.md](docs/ADDONS_AND_FEATURE_MATRIX.md)
  for deciding which skills and add-ons to enable
- [docs/TESTING_AND_RELEASE_RUNBOOK.md](docs/TESTING_AND_RELEASE_RUNBOOK.md)
  for release-quality validation
- [docs/README.md](docs/README.md)
  for the full local docs hub

## Repo Structure

Key areas in this repo:

- `src/` - core runtime, channels, IPC, scheduler, container integration
- `docs/` - local operator, onboarding, testing, and reference docs
- `assets/` - Andrea branding and repo visuals
- `container/skills/openclaw-market/` - bundled marketplace catalog
- `groups/` - per-chat working context and memory
- `data/` - runtime data, cache, and marketplace skill state

## Testing And Release Discipline

This repo is meant to be run methodically. The primary CI-safe application
suite is:

```bash
npm run test:major:ci
```

That runs:

1. formatting checks
2. type checking
3. linting
4. unit tests
5. production build

It is not the complete release matrix. Container-runner contracts, AGI gates,
the deterministic sweep and scorecard, documentation, dependency/security
checks, hosted platform checks, and runtime proof are defined in
[the testing and release runbook](docs/TESTING_AND_RELEASE_RUNBOOK.md).

For live operator verification on a real machine, use:

```bash
npm run test:major
```

## Built On

Andrea_NanoBot is built on top of:

- [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw) for the secure runtime base
- [VoltAgent/awesome-openclaw-skills](https://github.com/VoltAgent/awesome-openclaw-skills) for curated skill discovery

This fork is where the Andrea-specific product experience, docs, Telegram UX, and operator workflow improvements live.

## License

MIT
