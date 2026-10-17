# Optional Web Bob owner bridge

This draft adds an opt-in Web Bob owner surface inside Andrea. The listener is
disabled unless a private configuration explicitly enables it. Owner challenge
delivery is separately disabled and fails closed in the shipped implementation,
so enabling the listener alone cannot authorize a send. It does not enable
control API or MCP sends, impersonate Telegram or Messages self-thread messages,
or turn a read helper into a sender. Production activation is separate work.

The dedicated loopback bearer credential authenticates the Web Bob service to
Andrea; the existing control token is rejected. Possession of that credential
does not establish owner approval. Web Bob remains responsible for its own
login and CSRF checks, but Andrea verifies approval independently through a
single-use token delivered outside the bearer response path.

The `OwnerChallengeDelivery` interface provides
`deliver(challenge, summary)` for a future integration with Bob's front door to
Jeff. The summary identifies the exact draft revision, recipient, content and
expiry. Only a disabled implementation ships here: it rejects delivery, and
`POST .../draft` returns 503 before creating any persistent draft or core action.
No messaging-service HTTP, real message sender or auto-reply implementation is included. An injected
delivery adapter is a trusted host dependency, never a caller-selected URL or
request option. Test adapters capture synthetic challenges only.

A draft remains `awaiting_delivery` in bounded memory until that interface
completes successfully. Only then are its core action and persistent draft
created. Delivery failure creates neither record and revokes the challenge even
if the adapter saw it before failing. Failed delivery diagnostics remain only
in bounded memory and disappear on restart. Cancellation, supersession, expiry
or restart during delivery cannot make it confirmable later. A successful `/draft` response contains draft and
receipt identifiers, its digest and expiry, but no approval token or other
confirmation capability.

Andrea reads the actual direct-thread membership before preparing the draft and
again before confirmation. Each read queries the exact GUID with a two-row
limit and participants only, so an older thread need not appear in the recent
chat window. Missing, mismatched, duplicate or non-direct results fail closed.
Andrea assigns the owner actor as the SHA-256 digest of `web-bob:owner:jeff` and
generates the draft request ID itself; caller-provided actor and draft request
IDs do not establish identity or authority. It stores the exact body bytes,
recipient, actor, conversation, Web Bob process epoch, draft ID/revision and
server-generated request ID. A 32-byte random approval token is hashed together
with the stored draft ID, revision and content digest, then verified using a
constant-time comparison. The token expires with the draft after five minutes.

Successful draft responses include a separate `requestDigest` for the immutable
original Web Bob scope (caller `actor` and `draftRequestId` included). The
action `digest` remains Andrea's normalized scope hash. `requestDigest` is
computed from the exact request bytes Web Bob sent: addresses must already be
canonical (Andrea rejects rewritable forms such as `(202) 555-0102`), body text
is never trimmed or normalized for hashing, and lone UTF-16 surrogates are
rejected. `/draft` accepts only the eleven scope fields; caller-supplied
`requestDigest` or `digest` keys are refused. Each `draftRequestId` binds at most
one stored draft for the life of the bridge database; a second `/draft` that
reuses an existing ID is rejected with 409 before any new owner challenge is
delivered. Owner approval tokens are hashed with the stored `requestDigest`, not
the action digest, so an approval minted for one request cannot validate against
a record whose immutable request changed. Confirm, cancel and status require
`bridgeDraftId` and the expected `requestDigest`; Andrea compares that digest
against the stored original request before consuming approval or dispatching.

`POST .../confirm` accepts only `bridgeDraftId`, `requestDigest` and
`approvalToken`. It rejects
caller-supplied actor, scope, approval timestamp, request IDs and legacy
confirmation text. Andrea loads the scope from its stored draft, timestamps
approval using its own clock, and generates and persists the confirmation
request ID. The token must already have been delivered through the owner
interface. Cancellation, replacement, service restart, altered stored scope,
expiry or owner pause revoke it. Configured Instinct GUIDs and normalized
addresses are denied at both preparation and confirmation; groups are rejected.
Draft expiry and the 30-second server-timed approval window are checked again
after recipient lookup and immediately before dispatch, so a slow verification
cannot extend consent.

