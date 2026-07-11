# Modernization Plan

## Grounded agency flywheel — 2026-07-11

### Implemented

- [x] Bridge owner-reviewed coding missions into one Agent OS episode,
      trajectory evaluation, stable skill proposal, cognitive skill card, and
      runtime manifest.
- [x] Require complete artifacts, passing checks, resolved risks, approval
      evidence, deterministic replay/test evidence, and owner review before a
      mission can contribute to promotion.
- [x] Add a configured-model capability registry, task-specific ranking, twelve
      redacted routing cases, metadata-only results, and a fail-closed live cost
      ledger capped by the operator-provided value.
- [x] Add bounded active-perception assessment for calendar, open loops, goals,
      messages, repository state, and tools without creating a new memory store.
- [x] Show the ten-working-day dogfood target, owner-review progress, model route,
      latency, cost, evidence readiness, and promotion state in the cockpit.

### Release and real-world proof

- [x] Run focused and full primary/AGI/deterministic/build/docs/audit gates on the
      combined tree; review the diff and secret boundaries.
- [ ] Commit and push only if `main` remains non-diverged, then rebuild/restart
      the canonical Mac runtime and verify the serving SHA and OpenClaw tools.
- [ ] Complete one real coding mission on each of ten working days. Save a metric
      baseline only after five genuine reviewed outcomes; do not synthesize or
      backfill operator evidence.
- [x] Run the redacted live routing comparison within the approved cumulative
      $25 cap. Incomplete or provider-blocked cases cannot promote a route.

Validation result: 2,100/2,100 primary tests, the production build, 279/279 AGI
tests, 90/90 deterministic commands, documentation checks, dependency audit,
signature flows, formatting, and typecheck pass. The deterministic scorecard is
98.1% A+ with zero regressions and $0 cost. The 12-case redacted live comparison
completed across OpenAI, Anthropic, and Gemini with a conservative estimated
cost of $0.30416; structural passes are explicitly not owner-verified outcomes
and do not satisfy the five-outcome baseline gate.

### Deferred intentionally

- Computer use, realtime voice, persistent sub-agents, autonomous
  self-modification, automatic deployment, passive personal archives, and new
  integrations remain outside this round.

## Deep owner UI/UX round — 2026-07-10

### Implemented

- [x] Add a bounded channel-neutral presentation contract with tailored compact
      renderers and control limits.
- [x] Attach structured presentations to daily guidance, message drafts, and
      follow-through bundles without removing their compatible text surfaces.
- [x] Make calendar guidance and recent Messages reviews visibly state source,
      requested period, freshness, and coverage where available.
- [x] Add a responsive, accessible personal command center for current focus,
      open loops, goals, staged approvals, and recent outcomes.
- [x] Reuse existing database records and approval packets; add no parallel
      memory, action store, or workflow engine.
- [x] Limit cockpit mutations to reversible thread/goal state changes and exact,
      unexpired approval confirmation. External effects still require normal
      executor revalidation.
- [x] Enforce loopback binding, POST-only secret login, constant-time secret
      checks, short-lived HttpOnly sessions, CSRF/same-origin checks, rate
      limiting, restrictive browser headers, and fail-closed configuration.
- [x] Document local setup, Tailscale Serve boundaries, recovery, and the revised
      everyday response model.

### Validation required before release

- [x] Run focused presentation, daily companion, recent-text, action bundle,
      message action, and cockpit security tests.
- [x] Run format, typecheck, lint, full primary tests, production build, AGI
      typecheck/tests, deterministic gates, docs checks, and final diff review.
- [x] Start the cockpit on loopback with a temporary test secret and verify
      login, snapshot, CSRF rejection, reversible controls, and health.
- [ ] Inspect existing Tailscale Serve state before adding a route; do not
      overwrite unrelated handlers. Remote proof remains operator-dependent if
      the local Tailscale CLI cannot read host preferences.

