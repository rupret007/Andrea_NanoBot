# Andrea owner cockpit

The owner cockpit is an optional personal command center. It shows a bounded
view of current focus, open loops, active goals, staged approvals, and recent
outcomes. It does not expose raw messages, hidden reasoning, credentials, or
database records.

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
