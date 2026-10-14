# Step 2: full Alexa removal

Branch: `feat/remove-alexa-full`. Changes remain uncommitted in the working tree; nothing was pushed.

## Result

Removed Alexa modules, routes/channel metadata, commands, capability entries, proof/readiness/pilot/setup handling, environment keys, interaction model, marketplace entries, documentation, and shared-script scenarios. Shared Telegram/BlueBubbles conversation follow-ups and action completion remain under generic names. Generic tests were retained, including four conversation tests and one profile-fact test moved from Alexa-named files.

The five tables (`alexa_linked_accounts`, `alexa_sessions`, `alexa_conversation_contexts`, `alexa_oauth_authorization_codes`, `alexa_oauth_refresh_tokens`) and their CREATE TABLE/index/migration code remain. Unused accessors were removed. Schema definitions match original HEAD byte-for-byte; a disposable-database check confirmed all five schemas, indexes, and seeded rows survive initialization unchanged. No live database was modified.

Historical retired-channel reliability rows remain stored but no longer influence current blockers or routing. Two regression tests cover retained rows and supported/custom subjects. A stale derived proof-plan projection found by the preserved goal-planning assertion was corrected without changing that assertion's strength.

## Verification

| Command | Result | Counts |
| --- | --- | --- |
| `npm run build` | Passed | TypeScript and build provenance completed |
| `npm run docs:check` | Passed | 85 Markdown files, including both required reports |
| `npx vitest run` | Failed due to sandbox loopback restrictions | 4,055 passed, 10 failed, 4,193 collected; 291 files passed, 5 failed, 301 collected; 8 unhandled errors |
| `npm run lint` | Passed | 0 errors, 695 warnings |

The exact required command chain was invoked. Because Vitest failed, lint was also invoked separately and passed. A second full `npx vitest run` after the source-hash fixture update produced the final counts above (182.11 seconds). Five worker suites exited unexpectedly; 128 collected tests were not reported as completed. This is not a clean full-suite pass.

All ten remaining failures arise from the sandbox denying local HTTP/TCP server binds with `listen EPERM` on `127.0.0.1`, including dependent timeout/worker-readiness failures:

- `setup/google-calendar.test.ts`: 2 callback-server failures.
- `src/bluebubbles-receipt-inbox.test.ts`: 3 HTTP-server failures.
- `src/bluebubbles-message-action-hard-kill.test.ts`: 3 dependent 60-second timeouts after socket errors.
- `src/bluebubbles-receipt-inbox-hard-kill.test.ts`: 1 child-server readiness failure.
- `src/hermetic-test-env.test.ts`: 1 loopback HTTP/TCP/UDP fixture failure.

No test was skipped, weakened, or reconfigured to work around the sandbox. These tests require a runtime that permits loopback listeners. Final command logs: `/tmp/alexa-confirmed-build.log`, `/tmp/alexa-confirmed-docs.log`, `/tmp/alexa-final-vitest-confirmed.log`, `/tmp/alexa-final-lint.log`.

Additional verification: 240 operational tests passed; 382 capability tests passed after fixture correction; 10 reliability tests passed (including two new tests); the 2 source-identity/send-fence tests passed. Thirteen script checks and eight isolated debug harnesses passed. The source-identity fixture's message-actions SHA-256 was updated only for the three type edits; every hash matcher and send-fence assertion remains, and all five other source hashes are unchanged.

Every removed test/assertion is documented in `REMOVED_ASSERTIONS.md`, grouped by file. The six deleted Alexa-named test files held 43 tests: 5 shared tests were moved intact and 38 Alexa-specific tests were removed. Independent audit confirmed coverage of all 138 removed cases or revised/deleted assertion expressions in shared files. No skips, relaxed matchers, threshold changes, clock/TZ changes, or vitest/tsconfig/eslint/CI configuration changes were introduced. Package overrides, audit settings, package.json, and package-lock.json are unchanged.

The initial untracked `node_modules` symlink pointed to `../andrea-alexa-verify/node_modules`; it was replaced with a writable local copy so Vitest could create its cache without writing outside this workspace.

## Files deleted (17)

