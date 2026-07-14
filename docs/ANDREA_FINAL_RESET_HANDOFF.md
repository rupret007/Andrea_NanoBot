# Andrea Final Reset Handoff

Snapshot date: 2026-07-14. The pushed baseline inspected for this pass was
`9dd2b1e7` on `main`, aligned with `origin/main` before the change below.
The completed code-bearing pass was pushed as `d74b8191` (`Require Alexa
calendar confirmation`). A later handoff-only commit may contain this line;
use `git rev-parse origin/main` for the repository's current documentary HEAD.

## Surgical improvement

Alexa calendar creation bypassed the shared confirmation contract. A request
with one writable calendar wrote immediately, and choosing a calendar from a
multi-calendar draft also wrote instead of advancing to `confirm_create`.

The Alexa adapter now persists every create draft, asks for fresh confirmation,
and lets the shared `advancePendingGoogleCalendarCreate` state machine decide
whether `AMAZON.YesIntent` authorizes the write. Calendar selection only
selects. Existing stable provider identity remains attached to the persisted
draft, so the subsequent confirmed write retains retry reconciliation.

Changed implementation and proof:

- `src/alexa.ts`
- `src/alexa.test.ts`

## Executed verification

- Focused: `src/alexa.test.ts`, `src/google-calendar-create.test.ts`,
  `src/calendar-research-coordinator.test.ts`, and
  `src/calendar-research-sequencing.test.ts`: 4 files / 183 tests passed.
- Full root suite: 229 files / 2,712 tests passed.
- `npm run format:check`: passed.
- `npm run lint`: passed with zero errors; the existing warning-only catch-all
  backlog remains.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm run docs:check`: passed for 68 Markdown files.
- `git diff --check`: passed.

The tests prove that natural-language and structured Alexa calendar requests do
not call the provider before confirmation, a calendar choice does not call the
provider, and a subsequent explicit `yes` produces exactly one create call.
Nearby tests also preserve targeted confirmation, provider-idempotency
reconciliation, research-only non-mutation, and compound Calendar/research
sequencing.

## Still unverified

- No real Alexa device or authenticated simulator request was sent. The current
  signed Alexa proof is stale, so voice recognition of the confirmation turn is
  still operator evidence debt.
- No real Google Calendar event was created or deleted for this pass. Provider
  acceptance, response delivery, and restart recovery are covered by isolated
  tests, not a new live destructive canary.
- The compound Calendar + research journey still lacks one genuine
  post-release user turn. No paid research or calendar mutation was
  manufactured for validation.
- Telegram and BlueBubbles were not mutated. Their current transport/proof
  status must be read from `npm run integrations:status -- --json` before a
  live drill.

## Next full-budget objectives

1. Add an Alexa end-to-end interruption fixture that stops after provider
   acceptance but before spoken-response delivery, reloads persisted state,
   and proves the retry reconciles the same event without a second write.
2. With owner approval, run one disposable real-device Alexa canary: request a
   clearly named event, verify no event exists before the confirmation turn,
   say `yes`, verify exactly one matching event, then explicitly approve its
   deletion.
3. Run one genuine Telegram or BlueBubbles compound request using a disposable
   event and bounded research question; verify the event title excludes the
   research clause, research starts only after draft delivery, and mutation
   occurs only after the targeted calendar confirmation.

Operator commands for the remaining proof:

```bash
npm run services:status
npm run integrations:status -- --json
npm run debug:alexa-conversation -- --review
```

For Alexa, use the real device or authenticated simulator. For Telegram or
BlueBubbles, use the existing owner thread. Do not run the mutating canaries
without explicit approval for the exact disposable event and cleanup.
