# Intelligence-Layer Security Boundaries

This is a supplemental note for Andrea's intelligence and evaluation modules.
The authoritative deployed trust model is
[SECURITY.md](SECURITY.md), and the release boundary is
[TESTING_AND_RELEASE_RUNBOOK.md](TESTING_AND_RELEASE_RUNBOOK.md). If this note
and the security model disagree, follow the security model.

## Scope

Andrea has two related but distinct security surfaces:

- the production host, channel, routing, container, credential, approval, and
  delivery boundaries; and
- AGI-oriented libraries and the feature-flagged `AgiRuntime`, including its
  constitution, prompt-injection scanner, policy evaluator, budget meter,
  memory systems, and hash-chained audit file.

The second surface provides defense in depth where it is invoked. Its tests do
not prove that every production route, prompt, tool, or audit record passes
through those libraries. Production authorization must remain enforced at the
host routing, capability, mount, IPC, approval, and delivery boundaries.

## Threats In Scope

- untrusted messages, files, search results, web pages, and tool output trying
  to become instructions;
- credentials appearing in prompts, mounts, command arguments, logs, errors,
  diagnostics, or persisted state;
- a low-trust route or chat gaining tools, files, sessions, or authority from a
  higher-trust route;
- external, destructive, or otherwise sensitive action without the required
  target-bound approval;
- stale state, ambiguous delivery, replay, or retry turning one approved action
  into another action;
- runaway provider calls or misleading cost accounting;
- untrusted or contradictory content becoming durable personal memory without
  provenance, review, or revocation;
- cross-chat, cross-run, symlink, mount, skill, plugin, runner, or project-hook
  escape;
- tampered or incomplete evidence being presented as verified completion; and
- dependency, build, or scanner compromise reaching a released artifact.

## Enforced Production Boundaries

Current primary controls are described and tested as concrete capability
boundaries:

1. **Container and mount isolation.** Agent work runs non-root with explicit
   mounts. Host-owned route policy, runner source, settings, guidance, skills,
   and plugins are immutable in the container. Writable session/workspace/IPC
   state is explicit. Symlinks, traversal, unsafe file types, and path escapes
   are rejected.
2. **No ambient host Codex authority.** Host Codex home, credentials, and
   configuration are not mounted or copied into agent containers. Host Codex
   remains a separate operator lane.
3. **Route-aware least privilege.** Ordinary `direct_assistant` requests have
   no SDK built-ins, MCP servers, project mount, additional directories, or
   skill/plugin authority. Protected, control, advanced, and code routes
   receive only the capabilities justified by their classification.
4. **Chat, session, and IPC isolation.** Per-route session lanes do not inherit
   each other's state. Host-created, run-bound IPC envelopes are authenticated,
   and cross-run or replayed messages are rejected.
5. **Credential isolation.** OneCLI is preferred. A degraded environment
   fallback passes only the selected key through child-process environment and
   uses a bare environment-key container argument. Secret values must never be
   placed in arguments, logs, errors, or diagnostics.
6. **Approval and execution truth.** Sensitive actions use the repository's
   current approval, receipt, postcondition, cursor, and uncertain-delivery
   controls. A timeout or ambiguous receipt must not be silently replayed as if
   no effect occurred.
7. **Release evidence.** Deterministic evaluation uses isolated state, injected
   fakes, provider-environment suppression, zero budget, and process-level
   non-loopback denial. Hosted exact-SHA checks and the independent dependency,
   secret, and Semgrep jobs are defined in the release runbook.

Optional integrations remain conditional on their actual configuration and
same-day proof. A passing fixture is not permission to describe an unproven
integration as live or healthy.

## AGI Runtime Defense In Depth

When `ANDREA_USE_AGI=1` selects the `AgiRuntime` Telegram path, the runtime:

- scans the incoming text with a local heuristic prompt-injection scanner and
  quarantines text classified as data-only;
- prepends its versioned constitution to that runtime's system prompt;
- evaluates registered tool calls by effect and user-initiation state;
- requires confirmation for external and destructive tool effects by default;
- denies those effects for background calls by default unless an explicit
  policy override applies;
- tracks configured in-process cost and tool-call windows; and
- writes a redacted, append-only, hash-chained AGI audit file.

These are implementation-specific controls, not universal claims. The scanner
is heuristic; there is no repository evidence for a universal OWASP recall
percentage or an LLM-classifier pass on every ingest. The in-memory budget
meter and evaluation estimate checks are not provider billing caps. The AGI
audit chain detects edits to that file when verified, but it is not a tamper-
proof external ledger and does not cover every production audit surface.

Prompt instructions, a constitution, reflection, and model self-critique are
not authorization boundaries. Untrusted content should be minimized and
clearly delimited, but tools and data must still be constrained outside the
model.

## Memory And Learning

Durable personal learning should store bounded, reviewable derived signals
with source provenance, confidence, freshness, expiry, and forget/revoke
controls. Raw messages from optional channels must not become a second passive
archive merely because they are available to a tool.

Contradictory or low-confidence facts need review before they influence a
sensitive plan or action. Synthetic runs, proof drills, and degraded
compatibility runs must remain distinguishable from real owner-reviewed
outcomes. Memory, feedback, and skill promotion can improve retrieval or
routing, but never grant new authority.

## Residual And External Risks

Repository controls do not eliminate:

- compromise of the trusted host, operating system, container runtime, model
  provider, channel provider, or integration account;
- side channels outside Andrea's process and filesystem controls;
- provider billing beyond the repository's recorded estimate;
- a newly disclosed dependency or model-supply-chain weakness;
- social engineering that wins valid owner approval; or
- data exposure caused by operator-provided mounts or credentials outside the
  documented policy.

Use host full-disk encryption, OS account protection, provider-side least
privilege and spending alerts, credential rotation, and current backups as
external controls. A credential pasted into chat, logs, diagnostics, or a
public issue must be rotated; deleting the visible copy is not sufficient.

## Reporting A Vulnerability

Do not post credentials, personal data, exploit details, or a working proof of
concept in a public issue. Use the repository's private vulnerability-reporting
channel or a GitHub private security advisory when available; otherwise
contact a maintainer privately and share only enough public information to
establish a secure reporting path.
