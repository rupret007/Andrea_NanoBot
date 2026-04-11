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

Use this shorthand when you need the current host story fast:

- **launch-candidate overlay on this Windows host**
  - `core_ready_with_manual_surface_sync`
- **core live-proven**
  - Telegram companion surface
  - Alexa companion while the fresh handled proof remains current
  - Google Calendar scheduling
  - unified work cockpit with Codex/OpenAI runtime
  - life-thread, communication-companion, mission, chief-of-staff, knowledge-library, and action-bundle / outcome-review flows
  - startup / host-control / watchdog / health
- **manual surface sync still pending**
  - Alexa's latest repo interaction-model hash has not been marked as synced locally yet
  - after the Developer Console import/build, run `npm run setup -- --step alexa-model-sync mark-synced`
- **degraded-but-usable**
  - BlueBubbles on this PC: transport and real traffic are healthy, but the canonical self-thread still needs one fresh same-thread `message_action` proof leg
- **externally blocked but optional**
  - outward research
  - Telegram image generation
  - the local Anthropic-compatible LiteLLM compatibility lane
- **fresh-proof gaps, not host failure**
  - daily guidance still needs one fresh same-host proof turn

When operator surfaces disagree, the release truth should come from:

1. `npm run services:status`
2. `npm run setup -- --step verify`
3. `npm run debug:status`
4. `npm run debug:pilot`

## Product Shape In One Minute

Andrea has two different documentation audiences on purpose:

- **User-safe surface**
  - normal conversation
  - calendar help, reminders, planning, quick replies, summaries, and project help
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
- `What am I forgetting?` -> one concrete open loop -> reminder, save, or tracking
- `What should I say back?` -> draft reply -> save, remind later, or continue in-thread
- `Help me plan tonight / this weekend` -> mission -> blocker -> confirmed action
- `What do I owe people?` -> communication review -> reminder or thread follow-up
- source-grounded research -> richer detail -> save to library
- BlueBubbles message help -> summarize -> draft -> send or queue send-later -> optional Telegram escalation

Use these docs as the architecture behind those journeys, not as separate product silos.
For repo-side proof, run `npm run debug:signature-flows`.
That flagship-flow suite and harness are now the primary product proof. Subsystem tests and debug scripts are supporting evidence.

Operator command examples in the docs use hyphen aliases in Telegram, such as `/cursor`, `/cursor-jobs`, `/cursor-create`, and `/purchase-request`.
Underscore aliases remain accepted for compatibility, but they are not the preferred examples anymore.
For Cursor output files specifically, the preferred operator examples are `/cursor-results` and `/cursor-download`. Older `/cursor-artifacts` and `/cursor-artifact-link` aliases still work.

## Feature Guides

Use these when you are enabling or validating specific capabilities:

| Feature                            | Read this                                                                |
| ---------------------------------- | ------------------------------------------------------------------------ |
| Telegram onboarding and command UX | [CHANNEL_COMMANDS_AND_ONBOARDING.md](CHANNEL_COMMANDS_AND_ONBOARDING.md) |
| Formal command inventory           | [COMMAND_SURFACE_REFERENCE.md](COMMAND_SURFACE_REFERENCE.md)             |
| Telegram operator live testing     | [TELEGRAM_OPERATOR_LIVE_TESTING.md](TELEGRAM_OPERATOR_LIVE_TESTING.md)   |
| Approval Center / Action Bundles   | [ACTION_BUNDLES.md](ACTION_BUNDLES.md)                                   |
| Delegation Rules / Safe Automation | [DELEGATION_RULES_AND_SAFE_AUTOMATION.md](DELEGATION_RULES_AND_SAFE_AUTOMATION.md) |
| Messaging Trust Ladder / Live Delivery | [MESSAGING_TRUST_LADDER_AND_LIVE_DELIVERY.md](MESSAGING_TRUST_LADDER_AND_LIVE_DELIVERY.md) |
| Outcome Tracking / Reviews         | [OUTCOME_TRACKING_AND_REVIEWS.md](OUTCOME_TRACKING_AND_REVIEWS.md)       |
| Knowledge Library                  | [KNOWLEDGE_LIBRARY.md](KNOWLEDGE_LIBRARY.md)                             |
| Cursor Cloud API keys              | [CURSOR_API_KEYS.md](CURSOR_API_KEYS.md)                                 |
| Cursor desktop machine access      | [CURSOR_DESKTOP_BRIDGE.md](CURSOR_DESKTOP_BRIDGE.md)                     |
| Alexa Companion Mode               | [ALEXA_VOICE_INTEGRATION.md](ALEXA_VOICE_INTEGRATION.md)                 |
| Amazon shopping + approvals        | [AMAZON_SHOPPING_AND_APPROVALS.md](AMAZON_SHOPPING_AND_APPROVALS.md)     |
| Optional add-ons and skills        | [ADDONS_AND_FEATURE_MATRIX.md](ADDONS_AND_FEATURE_MATRIX.md)             |

For the productized flagship-flow view specifically:

- daily orientation and open-loops recovery: [CHIEF_OF_STAFF_MODE.md](CHIEF_OF_STAFF_MODE.md) + [PROACTIVE_RITUALS.md](PROACTIVE_RITUALS.md)
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
- Telegram ordinary chat and the main flagship follow-through journeys were live-proven on this host on April 7, 2026
- Alexa is status-led on this host: it is currently `live_proven` while the handled proof stays fresh, and the latest repo model is tracked separately through the local Alexa model-sync marker
- after restart, operator surfaces may credit that Alexa proof either from the persisted handled signed-request markers or from a recent same-host `alexa_orientation` pilot success that already recorded the qualifying handled turn
- BlueBubbles is status-led on this host: it is currently `degraded_but_usable` because transport is healthy but the canonical same-thread `message_action` leg still needs a fresh repro in `bb:iMessage;-;+14695405551`
- outward-facing research and Telegram image generation are currently optional provider-blocked lanes on this host
- the local Anthropic-compatible LiteLLM gateway remains a separate compatibility/runtime lane and should be reported separately if it degrades later

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

| Read this                                                      | Use it for                                |
| -------------------------------------------------------------- | ----------------------------------------- |
| [SPEC.md](SPEC.md)                                             | Runtime architecture and IPC model        |
| [SDK_DEEP_DIVE.md](SDK_DEEP_DIVE.md)                           | Agent SDK/runtime implementation details  |
| [skills-as-branches.md](skills-as-branches.md)                 | Skill and branch workflow internals       |
| [APPLE-CONTAINER-NETWORKING.md](APPLE-CONTAINER-NETWORKING.md) | Apple Container network behavior on macOS |
| [docker-sandboxes.md](docker-sandboxes.md)                     | Docker sandbox notes                      |

`SPEC.md` is a historical runtime reference. When it disagrees with current operator docs or live host behavior, follow the current README, admin guide, setup guide, and Alexa guide.

## Quick Rule

- If you are trying to use Andrea: read the user guide first.
- If you are trying to keep Andrea safe and running: read the admin guide first.
- If you are trying to enable Cursor features: read the Cloud or desktop bridge guide before changing `.env`.
- If you are changing core internals: read the runtime docs before touching code.
