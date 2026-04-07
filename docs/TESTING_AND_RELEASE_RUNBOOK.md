# Andrea Testing And Release Runbook

This runbook defines how to validate Andrea end to end before major merges, main-branch pushes, or live deployment changes.

## What This Runbook Separates

This repo has three different validation layers:

- **CI-safe validation**
  - formatting, typecheck, lint, tests, build
  - no assumption of live credentials or channels
- **Operator-host live validation**
  - real runtime, real credentials, real channel behavior
  - restart and verify on the deployed machine
- **Optional integration validation**
  - Cursor Cloud
  - desktop bridge
  - Alexa
  - Amazon
  - marketplace/community skills

Do not treat optional integration checks as baseline unless that integration is actually configured.

## 1. Fast Local Checks

```bash
npm run format:check
npm run typecheck
npm run lint
npm run test
npm run build
```

For the shared assistant core specifically, add these focused checks when Alexa, Telegram, or research orchestration changes:

```bash
node scripts/run-with-pinned-node.mjs ./node_modules/vitest/vitest.mjs run src/assistant-capabilities.test.ts src/assistant-capability-router.test.ts src/research-orchestrator.test.ts
npm run debug:shared-capabilities
npm run debug:research-mode
npm run debug:knowledge-library
```

For ordinary companion chat, graceful degraded replies, and no-leakage checks, add:

```bash
node scripts/run-with-pinned-node.mjs ./node_modules/vitest/vitest.mjs run src/conversational-core.test.ts src/direct-quick-reply.test.ts src/assistant-routing.test.ts src/assistant-capability-router.test.ts src/research-orchestrator.test.ts src/user-facing-fallback.test.ts src/alexa.test.ts
npm run debug:conversational-core
```

Treat this conversational-core stack as the fast proof that normal Telegram, Alexa, and BlueBubbles users still get warm ordinary chat plus humane blocked-path behavior instead of operator diagnostics.

For the flagship end-to-end product journeys, add:

```bash
node scripts/run-with-pinned-node.mjs ./node_modules/vitest/vitest.mjs run src/signature-flows.test.ts
npm run debug:signature-flows
```

This is the fastest proof that the best Alexa, Telegram, BlueBubbles, communication, mission, and research journeys still feel coherent end to end.
Treat this flagship-flow suite and harness as the primary product proof. The narrower subsystem suites below are there to debug seams after the flagship proof tells you which journey regressed.

For cross-channel handoff and action-completion changes, add:

```bash
node scripts/run-with-pinned-node.mjs ./node_modules/vitest/vitest.mjs run src/cross-channel-handoffs.test.ts src/assistant-action-completion.test.ts src/alexa-conversation.test.ts src/alexa.test.ts src/assistant-capability-router.test.ts
npm run debug:cross-channel-handoffs
```

For BlueBubbles channel changes, add:

```bash
node scripts/run-with-pinned-node.mjs ./node_modules/vitest/vitest.mjs run src/channels/bluebubbles.test.ts src/companion-conversation-binding.test.ts src/cross-channel-handoffs.test.ts src/assistant-action-completion.test.ts
npm run debug:bluebubbles
```

For ritual and follow-through changes, add:

```bash
node scripts/run-with-pinned-node.mjs ./node_modules/vitest/vitest.mjs run src/rituals.test.ts src/life-threads.test.ts src/daily-companion.test.ts src/assistant-capabilities.test.ts src/assistant-capability-router.test.ts
npm run debug:rituals
```

For communication-companion and relationship-follow-through changes, add:

```bash
node scripts/run-with-pinned-node.mjs ./node_modules/vitest/vitest.mjs run src/communication-companion.test.ts src/assistant-capabilities.test.ts src/assistant-capability-router.test.ts src/alexa-conversation.test.ts src/daily-companion.test.ts src/channels/bluebubbles.test.ts
npm run debug:communication-companion
```

For chief-of-staff and decision-engine changes, add:

```bash
node scripts/run-with-pinned-node.mjs ./node_modules/vitest/vitest.mjs run src/chief-of-staff.test.ts src/assistant-capability-router.test.ts src/assistant-capabilities.test.ts src/daily-companion.test.ts
npm run debug:chief-of-staff
```

For missions and multi-step execution changes, add:

```bash
node scripts/run-with-pinned-node.mjs ./node_modules/vitest/vitest.mjs run src/missions.test.ts src/assistant-capability-router.test.ts src/assistant-capabilities.test.ts src/cross-channel-handoffs.test.ts
npm run debug:missions
```

## 2. Major Suite

```bash
npm run test:major
```

This is the standard pre-release validation stack on a real operator machine.

It includes:

1. formatting check
2. typecheck
3. lint
4. unit tests
5. production build
6. `setup -- --step verify`

Implementation note:

- `test:major` and `test:major:ci` already run with Node 22 through `npx -p node@22`
- if the host default `node` is not 22, do not use that runtime for DB-backed Alexa checks; unsupported runtimes can fail `better-sqlite3` with ABI mismatch errors that are not Alexa feature failures

## 3. Stability Gate

```bash
npm run test:stability
```

Use this when you want release confidence, not just a single clean pass.

For live environments where credential/runtime probes should be exercised each round:

```bash
npm run test:stability:live
```

## 4. CI-Safe Suite

```bash
npm run test:major:ci
```

Use this in CI runners that do not have live credentials, channels, or operator-only integrations.

## 5. Operator-Host Live Validation

Run this on the real deployed host.

### Preconditions

- Node 22 available
- one healthy container runtime
- model credentials configured
- at least one configured channel
- at least one registered chat or `/registermain` completed
- `npm run services:status` shows `assistant_name=Andrea` and the expected Telegram DM as `registered_main_chat_jid`

### Baseline Runtime Checks

Run:

```bash
npm run setup -- --step verify
```

Confirm:

- `STATUS: success`
- `SERVICE: running`
- `CREDENTIAL_RUNTIME_PROBE: ok`
- `CONFIGURED_CHANNELS: telegram`

Then validate the public-safe Telegram surface:

- `/start`
- `/help`
- `npm run telegram:user:smoke`
- `/commands`
- simple quick reply prompt
- simple factoid prompt
- one blocked-path prompt that should stay free of setup/runtime/operator wording
- reminder prompt
- `/cursor_status`

If BlueBubbles is configured on that host, add:

- one real inbound BlueBubbles message
- one real reply back into the same linked BlueBubbles conversation
- one safe companion flow such as `what am I forgetting`
- one explicit BlueBubbles -> Telegram handoff if you are validating cross-channel continuity
- one explicit communication-companion flow such as:
  - `summarize this message`
  - `what should I say back`
  - `what do I owe people`
  - `remind me to reply later`

If you are validating chief-of-staff behavior on the live host, add:

- `what matters most today`
- `what am I forgetting`
- `what should I remember tonight`
- `what should I do next`
- `why are you bringing that up`

Preferred proof shape:

- one concise Alexa chief-of-staff answer
- one richer Telegram chief-of-staff answer
- one explainability turn
- one daily-companion answer that still shows the shared chief-of-staff read

## 6. Cursor Validation

### Cursor Cloud Validation

Only run this if `CURSOR_API_KEY` is configured.

Expected meaning:

- `Cloud coding jobs: ready` means Cursor Cloud queued heavy-lift workflows are ready now

Run:

- `/cursor_status`
- `/cursor-create --repo https://github.com/rupret007/Andrea_NanoBot --ref main Reply with exactly: live cloud smoke ok. Do not modify files, branches, or PRs.`
- reply to the fresh Cursor task card with plain text
- tap `Refresh`
- tap `View Output`
- `/cursor`
- tap `Current Work`
- `/cursor-conversation current 5`
- tap `Results` when the provider has produced files

Check:

- the direct task card keeps the authoritative Cursor id visible
- reply-to-card continuation stays on the same Cursor task
- direct `/cursor-*` replies point back to exact-id fallbacks when needed
- if `current` points at a stale Cursor task, Andrea clears that selection honestly instead of cross-routing the turn

Optional if safe:

- `/cursor-followup <agent_id|current> ...`
- `/cursor-stop <agent_id>` on a disposable job only

### Desktop Bridge Validation

Only run this if all of these are configured:

- `CURSOR_DESKTOP_BRIDGE_URL`
- `CURSOR_DESKTOP_BRIDGE_TOKEN`
- a live bridge process on your normal machine

Expected meaning:

- `Desktop bridge terminal control: ready` means operator-only session recovery and line-oriented terminal control are ready
- `Desktop bridge agent jobs: conditional|unavailable` means desktop terminal control can still be real while local queued desktop-agent execution is not the baseline promise on that machine

Run:

- `/cursor_status`
- `/cursor`
- tap `Jobs`
- tap a desktop session
- tap `Sync` if a recoverable session exists
- `/cursor-terminal <agent_id> echo operator smoke ok`
- tap `Current Work` or `Current Job` -> `Terminal Status`
- tap `Current Work` or `Current Job` -> `Terminal Log`
- `/cursor-terminal-stop <agent_id>` if appropriate

Do not confuse desktop bridge readiness with Cursor Cloud readiness.

## 7. Codex/OpenAI Runtime Validation

Only run a live runtime acceptance pass if all of these are true:

- `ANDREA_OPENAI_BACKEND_ENABLED=true` in NanoBot
- `ANDREA_OPENAI_BACKEND_URL=http://127.0.0.1:3210`
- `npm run services:status` shows:
  - `runtime_backend_health=healthy`
  - `runtime_backend_local_execution_state=available_authenticated`
  - `runtime_backend_auth_state=authenticated`
