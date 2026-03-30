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

## Feature Guides

Use these when you are enabling or validating specific capabilities:

| Feature                            | Read this                                                                |
| ---------------------------------- | ------------------------------------------------------------------------ |
| Telegram onboarding and command UX | [CHANNEL_COMMANDS_AND_ONBOARDING.md](CHANNEL_COMMANDS_AND_ONBOARDING.md) |
| Cursor Cloud API keys              | [CURSOR_API_KEYS.md](CURSOR_API_KEYS.md)                                 |
| Cursor desktop machine access      | [CURSOR_DESKTOP_BRIDGE.md](CURSOR_DESKTOP_BRIDGE.md)                     |
| Alexa voice ingress                | [ALEXA_VOICE_INTEGRATION.md](ALEXA_VOICE_INTEGRATION.md)                 |
| Amazon shopping + approvals        | [AMAZON_SHOPPING_AND_APPROVALS.md](AMAZON_SHOPPING_AND_APPROVALS.md)     |
| Optional add-ons and skills        | [ADDONS_AND_FEATURE_MATRIX.md](ADDONS_AND_FEATURE_MATRIX.md)             |

For the default live demo, stay on Telegram + direct replies + reminders/tasks + `/cursor_status` unless you validated optional integrations that same day.

## Operations, Security, And Release

Use these during incidents, audits, or release preparation:

| Need                     | Read this                                                        |
| ------------------------ | ---------------------------------------------------------------- |
| Incident triage          | [DEBUG_CHECKLIST.md](DEBUG_CHECKLIST.md)                         |
| Security model           | [SECURITY.md](SECURITY.md)                                       |
| Environment requirements | [REQUIREMENTS.md](REQUIREMENTS.md)                               |
| Release test gate        | [TESTING_AND_RELEASE_RUNBOOK.md](TESTING_AND_RELEASE_RUNBOOK.md) |
| Public privacy policy    | [../PRIVACY.md](../PRIVACY.md)                                   |

## Runtime Internals

Only read these when changing core runtime behavior:

| Read this                                                      | Use it for                                |
| -------------------------------------------------------------- | ----------------------------------------- |
| [SPEC.md](SPEC.md)                                             | Runtime architecture and IPC model        |
| [SDK_DEEP_DIVE.md](SDK_DEEP_DIVE.md)                           | Agent SDK/runtime implementation details  |
| [skills-as-branches.md](skills-as-branches.md)                 | Skill and branch workflow internals       |
| [APPLE-CONTAINER-NETWORKING.md](APPLE-CONTAINER-NETWORKING.md) | Apple Container network behavior on macOS |
| [docker-sandboxes.md](docker-sandboxes.md)                     | Docker sandbox notes                      |

## Quick Rule

- If you are trying to use Andrea: read the user guide first.
- If you are trying to keep Andrea safe and running: read the admin guide first.
- If you are changing core internals: read the runtime docs before touching code.
