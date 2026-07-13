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

The main project root and host-owned control plane—including route policy,
runner code, and mount configuration—are immutable inside the container.
Writable state is limited to explicit per-chat session state, the group
workspace, and IPC. A control file must not become writable merely because a
route needs writable working state.

Host Codex home, auth, and config are not mounted or copied into agent
containers. Host-side Codex execution remains a separate, explicitly enabled
operator lane rather than ambient container authority.

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

- OneCLI Agent Vault as the preferred host-side credential boundary
- Anthropic-compatible gateway flows
- host-side shopping credentials for Amazon Business
- host-side bridge/auth tokens for optional integrations like Cursor desktop bridge and Alexa

Important rule:

- secrets should not be echoed back to users, stored in normal chat history, or mounted into general agent workspaces
- when OneCLI is unavailable, environment inheritance is explicitly classified as degraded rather than equivalent to vault-backed execution
- OneCLI may add only its documented proxy variables and bounded read-only CA
  mounts; executable-control environment keys or arbitrary mount targets fail
  closed
- the degraded container fallback passes secret values only through the spawned runtime process environment and uses bare `-e KEY` container arguments; secret values must never appear in command arguments, process listings, logs, errors, or diagnostics
- if a credential was previously observed in a process listing, rotate it before further live provider verification

### 6. Route-Aware Tool Narrowing

Andrea uses route-aware request policy so simple assistant turns do not
automatically receive the same tool surface as heavier workflows. Ordinary
`direct_assistant` requests are tool-free at the container boundary. Other
production-routed requests receive a minimized allowlist for the task. A
classified turn must never gain tools merely because a narrower route lacks
them.

Current route families:

- `direct_assistant`
- `protected_assistant`
- `control_plane`
- `advanced_helper`
- `code_plane`

This is a meaningful security improvement because it removes ambient tool reach
from ordinary chat and limits higher-trust tools to the route that justified
them.

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

| Capability               | Ordinary direct lane              | Explicit protected/control lane                                  | Explicit advanced/code lane                                                                                                               |
| ------------------------ | --------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| SDK built-in tools       | None                              | Exact read/web allowlist, or none                                | Explicit engineering allowlist                                                                                                            |
| MCP                      | None                              | Exact route allowlist                                            | None while shell-capable                                                                                                                  |
| Project root             | None                              | Main-group tracked-file snapshot only when read tools require it | Main-group tracked-file snapshot, read-only                                                                                               |
| Global/additional mounts | None                              | Route/group policy only                                          | Route/group policy only                                                                                                                   |
| Skill/plugin controls    | Empty read-only overlays          | Empty read-only overlays                                         | Read-only discovery catalog for skill-management MCP; canonical plus explicitly enabled entries only when the `Skill` built-in is allowed |
| Group/session state      | Direct-only writable session home | Distinct protected/control writable session homes                | One execution-lane writable session home shared only by advanced/code routes                                                              |
| Host Codex home/auth     | Never mounted or copied           | Never mounted or copied                                          | Never mounted or copied                                                                                                                   |

Docker and Podman are the verified nested read-only mount runtimes. The Apple
`container` runtime fails closed until it supplies equivalent mount-canary
evidence; availability alone is not enough for this trust boundary.

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
- do not mount or copy host Codex home/auth/config into agent containers
- do not treat degraded environment credential inheritance as equivalent to OneCLI isolation
- do not document a feature as baseline if it still depends on same-day validation
