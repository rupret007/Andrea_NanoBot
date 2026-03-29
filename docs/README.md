# Andrea Documentation

This docs directory is the local source of truth for operating and maintaining Andrea_NanoBot.

Andrea is built on the NanoClaw runtime, so some lower-level reference material still describes the underlying NanoClaw architecture and internals.
When you are deciding what to read, use the guide below.

## Start Here

If you are setting up or running Andrea, read these first:

| Goal                                        | Read this                                                                | Why it exists                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Get Andrea running on your machine          | [SETUP_AND_FEATURES_GUIDE.md](SETUP_AND_FEATURES_GUIDE.md)               | End-to-end operator setup, runtime choices, model config, and go-live flow                   |
| Understand what users do in chat            | [CHANNEL_COMMANDS_AND_ONBOARDING.md](CHANNEL_COMMANDS_AND_ONBOARDING.md) | Telegram onboarding, commands, DM vs group usage, and user-facing examples                   |
| Add voice without adding a second assistant | [ALEXA_VOICE_INTEGRATION.md](ALEXA_VOICE_INTEGRATION.md)                 | Alexa setup, signed endpoint flow, allowlists, and the importable interaction model          |
| Configure shopping with approval safety     | [AMAZON_SHOPPING_AND_APPROVALS.md](AMAZON_SHOPPING_AND_APPROVALS.md)     | Amazon Business setup, guarded purchase flow, and why Andrea refuses to freestyle with money |
| Decide which optional features to add       | [ADDONS_AND_FEATURE_MATRIX.md](ADDONS_AND_FEATURE_MATRIX.md)             | Practical map of skills, channels, tooling add-ons, and platform scope                       |
| Validate a release before shipping          | [TESTING_AND_RELEASE_RUNBOOK.md](TESTING_AND_RELEASE_RUNBOOK.md)         | Repeatable testing process, including the three-round stability gate                         |

## Operator And Debugging Docs

Use these when something is wrong or you need to verify a specific runtime area:

| Read this                                                      | Use it for                                            |
| -------------------------------------------------------------- | ----------------------------------------------------- |
| [DEBUG_CHECKLIST.md](DEBUG_CHECKLIST.md)                       | Fast incident triage and common failure patterns      |
| [../PRIVACY.md](../PRIVACY.md)                                 | Public-facing privacy policy for Telegram or repo use |
| [SECURITY.md](SECURITY.md)                                     | Security model and isolation assumptions              |
| [REQUIREMENTS.md](REQUIREMENTS.md)                             | Environment, tool, and capability baseline            |
| [APPLE-CONTAINER-NETWORKING.md](APPLE-CONTAINER-NETWORKING.md) | Apple Container networking details on macOS           |
| [docker-sandboxes.md](docker-sandboxes.md)                     | Docker Sandboxes / micro-VM style isolation notes     |

## Runtime And Architecture References

These are useful when changing core behavior or reviewing how the inherited runtime works:

| Read this                                      | Use it for                                              |
| ---------------------------------------------- | ------------------------------------------------------- |
| [SPEC.md](SPEC.md)                             | Runtime architecture, storage, IPC, and system behavior |
| [SDK_DEEP_DIVE.md](SDK_DEEP_DIVE.md)           | Claude SDK and agent-runner details                     |
| [skills-as-branches.md](skills-as-branches.md) | How the skill and branch model works                    |

## How To Read These Docs Accurately

The most practical reading rule is:

- if you are operating Andrea day to day, prefer the Andrea-specific guides above
- if you are changing core runtime internals, read the lower-level NanoClaw-derived reference docs too

That keeps the docs useful without pretending every inherited runtime document has already been fully rewritten from scratch.
