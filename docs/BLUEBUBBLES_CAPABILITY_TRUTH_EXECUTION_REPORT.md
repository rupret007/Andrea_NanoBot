# BlueBubbles Capability Truth and Execution Report

- Date: 2026-07-16
- Branch: `fix/capability-truth-bluebubbles-execution`
- Baseline: `58f8d0cd158b419e7c828866486251ee9a46ea61`
- Implementation commit: `ede6f0b50869bdf1d2dfa2967a8c1153577584ec`

## Outcome

Andrea now has a production-bound BlueBubbles execution path whose capability
answer is derived from current registration, exposure, authorization, transport,
receipt supervision, and dispatch ownership. Explicit send requests are no
longer silently reduced to draft-only behavior.

The requested turn is parsed as:

- intent: `execute`
- target: `Travis Story`
- requested content: say hi from Andrea and say he smells
- style: funny

Its deterministic output is:

> Hi from Andrea — she says you smell, but in a limited-edition, artisanal way. 😄

This work proves repository behavior, fail-closed runtime checks, and an
isolated compiled sidecar lifecycle. It is not live-delivery proof. Per the
task boundary, no message was sent to Travis Story or anyone else.

## Baseline root cause

Four systemic gaps combined to make capability claims and runtime behavior
disagree:

1. Explicit BlueBubbles imperatives were always converted to approval-bound
   drafts. The production handler called a staging contract that explicitly
   never sent.
2. Capability answers relied on static configuration and historical proof
   state instead of actual in-process function registration, current exposure,
   and dispatch ownership.
3. A configured Messages self-thread identified a conversation but did not
   prove that the current instruction was authored by the owner.
4. In-process dedupe and ordinary database updates did not provide an atomic
   cross-process dispatch fence or independently durable receipt persistence
   across main-runtime restarts.

The result was a misleading combination: Andrea could describe BlueBubbles as
available while the explicit-send path still stopped at a draft, and the
execution boundary was not durable enough to make a safe retry decision after
ambiguous provider outcomes.

## Runtime capability truth

### Intent and protected routing

`src/assistant-action-intent.ts` separates `execute`, `draft`, `prepare`,
`recommend`, and `inform`. A tone directive such as “make it funny” changes the
message content without demoting an execute imperative.

Execute, draft, and prepare message requests enter the protected local lane.
That lane does not expose model tools; production code owns identity,
authorization, recipient resolution, and dispatch.

### Registration and ownership

`src/runtime-capability-registry.ts` distinguishes three things that were
previously conflated:

- a capability descriptor;
- a concrete production function surface;
- an executable binding with declared dispatch ownership.

BlueBubbles is registry-dispatched. Telegram, Calendar, Reminders, and Research
are registered as observational references to their existing host-owned
production paths. Their presence proves a real function reference, but it does
not claim registry-owned dispatch, common provider health, or unified
idempotency for those tools.

BlueBubbles execution is exposed only to Telegram and BlueBubbles source
channels. Current evaluation requires all applicable checks to agree:

- a registered and exposed production surface;
- registry-owned BlueBubbles dispatch;
- current transport and independently supervised receipt readiness;
- write permission;
- explicit authorization for this turn.

`src/capability-self-model.ts` now uses this runtime evaluation for availability
answers. Historical proof remains diagnostic evidence; it cannot substitute
for current registration, authorization, or health.

`src/bluebubbles-outbound-turn.ts` is the trusted production turn. It checks
authorization before replay lookup, provider health refresh, contact lookup, or
binding invocation, then calls the registry's concrete BlueBubbles binding.

## Authorization and recipient resolution

### Trusted instruction origins

A production send instruction is trusted only when it comes from either:

- the registered main Telegram chat; or
- an explicitly configured BlueBubbles self-thread alias where the current
  inbound message has `is_from_me === true`.

Configured self-thread membership alone is insufficient. Fallback aliases,
missing authorship, and `ownerAuthored === false` do not grant authority.
Guided BlueBubbles canary execution remains unsupported without current
authorship evidence.

### Exact recipient rules

Stored recipient lookup accepts only exact normalized names, JIDs, or
addresses. Fuzzy matches become ambiguity rather than guesses. Live contact
lookup requires an exact normalized display-name match, prefers phone over
email, and treats multiple usable addresses as ambiguous. Explicit phone or
email targets are structurally validated before provider use.

The execute-time merge matrix is:

| Stored result | Current live result | Outcome |
| --- | --- | --- |
| Ambiguous or authoritative group | Any | Block terminally; no live redirect |
| Missing | One exact contact and address | Resolve as a direct first contact |
| Exact direct | Successful live miss | Retain the exact stored direct thread |
| Exact direct | Same address identity | Retain the existing stored thread |
| Exact direct | Conflicting identity | Block as ambiguous |
| Any | Directory, configuration, or transport exception | Fail closed; do not use stale fallback |