Validation results: 90 focused presentation and security tests pass, including
the calendar and recent-text journeys. The full primary suite, production
typecheck/build, 279 AGI tests, and 90-command deterministic sweep pass. Format,
docs, dependency audit, and final whitespace checks are green; lint has the
existing warning backlog and no errors. Browser review covered authenticated
desktop and 390px mobile layouts, semantic landmarks, responsive overflow,
control sizing, empty/populated states, and console errors. Remote Tailscale
publication was intentionally not changed because the feature has no configured
owner secret and the existing Serve map must be inspected before mutation.

### Intentionally unchanged

- Existing chat commands, memory stores, approval policies, action executors,
  and channel ownership remain authoritative.
- There is no raw-message dashboard, multi-user administration layer, frontend
  framework migration, or direct cockpit external-action executor.

## Production intelligence loop — 2026-07-10

## Verified deep-work apprenticeship — 2026-07-11

### Completed in this round

- [x] Link coding deep-work packets to missions, goals, cognitive episodes,
      approvals, outcomes, and captured repository state without adding a
      duplicate workflow engine or schema migration.
- [x] Add owner review outcomes, evidence completeness, stale-repository
      detection, and outcome-led assistant metrics.
- [x] Add a daily cockpit mission card and authenticated/CSRF-protected review
      endpoint, plus mission chat status and review commands.
- [x] Create coding-skill candidates after three verified missions, promote only
      after five verified missions with at least 80% acceptance and fewer than
      two negative outcomes, and quarantine after two corrections/rejections.
- [x] Preserve fresh approval requirements for commit, push, deploy, migration,
      dependency changes, and deletion; learned skill records cannot expand
      authority.
- [x] Classify the mission debug harness as isolated-write and prove it uses no
      live storage or external effects. No accidental live records existed to
      remove.
- [x] Make live scorecard runs emit explicit start, timeout, success/failure,
      cost-cap, and terminal metadata.
- [x] Refuse to save an assistant metric baseline until at least five reviewed
      outcome samples exist.

### Validation and operator proof

- [x] Focused typecheck and apprenticeship, metric, debug-policy, and cockpit
      tests pass.
- [x] Run format, full primary tests/build, AGI tests, deterministic scorecard,
      docs checks, dependency audit, and final diff review on the complete tree.
- [ ] Dogfood one coding/repository mission per working day for two weeks. This
      is real-world operator evidence and must not be fabricated from fixtures.
- [ ] Review promotion after mission 3 and mission 5. Keep the candidate blocked
      if acceptance, negative-outcome, evidence, or fresh-approval gates fail.

### Intentionally unchanged

- Existing missions, verified deep-work packets, cognitive skill cards, approval
  gates, and assistant metrics remain the systems of record.
- No autonomous commit/push/deploy behavior, broad workflow rewrite, passive
  archive, provider churn, or synthetic-to-live learning was introduced.

### Implemented

- [x] Reuse one cited `PersonalContextPacket` across meaningful turn-harness
      and Cognitive Executive paths; keep summaries local and remote metadata
      bounded to counts, freshness, citations, and conflicts.
- [x] Confidence-cap contradictory context and make it clarification-only.
- [x] Create and advance verified deep-work packets for research, operator,
      repair, and explicitly deep planning turns, including later approval binding.
- [x] Run reversible routine fixtures on rule confirmation and promote the first
      explicitly approved verified or honestly blocked execution as the canary.
- [x] Record accepted/rejected actions, tool attempts/successes, verified
      completion, latency, overrides, and negative-feedback fixtures.
- [x] Add a metadata-only assistant-intelligence operator report and baseline
      command.
- [x] Extend deterministic intelligence/scorecard evidence with cited personal
      context and verified deep-work outcome gates.
- [x] Share provider-env suppression and the process network deny guard across
      the primary and three-round stability runners.
- [x] Skip packet/deep-work persistence only when storage is unavailable and
      propagate unexpected verification failures instead of silently dropping
      evidence.
