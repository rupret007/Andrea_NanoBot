# Adaptive Cognition v1 — Night Handoff

Date: 2026-07-20

## Safe stopping state

- BlueBubbles outbound sending remains disabled with
  `BLUEBUBBLES_SEND_ENABLED=false`.
- No restart, deployment, message send, commit, push, or service change was
  performed during the Adaptive Cognition work.
- The repository already has a broad dirty worktree. Preserve unrelated user
  changes and review the exact diff before any commit.

## Completed and verified tonight

- The canonical adaptive engine, durable exact-node adapter, live
  `prepare_only` harness path, typed runtime completion bridge, and same-work
  terminal completion gate are implemented.
- Unsupported completion wording fails closed; container output is buffered
  until same-run/turn runtime evidence and durable terminal verification pass.
- The policy-first trajectory regression was repaired: an unsafe
  `bluebubbles_draft` is never executed, only that exact adapter is demoted,
  and the demotion survives durable recomputation.
- Current-tree `test:major:ci` passed: formatting, typecheck, lint, 283 test
  files / 3,693 tests, 48/48 adaptive certification scenarios, and build.
- All 14 cognition script gates passed. Certification still reports zero
  unauthorized effects, false completions, privacy leakage, oracle leakage,
  and production-state writes.
- Container contract, agent-runner, AGI, held-out continuity, hard-kill
  continuity, and the embedded three-round stability gate passed.

## Resume here tomorrow

1. Finish the requirement-by-requirement completion audit for all eight goal
   sections. Pay particular attention to whether goal-planner,
   metacognition, cognitive executive, and agency convergence all use the one
   canonical engine without creating a parallel cognition authority.
2. Close safe legacy receipt gaps with narrow, storage-backed adapters. The
   strongest candidates are exact reminder-task receipts, calendar automation
   pause/resume/save state, persisted Google Calendar create receipts, and
   exact life-thread records. Callers must pass identifiers, never construct
   their own `AdaptiveEvidence`.
3. Keep deletion, provider update/move, generic capability, research-result,
   artifact, mixed-union, and other paths fail-closed until they have a
   positive operation-specific receipt or tombstone.
4. Recheck acceptance coverage for novel planning, causal diagnosis,
   conflicting context, research, misleading observations, and correction-to-
   regression learning. Add focused fixtures if any named category is only
   implied rather than directly proven.
5. Rerun the complete deterministic sweep after any further code change. The
   previous sweep passed 98/99 plus its embedded stability gate; its sole
   trajectory failure was fixed and rerun successfully, but the entire
   99-script aggregate was not rerun after that small fix.
6. Do not claim full acceptance until the real owner dogfood has 20 qualifying
   live tasks across 10 distinct working dates. It currently has no qualifying
   live ledger and must not be backfilled or simulated.

## Restart boundary

Do not restart the full system merely to continue development. Before any
future restart, explicitly confirm owner authorization, verify the durable
outbound pause and `BLUEBUBBLES_SEND_ENABLED=false`, and keep sending disabled
through startup validation.