An explicitly authorized direct or first-contact action may bypass the ordinary
inbound allowlist only when it has a stable action key, suppresses the Andrea
label, and resolves to a non-group target. Group sends and ordinary
conversational sends remain scope-bound.

No live contact lookup for Travis Story was treated as proof in this task.

## Fenced dispatch and receipt semantics

The durable dispatch sequence is:

1. Authorize the current turn and resolve one exact direct target.
2. Atomically advance one eligible action snapshot from
   `drafted|approved|deferred` to `delivery_unverified`, conditioned on its exact
   prior status and `last_updated_at` value.
3. Capture immutable target JSON and exact draft bytes. Use the stable action
   identifier as the provider `tempGuid`.
4. Permit at most one fenced provider POST attempt for that action.
5. Transition to `sent` only from the claimed `delivery_unverified` snapshot.
6. Apply terminal updates through the same status/version compare-and-swap so
   stale workers and UI actions cannot regress newer truth.

A definite rejection before a provider effect may become `failed`. A timeout,
transport ambiguity, malformed or partial response, or otherwise unknown
effect remains `delivery_unverified`. Replays of sent, unverified, or terminal
failed inbound requests are read-only and do not reopen dispatch.

This is an at-most-one fenced provider POST attempt per action. It is not
exactly-once delivery and it is not an atomic transaction spanning SQLite and
the BlueBubbles HTTP endpoint.

Immediate HTTP success binds the provider receipt identifier to the immutable
locally approved recipient/body snapshot. It does not mean the provider echoed
every field, that a recipient device received the message, or that it was read.

Delayed reconciliation requires exactly one correlated row with:

- the stable `tempGuid` or captured provider receipt;
- the matching direct chat/address;
- self-authorship;
- exact body bytes, allowing only CRLF normalization; and
- a timestamp inside the bounded reconciliation window.

The default window ends ten minutes after dispatch and may be configured only
between 30 seconds and 30 minutes. Zero matches, multiple matches, or evidence
outside the window leave the action unverified.

## Durable receipt inbox and mirrored-ingress recovery

`src/bluebubbles-receipt-inbox-store.ts` provides a separate SQLite store with
WAL, `synchronous=FULL`, immediate transactions, leases, and token-gated
acknowledgement. The authenticated loopback HTTP service commits evidence
before returning success. An exact duplicate `tempGuid` is idempotent;
conflicting evidence receives HTTP 409.

The main runtime drains this queue at startup and every five seconds. It ACKs a
leased row only after the evidence has been accepted into the main store.
“Accepted” does not necessarily mean that an action reconciled to `sent`:
structurally valid but uncorrelated outbound evidence can be imported and ACKed
after reconciliation finds no action.

The receipt writer is independently supervised, but reconciliation remains in
the main process. While Andrea is down, the sidecar can accumulate committed
evidence for a later drain.

Outbound readiness requires:

- the main-process consumer to be running;
- the local queue to be available;
- authenticated health with the fixed service kind and protocol;
- valid PID, start time, build identity, webhook path, and configuration
  identity; and
- a distinct BlueBubbles webhook registration containing exactly the
  `new-message` event.

Main inbound webhook processing is not blocked by receipt-sidecar readiness;
new outbound provider POSTs are.

Mirrored self-thread command dedupe uses a separate durable claim. The same
canonical scope, self-authorship, normalized exact body, and timestamp within
plus or minus two seconds share one claim; a three-second difference is
distinct. History may resume only a pre-existing live claim and cannot invent a
new one. This is bounded mirror dedupe, not general exactly-once command
execution.

Acknowledged receipt rows and accepted mirrored-ingress claims currently have
no demonstrated pruning policy.

## Independent supervision and artifact provenance

The receipt writer has a separate fixed LaunchAgent label,
`com.nanoclaw.bluebubbles-receipt-inbox`, with `RunAtLoad`, `KeepAlive`, a
15-second throttle, private umask, and separate logs. Its lifecycle commands do
not start, stop, or restart Andrea's main service.

This is a per-user LaunchAgent. It starts at GUI login, not before login or
FileVault unlock. Strict pre-login operation would require a separately
reviewed, root-owned LaunchDaemon configuration; its payload could then drop
privileges through `UserName`.

Both compiled entrypoints derive their module path and project root from
`import.meta.url`, not the current working directory. Compiled startup requires
an intact artifact digest whose manifest says it was built from the exact clean
commit currently checked out. Missing Git HEAD, stale commit, dirty-build
manifest, runner build-ID mismatch, or a modified compiled artifact fails
closed. The service runners perform metadata preflight; the compiled runtimes
perform the full artifact digest check.

This proves the clean origin and integrity of the served compiled artifact. It
does not continuously re-check whether source files become dirty after that
build. Generic health proves service/build/config identity; the service-manager
status command additionally compares the health PID with launchd's PID.