Within the same stored owner actor, conversation and process epoch, a higher revision
of the same draft ID creates a fresh challenge and supersedes the older pending
card. Equal or lower revisions are rejected, including after cancellation or
consumption. Revisions cannot transfer an old challenge to edited content.
The 10,000-draft limit counts pending decisions and challenges awaiting owner
delivery; elapsed drafts are expired before enforcing it. Unfinished adapter
calls are separately capped at 10,000, including calls already superseded.
At most 10,000 settled terminal drafts of all states are retained for receipt
inspection; older records and their delivery evidence are pruned on admission,
cancellation, consumption, settlement and startup. Their bridge-owned core
message actions and associated outcomes are also deleted. Cleanup verifies the
dedicated source namespace and server-derived action ID, leaving other core
actions untouched. It reconciles against committed bridge records under the
bridge write lock, including after a failed bridge insert and on startup after
an interrupted write or cleanup. SQLite reuses the freed pages. Failed in-memory
delivery diagnostics have the same 10,000-record cap.

Up to 32 additional consumed approvals are durably reserved while provider
dispatch and receipt persistence settle. Pruning cannot remove these drafts,
their core actions or outcomes. The reservation limit is checked atomically
with token consumption; a full limit returns 503 without consuming another
approval. Unresolved reservations survive restart and continue counting against
the limit, since an old provider call may still be running. A process crash can
therefore leave capacity occupied indefinitely; restart does not automatically
release uncertain reservations or retry sends. The total retained bridge-owned
core actions and outcomes are bounded by the pending, settled terminal and
reservation limits.

A separate persistent registry retains the highest accepted revision for each
owner/conversation/epoch/draft identity, including legacy rows before pruning.
Its 20,000-identity limit rejects new identities with 503 once full; known
identities can still advance revisions. These watermarks are never evicted or
reset on restart. An oversized legacy store seals admission for untracked
identities before pruning, so forgetting a receipt cannot revive a stale
revision. Each new bridge reference is also server-random and cannot reconnect
a pruned token to an old core action. No unbounded token tombstone list is used.

SQLite FULL synchronous persistence consumes the challenge before dispatch.
Andrea's existing message-action claim, owner-pause fence, provider idempotency
and durable receipt machinery then handle delivery. A host-only capability
binds that dispatch to the exact action; serialized objects and caller-selected
`webbob:` chat IDs cannot create it. Success requires the matching persisted
action and a complete receipt for the exact recipient thread. Missing, partial,
lost or mismatched receipts remain unconfirmed. Every confirmation replay,
including a concurrent duplicate or a replay after restart, fails with 409
(or 404 once the reference is pruned). `/status` inspects retained consumed
draft receipts; pruned receipts return 404. This correlation proves a submission,
not arrival on a recipient's phone.
An uncertain send must be checked before anyone prepares a new draft.

Delivery protocol 1 adds an authenticated, bounded, read-only status inspection.
It reads the original provider message GUID and verifies exact body, authorship
and every observed direct-thread alias against the approved address. SMS/RCS
thread migration does not change that approval. Missing or mismatched evidence
cannot establish delivery. A nonzero transport error reports `delivery_failed`;
an explicit delivery flag with zero error reports `delivered`; an explicit sent
flag with zero error reports `sent`. A GUID with zero error alone reports
`submitted`, and unsupported error metadata remains `delivery_unconfirmed`.
Installed provider versions that omit a sent flag cannot prove transport send.

