# Local communication tracking removal — agent handoff

## Product delta

The complete-forget command was shadowed by ordinary stop-tracking, leaving the
record saved. This slice makes the existing command remove one explicitly
reviewed local tracking record safely, without turning it into inbox deletion.

- Standalone raw owner text is required. Rewrites, quotes, questions, negation,
  and mixed commands cannot authorize deletion or dispatch another action.
- Synchronous single-conversation reviews bind the group, exact record and
  whole-record fingerprint, recipient channel/chat, owner presentation surface,
  and a ten-minute review window. Ambiguous lists and asynchronous drafts do not
  issue deletion authority.
- A review receipt survives only when its exact text receives confirmed
  delivery. Typed local tracking status uses the existing structured status
  path; the general cognitive completion gate remains unchanged.
- One immediate SQLite transaction removes the tracking thread, signals,
  identity review, and directly derived communication outcome. Stale records,
  mismatched groups, inconsistent cross-group children, or database failure
  cause no partial removal.
- Shared context retires before deletion confirmation delivery, including on
  refusal. Delivery failure cannot revive the old deletion review.
- Immediate callback and durable-queue routing keep this local command out of
  OpenClaw delegation, runtime follow-ups, and Messages history priming.

Original messages, profiles/facts, life threads, reminders, drafts, and
independently sourced outcomes remain. Explicitly reviewing the original
conversation again may create new tracking. Ordinary stop-tracking still
retains a disabled record. There is no migration, background purge, new store,
provider integration, or change to outbound authorization.

## Verification and remaining gates

- Existing focused baseline: 173 tests passed before implementation.
- New product regression initially reproduced 16 failures; the final focused
  three-file gate covers product behavior, real in-memory SQLite rollback,
  raw-input provenance, and actual pure delivery-policy projection.
- Live bot/provider execution is not part of these tests. Ingress wiring checks
  inspect source rather than importing the application entry point.
- Local validation uses synthetic fixtures and Node 22.22.3, with owner/provider
  environment files disabled. It does not claim the Windows exact-pin runtime.
- The preliminary all-network-denied broad run was not green: loopback and
  native fixture subprocess restrictions, two inconclusive worker timeouts, and
  a mixed-source run required a final frozen-source verification. Do not treat
  that preliminary run as release evidence. Final exact-head results and any
  remaining limits belong in the draft PR verification record.
- Compilation is not a running service, deployment, release, or production
  provenance/signing proof. Karen's leftover/security review remains required;
  this change must not be merged or deployed by the authoring agent.

See [COMMUNICATION_COMPANION.md](COMMUNICATION_COMPANION.md) for the owner flow
and exact retention boundary. Keep the Private API disabled and preserve the
separate explicit-send fence. No real inbox, customer data, live credentials,
provider calls, gateway restarts, or outbound messages were used for this slice.
