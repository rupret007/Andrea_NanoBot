# Andrea Documentation

This folder is the source of truth for running Andrea_NanoBot in production and day-to-day usage.

## Read By Role

Start with exactly one document based on your role:

| Role               | Read this first                                            | Why                                                                    |
| ------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| End user           | [USER_GUIDE.md](USER_GUIDE.md)                             | Daily usage, most useful commands, practical examples                  |
| Operator/Admin     | [ADMIN_GUIDE.md](ADMIN_GUIDE.md)                           | Ownership model, security defaults, service operations, release checks |
| Setup owner        | [SETUP_AND_FEATURES_GUIDE.md](SETUP_AND_FEATURES_GUIDE.md) | End-to-end install and runtime configuration                           |
| Live demo operator | [DEMO_CHECKLIST.md](DEMO_CHECKLIST.md)                     | Tight demo script, preflight checks, and what to avoid demoing         |

## Current Field-Trial Truth

[CURRENT_STATUS.md](CURRENT_STATUS.md) is the dated repository and host
snapshot. Do not copy host paths, personal channel identifiers, or a proof
label from this page into release notes; refresh the operator commands below.

The dated snapshot is deliberately conservative. The action-authority tree has
passed its primary, focused, container, AGI, deterministic, certification,
scorecard, signature, documentation, and dependency-audit gates. Publication,
hosted CI, and the exact version serving on the canonical Mac host are
time-sensitive and must be queried rather than inferred from this index. The Release-Readiness candidate
has only labeled synthetic
`owner_review_required` evidence: no real canary, protected action decision,
owner verdict, activation, or reuse is claimed. Repository, hosted-CI, runtime,
and genuine live proof remain distinct in
[CURRENT_STATUS.md](CURRENT_STATUS.md). Do not infer deployment from source
files or this index.

The latest dated host snapshot records:

- **canonical Mac mini runtime**: use `npm run services:status` to refresh the
  exact committed, built, and serving SHA plus current OpenClaw and Andrea
  process identities; this index deliberately does not pin a release SHA
- every release needs its own exact-SHA hosted result; a prior green SHA does
  not certify a later commit
- the latest bounded cleanup reclaimed about 3 GiB of regenerable package and
  compile caches; active containers, Docker images and volumes, models,
  messages, session history, repository dependencies, build output, and live
  Andrea data were preserved, and free space must still be rechecked before
  release
- Telegram transport is healthy; the last recorded `/ping` roundtrip at
  `2026-07-14T15:10:07.618Z` is aged and needs a genuine user-path refresh
- BlueBubbles transport is reachable, while a same-thread action proof can age
  independently and must remain explicit in the dated status
- **manual live proof still pending**: Alexa needs a fresh signed handled
  custom-skill `IntentRequest`; any aged Telegram, BlueBubbles, or life-thread
  proof must remain operator debt rather than repository failure
- Google Calendar is live-proven; configured provider entries are not live
  health claims unless a current probe or verified-use record says so
- flagship journey proofs can age out separately from integration health
- Telegram stays the dependable main messaging surface while optional channel
  proof is stale

Retired wording such as “BlueBubbles optional Messages bridge with a fresh canonical same-thread `message_action` proof” describes an aged-out historical result and must not be used as the current host claim.

After any Alexa interaction-model change, import/build in the Developer Console
and run `npm run setup -- --step alexa-model-sync mark-synced`.

When operator surfaces disagree, the release truth should come from:

1. `npm run services:status`
2. `npm run setup -- --step verify` (live; may call a model and start a
   container execution probe)
3. `npm run debug:status`
4. `npm run debug:pilot`

## Product Shape In One Minute

Andrea has two different documentation audiences on purpose:

- **User-safe surface**
  - normal conversation
  - schedule help, reminders, groceries, errands, meal planning, recurring household obligations, quick replies, summaries, bill follow-through, and project help
  - personalized setup so Andrea can learn what to track and how to surface it
  - the narrow public Telegram command set
  - `/cursor_status` as the only public-safe Cursor readiness check
- **Operator-only surface**
  - setup, environment variables, startup/restart/verify
  - Cursor Cloud job workflows
  - desktop bridge terminal/session workflows
  - Alexa Companion Mode setup and live validation
  - troubleshooting, validation, and release gates

Cursor-specific docs also split into three surfaces:

- **Cursor Cloud**: queued heavy-lift coding jobs, requires `CURSOR_API_KEY`
- **Cursor desktop bridge**: operator-only session recovery plus line-oriented terminal control, requires `CURSOR_DESKTOP_BRIDGE_URL` and `CURSOR_DESKTOP_BRIDGE_TOKEN`
- **Cursor-backed runtime route**: optional diagnostic/runtime-routing surface, separate from both Cloud jobs and desktop bridge readiness

