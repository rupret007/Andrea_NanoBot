<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  An AI assistant that runs agents securely in their own containers. Lightweight, built to be easily understood and completely customized for your needs.
</p>

<p align="center">
  <a href="https://nanoclaw.dev">nanoclaw.dev</a>&nbsp; • &nbsp;
  <a href="https://docs.nanoclaw.dev">docs</a>&nbsp; • &nbsp;
  <a href="README_zh.md">中文</a>&nbsp; • &nbsp;
  <a href="README_ja.md">日本語</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>&nbsp; • &nbsp;
  <a href="repo-tokens"><img src="repo-tokens/badge.svg" alt="34.9k tokens, 17% of context window" valign="middle"></a>
</p>

---

## Why I Built NanoClaw

[OpenClaw](https://github.com/openclaw/openclaw) is an impressive project, but I wouldn't have been able to sleep if I had given complex software I didn't understand full access to my life. OpenClaw has nearly half a million lines of code, 53 config files, and 70+ dependencies. Its security is at the application level (allowlists, pairing codes) rather than true OS-level isolation. Everything runs in one Node process with shared memory.

NanoClaw provides that same core functionality, but in a codebase small enough to understand: one process and a handful of files. Claude agents run in their own Linux containers with filesystem isolation, not merely behind permission checks.

## Quick Start

```bash
gh repo fork qwibitai/nanoclaw --clone
cd nanoclaw
claude
```

<details>
<summary>Without GitHub CLI</summary>

1. Fork [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw) on GitHub (click the Fork button)
2. `git clone https://github.com/<your-username>/nanoclaw.git`
3. `cd nanoclaw`
4. `claude`

</details>

Then run `/setup`. Claude Code handles everything: dependencies, authentication, container setup and service configuration.
For Telegram-first installs, you can bootstrap the main control chat by DMing the bot `/registermain` once.

> **Note:** Commands prefixed with `/` (like `/setup`, `/add-whatsapp`) are [Claude Code skills](https://code.claude.com/docs/en/skills). Type them inside the `claude` CLI prompt, not in your regular terminal. If you don't have Claude Code installed, get it at [claude.com/product/claude-code](https://claude.com/product/claude-code).

Need the full local operator guide (setup + usage + add-ons)?
See [docs/SETUP_AND_FEATURES_GUIDE.md](docs/SETUP_AND_FEATURES_GUIDE.md).
For a feature-by-feature add-on index, see [docs/ADDONS_AND_FEATURE_MATRIX.md](docs/ADDONS_AND_FEATURE_MATRIX.md).
For the full test/release checklist used each major iteration, see [docs/TESTING_AND_RELEASE_RUNBOOK.md](docs/TESTING_AND_RELEASE_RUNBOOK.md).

## Philosophy

**Small enough to understand.** One process, a few source files and no microservices. If you want to understand the full NanoClaw codebase, just ask Claude Code to walk you through it.

**Secure by isolation.** Agents run in Linux containers (Apple Container on macOS, Docker, or Podman) and they can only see what's explicitly mounted. Bash access is safe because commands run inside the container, not on your host.

**Built for the individual user.** NanoClaw isn't a monolithic framework; it's software that fits each user's exact needs. Instead of becoming bloatware, NanoClaw is designed to be bespoke. You make your own fork and have Claude Code modify it to match your needs.

**Customization = code changes.** No configuration sprawl. Want different behavior? Modify the code. The codebase is small enough that it's safe to make changes.

**AI-native.**

- No installation wizard; Claude Code guides setup.
- No monitoring dashboard; ask Claude what's happening.
- No debugging tools; describe the problem and Claude fixes it.

**Skills over features.** Instead of adding features (e.g. support for Telegram) to the codebase, contributors submit [claude code skills](https://code.claude.com/docs/en/skills) like `/add-telegram` that transform your fork. You end up with clean code that does exactly what you need.

**Best harness, best model.** NanoClaw runs on the Claude Agent SDK, which means you're running Claude Code directly. Claude Code is highly capable and its coding and problem-solving capabilities allow it to modify and expand NanoClaw and tailor it to each user.

## What It Supports

- **Multi-channel messaging** - Talk to your assistant from WhatsApp, Telegram, Discord, Slack, or Gmail. Add channels with skills like `/add-whatsapp` or `/add-telegram`. Run one or many at the same time.
- **Isolated group context** - Each group has its own `CLAUDE.md` memory, isolated filesystem, and runs in its own container sandbox with only that filesystem mounted to it.
- **Main channel** - Your private channel (self-chat) for admin control; every group is completely isolated
- **Scheduled tasks** - Recurring jobs that run Claude and can message you back
- **Web access** - Search and fetch content from the Web
- **Container isolation** - Agents are sandboxed in Podman, Docker, [Docker Sandboxes](docs/docker-sandboxes.md) (micro VM isolation), or Apple Container (macOS)
- **Credential security** - Agents never hold raw API keys when [OneCLI's Agent Vault](https://github.com/onecli/onecli) is running. Outbound requests route through OneCLI for request-time credential injection and policy enforcement. If OneCLI is unavailable, NanoClaw can fall back to explicit `.env` passthrough of a minimal credential set so the system still runs.
- **Agent Swarms** - Spin up teams of specialized agents that collaborate on complex tasks
- **Community skill marketplace** - Search a bundled catalog of curated OpenClaw skills, cache them once globally, and explicitly enable or disable them per chat
- **Optional integrations** - Add Gmail (`/add-gmail`) and more via skills

## Usage

Talk to your assistant with the trigger word (default: `@Andy`):

```
@Andy send an overview of the sales pipeline every weekday morning at 9am (has access to my Obsidian vault folder)
@Andy review the git history for the past week each Friday and update the README if there's drift
@Andy every Monday at 8am, compile news on AI developments from Hacker News and TechCrunch and message me a briefing
```

From the main channel (your self-chat), you can manage groups and tasks:

```
@Andy list all scheduled tasks across groups
@Andy pause the Monday briefing task
@Andy join the Family Chat group
```

Cursor-focused runtime checks are also available as control commands:

```
/cursor_status
/cursor_test
/cursor_remote
/cursor_remote_end
```

You can also install community OpenClaw skills without giving them access to every chat:

```
@Andy search for a community skill that can review GitHub Actions failures
@Andy enable the martok9803-ci-whisperer skill in this chat
```

NanoClaw caches community skills under `data/marketplace/skills/<owner>/<slug>/` and only copies them into a chat's isolated `.claude/skills` directory when that chat explicitly enables them. A skill enabled in one chat does not automatically appear in the others, and disabling it removes only that chat's copy.

## Customizing

NanoClaw doesn't use configuration files. To make changes, just tell Claude Code what you want:

- "Change the trigger word to @Bob"
- "Remember in the future to make responses shorter and more direct"
- "Add a custom greeting when I say good morning"
- "Store conversation summaries weekly"

Or run `/customize` for guided changes.

The codebase is small enough that Claude can safely modify it.

## Contributing

**Don't add features. Add skills.**

If you want to add Telegram support, don't create a PR that adds Telegram to the core codebase. Instead, fork NanoClaw, make the code changes on a branch, and open a PR. We'll create a `skill/telegram` branch from your PR that other users can merge into their fork.

Users then run `/add-telegram` on their fork and get clean code that does exactly what they need, not a bloated system trying to support every use case.

### RFS (Request for Skills)

Skills we'd like to see:

**Communication Channels**

- `/add-signal` - Add Signal as a channel

## Requirements

- macOS, Linux, or Windows
- Node.js 22.x (required; Node 24 is not supported in this repo baseline)
- [Claude Code](https://claude.ai/download)
- One of:
  - [Docker](https://docker.com/products/docker-desktop) (supported on Windows, macOS, and Linux)
  - [Podman](https://podman.io/) (supported on Windows and Linux)
  - [Apple Container](https://github.com/apple/container) (macOS)

## Architecture

```
Channels --> SQLite --> Polling loop --> Container (Claude Agent SDK) --> Response
```

Single Node.js process. Channels are added via skills and self-register at startup — the orchestrator connects whichever ones have credentials present. Agents execute in isolated Linux containers with filesystem isolation. Only mounted directories are accessible. Per-group message queue with concurrency control. IPC via filesystem.

For the full architecture details, see the [documentation site](https://docs.nanoclaw.dev/concepts/architecture).

Key files:

- `src/index.ts` - Orchestrator: state, message loop, agent invocation
- `src/channels/registry.ts` - Channel registry (self-registration at startup)
- `src/ipc.ts` - IPC watcher and task processing
- `src/router.ts` - Message formatting and outbound routing
- `src/group-queue.ts` - Per-group queue with global concurrency limit
- `src/container-runner.ts` - Spawns streaming agent containers
- `src/task-scheduler.ts` - Runs scheduled tasks
- `src/db.ts` - SQLite operations (messages, groups, sessions, state)
- `groups/*/CLAUDE.md` - Per-group memory

## FAQ

**Which container runtime should I use?**

NanoClaw supports Podman, Docker, and Apple Container. On Windows, Docker and Podman both work (auto-selection prefers Docker when available). On macOS, Apple Container and Docker both work. On Linux, Docker and Podman both work. NanoClaw auto-selects a runtime if you do not set `CONTAINER_RUNTIME`, and you can force one with `CONTAINER_RUNTIME=podman`, `docker`, or `apple-container`.

**Can I run this on Linux or Windows?**

Yes. Windows now works with native PowerShell plus Podman or Docker, and WSL remains acceptable. Linux works with Docker or Podman. Just run `/setup`.

**Is this secure?**

Agents run in containers, not behind application-level permission checks. They can only access explicitly mounted directories. In the recommended setup, credentials never enter the container — outbound API requests route through [OneCLI's Agent Vault](https://github.com/onecli/onecli), which injects authentication at the proxy level and supports rate limits and access policies. If OneCLI is down or not yet installed, NanoClaw can fall back to direct `.env` credential passthrough so you can still operate while recovering the gateway. You should still review what you're running, but the codebase is small enough that you actually can. See the [security documentation](https://docs.nanoclaw.dev/concepts/security) for the full security model.

**Why no configuration files?**

We don't want configuration sprawl. Every user should customize NanoClaw so that the code does exactly what they want, rather than configuring a generic system. If you prefer having config files, you can tell Claude to add them.

**Can I use third-party, OpenAI, or open-source models?**

Yes. NanoClaw supports Anthropic-compatible model endpoints.

Anthropic / Claude credentials:

```bash
ANTHROPIC_AUTH_TOKEN=your-token-here
# or ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN
```

OpenAI key via an Anthropic-compatible gateway:

```bash
ANTHROPIC_BASE_URL=https://your-anthropic-compatible-endpoint.com
# or OPENAI_BASE_URL=https://your-anthropic-compatible-endpoint.com
OPENAI_API_KEY=your-openai-key
```

9Router (including Cursor-backed model routing):

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:20128/v1
ANTHROPIC_AUTH_TOKEN=your-9router-api-key
NANOCLAW_AGENT_MODEL=cu/default
```

`localhost` / `127.0.0.1` endpoints are automatically rewritten to the active
container runtime host alias inside containers (`host.docker.internal` or
`host.containers.internal`).

This allows you to use:

- Local models via [Ollama](https://ollama.ai) with an API proxy
- Open-source models hosted on [Together AI](https://together.ai), [Fireworks](https://fireworks.ai), etc.
- OpenAI-key-backed providers that expose Anthropic-compatible endpoints
- Custom model deployments with Anthropic-compatible APIs

Note: NanoClaw's core agent runtime uses the Claude Agent SDK, so the endpoint must support Anthropic API semantics. Native OpenAI API endpoints without Anthropic compatibility are not drop-in for the core agent runtime.

**How do I debug issues?**

Ask Claude Code. "Why isn't the scheduler running?" "What's in the recent logs?" "Why did this message not get a response?" That's the AI-native approach that underlies NanoClaw.

**Why isn't the setup working for me?**

If you have issues, during setup, Claude will try to dynamically fix them. If that doesn't work, run `claude`, then run `/debug`. If Claude finds an issue that is likely affecting other users, open a PR to modify the setup SKILL.md.

If tests fail with a `better-sqlite3` `NODE_MODULE_VERSION` mismatch, you are likely on the wrong Node major version. Switch to Node 22 and reinstall dependencies (or rebuild `better-sqlite3`) before rerunning tests.
For Windows service setup, NanoClaw prefers a local Node 22 binary and can fall back to an `npx -p node@22` launcher when needed.
If PowerShell blocks `npx.ps1` because of execution policy, run the same commands with `npx.cmd` (and `npm.cmd`) instead.
For major iterations, run `npm run test:major` for the full gate (format/typecheck/lint/tests/build/live verify).

**What changes will be accepted into the codebase?**

Only security fixes, bug fixes, and clear improvements will be accepted to the base configuration. That's all.

Everything else (new capabilities, OS compatibility, hardware support, enhancements) should be contributed as skills.

This keeps the base system minimal and lets every user customize their installation without inheriting features they don't want.

## Rebuilding The Community Catalog

The bundled OpenClaw marketplace catalog is generated from [VoltAgent/awesome-openclaw-skills](https://github.com/VoltAgent/awesome-openclaw-skills):

```bash
npm run build:openclaw-market -- ../awesome-openclaw-skills/categories
```

If you cloned the awesome-list repo alongside NanoClaw, the script auto-detects it and writes the generated catalog to `container/skills/openclaw-market/catalog.json`.

## Community

Questions? Ideas? [Join the Discord](https://discord.gg/VDdww8qS42).

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for breaking changes, or the [full release history](https://docs.nanoclaw.dev/changelog) on the documentation site.

## License

MIT
