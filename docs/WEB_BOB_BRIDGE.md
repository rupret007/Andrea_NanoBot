# Optional Web Bob owner bridge

This draft adds an opt-in Web Bob owner surface inside Andrea. It is disabled
unless a private configuration explicitly enables it. It does not enable control
API or MCP sends, impersonate Telegram or Messages self-thread messages, or
turn a read helper into a sender. Production activation is separate release work.

Web Bob authenticates its owner and checks CSRF before forwarding a draft and a
later exact confirmation. A dedicated loopback service credential authenticates
Web Bob to Andrea; the existing control token is rejected. The host Web Bob
backend is trusted to attest its own authenticated session. An actor string by
itself is never an authentication credential.

Andrea reads the actual direct-thread membership before preparing the draft and
again before confirmation. Each read queries the exact GUID with a two-row
limit and participants only, so an older thread need not appear in the recent
chat window. Missing, mismatched, duplicate or non-direct results fail closed.
It binds exact body bytes, recipient, owner-session
digest, conversation, Web Bob process epoch, draft ID/revision and original
request ID to an Andrea-owned random challenge. The challenge expires in five
minutes. Separate confirmation carries the challenge, a new request ID and a
fresh arrival timestamp. Cancellation, replacement, service restart, altered
scope, expiry or owner pause revoke it. Configured Instinct GUIDs and normalized
addresses are denied at both preparation and confirmation; groups are draft-only.

SQLite FULL synchronous persistence consumes the challenge before dispatch.
Andrea's existing message-action claim, owner-pause fence, provider idempotency
and durable receipt machinery then handle delivery. A host-only capability
binds that dispatch to the exact action; serialized objects and caller-selected
`webbob:` chat IDs cannot create it. Success requires the matching persisted
action and a complete receipt for the exact recipient thread. Missing, partial,
lost or mismatched receipts remain unconfirmed; replay cannot call the provider
again. This correlation proves a submission, not arrival on a recipient's phone.
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
Origin headers. Runtime challenge state is private under
`data/runtime/webbob/challenges.db`. Keep the file outside source control and
container mounts. A missing/invalid configuration leaves the bridge off.

Web Bob uses a separate private file selected by `BOB_ANDREA_WEBBOB_CONFIG`,
containing `url` (`http://127.0.0.1:PORT`) and the same dedicated `token`. Do not
copy the token into chat, command arguments, PRs, evidence or logs. These drafts
do not create either production file, change a service pin, or send any text.

The protocol is `GET /web-bob/v1/health`, then `POST .../draft`, followed by
`POST .../confirm` or `POST .../cancel`. `POST .../status` inspects a bound draft
without sending, including one whose confirmation was already consumed.
Health and receipts advertise `deliveryProtocol: 1`. All calls require dedicated bearer
authentication. Body size is bounded and no user-supplied URL is accepted.

## Verification and activation

Run the full repository checks and the Web Bob suite/evals/browser/staging
checks on exact committed heads. The Web Bob `release/bridge_probe.py` runs the
real Python client against Andrea's compiled HTTP server and action store with
a synthetic provider, under the network-denial test boundary. This proves the
protocol, not live delivery. The fixture uses the compiled recipient resolver
against a local synthetic server whose target is outside its recent 200 chats;
preparation and confirmation must each verify that exact target. It never loads
production credentials and records only synthetic query metadata and provider
call counts. The same compiled path must show submission, later failure, retained
failure after stale acceptance, newer delivery and unavailable mismatched status,
with a single synthetic submission and verified same-recipient service aliases.

Activation must retain both predecessor artifacts, service configurations and
private configuration files, validate the explicitly enabled owner surface,
and verify coordinated rollback. Do not migrate or delete the existing Andrea
message database to activate this bridge. Run two complete cumulative Web Bob
live rounds including authenticated bridge health, real recipient verification,
draft/cancel/revocation and permanent Instinct denial. Those rounds must remain
no-send. Real texts require the owner's separate approval of the exact recipient
and body under the active task's authority. A prior consumed approval cannot be
reused. Acceptance requires the actual owner outcome as well as supported
provider evidence; a missed message or manual retry is not unattended delivery.
No mock is live-send evidence.
