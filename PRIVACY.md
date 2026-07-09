# Andrea_NanoBot Privacy Policy

This privacy policy describes how Andrea_NanoBot handles data when deployed from this repository.

## What Andrea Stores

Depending on which channels and features are enabled, Andrea may store:

- chat identifiers and basic chat metadata
- message content needed for assistant responses
- task and reminder definitions
- enabled skill state per chat
- local runtime logs and operational state
- per-chat working files inside isolated group folders

Andrea runtime logs are designed to redact token-like secrets from emitted error text, but operators should still treat logs as sensitive operational data.

## Why Andrea Stores It

Andrea stores this information so the bot can:

- respond in context
- remember per-chat state
- run reminders and scheduled tasks
- keep skill enablement isolated to the correct chat
- support debugging and operational reliability

## Where Data Lives

Data is primarily stored on the machine where Andrea is deployed, including:

- the local SQLite database
- local runtime data directories
- per-chat group folders
- local logs

BlueBubbles/Messages data is local-first in normal operation: Andrea reads the
local BlueBubbles endpoint, stores normalized `bb:` chat/message context, and
keeps runtime state on the host. A Cloudflare BlueBubbles URL may be configured
as a fallback or diagnostic route for this host, but it should not replace the
local endpoint as the primary path.

## Local And Cloud Processing

Some communication features can use configured OpenAI-compatible provider
refinement to improve BlueBubbles conversation summaries and suggested replies.
When enabled, Andrea should send only bounded context needed for the request,
prefer sanitized snippets/summaries, and preserve a deterministic local fallback
when the provider is unavailable.

Recent-text review and provider prompt paths redact phone numbers, JIDs, email
addresses, and token-like secrets before sending context to providers or writing
operator proof timelines. Provider usage state should remain metadata-focused
where possible, such as surface, model tier, outcome, and blocker, rather than
raw private message bodies, secrets, or hidden reasoning.

## External Services

Andrea may send request content to external AI or integration providers when those services are configured by the operator.
Examples can include:

- Anthropic-compatible model endpoints
- OpenAI-key-backed gateways
- OneCLI credential proxy or vault services
- approved third-party skills and integrations explicitly enabled by the operator

If a provider or skill is enabled, the data sent to that provider depends on the user request and the feature being used.

## Isolation And Skills

Andrea is designed around per-chat isolation:

- each chat has its own working context
- community skills are not enabled globally by default
- a skill enabled in one chat does not automatically become active in another

## What Andrea Does Not Intend To Do

This repo is intended for self-hosted or operator-controlled deployments.
Andrea is not designed to sell personal data or run ad-targeting workflows from user messages.

## Operator Responsibility

The person deploying Andrea is responsible for:

- choosing which model and integration providers to use
- securing the host machine and credentials
- deciding retention practices for logs, database content, and working files
- reviewing which community skills are enabled

## Contact

For questions about a deployment of Andrea_NanoBot, contact the operator or repository owner associated with that deployment.
