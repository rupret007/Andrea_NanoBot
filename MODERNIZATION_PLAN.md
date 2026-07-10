# Modernization Plan

## Production intelligence loop — 2026-07-10

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
