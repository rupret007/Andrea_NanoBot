# Andrea_NanoBot Security Model

This document describes the security posture Andrea actually relies on today.
It is intentionally practical: trust boundaries first, product claims second.

## Trust Model

| Entity                | Trust Level | Why                                                  |
| --------------------- | ----------- | ---------------------------------------------------- |
| Main control chat     | Trusted     | Private operator/admin surface                       |
| Non-main chats        | Untrusted   | Messages may be malicious or prompt-injecting        |
| Host process          | Trusted     | Owns routing, authorization, mounts, and credentials |
| Container agents      | Sandboxed   | Isolated execution environment                       |
| External integrations | Conditional | Safe only when explicitly configured and validated   |

## Primary Security Boundaries

### 1. Container Isolation

Andrea runs agent work inside containers instead of directly on the host.
That gives the system:

- process isolation
- filesystem isolation through explicit mounts only
- non-root execution in the container
- fresh per-run execution with bounded mounted state

This is the main sandbox boundary. The system does not assume prompt-level obedience is enough.

### 2. Mount Security

Mount permissions are validated on the host before container startup.

Important rules:

- the external allowlist lives outside the repo
- blocked secret-like paths are denied by default
- symlinks are resolved before validation
- unsafe relative paths and traversal are rejected
- non-main additional mounts are read-only unless explicitly allowed

The main project root is mounted read-only. Writable state lives in narrower paths such as the group folder, IPC, and `.claude` state.

### 3. Session And Chat Isolation

Each registered chat keeps its own group folder and session state.

That means:

- one chat does not automatically inherit another chat's files
- one chat does not automatically inherit another chat's enabled community skills
- per-chat state is explicit instead of ambient

### 4. IPC Authorization

IPC messages and task operations are authorized against the group identity that owns the IPC namespace.

| Operation                   | Main Group | Non-Main Group |
| --------------------------- | ---------- | -------------- |
| Send message to own chat    | Yes        | Yes            |
| Send message to other chats | Yes        | No             |
| Schedule task for self      | Yes        | Yes            |
| Schedule task for others    | Yes        | No             |
| View all tasks              | Yes        | Own only       |
| Manage other groups         | Yes        | No             |

### 5. Credential Isolation

Real API credentials are supposed to stay on the host side, not in normal agent prompts or mounted container files.

The repo supports:

- OneCLI Agent Vault for host-side credential injection
- Anthropic-compatible gateway flows
- host-side shopping credentials for Amazon Business
- host-side bridge/auth tokens for optional integrations like Cursor desktop bridge and Alexa

Important rule:

- secrets should not be echoed back to users, stored in normal chat history, or mounted into general agent workspaces

### 6. Route-Aware Tool Narrowing

Andrea now uses route-aware request policy so simple assistant turns do not automatically receive the same tool surface as heavier workflows.

Current route families:

- `direct_assistant`
- `protected_assistant`
- `control_plane`
- `advanced_helper`
- `code_plane`

This is a meaningful security improvement because it reduces accidental tool reach for ordinary chat turns.

### 7. Command Surface Gating

The public Telegram command menu is intentionally smaller than the total codebase surface.

Current policy:

- core public commands stay available for normal users
- `/cursor_status` is the safe public Cursor status exception
- advanced Cursor, Amazon, and Alexa operator commands are gated to Andrea's registered main control chat
- remote-control remains disabled in the runtime path

Current Cursor trust split:

- Cursor Cloud is the operator-enabled validated heavy-lift path
- desktop bridge is operator-only and environment-dependent
- Cursor-backed runtime routing is a separate diagnostic/config surface

## Privilege Comparison

| Capability          | Main Group                                     | Non-Main Group                                    |
| ------------------- | ---------------------------------------------- | ------------------------------------------------- |
| Project root access | `/workspace/project` (read-only)               | None                                              |
| Group folder        | `/workspace/group` (read/write)                | `/workspace/group` (read/write)                   |
| Global memory       | Implicit via project                           | `/workspace/global` (read-only)                   |
| Additional mounts   | Configurable                                   | Read-only unless explicitly allowed               |
| Network access      | Unrestricted                                   | Unrestricted                                      |
| MCP tools           | Route-aware subset with broader operator reach | Route-aware subset scoped to the request and chat |

## What This Model Does Well

- keeps Andrea as one public assistant while internal helpers stay hidden
- isolates chats from each other by default
- blocks many high-trust actions outside the main control chat
- keeps container execution narrower than host execution
- preserves explicit approvals for shopping flows

## What Is Still Conditional

These are only as safe as their real deployment:

- Alexa voice ingress
- Amazon Business ordering
- Cursor Cloud beyond the configured operator path
- Cursor desktop bridge
- Cursor-backed runtime routing
- community skill enablement from external catalogs

They should be treated as operator-enabled extras, not baseline assumptions.

## Security Hygiene Rules

When changing behavior, keep these rules intact:

- do not broaden the public command surface casually
- do not let helper chatter leak into user-facing replies
- do not assume optional integrations are safe just because tests pass
- do not turn route-policy misses into silently broad tool access without a conscious decision
- do not document a feature as baseline if it still depends on same-day validation