## Signature Flows

Andrea's current flagship journeys are:

- Alexa or Telegram schedule check -> reminder, move, or richer follow-through
- `What's on my calendar tomorrow?` -> short read -> add, move, or reminder
- `Help me set this up` -> proposed Andrea setup -> approved lists and routines
- `Add milk to my shopping list` -> zero-setup capture -> grouped list readout -> done, defer, remind, move, or plan follow-up
- `What do we need from the store?` / `What's left for tonight?` -> smart household slice -> Telegram for the fuller review
- `Remind me to take my pills at 9` -> clear reminder confirmation -> one next move
- `What bills do I need to pay this week?` -> open follow-through -> reminder or plan
- `What's missing for dinner?` / `What should I handle this weekend?` -> practical household view -> one grounded next step
- `Make this a monthly bill` -> recurring obligation -> resurfaces when due without turning into a second task system
- `What am I forgetting?` -> one concrete open loop -> reminder, save, or tracking
- `What should I say back?` -> draft reply -> save, remind later, or continue in-thread
- `Help me plan tonight / this weekend / meals this week` -> mission -> blocker -> confirmed action
- `What do I owe people?` -> communication review -> reminder or thread follow-up
- source-grounded research -> richer detail -> save to library
- Messages bridge help when available -> summarize -> draft -> send or queue send-later -> optional Telegram escalation

OpenBubbles remains a future/provider-feasibility track, not a live Andrea runtime provider. BlueBubbles is the active Messages bridge on this Mac mini.

Use these docs as the architecture behind those journeys, not as separate product silos.
For repo-side proof, run `npm run debug:signature-flows`.
That flagship-flow suite and harness are now the primary product proof. Subsystem tests and debug scripts are supporting evidence.

Operator command examples in the docs use hyphen aliases in Telegram, such as `/cursor`, `/cursor-jobs`, `/cursor-create`, and `/purchase-request`.
Underscore aliases remain accepted for compatibility, but they are not the preferred examples anymore.
For Cursor output files specifically, the preferred operator examples are `/cursor-results` and `/cursor-download`. Older `/cursor-artifacts` and `/cursor-artifact-link` aliases still work.

## Feature Guides

Use these when you are enabling or validating specific capabilities:

| Feature                                | Read this                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------ |
| Telegram onboarding and command UX     | [CHANNEL_COMMANDS_AND_ONBOARDING.md](CHANNEL_COMMANDS_AND_ONBOARDING.md)                   |
| Formal command inventory               | [COMMAND_SURFACE_REFERENCE.md](COMMAND_SURFACE_REFERENCE.md)                               |
| Telegram operator live testing         | [TELEGRAM_OPERATOR_LIVE_TESTING.md](TELEGRAM_OPERATOR_LIVE_TESTING.md)                     |
| Follow-Through Reviews / Approvals     | [ACTION_BUNDLES.md](ACTION_BUNDLES.md)                                                     |
| Delegation Rules / Safe Automation     | [DELEGATION_RULES_AND_SAFE_AUTOMATION.md](DELEGATION_RULES_AND_SAFE_AUTOMATION.md)         |
| Grounded response intelligence         | [GROUNDED_RESPONSE_INTELLIGENCE.md](GROUNDED_RESPONSE_INTELLIGENCE.md)                     |
| Messaging Trust Ladder / Live Delivery | [MESSAGING_TRUST_LADDER_AND_LIVE_DELIVERY.md](MESSAGING_TRUST_LADDER_AND_LIVE_DELIVERY.md) |
| Outcome Tracking / Reviews             | [OUTCOME_TRACKING_AND_REVIEWS.md](OUTCOME_TRACKING_AND_REVIEWS.md)                         |
| Adaptive cognition core and rollout    | [ADAPTIVE_COGNITIVE_CORE.md](ADAPTIVE_COGNITIVE_CORE.md)                                   |
| Adaptive cognition live dogfood gate   | [ADAPTIVE_COGNITION_DOGFOOD.md](ADAPTIVE_COGNITION_DOGFOOD.md)                             |
| Knowledge Library                      | [KNOWLEDGE_LIBRARY.md](KNOWLEDGE_LIBRARY.md)                                               |
| Commitment Intelligence                | [COMMITMENT_INTELLIGENCE.md](COMMITMENT_INTELLIGENCE.md)                                   |
| Verified capability acquisition        | [VERIFIED_CAPABILITY_ACQUISITION.md](VERIFIED_CAPABILITY_ACQUISITION.md)                   |
| Verified production apprenticeship     | [VERIFIED_PRODUCTION_APPRENTICESHIP.md](VERIFIED_PRODUCTION_APPRENTICESHIP.md)             |
| Cursor Cloud API keys                  | [CURSOR_API_KEYS.md](CURSOR_API_KEYS.md)                                                   |
| Cursor desktop machine access          | [CURSOR_DESKTOP_BRIDGE.md](CURSOR_DESKTOP_BRIDGE.md)                                       |
| Alexa Companion Mode                   | [ALEXA_VOICE_INTEGRATION.md](ALEXA_VOICE_INTEGRATION.md)                                   |
| Amazon shopping + approvals            | [AMAZON_SHOPPING_AND_APPROVALS.md](AMAZON_SHOPPING_AND_APPROVALS.md)                       |
| Optional add-ons and skills            | [ADDONS_AND_FEATURE_MATRIX.md](ADDONS_AND_FEATURE_MATRIX.md)                               |

