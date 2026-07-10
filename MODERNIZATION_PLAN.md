# Modernization Plan

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
