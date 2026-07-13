# Andrea owner cockpit

The owner cockpit is an optional personal command center. It shows a bounded
view of current focus, open loops, active goals, staged approvals, and recent
outcomes. Its real-world intelligence card shows genuine owner-review progress,
delivery p50/p95, route targets, provider/model and capability attribution when
available, the slowest measured stage, and aggregate host-pressure correlation.
Queue wait behind earlier work is a separate stage rather than being hidden in
request preparation. Host pressure is a bounded dequeue-time observation, not
a causal diagnosis or an excuse for a latency breach. Legacy timing samples
remain counted for audit but stop influencing current percentiles once
complete stage-attributed samples exist. Malformed or internally inconsistent
stage bundles are excluded and counted separately. It does not expose raw
messages, hidden reasoning, credentials, or database records.

On the primary evaluated reply path, local controls explicitly opt into a
two-second target and ordinary responses use ten seconds. Missing or malformed
classification fails conservatively to the ordinary target; a zero-duration or
bypassed harness never implies that a response is local. The first primary
reply per inbound turn is timed from the earliest valid queued inbound
timestamp but recorded only after the channel returns a non-empty platform
receipt for every response chunk; this is transport acceptance, not
recipient-read confirmation. A confirmed prefix followed by failure is shown
as `partial`; uncertain server acceptance is shown as `unknown`. The cockpit
counts both as incomplete or uncertain delivery, but excludes them from
successful p50/p95 and route-target claims. Their inbound cursor is committed
only to avoid duplicating an already accepted or possibly accepted response,
and no feedback or post-delivery enrichment is created. A definite failure or
empty complete receipt creates no success sample and remains retryable.

After confirmed transport acceptance, the in-flight cursor is committed before
optional metrics or enrichment, and observer failures cannot re-enter that
reply's retry path. Specialized action presentations and handoff sends remain
outside comparable latency until they have typed route semantics; durable
message workflows separately fail closed unless the shared guard sees complete
delivery. File and media artifacts retain a narrower residual ambiguity: a
transport timeout is unconfirmed rather than proof that the artifact did not
arrive, so inspect the target thread before manually resending one.

## Enable locally

1. Generate a high-entropy secret with your normal secret manager. Do not put
   the value in source control or a command argument.
2. Set these values through the existing local environment or secret workflow:

   ```text
   ANDREA_OWNER_COCKPIT_ENABLED=true
   ANDREA_OWNER_COCKPIT_HOST=127.0.0.1
   ANDREA_OWNER_COCKPIT_PORT=4320
   ANDREA_OWNER_COCKPIT_SECRET=<at least 20 high-entropy characters>
   ANDREA_OWNER_COCKPIT_SESSION_MINUTES=30
   ANDREA_OWNER_COCKPIT_GROUP=main
   ```

3. Restart Andrea and check `http://127.0.0.1:4320/health`. The snapshot and
   interface remain unavailable until the owner signs in through the POST-only
   login form.

The server rejects non-loopback bind addresses. Disabling the feature and
restarting Andrea immediately removes the cockpit surface.

## Tailscale access

Use Tailscale Serve as the HTTPS boundary in front of
`http://127.0.0.1:4320`. Inspect the current Serve configuration first and add a
dedicated Andrea handler without replacing existing handlers. Keep tailnet ACLs
restricted to the owner's devices. Tailscale access is one security layer; the
cockpit secret is still required.

Forwarded HTTPS is trusted only when it arrives over the loopback proxy path.
The resulting session is short-lived, `HttpOnly`, and `SameSite=Strict`; remote
HTTPS sessions also receive the `Secure` flag. Mutations require same-origin and
CSRF verification.

## Safety model

- Thread and goal pause/resume controls are reversible local changes.
- The cockpit can approve only an existing, unexpired staged approval whose
  exact summary is unchanged.
- Approval records intent; Andrea's normal executor must still revalidate
  policy, context, expiry, and postconditions before producing an external
  effect.
- Sends, calendar writes, purchases, deployments, deletions, and administrative
  changes are never executed directly by the cockpit server.

If an approval looks stale or unexpected, do not confirm it. Return to chat and
ask Andrea to explain or recreate the proposed action.

## Experience principles

Everyday replies lead with the answer, include no more than the essential facts,
and offer one next move. “Why?” and diagnostics remain available on demand.
Calendar guidance states whether the calendar was checked; recent-text reviews
state the requested period and how many conversations were reviewed.