For the productized flagship-flow view specifically:

- daily orientation and open-loops recovery: [CHIEF_OF_STAFF_MODE.md](CHIEF_OF_STAFF_MODE.md) + [PROACTIVE_RITUALS.md](PROACTIVE_RITUALS.md)
- commitment strength, ownership, waiting/blocking, ranking, and restart truth: [COMMITMENT_INTELLIGENCE.md](COMMITMENT_INTELLIGENCE.md)
- metadata-only capability-gap observation, declared identity/version-digest-pinned
  bindings, canonical durable sandbox proof, synthetic `sandbox_verified` limit,
  and authority boundaries:
  [VERIFIED_CAPABILITY_ACQUISITION.md](VERIFIED_CAPABILITY_ACQUISITION.md)
- implemented canonical canary, separate protected-action approval, exact owner
  review, separate activation, monitored narrow reuse, quarantine, and
  revocation contract; current 22/22 synthetic certification plus focused
  forward-fix validation; the primary, container, AGI, deterministic,
  scorecard, signature, documentation, and audit gates pass; query Git,
  GitHub, and service status for current publication, hosted, and runtime
  evidence, while genuine owner/live proof remains pending:
  [VERIFIED_PRODUCTION_APPRENTICESHIP.md](VERIFIED_PRODUCTION_APPRENTICESHIP.md)
- Candace / people follow-through: [COMMUNICATION_COMPANION.md](COMMUNICATION_COMPANION.md)
- plan creation and execution: [MISSIONS_AND_EXECUTION.md](MISSIONS_AND_EXECUTION.md)
- approval and partial execution: [ACTION_BUNDLES.md](ACTION_BUNDLES.md)
- delegated defaults and safe automation: [DELEGATION_RULES_AND_SAFE_AUTOMATION.md](DELEGATION_RULES_AND_SAFE_AUTOMATION.md)
- draft -> approve -> send -> review: [MESSAGING_TRUST_LADDER_AND_LIVE_DELIVERY.md](MESSAGING_TRUST_LADDER_AND_LIVE_DELIVERY.md)
- closure and carryover review: [OUTCOME_TRACKING_AND_REVIEWS.md](OUTCOME_TRACKING_AND_REVIEWS.md)
- research -> saveable output: [KNOWLEDGE_LIBRARY.md](KNOWLEDGE_LIBRARY.md)
- cross-surface continuity: [CROSS_CHANNEL_HANDOFFS.md](CROSS_CHANNEL_HANDOFFS.md) + [ALEXA_VOICE_INTEGRATION.md](ALEXA_VOICE_INTEGRATION.md)

For the default live demo, stay on Telegram conversation + direct replies + reminders/tasks + `/help` + `/cursor_status` unless you validated optional integrations that same day.

Current host-proof rule:

- `Andrea_NanoBot` is the only canonical repo now; the older `ANDREA/nanoclaw` checkout is non-authoritative reference only
- Telegram ordinary chat and the main flagship follow-through journeys are status-led and should be refreshed with `npm run debug:pilot` before demos
- Alexa is status-led on this host: it is currently manual-action proof debt until a fresh signed handled custom-skill turn is recorded
- after restart, operator surfaces may credit that Alexa proof either from the persisted handled signed-request markers or from a recent same-host `alexa_orientation` pilot success that already recorded the qualifying handled turn
- BlueBubbles is status-led on this host: transport is ready, but current proof
  is `degraded_but_usable`/`needs_proof` until the configured canonical
  self-thread records a fresh `message_action` chain