Transport observations are persisted separately from the consumed confirmation,
bound to the original action, scope digest and provider GUID. Checking status
never confirms or resends. Weaker acceptance does not erase known failure or
delivery; recovery from failure requires a newer positive delivery timestamp.
An unavailable refresh returns the prior observation marked unavailable, not
fresh success. Legacy receipts without the delivery protocol prove submission
only. A delivery failure requires a fresh exact owner-approved draft for any
new send; no automatic retry or transport downgrade is added here.

## Configuration contract

`ANDREA_WEBBOB_CONFIG_PATH` points to an absolute, regular file with mode 0600.
The JSON contains `enabled`, `port`, a new random `token` (32–128 base64url/hex
characters), nonempty `denyAddresses` and nonempty `denyChatGuids` for the
verified Instinct identity. The server binds only `127.0.0.1`; it rejects browser
Origin and forwarded-proxy headers, including empty values, and requires
loopback socket addresses and a `127.0.0.1` Host header. Runtime challenge state
is private under `data/runtime/webbob/challenges.db`. Keep the file outside source control and
container mounts. A missing/invalid configuration leaves the listener off. A
valid configuration still leaves owner delivery disabled; there is no
configuration switch that supplies or bypasses the owner delivery interface.

Web Bob uses a separate private file selected by `BOB_ANDREA_WEBBOB_CONFIG`,
containing `url` (`http://127.0.0.1:PORT`) and the same dedicated `token`. Do not
copy the token into chat, command arguments, PRs, evidence or logs. These drafts
do not create either production file, change a service pin, or send any text.

The protocol is `GET /web-bob/v1/health`, then `POST .../draft`, followed by
`POST .../confirm` or `POST .../cancel`. Draft requests provide `issuer`,
`audience`, `conversationId`, `epoch`, `draftId`, `revision`, `chatGuid`,
`addresses`, `text`, `actor` and `draftRequestId`. Andrea persists the exact
request scope for `requestDigest`, then substitutes its fixed owner actor and
generated draft request ID only for the normalized action digest and dispatch.
Confirmation requires
`{"bridgeDraftId":"...","approvalToken":"..."}` and no additional fields.
`POST .../status` and `POST .../cancel` accept only `{"bridgeDraftId":"..."}`.
Status inspects the stored draft without sending, including one whose
confirmation was already consumed.
Health advertises `protocol: 2` for the incompatible confirmation contract.
Health and receipts retain `deliveryProtocol: 1` for receipt inspection. All
calls require dedicated bearer authentication. Body size is bounded and no
user-supplied URL is accepted.

## Verification and activation

Run the full repository tests, lint and typecheck on the exact committed head.
Synthetic tests must prove that the bearer response never exposes a challenge,
caller authorization metadata is rejected, the owner token is mandatory and
bound to the exact draft revision/content, replay fails, and disabled or failed
delivery cannot authorize dispatch. Preserve recipient, pause, expiry, durable
consumption and receipt-inspection coverage using test-only owner delivery.

The older Web Bob `release/bridge_probe.py` client and the compiled
`scripts/fixtures/web-bob-bridge-worker.mjs` fixture used the former bearer
challenge response and caller-attested confirmation. Their prior positive
results do not validate this trust model. The fixture has no owner delivery
adapter and therefore fails closed with the shipped default. Any future
positive cross-language probe needs a separate, explicit test-only owner channel
and the new request shapes; it must never expose the token through `/draft` or
load production credentials. Synthetic results do not establish live delivery.

Activation must retain both predecessor artifacts, service configurations and
private configuration files, validate the explicitly enabled owner surface,
and verify coordinated rollback. Implementing a real owner delivery adapter
requires separate authorized work. This change must not access `chat.db` or any
Messages database, send real messages, or add auto-replies. Real texts require
the owner's separate approval of the exact recipient and body under the active
task's authority. A prior consumed approval cannot be reused. Acceptance requires
the actual owner outcome as well as supported provider evidence; a missed
message or manual retry is not unattended delivery. No mock is live-send evidence.
