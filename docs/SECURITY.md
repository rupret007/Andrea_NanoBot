# Andrea_NanoBot Security Model

This document describes the security posture Andrea actually relies on today.
It is intentionally practical: trust boundaries first, product claims second.

## Trust Model

| Entity                           | Trust Level | Why                                                           |
| -------------------------------- | ----------- | ------------------------------------------------------------- |
| Main control chat                | Trusted     | Private operator/admin surface                                |
| Registered owner review surfaces | Trusted     | Exact main Telegram, Messages self-thread, or cockpit binding |
| All other/unregistered chats     | Untrusted   | Messages may be malicious or prompt-injecting                 |
| Host process                     | Trusted     | Owns routing, authorization, mounts, and credentials          |
| Container agents                 | Sandboxed   | Isolated execution environment                                |
| External integrations            | Conditional | Safe only when explicitly configured and validated            |

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
- rotate a credential before further live provider verification if it was
  previously observed in a process listing or pasted into chat, logs, issues,
  diagnostics, or any other non-secret-controlled surface; deletion or
  redaction of the pasted copy does not make the original credential safe

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

### 7. Commitment-State Trust Boundary

Commitment Intelligence changes planning truth, not action authority. A life
thread can say the user, another subject, both, Andrea, or an unresolved party
owns the next step. That ownership field must never be interpreted as approval
to perform an external effect.

Security and privacy rules for commitment state:

- an explicit request may assign Andrea a bounded reminder or local-save step,
  but sends, calendar writes, purchases, deployments, repository changes,
  migrations, dependency changes, and deletions keep their existing fresh
  approval and target-binding rules;
- vague references, competing targets, and unclear ownership fail without a
  state mutation;
- exact replay is idempotent and older evidence cannot reactivate a newer
  completed, cancelled, deferred, or superseded state;
- the canonical state and its compatibility projection update atomically, so
  an older active field cannot continue authorizing or recommending work;
- transition evidence is bounded to a derived transition type and reason,
  source kind, confidence, timestamp, event identity, and one-way-hashed source
  reference; raw message text, raw channel identifiers, credentials, and
  secret-like values are redacted rather than copied into the commitment
  ledger, API responses, logs, or diagnostics;
- group, subject, sensitivity, manual-only, snooze, and source-consent
  boundaries remain in force for every consumer;
- communication drafts and provider payloads may use only recipient-safe,
  topically relevant commitment context; sensitive planning titles and profile
  fact text never becomes draft support, a conversation title, or provider
  content; an accepted fact may select only a closed local style label;
- council evidence keeps `local_only` cards unavailable and withholds semantic
  values from `metadata_only` cards, including accepted profile facts and
  sensitive life threads;
- destructive selective multi-item forgetting is not exposed by this round.

The full state and migration contract is documented in
[COMMITMENT_INTELLIGENCE.md](COMMITMENT_INTELLIGENCE.md).

### 8. Production Apprenticeship Trust Boundary

Capability acquisition and production apprenticeship change which exact
bounded method Andrea may recognize and reuse; they do not grant action
authority. The only bundled first candidate is the read-only, zero-egress
Release-Readiness Brief.

Security rules for that lifecycle:

- synthetic preparation writes only labeled preproduction records to the
  canonical local ledger; it cannot create a live canary, owner verdict,
  activation, provider call, external effect, or production-use proof;
- canary approval, the owner's verdict on the independently verified canary
  outcome, and activation approval are three separate decisions bound to exact
  acquisition, run, revision, contract, scope, owner, chat, group, channel,
  target, health, lease, checkpoint, receipt, and outcome records;
- owner verdicts are accepted only from the registered main Telegram chat, the
  configured BlueBubbles/Messages self-thread, or the authenticated loopback
  owner cockpit; cockpit mutations also retain its authentication and CSRF
  boundary;
- generic Helpful feedback, another chat, a stale token, a mixed request, an
  ambiguous target, a disconnected identifier, or a synthetic fixture cannot
  become genuine promotion evidence;
- active reuse revalidates the exact contract, intended postconditions,
  versions, health, owner scope, lease, receipts, and independent evaluator on
  every run; pause, quarantine, revoke, retire, and negative history remain
  authoritative;
- external sends, calendar writes, purchases, repository changes, deployments,
  migrations, dependency changes, installations, and deletion retain their
  normal fresh exact-scope approvals even if a capability is active.

The deterministic certification may exercise synthetic owner-review and active
branches in an isolated disposable database. That proves repository behavior,
not a real owner decision, live activation, authority, or production use.

### 9. Command Surface Gating

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
- do not let commitment ownership, strength, confidence, or model output stand
  in for action approval
- do not store a raw conversation merely to justify a commitment transition
- do not document a feature as baseline if it still depends on same-day validation
- do not send BlueBubbles/Messages traffic through Private API; AppleScript is
  the only outbound send path, including when the server advertises Private API
  or the server-info probe fails. The Private API probe is diagnostic only and
  never selects a send method
- do not treat QA, Karen, or ordinary contact/group threads as
  send-authorization surfaces, including Telegram JIDs such as `tg:qa` or
  `tg:karen` that reuse a main-looking group record, numeric Telegram JIDs
  that are not the registered front-door chat, numeric Telegram JIDs that
  borrow `isMain` when no front-door is registered yet, and numeric
  Telegram JIDs whose stored title is QA or Karen. A provided title cannot
  hide that stored canary. A missing caller JID cannot authorize. Contact
  sends still require a fresh owner `send it` / `Send now` in the
  registered Telegram front-door chat (Bob) or the configured Messages
  self-thread. Dispatch and scheduled-send deferral also fail-close those
  callers.
