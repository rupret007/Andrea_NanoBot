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
again. An uncertain send must be checked in the recipient thread before anyone
prepares a new draft.

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
`POST .../confirm` or `POST .../cancel`. All calls require dedicated bearer
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
call counts.

Activation must retain both predecessor artifacts, service configurations and
private configuration files, validate the explicitly enabled owner surface,
and verify coordinated rollback. Do not migrate or delete the existing Andrea
message database to activate this bridge. Run two complete cumulative Web Bob
live rounds including authenticated bridge health, real recipient verification,
draft/cancel/revocation and permanent Instinct denial. Those rounds must remain
no-send. The only authorized real text in the solo parity run is its final
readiness notification to Jeff, through Andrea; its actual provider receipt
must be recorded before claiming delivery. No mock is live-send evidence.
