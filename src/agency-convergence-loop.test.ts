import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { beginAgentRuntimeSpineRun } from './agent-runtime-spine.js';
import {
  formatAgencyConvergenceDoctorReport,
  runAgencyConvergenceLoop,
} from './agency-convergence-loop.js';
import { _closeDatabase, _initTestDatabase } from './db.js';
import {
  commitDurableCheckpointCAS,
  createOrLoadDurableWork,
  issueDurableResumeGrant,
} from './durable-work-continuity.js';

const NOW = '2026-07-13T12:00:00.000Z';
const binding = {
  ownerId: 'owner-agency-continuity',
  chatId: 'chat-agency-continuity',
  groupId: 'main',
  channel: 'telegram',
  targetScopeKey: 'repository-agency-continuity',
};

beforeEach(() => _initTestDatabase());
afterEach(() => _closeDatabase());

function seedLegacyResumeId(): string {
  const runtime = beginAgentRuntimeSpineRun({
    turnId: 'legacy-resume-seed',
    channel: 'telegram',
    groupFolder: 'main',
    taskFamily: 'communication',
    goal: 'Send one staged message after approval.',
    generatedAt: NOW,
    mode: 'assistive',
  });
  const resumeId = runtime?.report.resumeTokens[0]?.resumeTokenId;
  expect(resumeId).toBeTruthy();
  return resumeId!;
}

function seedDurableGrant() {
  const created = createOrLoadDurableWork({
    originTurnId: 'turn-agency-continuity',
    authorizedSurface: 'telegram',
    binding,
    goalSummary: 'Repair a bounded repository fixture and verify it.',
    status: 'ready',
    runtimeRunId: 'runtime:durable-agency',
    nextAction: 'Re-inspect repository state before the edit step.',
    now: NOW,
  });
  const committed = commitDurableCheckpointCAS({
    workId: created.work.workId,
    expectedWorkVersion: created.work.version,
    completedNodeIds: ['inspect'],
    pendingNodeIds: ['edit', 'verify'],
    uncertainNodeIds: [],
    dependencyIds: ['inspect'],
    worldSignals: { fresh: ['repository'], stale: [], missing: [] },
    executorScopeKey: 'host-executor-agency-continuity',
    targetScopeKey: binding.targetScopeKey,
    preStateFingerprint: 'sha256:agency-prestate',
    verificationRequirementIds: ['fixture-test'],
    stopConditionIds: ['terminal-error'],
    recoveryPolicy: 'inspect_then_resume',
    nextSafeAction: 'Re-inspect state, then execute only the next valid node.',
    now: NOW,
  });
  const issued = issueDurableResumeGrant({
    workId: committed.work.workId,
    binding,
    actionClass: 'repository_read',
    now: NOW,
  });
  return { ...committed, issued };
}

describe('agency convergence durable continuity projection', () => {
  it('does not present a legacy descriptive resume ID as executable', async () => {
    const legacyResumeId = seedLegacyResumeId();
    const report = await runAgencyConvergenceLoop({
      generatedAt: '2026-07-13T12:00:01.000Z',
      mode: 'assistive',
      groupFolder: 'main',
      intentText: 'resume that',
      providerSnapshots: [],
      liveProviderProbe: false,
    });
    const resumePlan = report.resumePlans[0];
    const text = formatAgencyConvergenceDoctorReport(report);

    expect(report.durableContinuity.work?.status).toBe('awaiting_approval');
    expect(resumePlan?.status).toBe('approval_required');
    expect(resumePlan?.resumeTokenId).toBeNull();
    expect(resumePlan?.summary).toContain('exact-scope approval');
    expect(text).toContain('legacy resume identifiers do not authorize');
    expect(JSON.stringify({ report, text })).not.toContain(legacyResumeId);
  });

  it('makes scoped durable continuity the canonical recovery view', async () => {
    const { work, issued } = seedDurableGrant();
    const report = await runAgencyConvergenceLoop({
      generatedAt: '2026-07-13T12:00:01.000Z',
      mode: 'assistive',
      groupFolder: 'main',
      intentText: 'keep going',
      providerSnapshots: [],
      liveProviderProbe: false,
    });
    const resumePlan = report.resumePlans[0];
    const text = formatAgencyConvergenceDoctorReport(report);

    expect(report.durableContinuity.work?.workId).toBe(work.workId);
    expect(report.durableContinuity.resumeEligible).toBe(true);
    expect(resumePlan).toMatchObject({
      status: 'available',
      resumeTokenId: null,
      checkpointId: work.checkpointHeadId,
    });
    expect(resumePlan?.summary).toContain('opaque single-use grant');
    expect(JSON.stringify({ report, text })).not.toContain(issued.token);
    expect(text.indexOf('Canonical recovery state:')).toBeLessThan(
      text.indexOf('Session Graph compatibility view'),
    );
    expect(text).toContain('Durable Cognitive Continuity');
  });
});