The isolated clean build used implementation commit
`ede6f0b50869bdf1d2dfa2967a8c1153577584ec`, reported `dirty_paths=0`, and
hashed 2,416 compiled files. The report-only commit created after this proof
advances Git HEAD, so that existing manifest is intentionally stale by commit
mismatch. Rebuild before starting either supervised compiled service.

## BlueBubbles provider boundary

Primary BlueBubbles source establishes these provider facts:

- The send response injects the caller's `tempGuid` into the serialized
  provider message: [send router](https://github.com/BlueBubblesApp/bluebubbles-server/blob/95204ac18513fffcbb76cafed26008952e8346b3/packages/server/src/server/api/http/api/v1/routers/messageRouter.ts#L237-L279).
- New-message webhook payloads receive correlation fields during injection:
  [webhook injection](https://github.com/BlueBubblesApp/bluebubbles-server/blob/95204ac18513fffcbb76cafed26008952e8346b3/packages/server/src/server/index.ts#L1182-L1200).
- Ordinary message-history serialization does not preserve `tempGuid`:
  [history serializer](https://github.com/BlueBubblesApp/bluebubbles-server/blob/95204ac18513fffcbb76cafed26008952e8346b3/packages/server/src/server/api/serializers/MessageSerializer.ts#L117-L212).
- Provider webhook dispatch is fire-and-forget without retry:
  [webhook service](https://github.com/BlueBubblesApp/bluebubbles-server/blob/95204ac18513fffcbb76cafed26008952e8346b3/packages/server/src/server/services/webhookService/index.ts).

Durability therefore begins only after a callback reaches Andrea and the
receipt SQLite transaction commits. A lost send HTTP response combined with a
missed webhook can remain permanently unverified because later history cannot
reconstruct the absent `tempGuid`.

## Verification evidence

The focused, full, and deterministic gates did not perform BlueBubbles
provider writes. No live-send verification was run.

| Gate | Result |
| --- | --- |
| Focused BlueBubbles, capability, auth, CAS, receipt, recovery, and provenance matrix | 36 files, 554 tests passed |
| Full primary unit suite | 264 files, 3,276 tests passed |
| `test:major:ci -- --skip-live-verify` | Format, typecheck, lint, 264/3,276 unit tests, and build passed; live verification intentionally skipped |
| Deterministic sweep, final run | 97/97 scripts passed in 438.8 seconds |
| AGI typecheck and suite | 28 files, 286 tests passed |
| AGI gauntlet | Passed |
| Agent runner | Typecheck, build, and 13/13 tests passed |
| Host container contract | 7 files, 132 tests passed |
| Real Docker image canary | Image build, pinned runtime/tool checks, and in-container typecheck passed |
| Real container mount canary | Passed |
| Static checks | Root typecheck, quiet lint, format check, docs check, shell syntax, plist validation, helper syntax, and `git diff --check` passed |
| Active dependency audits | Root and active agent-runner audits reported zero vulnerabilities |

Additional adversarial proof included:

- cross-process and hard-kill action-claim races;
- receipt persistence, duplicate/conflict, lease expiry, and token-gated ACK;
- process restart and mirrored self-thread alias races;
- alternate-working-directory compiled launches that rejected a dirty manifest
  before main initialization or sidecar storage creation;
- an independent receipt/auth/contact/CAS identity audit with no P0/P1 finding;
- an independent provenance re-review with no P0/P1 finding; and
- a staged-scope/secret/side-effect audit with no remaining P0/P1 finding.

The post-commit compiled runtime proof passed:

- ordinary build and provenance generation at the exact implementation commit;
- service-manager dry-run with no file or service mutation;
- isolated loopback-only sidecar startup;
- authenticated protocol-v2 health with exact PID, build, webhook-path, and
  configuration identity;
- private `0700` queue directory and `0600` SQLite file; and
- graceful stop followed by temporary-state cleanup.

Two untouched vendored `imported/andrea_openai_bot` dependency snapshots
reported eight pre-existing advisories each during supplementary audits. They
are not used as the active root or agent-runner dependency tree and were not
modified as part of this scoped fix.

## Remaining operator and live-proof gates

The following were intentionally not performed:

- no live message send;
- no BlueBubbles webhook registration or other provider mutation;
- no LaunchAgent install, bootstrap, restart, stop, or uninstall;
- no deployment, merge, or push; and
- no claim that Travis Story was live-resolved or received a message.

To obtain live proof in a separately authorized operation:

1. Rebuild at the exact final commit so the compiled manifest matches Git HEAD.
2. Install and verify the dedicated receipt-inbox LaunchAgent.
3. Register the exact distinct second BlueBubbles webhook for only
   `new-message`, then confirm authenticated readiness.
4. Re-verify current BlueBubbles transport, webhook, and exact contact truth.
   Prior host notes in `docs/BLUEBUBBLES_CHANNEL_PREP.md` were not freshly
   re-established by this task.
5. Obtain explicit authorization for the live send and execute it once through
   the fenced production path.

Until those gates are completed, the correct status is: implementation and
offline runtime proof complete; live delivery unproven.