- [x] Preserve a completed streamed assistant result when the host watchdog
      reaps its container during post-output cleanup; lifecycle-only and error
      results still fail closed.

### Remaining release proof

- [x] Complete full primary, AGI, deterministic, build, docs, lint, audit, and
      signature-flow validation on the combined working tree.
- [x] Restart Mac services and verify serving SHA/runtime health.
- [x] Run one budgeted read-only live council proof. No routine canary or metric
      baseline is due until a real user-selected routine or verified daily
      recommendation exists; the live store currently has zero of both.
- [x] Fetch remote metadata, review the combined diff, commit once, and push
      `main` if it has not diverged.

## Personal intelligence and verified agency — 2026-07-10

### Completed and verified in this round

- [x] Removed secret values from Docker/Podman command arguments while
      preserving OneCLI-preferred and environment fallback execution.
- [x] Added deterministic/live evaluation policy. Deterministic scorecards use
      isolated storage, injected platform fixtures, provider-env suppression, zero
      budget, and non-loopback network denial. Live runs require an explicit
      positive cost cap.
- [x] Added council run origin provenance and restricted calibration and
      provider-quality signals to live runs. Legacy rows are classified as replay.
- [x] Added opt-in source memory policies, redacted derived fact candidates,
      accept/revoke/forget/expiry controls, conflict review, cited bounded context
      packets, and optional semantic scoring with deterministic local fallback.
- [x] Added evidence-gated routine promotion, reversible-action enforcement,
      canary requirements, and automatic pause after two recent negative events.
- [x] Added persisted verified deep-work packets with approval binding,
      checkpoint/resume tool revalidation, degraded-provider blocking,
      postcondition verification, and outcome recording.
- [x] Added outcome-led assistant metrics, saved baselines, regression
      comparison, and feedback-to-redacted-fixture conversion.
- [x] Added focused tests and operator documentation for each new boundary.

### Required validation before release

- [x] Run formatting, lint, full typecheck, primary tests, AGI tests,
      deterministic sweep, build, docs check, and dependency audit.
- [x] Run the deterministic AGI scorecard and confirm zero live provider cost.
- [x] Review the final diff for database migration safety, accidental behavior
      changes, privacy regressions, and scope creep.
- [x] Record the operator's POC-only decision to proceed with budgeted live
      verification without making credential rotation a release blocker. Secret
      values remain prohibited from arguments, logs, errors, and diagnostics.
- [ ] Run one budgeted live council proof. Run an approved canary only when a
      routine has actually been selected for promotion.

Validation results: the full 2,073-test primary suite passed, including the
legacy migration and new storage-boundary/network-denial coverage, as did
279/279 AGI tests and 90/90 deterministic commands (including three hermetic
stability rounds). The production build and formatting/type/docs/dependency
checks are green; lint has the existing warning backlog and no errors. The
deterministic scorecard reached 98.1% A+ with zero merge-blocking regressions
and $0.0000 estimated cost, and signature workflows completed. The shared
TypeScript artifact is Windows-compatible; native Windows restart proof remains
deferred because no Windows host or PowerShell runtime is available here. The
budgeted live scorecard also reached 98.1% A+ with no merge-blocking regressions
and $0.0000 estimated cost under its $1 cap. The canonical Mac runtime is
`running_ready`, serves the final commit, and passed exact, summary, and
refinement assistant execution probes; OpenClaw is live with 11/11 required
bridge tools. The obsolete duplicate `com.nanoclaw.mac-mini` LaunchAgent was
disabled after it was found retrying against the canonical runtime's ports.

### Intentionally unchanged

- Existing profile memory, Knowledge Library, and episodic/context stores stay
  distinct; the packet is a bounded compilation layer, not a replacement.
- External sends, calendar writes, purchases, admin actions, deploys, and
  deletions retain fresh approval gates.