- outward-facing research and Telegram image generation should be called
  healthy only when a current provider status or verified-use record is green
- local compatibility/runtime lanes should be reported separately from direct provider health if they degrade later

## Pilot Review Loop

Andrea now has one bounded pilot-mode review surface for this host:

```bash
npm run debug:pilot
```

That operator-only view shows:

- current pilot-readiness proof by surface
- the 7 flagship journey proof states
- proof freshness and 24h / 7d usage by flagship journey
- recent flagged outcomes, including degraded-but-usable fallback
- open private pilot issues
- grouped Alexa utterance-review patterns through the Alexa router when those review signals exist

Private pilot issue capture is explicit and local-only. During dogfooding, you can say:

- `this felt weird`
- `that answer was off`
- `this shouldn't have happened`
- `save this as a pilot issue`
- `mark this flow as awkward`

Important limits:

- this does not create a public bug tracker
- raw transcripts are not stored in pilot instrumentation
- set `ANDREA_PILOT_LOGGING_ENABLED=0` if you need to disable journey logging and explicit pilot issue capture on a host

For Alexa-specific router tuning, also use:

- `npm run debug:alexa-conversation`
- `npm run debug:alexa-conversation -- --review`

## Operations, Security, And Release

Use these during incidents, audits, or release preparation:

| Need                     | Read this                                                        |
| ------------------------ | ---------------------------------------------------------------- |
| Incident triage          | [DEBUG_CHECKLIST.md](DEBUG_CHECKLIST.md)                         |
| Security model           | [SECURITY.md](SECURITY.md)                                       |
| Environment requirements | [REQUIREMENTS.md](REQUIREMENTS.md)                               |
| Release test gate        | [TESTING_AND_RELEASE_RUNBOOK.md](TESTING_AND_RELEASE_RUNBOOK.md) |
| Public privacy policy    | [../PRIVACY.md](../PRIVACY.md)                                   |

Current Andrea operator truth lives in the README, admin guide, setup guide, and Alexa guide. `REQUIREMENTS.md` remains useful background, but it is historical NanoClaw design reference rather than the day-to-day operations source of truth.

## Runtime Internals

Only read these when changing core runtime behavior:

| Read this                                                      | Use it for                                                                         |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [SPEC.md](SPEC.md)                                             | Historical runtime and IPC reference                                               |
| [SDK_DEEP_DIVE.md](SDK_DEEP_DIVE.md)                           | Agent SDK/runtime implementation details                                           |
| [skills-as-branches.md](skills-as-branches.md)                 | Skill and branch workflow internals                                                |
| [APPLE-CONTAINER-NETWORKING.md](APPLE-CONTAINER-NETWORKING.md) | Historical Apple Container network notes; agent execution is currently fail-closed |
| [docker-sandboxes.md](docker-sandboxes.md)                     | Retired Docker Sandbox guide and the supported container-validation path           |

`SPEC.md` is a historical runtime reference. When it disagrees with current operator docs or live host behavior, follow the current README, admin guide, setup guide, and Alexa guide.

## Intelligence Design And Evidence

These documents describe the intelligence goal without turning experimental
modules or synthetic scores into production claims:

| Topic                                                               | Read this                                                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Grounded intelligence and verified-agency direction                 | [AGI_ROADMAP.md](AGI_ROADMAP.md)                                               |
| Evaluation classes and what each result can prove                   | [AGI_EVALUATION.md](AGI_EVALUATION.md)                                         |
| Intelligence-layer security and production trust boundaries         | [AGI_SECURITY.md](AGI_SECURITY.md)                                             |
| Durable agency contract, invariants, and proof requirements         | [ANDREA_DURABLE_AGENCY_PLAN.md](ANDREA_DURABLE_AGENCY_PLAN.md)                 |
| Implemented sandbox-to-production apprenticeship and proof boundary | [VERIFIED_PRODUCTION_APPRENTICESHIP.md](VERIFIED_PRODUCTION_APPRENTICESHIP.md) |

Use [CURRENT_STATUS.md](CURRENT_STATUS.md) for the dated host/release snapshot
and [TESTING_AND_RELEASE_RUNBOOK.md](TESTING_AND_RELEASE_RUNBOOK.md) for the
actual commands and acceptance gates.

## Quick Rule

- If you are trying to use Andrea: read the user guide first.
- If you are trying to keep Andrea safe and running: read the admin guide first.
- If you are trying to enable Cursor features: read the Cloud or desktop bridge guide before changing `.env`.
- If you are changing core internals: read the runtime docs before touching code.
