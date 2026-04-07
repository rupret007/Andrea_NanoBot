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

## Product Shape In One Minute

Andrea has two different documentation audiences on purpose:

- **User-safe surface**
  - normal conversation
  - reminders, quick replies, summaries, and project help
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

- Alexa daily orientation -> Telegram richer follow-through
- `What am I forgetting?` -> one concrete open loop -> reminder, save, or tracking
- `What's still open with Candace?` -> draft reply -> save to thread or remind later
- `Help me plan tonight / this weekend` -> mission -> blocker -> confirmed action
- source-grounded research -> richer detail -> save to library
- BlueBubbles message help -> summarize -> draft -> remind later -> optional Telegram escalation

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
| Telegram operator live testing     | [TELEGRAM_OPERATOR_LIVE_TESTING.md](TELEGRAM_OPERATOR_LIVE_TESTING.md)   |
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
- research -> saveable output: [KNOWLEDGE_LIBRARY.md](KNOWLEDGE_LIBRARY.md)
- cross-surface continuity: [CROSS_CHANNEL_HANDOFFS.md](CROSS_CHANNEL_HANDOFFS.md) + [ALEXA_VOICE_INTEGRATION.md](ALEXA_VOICE_INTEGRATION.md)

For the default live demo, stay on Telegram conversation + direct replies + reminders/tasks + `/help` + `/cursor_status` unless you validated optional integrations that same day.

Current Alexa truth:

- `Andrea_NanoBot` is the only canonical repo now; the older `ANDREA/nanoclaw` checkout is non-authoritative reference only
- Telegram ordinary chat and the main flagship follow-through journeys were live-proven on this host on April 7, 2026
- Alexa repo-side and near-live proof are strong, but full live acceptance still means one fresh signed Alexa utterance on this host after importing the current interaction model and running `Build Model`
- BlueBubbles remains near-live until a reachable live server/webhook is reproved
- outward-facing research is currently validated as a graceful blocked path on this host because direct provider credentials are not currently usable for live outward lookup, even though the local runtime backend remains healthy

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