- No passive raw-message archive, autonomous workflow engine, broad rewrite,
  provider dependency churn, or automatic behavior-changing patch promotion
  was introduced.

## Audit baseline — 2026-07-10

- The previous agent's release-proof and messaging work is committed in
  `077d2a8f`; there were no tracked unfinished edits to recover.
- Verified before this modernization pass: primary typecheck, formatting,
  lint with pre-existing warnings only, build, 2,043 primary tests, AGI
  typecheck/tests, dependency audit, signature-flow harness, and AGI-lab
  report.
- `main` matched `origin/main` before implementation. The untracked private
  `.env.backup-2026-07-06` is preserved and now ignored.

## Completed in this pass

- [x] Bound inbound media downloads and vision inputs; cache paths are checked
      before analysis.
- [x] Add automatic cache retention and size-budget pruning for inbound and
      derived media.
- [x] Reuse cached BlueBubbles attachments during repeat history priming.
- [x] Make OpenAI provider tests ignore host `.env` credentials and block
      public fetches in deterministic test processes.
- [x] Make logger process error handlers idempotent.
- [x] Add documentation validation, privacy disclosure, and media settings.
- [x] Update `tsx` from 4.21.0 to 4.23.0, which brings transitive `esbuild`
      to 0.28.1 and resolves the low-severity Windows development-server advisory.

## Validation completed before release actions

- [x] Clean dependency install: `npm ci`.
- [x] Primary CI-safe gate: `npm run test:major:ci` (format, typecheck, lint,
      full primary tests, and build). Lint passed with the pre-existing warning
      backlog only; touched files introduced no lint errors.
- [x] AGI typecheck and test suite: `npm run typecheck:agi` and
      `npm run test:agi` (28 files, 279 tests).
- [x] Deterministic suite: `npm run test:deterministic:sweep` (90/90 scripts,
      including three stability rounds).
- [x] Product workflow harness: `npm run debug:signature-flows`.
- [x] Documentation and dependency checks: `npm run docs:check`,
      `npm audit --omit=dev`, and full `npm audit` (zero vulnerabilities).

## Release verification completed

- [x] Built the final shared `dist/index.js` artifact from the committed tree,
      reinstalled the local OpenClaw bridge, and restarted the Mac launchd service
      plus the OpenClaw gateway.
- [x] Mac service status is `running` and serving the committed `main` SHA;
      three configured assistant-runtime probes completed successfully, with host
      state `running_ready`.
- [x] OpenClaw bridge status and probe are live: 11/11 required tools are
      available, direct BlueBubbles send remains excluded, and the local control
      API is healthy.
- [x] BlueBubbles is reachable on its local endpoint and its webhook is
      registered. Its remaining same-thread message-action proof debt is
      operator/product evidence, not a release regression.
- [x] Windows has no host available in this session. The shared TypeScript
      artifact is validated here; the documented post-push Windows proof is
      `npm ci`, `npm run build`, `npm run services:restart`, and
      `npm run setup -- --step verify` from the canonical checkout.

## Required release validation

- Focused media, channel, control-server, logger, docs, and Windows launcher
  tests; then the full primary, AGI, deterministic, and CI-safe test suites.
- Format, typecheck, lint, build, `npm audit --omit=dev`, docs check, workflow
  harnesses, and final diff review.
- Rebuild and verify the Mac launchd runtime, OpenClaw bridge/gateway, and
  deployment status before pushing `main`.
- Windows uses the same `dist/index.js` build; its native rebuild remains the
  documented post-push `npm ci`, build, service restart, and verify sequence.

## Intentionally unchanged

- Existing message approval gates, backend lanes, database schema, and live
  proof classifications remain intact.
- The repository-wide lint warning backlog is not a safe modernization target
  for this pass; only warnings in touched code are addressed.
- Alexa device proof, provider quotas, credential state, and aged pilot or
  council evidence remain external/operator state unless validation proves a
  repository defect.