- the registered main chat is healthy in Telegram

If the backend is reachable but `runtime_backend_local_execution_state=available_auth_required`, stop and do the real Codex login step on the host running `Andrea_OpenAI_Bot`. Do not treat that as a generic runtime failure.

Run:

- `/runtime-status`
- `/runtime-create Append the exact text <PROOF_LINE> on a new line at the end of proof.txt in the current workspace. Do not change anything else.`
- `/runtime-job <jobId>`
- `/runtime-logs <jobId> 60`
- reply directly to the fresh runtime card with one safe follow-up
- `/cursor`
- tap `Current Work`
- tap `View Output`

Check:

- the runtime card keeps the authoritative backend `jobId` visible
- no `Not logged in` failure appears
- the proof file actually changes on disk
- reply-to-card continuation stays on the same runtime thread when available
- `/cursor` shows the live runtime task as `Current Work` while it is active
- `Current Work -> View Output` still works even after the runtime task finishes

## 8. Alexa Validation

Only run a real Alexa acceptance pass if all of these are configured:

- Node `22.22.2` on the host
- `ALEXA_SKILL_ID`
- local Alexa listener config
- local Andrea OAuth config:
  - `ALEXA_OAUTH_CLIENT_ID`
  - `ALEXA_OAUTH_CLIENT_SECRET`
  - `ALEXA_OAUTH_SCOPE`
- HTTPS ingress or tunnel
- Alexa console skill endpoint
- Alexa console Authorization Code Grant account linking
- a valid Andrea group for the OAuth target `groupFolder`

If any of those are missing, record Alexa as **code-ready but setup-blocked** instead of failing the release gate for missing external setup.

Current truthful closeout note:

- Alexa is now live-accepted on this host after a real signed voice conversation
- the accepted flow was:
  - `Open Andrea Assistant`
  - `What am I forgetting?`
  - `Anything else?`
  - `What about Candace?`
  - `Be a little more direct.`
  - optional `What should I remember tonight?`
- the accepted live turns resolved to `groupFolder=main` and used `responseSource=local_companion`
- typed Alexa+ app chat is not an authoritative proof surface unless Andrea logs a real signed follow-up `IntentRequest` after launch
- interaction-model changes require a fresh import of `docs/alexa/interaction-model.en-US.json` plus `Build Model` in the Alexa Developer Console before live utterance failures count against the repo
- if live voice still falls into `AMAZON.FallbackIntent` after that rebuild, use the Alexa Developer Console Utterance Profiler or Intent History to capture the exact recognized phrase before changing repo code
- `npm run debug:daily-companion` is the local pinned-Node smoke path for comparing canonical daily-companion prompts like `what am I forgetting` or `what's still open with Candace` against real `groupFolder=main` data
- `npm run debug:alexa-conversation` is the near-live pinned-Node harness for checking Alexa-style follow-ups like `anything else`, `what about Candace`, `remember that`, `why`, or `be a little more direct` against the real local routing stack before blaming the live voice surface

When configured, validate in this order:

1. `npm run services:status` and confirm `alexa_listener_health=healthy` plus `alexa_oauth_health=healthy`
   - also note the `alexa_last_signed_request_*` fields before the attempt
2. `/alexa-status`
3. public `GET /alexa/oauth/health`
   - if the live host is an `ngrok` `*.ngrok-free.dev` tunnel, use the `ngrok-skip-browser-warning: 1` header for browser-style checks
   - if the skill endpoint uses that host, confirm the Alexa console SSL setting is the wildcard-certificate option
4. authoritative voice launch

## 9. Research And Media Validation

Run this when research orchestration, Telegram research rendering, or media capability wiring changes.

Pinned-Node smoke path:

```bash
npm run debug:research-mode
```

Expect:

- one clearly local-context research result
- one outward-facing research result that either uses OpenAI-backed synthesis or reports the exact blocker honestly
- an explicit route explanation in the output
- `media.image_generate` either returns a Telegram-deliverable artifact or reports the exact provider blocker honestly

Important truth:

- OpenAI-backed research is only live when `OPENAI_API_KEY` is configured and the provider account has usable quota/billing
- `web_search` is in scope for research; file search is not promised unless separate file-search plumbing is added
- Telegram is the rich research and media surface
- Alexa should stay concise and use handoffs when the result is too long or not voice-safe

## 10. Shared Capability Graph Validation

Use this when the shared assistant core changes:

1. Run:
   - `npm run debug:shared-capabilities`
2. Confirm:
   - Telegram daily guidance runs through the shared graph
   - Alexa household guidance runs through the shared graph
   - research returns a bounded voice-safe answer on Alexa
   - Telegram gets the richer research shape
   - `work.current_logs` remains blocked on Alexa and allowed only on the Telegram/operator side

