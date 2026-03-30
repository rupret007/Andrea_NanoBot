# Andrea Add-Ons And Feature Matrix

This file is the practical index of major add-ons in Andrea_NanoBot.
Use it when deciding what to enable, what to leave out, and which skills are worth the added operational complexity.

This is an inventory, not the default public product surface.
Many entries here are optional operator-enabled skills or integrations, and they should not be presented as baseline end-user capabilities unless they are actually configured and validated in the current environment.

Important product split:

- Andrea's public-safe surface stays narrow
- Cursor Cloud is the validated operator-enabled heavy-lift path
- desktop bridge is operator-only and environment-dependent
- runtime routing is a separate diagnostic/config surface

## Core Runtime Features

| Feature                    | What it does                                                 | Notes                                         |
| -------------------------- | ------------------------------------------------------------ | --------------------------------------------- |
| Container isolation        | Runs agents in isolated containers instead of host execution | Docker, Podman, and Apple Container supported |
| Per-group isolation        | Each group gets isolated memory/filesystem context           | Group folder mounted into container           |
| Main-channel control plane | Main chat can manage groups, tasks, and skill enablement     | Non-main chats are scoped to themselves       |
| Scheduler                  | Supports cron, interval, and one-time tasks                  | Tasks run in group context                    |
| Community marketplace      | Search OpenClaw catalog and enable skills per chat           | Global cache + explicit per-chat activation   |

## Setup And Operations Skills

| Skill              | Purpose                                                     | Typical use                                 |
| ------------------ | ----------------------------------------------------------- | ------------------------------------------- |
| `/setup`           | End-to-end installation and initial configuration           | First run or fresh machine setup            |
| `/debug`           | Guided troubleshooting flow                                 | Runtime, channel, auth, or startup failures |
| `/customize`       | Guided behavior and feature changes                         | Ongoing fork customization                  |
| `/update-nanoclaw` | Bring in upstream base updates safely                       | Periodic maintenance                        |
| `/update-skills`   | Refresh installed skill branches                            | Pull skill-level fixes and updates          |
| `/claw`            | Local CLI helper for containerized NanoClaw agent execution | Dev/testing and scripted local runs         |
| `/add-compact`     | Adds manual context compaction control                      | Long-running sessions with large context    |

## Channels And Messaging Extensions

| Skill            | Adds                                     | Platform scope                  |
| ---------------- | ---------------------------------------- | ------------------------------- |
| `/add-whatsapp`  | WhatsApp channel support                 | Cross-platform                  |
| `/add-telegram`  | Telegram channel support                 | Cross-platform                  |
| `/add-discord`   | Discord channel support                  | Cross-platform                  |
| `/add-slack`     | Slack channel support                    | Cross-platform                  |
| `/add-gmail`     | Gmail integration (tool or channel mode) | Cross-platform                  |
| `/add-emacs`     | Emacs interactive channel bridge         | Primarily desktop/dev workflows |
| `/x-integration` | X/Twitter posting and engagement actions | Cross-platform                  |

## Channel Enhancements

| Skill                 | Adds                                        | Dependency                                   |
| --------------------- | ------------------------------------------- | -------------------------------------------- |
| `/add-reactions`      | WhatsApp emoji reaction handling            | Requires WhatsApp integration                |
| `/channel-formatting` | Channel-native formatting output            | Works best with messaging channels installed |
| `/add-telegram-swarm` | Team/specialist swarm behavior for Telegram | Requires Telegram integration                |

## Model, Credentials, And Review Workflows

| Skill                          | Adds                                               | Notes                                          |
| ------------------------------ | -------------------------------------------------- | ---------------------------------------------- |
| `/init-onecli`                 | OneCLI Agent Vault bootstrap                       | Recommended credential mode                    |
| `/use-native-credential-proxy` | Native credential-proxy path instead of OneCLI     | Alternative deployment preference              |
| `/get-qodo-rules`              | Pull org/repo coding rules from Qodo before coding | Requires Qodo config and git repo              |
| `/qodo-pr-resolver`            | Fetch and resolve Qodo PR review issues            | Requires git provider CLI and Qodo-reviewed PR |

## Media And Knowledge Add-Ons

| Skill                      | Adds                                                 | Notes                                     |
| -------------------------- | ---------------------------------------------------- | ----------------------------------------- |
| `/add-voice-transcription` | Voice transcription pipeline via OpenAI Whisper APIs | Requires OpenAI credentials               |
| `/use-local-whisper`       | Local whisper.cpp transcription path                 | Local compute path, no remote Whisper API |
| `/add-image-vision`        | Image attachment understanding workflow              | Useful for channel attachments            |
| `/add-pdf-reader`          | PDF text extraction and agent access                 | Useful for document-heavy workflows       |

## Tooling And Research Add-Ons

| Skill              | Adds                                 | Notes                         |
| ------------------ | ------------------------------------ | ----------------------------- |
| `/add-ollama-tool` | Local Ollama MCP tool access         | Requires local Ollama runtime |
| `/add-parallel`    | Parallel AI research MCP integration | Requires `PARALLEL_API_KEY`   |

## Platform-Specific Add-Ons

| Skill                         | Adds                                       | Platform scope |
| ----------------------------- | ------------------------------------------ | -------------- |
| `/convert-to-apple-container` | Migrates runtime to Apple Container        | macOS only     |
| `/add-macos-statusbar`        | macOS menu bar service controls and status | macOS only     |

## Built-In Container Skills (Always Relevant)

| Skill             | Purpose                                                 | Notes                                             |
| ----------------- | ------------------------------------------------------- | ------------------------------------------------- |
| `/status`         | Quick health check for runtime/tools/tasks/skills       | Main chat only                                    |
| `/capabilities`   | Full capability report (skills, tools, runtime, mounts) | Main chat only                                    |
| `openclaw-market` | Community skill marketplace flow                        | Uses search/enable/disable/list marketplace tools |

## Cursor Operator Surfaces

| Surface | What it does | Notes |
| --- | --- | --- |
| Cursor Cloud jobs | Create, sync, follow up, stop, inspect conversation, and fetch artifacts | Operator-enabled validated path; requires `CURSOR_API_KEY` |
| Cursor desktop bridge | Recover bridge-known sessions and run line-oriented shell commands on your normal Cursor machine | Operator-only; requires bridge setup; no live PTY, GUI control, arbitrary shell attach, or validated local Windows agent-job path |
| Cursor-backed runtime route | Route Andrea's own runtime through a Cursor-aware gateway such as 9router | Optional diagnostic/runtime surface; separate from Cloud job readiness and desktop bridge readiness |
| `/cursor_status` | Show readiness for Cloud, desktop bridge, and runtime-route wiring | Safe status surface; public-safe |

## Marketplace Tool Surface

These runtime tools back the community skill lifecycle:

- `search_openclaw_skills(query, category?, limit=5)`
- `enable_openclaw_skill(skill_url, target_group_jid?)`
- `disable_openclaw_skill(skill_id_or_url, target_group_jid?)`
- `list_enabled_openclaw_skills(target_group_jid?)`
- `install_openclaw_skill(...)` compatibility alias

## Recommended Activation Order For New Installs

1. `/setup`
2. One channel skill (for example `/add-whatsapp` or `/add-telegram`)
3. `/init-onecli` or `/use-native-credential-proxy`
4. Optional media/tooling add-ons (`/add-pdf-reader`, `/add-image-vision`, `/add-ollama-tool`)
5. Marketplace usage when you need additional capabilities
