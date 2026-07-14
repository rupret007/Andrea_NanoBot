# Andrea Final Reset Handoff

Snapshot date: 2026-07-14. The live transport certification pass began from
`24371f1139504bde57df536f8af4139ee1c8c28f`. The latest code-bearing runtime
used for the BlueBubbles drill was `3a02430c`; use
`git rev-parse origin/main` and `npm run services:status` for the final
documentation/release SHA and serving provenance.

## Latest live transport pass

- Telegram is `VERIFIED`. The production user-session `/ping` sent message
  `11709`, received exactly one expected reply `11710`, and persisted the fresh
  marker at `2026-07-14T15:10:07.618Z` in
  `data/runtime/telegram-roundtrip-health.json`.
- BlueBubbles transport is ready and OpenClaw is live with 11/11 bridge tools,
  but the exactly-once certification is `FAILED`. Correlation
  `BB-CERT-20260714T154100Z-3A02430C` reached the correct read-only
  `andrea-bluebubbles__bluebubbles_status` tool and produced grounded replies,
  but the same physical self-thread request was mirrored under phone and email
  aliases with different provider IDs. OpenClaw therefore recorded two
  read-only calls. No send tool, message-action execution, calendar write, or
  other mutation occurred.
- Alexa is `BLOCKED` for this pass and its prior proof is `STALE`. There is no
  authenticated Alexa simulator/device client in this environment. The last
  qualifying handled signed request remains `WhatAmIForgettingIntent` at
  `2026-06-03T13:57:39.518Z`. No unsigned local call was substituted for signed
  proof.

BlueBubbles evidence is retained in the local message ledger and in these
OpenClaw transcripts:

- `$HOME/.openclaw/agents/main/sessions/d8236900-084d-40f1-91e2-d546f6789721.jsonl`
- `$HOME/.openclaw/agents/main/sessions/abfecee0-3436-4d3f-b927-e2afe3e19d3a.jsonl`

The repository now recognizes the configured Messages self-thread as an
OpenClaw owner surface, routes direct and durable asks through the same
connector, uses a fast gateway health preflight, and suppresses a physical
self-thread message mirrored across aliases even when BlueBubbles changes the
message ID and timestamp slightly. The regression test also proves the guard
does not swallow an intentional repeat outside the two-second mirror window.
Focused transport tests and root typechecking pass. No further BlueBubbles live
probe was sent after the final dedupe correction, so the fix is repository
verified but not yet live recertified.

Exact remaining proof steps:

```bash
npm run services:status
npm run debug:bluebubbles -- --live
npm run openclaw:bridge:status -- --json
```

Then send one new uniquely correlated `@OpenClaw` request in the configured
canonical Messages self-thread that requires exactly one read-only
`bluebubbles_status` call. Confirm one request session, one tool call, and one
same-thread reply before changing the result to `VERIFIED`. Do not repeat the
probe if provider outcome is indeterminate.

For Alexa, use a real device or authenticated Alexa Developer Console
simulator, say `Open Andrea Assistant`, then `What am I forgetting?`, and run
`npm run services:status`. Success requires a fresh handled signed
`IntentRequest` with `WhatAmIForgettingIntent`; local HTTP is diagnosis only.

### Next full-reset priorities

1. Run one BlueBubbles/OpenClaw recertification after the alias-dedupe release
   and require exactly one read-only tool call and one same-thread reply.
2. Complete the fresh signed Alexa device/simulator turn and confirm the
   request type, intent, handled response source, and freshness marker.
3. Complete one genuine BlueBubbles `message_action` continuation and one
   life-thread save/retrieval turn without manufacturing evidence.

## Prior release handoff (preserved history)

The pushed baseline inspected for the prior pass was
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