If `OPENAI_API_KEY` is configured and the provider account is usable, a comparative or outward-facing research prompt may use the OpenAI Responses path. If it is missing or the provider account is quota-blocked, the shared research proof should report that blocker honestly instead of pretending the external answer is live.

Check:

- concise spoken output
- one clarification at a time
- daily guidance sounds specific and useful, not generic
- no personal data without linking
- no Telegram/operator wording leaks
- no fake calendar or reminder content

## 11. Cross-Channel Handoff Validation

Run this when Alexa-to-Telegram continuation, voice-triggered save flows, or companion action completion changes.

Pinned-Node proof harness:

```bash
npm run debug:cross-channel-handoffs
```

Expected proof points:

- one research handoff reaches Telegram
- one knowledge-detail handoff reaches Telegram
- one media handoff records artifact delivery
- one voice-triggered save-to-library flow completes
- one voice-triggered reminder completion creates a scheduled task

Important truth:

- handoffs are explicit, not background pushes
- only the registered main Telegram chat is used as a handoff target
- work cockpit and other operator-only flows stay out of Alexa
- failed delivery must surface honest blocker text instead of pretending the continuation was sent

### Optional Amazon Validation

Only run this if Amazon Business credentials are configured.

Run from the main control chat:

- `/amazon-status`
- `/amazon-search ergonomic keyboard`

Optional if safe:

- `/purchase-request <asin> <offer_id> 1`
- `/purchase-approve <request_id> <approval_code>` only in trial mode or another intentionally disposable validation setup

## 12. Knowledge Library Validation

Run this when the Knowledge Library model, ingestion, retrieval, or source-grounded research behavior changes.

Focused tests:

```bash
node scripts/run-with-pinned-node.mjs ./node_modules/vitest/vitest.mjs run src/knowledge-library.test.ts src/research-orchestrator.test.ts src/assistant-capabilities.test.ts src/assistant-capability-router.test.ts
```

Pinned-Node proof harness:

```bash
npm run debug:knowledge-library
```

Expected proof points:

- one explicit note saves into the library
- one approved local text file imports cleanly
- Telegram can summarize saved material with supporting sources
- Telegram can compare saved sources with provenance
- Telegram can list or explain the relevant saved items
- Alexa can produce a short saved-material summary without dumping source detail
- `use only my saved material` stays grounded in the library path

Important truth:

- the library is explicit/manual only in v1
- retrieval is lexical-first with FTS5, not embeddings-driven
- disabled or deleted sources must stop contributing to future answers
- the library stays distinct from memory, life threads, reminders, and current work

## 13. Restart And Verify

After meaningful runtime or operator-surface changes:

```bash
npm run services:restart
npm run setup -- --step verify
```

Important rule:

- run restart and verify sequentially, not in parallel

Then rerun a small live smoke:

- `/ping`
- `/help`
- `/cursor_status`
- `npm run telegram:user:smoke`

If the change touched direct work-lane commands, also rerun one live lane-specific proof:

- one `/cursor-*` proof that includes `current` plus one exact-id fallback
- one `/runtime-*` proof that includes `current` plus one exact-id fallback

If `/cursor_status` still behaves like an unregistered shell, stop and compare the real DM against `registered_main_chat_jid`, `latest_telegram_chat_jid`, and `main_chat_audit_warning` in `npm run services:status` before assuming a code rollback.

Telegram live-testing truth:

- the dedicated Telegram smoke command is explicit and credentialed on purpose
- it is not part of the default unit/full suite
- it is the canonical proof that Telegram is actually replying end to end rather than only polling successfully

## 14. Failure Handling

### `CREDENTIAL_RUNTIME_PROBE: failed`

- rerun `npm run setup -- --step verify`
- check `CREDENTIAL_RUNTIME_PROBE_REASON`
- check `NEXT_STEPS`

### Cloud coding jobs unavailable

- `CURSOR_API_KEY` is missing, rejected, or not loaded
- fix `.env`
- restart
- rerun `/cursor_status`

### Desktop bridge terminal control unavailable

- `CURSOR_DESKTOP_BRIDGE_URL` and/or `CURSOR_DESKTOP_BRIDGE_TOKEN` are missing
- or the configured bridge is unreachable/unhealthy
- confirm the bridge process and tunnel
- restart Andrea
- rerun `/cursor_status`

### Runtime route unavailable

- treat it as optional unless you specifically want Cursor-backed runtime routing
- check 9router endpoint/auth/model settings separately from Cloud/desktop

## 15. Release Gate

Before pushing a release:

1. `npm run test:major` passes
2. `npm run test:stability` passes
3. live verify is green on the operator host
4. docs and help surfaces are updated if wording or behavior changed
5. optional integrations are documented as optional, not baseline
6. final command outputs and any caveats are captured in release notes or the PR summary