- `docs/ALEXA_VOICE_INTEGRATION.md`
- `docs/alexa/interaction-model.en-US.json`
- `setup/alexa-model-sync.ts`
- `src/alexa-bridge.test.ts`
- `src/alexa-bridge.ts`
- `src/alexa-conversation.test.ts`
- `src/alexa-conversation.ts`
- `src/alexa-dialogue.test.ts`
- `src/alexa-dialogue.ts`
- `src/alexa-identity.test.ts`
- `src/alexa-identity.ts`
- `src/alexa-model-sync-state.ts`
- `src/alexa-oauth.ts`
- `src/alexa-session.ts`
- `src/alexa-v1.test.ts`
- `src/alexa-v1.ts`
- `src/db-alexa.test.ts`

## Files changed (183)

- `.env.example`
- `CHANGELOG.md`
- `MODERNIZATION_PLAN.md`
- `README.md`
- `README_ja.md`
- `README_zh.md`
- `container/skills/openclaw-market/catalog.json`
- `docs/ACTION_BUNDLES.md`
- `docs/ADDONS_AND_FEATURE_MATRIX.md`
- `docs/ADMIN_GUIDE.md`
- `docs/AGI_ARCHITECTURE.md`
- `docs/AGI_INTEGRATION_GUIDE.md`
- `docs/AGI_ROADMAP.md`
- `docs/ANDREA_FINAL_RESET_HANDOFF.md`
- `docs/ASSISTANT_CAPABILITY_GRAPH.md`
- `docs/BLUEBUBBLES_CHANNEL_PREP.md`
- `docs/CHANNEL_COMMANDS_AND_ONBOARDING.md`
- `docs/CHIEF_OF_STAFF_MODE.md`
- `docs/COMMAND_SURFACE_REFERENCE.md`
- `docs/COMMITMENT_INTELLIGENCE.md`
- `docs/COMMUNICATION_COMPANION.md`
- `docs/CROSS_CHANNEL_HANDOFFS.md`
- `docs/CURRENT_STATUS.md`
- `docs/DELEGATION_RULES_AND_SAFE_AUTOMATION.md`
- `docs/DEMO_CHECKLIST.md`
- `docs/KNOWLEDGE_LIBRARY.md`
- `docs/MESSAGING_TRUST_LADDER_AND_LIVE_DELIVERY.md`
- `docs/MISSIONS_AND_EXECUTION.md`
- `docs/OUTCOME_TRACKING_AND_REVIEWS.md`
- `docs/PROACTIVE_RITUALS.md`
- `docs/README.md`
- `docs/SECURITY.md`
- `docs/SETUP_AND_FEATURES_GUIDE.md`
- `docs/TESTING_AND_RELEASE_RUNBOOK.md`
- `docs/USER_GUIDE.md`
- `imported/andrea_openai_bot/.github/PULL_REQUEST_TEMPLATE.md`
- `scripts/agi-doctor.sh`
- `scripts/debug-chief-of-staff.ts`
- `scripts/debug-communication-companion.ts`
- `scripts/debug-cross-channel-handoffs.ts`
- `scripts/debug-daily-companion.ts`
- `scripts/debug-knowledge-library.ts`
- `scripts/debug-missions.ts`
- `scripts/debug-pilot.ts`
- `scripts/debug-rituals.ts`
- `scripts/debug-setup-dogfood.ts`
- `scripts/debug-shared-capabilities.ts`
- `scripts/debug-signature-flows.ts`
- `scripts/nanoclaw-host.ps1`
- `scripts/test-action-lifecycle.ts`
- `scripts/test-action-preflight.ts`
- `scripts/test-active-perception.ts`
- `scripts/test-blackboard.ts`
- `scripts/test-capabilities.ts`
- `scripts/test-dogfood-gauntlet.ts`
- `scripts/test-goal-planning.ts`
- `scripts/test-proof-gauntlet.ts`
- `scripts/test-reality-grounding.ts`
- `scripts/test-shadow-improvement.ts`
- `scripts/test-truth-maintenance.ts`
- `scripts/test-world.ts`
- `setup/index.ts`
- `setup/verify.test.ts`
- `setup/verify.ts`
- `src/action-bundles.test.ts`
- `src/action-bundles.ts`
- `src/action-lifecycle.ts`
- `src/action-preflight.ts`
- `src/agency-convergence-loop.ts`
- `src/agi-gauntlet.ts`
- `src/agi-lab-readiness.test.ts`
- `src/agi-leap-readiness.test.ts`
- `src/agi-runtime.ts`
- `src/agi-scorecard.ts`
- `src/andrea-openai-backend.ts`
- `src/andrea-platform-bridge.ts`
- `src/andrea-pulse.test.ts`
- `src/andrea-pulse.ts`
- `src/assistant-action-completion.test.ts`
- `src/assistant-action-completion.ts`
- `src/assistant-capabilities.test.ts`
- `src/assistant-capabilities.ts`
- `src/assistant-capability-router.test.ts`
- `src/assistant-capability-router.ts`
- `src/assistant-personalization.test.ts`
- `src/assistant-personalization.ts`
- `src/assistant-presentation.test.ts`
- `src/assistant-presentation.ts`
- `src/autonomous-improvement-lab.ts`
- `src/bluebubbles-companion.ts`
- `src/capability-resource-broker.test.ts`
- `src/capability-resource-broker.ts`
- `src/capability-self-model-runtime-contract.test.ts`
- `src/capability-self-model.ts`
- `src/channels/telegram.test.ts`
- `src/chief-of-staff.ts`
- `src/cognitive-blackboard.ts`
- `src/cognitive-kernel.ts`
- `src/cognitive-workspace.ts`
- `src/command-surface-registry.test.ts`
- `src/command-surface-registry.ts`
- `src/communication-companion.test.ts`
- `src/communication-companion.ts`
- `src/communication-forget.ts`
- `src/communication-identity-review.ts`
- `src/companion-personality.ts`
- `src/conversational-core.test.ts`
- `src/conversational-core.ts`
- `src/council-evidence.ts`
- `src/council-quality.test.ts`
- `src/critic-agent.ts`
- `src/cross-channel-handoffs.test.ts`
- `src/daily-companion.test.ts`
- `src/daily-companion.ts`
- `src/db.ts`
- `src/debug-control.test.ts`
- `src/debug-control.ts`
- `src/delegation-rules.test.ts`
- `src/delegation-rules.ts`
- `src/dogfood-gauntlet.ts`
- `src/everyday-capture.test.ts`
- `src/everyday-capture.ts`
- `src/field-trial-readiness.test.ts`
- `src/field-trial-readiness.ts`
- `src/follow-through-activation.ts`
- `src/goal-planner.ts`
- `src/helper-boundary.test.ts`
- `src/host-control.test.ts`
- `src/host-control.ts`
- `src/index.ts`
- `src/integration-doctor.test.ts`
- `src/integration-doctor.ts`
- `src/integration-healer.ts`
- `src/integration-recovery.test.ts`
- `src/integration-recovery.ts`
- `src/intelligence-progress.test.ts`
- `src/keyed-turn-serializer.ts`
- `src/life-thread-commitment.ts`
- `src/life-threads.ts`
- `src/live-proof-gauntlet.ts`
- `src/local-reminder.ts`
- `src/media-generation.test.ts`
- `src/media-generation.ts`
- `src/memory-activation.ts`
- `src/message-actions.ts`
- `src/metacognition-routing.test.ts`
- `src/metacognition.ts`
- `src/missions.ts`
- `src/named-open-loop.test.ts`
- `src/named-open-loop.ts`
- `src/onboarding-profile-pack.ts`
- `src/operator-command-gate.test.ts`
- `src/operator-command-gate.ts`
- `src/outcome-reviews.test.ts`
- `src/outcome-reviews.ts`
- `src/pilot-mode.test.ts`
- `src/pilot-mode.ts`
- `src/provider-council-runner.ts`
- `src/reality-grounding.ts`
- `src/research-orchestrator.test.ts`
- `src/research-orchestrator.ts`
- `src/response-feedback.test.ts`
- `src/response-feedback.ts`
- `src/rituals.ts`
- `src/runtime-capability-production-surfaces.test.ts`
- `src/runtime-capability-registry.test.ts`
- `src/runtime-capability-registry.ts`
- `src/send-path-blob-identity.test.ts`
- `src/session-graph.ts`
- `src/setup-dogfood.ts`
- `src/shadow-improvement-runner.test.ts`
- `src/shadow-improvement-runner.ts`
- `src/signature-flows.test.ts`
- `src/signature-flows.ts`
- `src/skill-library.ts`
- `src/strategy-evals.ts`
- `src/tool-reliability.ts`
- `src/truth-engine.ts`
- `src/turn-agent-harness.ts`
- `src/types.ts`
- `src/user-facing-fallback.test.ts`
- `src/world-model.ts`
- `tests/agi-readiness.test.ts`

## Files added (6)

- `REMOVED_ASSERTIONS.md`
- `src/assistant-conversation.test.ts`
- `src/assistant-conversation.ts`
- `src/db-profile-facts.test.ts`
- `src/tool-reliability-current-subjects.test.ts`
- `STEP2_SUMMARY.md`
