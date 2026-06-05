import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  beginCognitiveKernelRun,
  buildCognitiveDoctorReport,
  buildCognitiveResumePlan,
  buildCognitiveTraceReport,
  finalizeCognitiveKernelOutcome,
  formatCognitiveDoctorReport,
  isCognitionDoctorRequest,
  runCognitiveBenchmarkSuite,
} from './cognitive-kernel.js';
import {
  _closeDatabase,
  _initTestDatabase,
  getCognitiveRun,
  listCognitiveAutonomyBudgets,
  listCognitiveBlackboardEntries,
  listCognitiveCheckpoints,
  listCognitiveGoals,
  listCognitiveProviderCooldowns,
  listCognitiveReflections,
  listCognitiveRewardSignals,
  listCognitiveSkillCards,
  listCognitiveSubgoalsForRun,
  listCognitiveToolSimulations,
  listCognitiveTraceSpans,
  listCognitiveToolRegistry,
  listCognitiveWorldBeliefs,
} from './db.js';

describe('cognitive kernel', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('frames read-only evidence tasks with explicit subgoal contracts', () => {
    const kernel = beginCognitiveKernelRun({
      turnId: 'cog-read-only',
      channel: 'telegram',
      taskFamily: 'calendar',
      goal: "what's on my calendar tomorrow",
      requestRoute: 'direct_assistant',
      selectedSkillId: 'calendar.availability',
      selectedSkillPurpose: 'Read calendar safely.',
      selectedSkillApprovalNeed: 'conditional',
      selectedSkillSideEffectRisk: 'medium',
      selectedSkillEvidenceLevel: 'strong',
    });

    expect(kernel.run.cognitiveMode).toBe('read_only_react');
    expect(kernel.run.autonomyLevel).toBe('read_only_tools');
    expect(kernel.taskGraph.subgoals.length).toBeGreaterThanOrEqual(5);
    expect(
      kernel.taskGraph.subgoals.every(
        (subgoal) => subgoal.requiredEvidence && subgoal.stopCondition,
      ),
    ).toBe(true);
    expect(
      kernel.taskGraph.subgoals.some((subgoal) =>
        subgoal.allowedActions.includes('read_only_integration'),
      ),
    ).toBe(true);
    expect(listCognitiveSubgoalsForRun(kernel.run.runId)).toHaveLength(
      kernel.taskGraph.subgoals.length,
    );
    expect(
      listCognitiveToolRegistry().some(
        (tool) => tool.toolId === 'google_calendar_read',
      ),
    ).toBe(true);
    expect(
      listCognitiveCheckpoints({ runId: kernel.run.runId }).map(
        (checkpoint) => checkpoint.checkpointKind,
      ),
    ).toEqual(
      expect.arrayContaining(['frame', 'plan', 'tool_policy', 'verification']),
    );
    expect(
      listCognitiveWorldBeliefs({ runId: kernel.run.runId }).some(
        (belief) => belief.source === 'provider_health',
      ),
    ).toBe(true);
    expect(kernel.activeGoal).toMatchObject({
      taskFamily: 'calendar',
      status: 'active',
    });
    expect(kernel.blackboardSnapshot.length).toBeGreaterThanOrEqual(3);
    expect(kernel.autonomyBudget).toMatchObject({
      cognitiveMode: 'read_only_react',
      mutatingAllowed: false,
      approvalRequired: false,
    });
    expect(listCognitiveGoals({ taskFamily: 'calendar' })[0]?.goalId).toBe(
      kernel.activeGoal?.goalId,
    );
    expect(
      listCognitiveBlackboardEntries({ runId: kernel.run.runId }).length,
    ).toBeGreaterThanOrEqual(3);
    expect(
      listCognitiveAutonomyBudgets({
        cognitiveMode: 'read_only_react',
        taskFamily: 'calendar',
      })[0],
    ).toMatchObject({ mutatingAllowed: false });
    expect(
      listCognitiveTraceSpans({ runId: kernel.run.runId }).length,
    ).toBeGreaterThanOrEqual(5);
    expect(
      listCognitiveToolSimulations({ runId: kernel.run.runId }).length,
    ).toBeGreaterThan(0);
    expect(
      buildCognitiveTraceReport({ runId: kernel.run.runId }),
    ).toMatchObject({
      runId: kernel.run.runId,
      spanCount: expect.any(Number),
    });
  });

  it('forces ultrathink into council-verified mode without storing raw private content', () => {
    const kernel = beginCognitiveKernelRun({
      turnId: 'cog-ultra',
      channel: 'telegram',
      taskFamily: 'operator',
      goal: 'ultrathink the safest repair route for the provider diagnostics',
      requestRoute: 'direct_assistant',
      selectedSkillId: 'operator.diagnostics',
      selectedSkillPurpose: 'Diagnose operator issues without mutating state.',
      selectedSkillApprovalNeed: 'none',
      selectedSkillSideEffectRisk: 'low',
      selectedSkillEvidenceLevel: 'partial',
      providerCouncil: {
        councilRunId: 'council-ultra',
        mode: 'max_iq_council',
        status: 'completed',
        answerGuidance: {
          status: 'pass',
          visibleVerdict: 'Proceed read-only.',
          answerDirection: 'Use diagnostics and stage repairs.',
          confidence: 0.82,
          uncertainty: 'No mutation approval.',
          sourceMemberIds: ['planner', 'verifier'],
        },
      },
      thinkingPreference: 'deep',
      thinkingTrigger: 'ultrathink',
    });

    expect(kernel.run.cognitiveMode).toBe('council_verified');
    expect(kernel.verification.councilRunId).toBe('council-ultra');
    expect(kernel.run.goalSummary).not.toMatch(/sk-|Bearer\s+|AIza/);
    expect(JSON.parse(kernel.run.privacyJson)).toMatchObject({
      rawPromptsStored: false,
      rawPrivateBodiesStored: false,
      hiddenReasoningStored: false,
    });
  });

  it('records outcome rewards and promotes repeated successful skills', () => {
    function runSuccess(turnId: string) {
      const kernel = beginCognitiveKernelRun({
        turnId,
        channel: 'telegram',
        taskFamily: 'research',
        goal: 'compare this with local memory first and search only if needed',
        requestRoute: 'direct_assistant',
        selectedSkillId: 'research.live_or_saved',
        selectedSkillPurpose: 'Answer from saved or live evidence.',
        selectedSkillApprovalNeed: 'none',
        selectedSkillSideEffectRisk: 'none',
        selectedSkillEvidenceLevel: 'strong',
      });
      finalizeCognitiveKernelOutcome({
        cognitiveRun: kernel,
        evaluationStatus: 'pass',
        evidenceGap: 'none',
        evaluatorFlags: ['none'],
        routeUsed: 'research.live_or_saved',
        answerClass: 'handled',
      });
      return kernel;
    }

    const first = runSuccess('cog-skill-1');
    const second = runSuccess('cog-skill-2');
    const cards = listCognitiveSkillCards({ taskFamily: 'research' });
    const skill = cards.find((card) =>
      card.skillId.includes('research.live_or_saved'),
    );

    expect(getCognitiveRun(first.run.runId)?.status).toBe('answered');
    expect(getCognitiveRun(second.run.runId)?.status).toBe('answered');
    expect(skill?.promotionState).toBe('promoted');
    expect(
      listCognitiveRewardSignals({ runId: second.run.runId })[0],
    ).toMatchObject({
      signalKind: 'task_answered',
    });
  });

  it('quarantines blocked approval-required skills and keeps reports redacted', () => {
    const kernel = beginCognitiveKernelRun({
      turnId: 'cog-blocked',
      channel: 'bluebubbles',
      taskFamily: 'communication',
      goal: 'Communication task from bluebubbles; raw message body stays local. Shape: words=4; question=false; action=true.',
      requestRoute: 'bluebubbles.direct',
      selectedSkillId: 'communication.reply_help',
      selectedSkillPurpose: 'Draft replies while preserving send approval.',
      selectedSkillApprovalNeed: 'explicit',
      selectedSkillSideEffectRisk: 'high',
      selectedSkillEvidenceLevel: 'partial',
      knownBlockers: ['same-thread approval missing'],
    });

    finalizeCognitiveKernelOutcome({
      cognitiveRun: kernel,
      evaluationStatus: 'block',
      evidenceGap: 'blocked',
      evaluatorFlags: ['approval_required'],
      routeUsed: 'communication.reply_help',
      answerClass: 'blocked',
      blockerClass: 'approval_required',
    });

    const card = listCognitiveSkillCards({ taskFamily: 'communication' }).find(
      (skill) => skill.skillId.includes('communication.reply_help'),
    );
    const report = buildCognitiveDoctorReport();
    const formatted = formatCognitiveDoctorReport(report);

    expect(card?.promotionState).toBe('quarantined');
    expect(
      listCognitiveReflections({ taskFamily: 'communication' })[0],
    ).toMatchObject({
      reflectionKind: 'failure',
    });
    expect(formatted).toContain('Cognition Status');
    expect(formatted).toContain('Checkpoints');
    expect(formatted).toContain('Tool Registry');
    expect(formatted).toContain('Goal Lifecycle');
    expect(formatted).toContain('Autonomy Budgets');
    expect(formatted).not.toMatch(/sk-|Bearer\s+|AIza|raw message body text/i);
  });

  it('creates resumable approval checkpoints without raw private content', () => {
    const kernel = beginCognitiveKernelRun({
      turnId: 'cog-resume-approval',
      channel: 'bluebubbles',
      groupFolder: 'main',
      taskFamily: 'communication',
      goal: 'Communication task from bluebubbles; raw message body stays local. Shape: words=6; question=false; action=true.',
      requestRoute: 'bluebubbles.direct',
      selectedSkillId: 'communication.reply_help',
      selectedSkillPurpose: 'Draft reply help.',
      selectedSkillApprovalNeed: 'explicit',
      selectedSkillSideEffectRisk: 'high',
      selectedSkillEvidenceLevel: 'partial',
    });

    const resume = buildCognitiveResumePlan({
      groupFolder: 'main',
      channel: 'bluebubbles',
      continuationKey: 'communication:communication.reply_help',
    });

    expect(kernel.run.status).toBe('awaiting_approval');
    expect(resume.found).toBe(true);
    expect(resume.run?.runId).toBe(kernel.run.runId);
    expect(resume.goal?.goalId).toBe(kernel.activeGoal?.goalId);
    expect(resume.blackboardEntries.length).toBeGreaterThanOrEqual(3);
    expect(resume.checkpoint?.checkpointKind).toBe('approval_wait');
    expect(JSON.stringify(resume)).not.toMatch(
      /sk-|Bearer\s+|AIza|raw message body text|chain-of-thought/i,
    );
  });

  it('blocks unsafe tool plans that omit high-risk approval', () => {
    const kernel = beginCognitiveKernelRun({
      turnId: 'cog-unsafe-tool',
      channel: 'telegram',
      taskFamily: 'communication',
      goal: 'Communication task from telegram; raw message body stays local. Shape: words=6; question=false; action=true.',
      requestRoute: 'direct_assistant',
      selectedSkillId: 'communication.reply_help',
      selectedSkillPurpose: 'Draft reply help.',
      selectedSkillApprovalNeed: 'none',
      selectedSkillSideEffectRisk: 'high',
      selectedSkillEvidenceLevel: 'partial',
    });

    expect(kernel.run.status).toBe('blocked');
    expect(kernel.verification.evidenceGaps).toContain(
      'tool_policy:approval_missing:bluebubbles_draft',
    );
    expect(kernel.verification.evidenceGaps).toContain(
      'tool_simulation_blocked',
    );
    expect(
      listCognitiveToolSimulations({
        runId: kernel.run.runId,
        status: 'block',
      }).some((simulation) => simulation.toolId === 'bluebubbles_draft'),
    ).toBe(true);
  });

  it('runs deterministic cognition benchmarks with checkpoints and policy proof', () => {
    const report = runCognitiveBenchmarkSuite({
      generatedAt: '2026-06-05T12:00:00.000Z',
    });

    expect(report.status).not.toBe('fail');
    expect(report.attempts).toHaveLength(4);
    expect(
      report.attempts.every((attempt) => attempt.checkpointCount >= 4),
    ).toBe(true);
    expect(report.attempts.every((attempt) => attempt.toolPolicyPass)).toBe(
      true,
    );
    expect(report.attempts.every((attempt) => attempt.privacyPass)).toBe(true);
    expect(
      report.attempts.every((attempt) => {
        const detail = JSON.parse(attempt.detailJson) as {
          goalPass?: boolean;
          blackboardPass?: boolean;
          budgetPass?: boolean;
        };
        return detail.goalPass && detail.blackboardPass && detail.budgetPass;
      }),
    ).toBe(true);
    expect(
      report.attempts.some((attempt) => attempt.taskId === 'approval-draft'),
    ).toBe(true);
  });

  it('recognizes cognition natural status requests', () => {
    expect(isCognitionDoctorRequest('/cognition')).toBe(true);
    expect(isCognitionDoctorRequest('cognition status')).toBe(true);
    expect(isCognitionDoctorRequest('why did you choose that?')).toBe(true);
    expect(isCognitionDoctorRequest('what is on my calendar')).toBe(false);
  });

  it('lets doctor reports use live provider truth instead of stale config snapshots', () => {
    const checkedAt = '2026-06-05T12:00:00.000Z';
    const report = buildCognitiveDoctorReport(checkedAt, [
      {
        providerId: 'openai_cloud',
        kind: 'llm',
        state: 'healthy',
        lastHealthyAt: checkedAt,
        lastCheckedAt: checkedAt,
        failureClass: 'none',
        quotaState: 'unknown',
        credentialState: 'configured',
        knownExpiresAt: null,
        rotationDueAt: null,
        blocker: '',
        nextAction: '',
        metadata: {},
      },
      {
        providerId: 'gemini_cloud',
        kind: 'llm',
        state: 'externally_blocked',
        lastHealthyAt: null,
        lastCheckedAt: checkedAt,
        failureClass: 'quota_or_rate_limit',
        quotaState: 'blocked',
        credentialState: 'configured',
        knownExpiresAt: null,
        rotationDueAt: null,
        blocker: 'quota blocked',
        nextAction: 'wait',
        metadata: {},
      },
    ]);

    expect(report.providerUsability.healthy).toBe(1);
    expect(report.providerUsability.blocked).toBe(1);
    expect(report.providerUsability.degradedProviderIds).toContain(
      'gemini_cloud',
    );
    expect(report.providerCooldowns.providerIds).toContain('gemini_cloud');
    expect(
      listCognitiveProviderCooldowns({
        status: 'active',
        activeAt: checkedAt,
      }).some((cooldown) => cooldown.providerId === 'gemini_cloud'),
    ).toBe(true);
  });
});
