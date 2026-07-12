import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assessCognitiveRunQuality,
  beginCognitiveKernelRun,
  buildCognitiveDoctorReport,
  buildCognitiveResumePlan,
  buildCognitiveTraceReport,
  finalizeCognitiveKernelOutcome,
  formatCognitiveDoctorReport,
  isCognitionDoctorRequest,
  recordCognitiveOwnerReview,
  runCognitiveBenchmarkSuite,
} from './cognitive-kernel.js';
import {
  _closeDatabase,
  _initTestDatabase,
  getCognitiveRun,
  listCognitiveAutonomyBudgets,
  listCognitiveBlackboardEntries,
  listCognitiveCheckpoints,
  listCognitiveExecutionSteps,
  listCognitiveGoals,
  listCognitivePolicyDecisions,
  listCognitivePlanRevisions,
  listCognitiveProviderCooldowns,
  listCognitiveReflections,
  listCognitiveRewardSignals,
  listCognitiveRuns,
  listCognitiveSkillCards,
  listCognitiveSubgoalsForRun,
  listCognitiveToolResults,
  listCognitiveToolSimulations,
  listCognitiveTraceSpans,
  listCognitiveToolRegistry,
  listCognitiveWorldBeliefs,
  upsertCognitiveSkillCard,
} from './db.js';
import { buildSkillLibraryReport } from './skill-library.js';

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
    expect(kernel.activeGoal?.taskFamily).toBe('calendar');
    expect(['satisfied', 'waiting_evidence']).toContain(
      kernel.activeGoal?.status,
    );
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
      listCognitiveExecutionSteps({ runId: kernel.run.runId }).length,
    ).toBeGreaterThan(0);
    expect(
      listCognitiveToolResults({ runId: kernel.run.runId }).length,
    ).toBeGreaterThan(0);
    expect(
      listCognitivePolicyDecisions({ runId: kernel.run.runId }).length,
    ).toBeGreaterThan(0);
    expect(
      listCognitivePlanRevisions({ runId: kernel.run.runId }).length,
    ).toBeGreaterThan(0);
    const trace = buildCognitiveTraceReport({ runId: kernel.run.runId });
    expect(trace).toMatchObject({
      runId: kernel.run.runId,
      spanCount: expect.any(Number),
    });
    expect(trace.executionStatus).not.toBe('none');
    expect(trace.replayPacket.executionSteps.length).toBeGreaterThan(0);
  });

  it('keeps local-only work available when provider configuration has not been live-probed', () => {
    const kernel = beginCognitiveKernelRun({
      turnId: 'cog-provider-health-unknown',
      channel: 'telegram',
      taskFamily: 'assistant',
      goal: 'Give me one grounded next step.',
      requestRoute: 'direct_assistant',
      selectedSkillId: 'assistant.daily_guidance',
      selectedSkillPurpose: 'Offer one grounded next step.',
      selectedSkillApprovalNeed: 'none',
      selectedSkillSideEffectRisk: 'none',
      selectedSkillEvidenceLevel: 'strong',
      providerHealthSnapshots: [
        {
          providerId: 'openai',
          kind: 'llm',
          state: 'unknown',
          lastHealthyAt: null,
          lastCheckedAt: '2026-07-12T01:00:00.000Z',
          failureClass: 'none',
          quotaState: 'unknown',
          credentialState: 'configured',
          knownExpiresAt: null,
          rotationDueAt: null,
          blocker: '',
          nextAction: 'Run an explicit live probe before model routing.',
          metadata: {
            healthEvidence: 'configuration_only',
            liveProbe: 'not_run',
          },
        },
      ],
    });

    expect(
      kernel.toolResults.find((result) => result.toolId === 'provider_health'),
    ).toMatchObject({
      status: 'degraded',
      failureClass: 'no_live_health_evidence',
    });
    expect(kernel.trajectoryScore.status).not.toBe('fail');
    expect(kernel.run.status).not.toBe('blocked');
  });

  it('blocks provider-health evidence only when snapshot collection is unavailable', () => {
    const kernel = beginCognitiveKernelRun({
      turnId: 'cog-provider-health-unavailable',
      channel: 'telegram',
      taskFamily: 'assistant',
      goal: 'Give me one grounded next step.',
      requestRoute: 'direct_assistant',
      selectedSkillId: 'assistant.daily_guidance',
      selectedSkillPurpose: 'Offer one grounded next step.',
      selectedSkillApprovalNeed: 'none',
      selectedSkillSideEffectRisk: 'none',
      selectedSkillEvidenceLevel: 'strong',
      providerHealthSnapshots: [],
    });

    expect(
      kernel.toolResults.find((result) => result.toolId === 'provider_health'),
    ).toMatchObject({
      status: 'blocked',
      failureClass: 'provider_probe_unavailable',
    });
    expect(kernel.run.status).not.toBe('answered');
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

  it('keeps attached council evidence within an approval-staged BlueBubbles budget', () => {
    const kernel = beginCognitiveKernelRun({
      turnId: 'cog-bluebubbles-council-approval',
      channel: 'bluebubbles',
      groupFolder: 'main',
      taskFamily: 'communication',
      goal: 'Send it later tonight.',
      requestRoute: 'bluebubbles.direct',
      selectedSkillId: 'bluebubbles.continuity',
      selectedSkillPurpose:
        'Preserve same-thread context and stage any send for approval.',
      selectedSkillApprovalNeed: 'explicit',
      selectedSkillSideEffectRisk: 'high',
      selectedSkillEvidenceLevel: 'partial',
      providerCouncil: {
        councilRunId: 'council-bluebubbles-approval',
        mode: 'max_iq_council',
        status: 'completed',
        answerGuidance: {
          status: 'pass',
          visibleVerdict: 'Stage the deferred action.',
          answerDirection: 'Keep the send approval-gated.',
          confidence: 0.84,
          uncertainty: 'No send is authorized yet.',
          sourceMemberIds: ['planner', 'verifier'],
        },
      },
    });

    expect(kernel.run.cognitiveMode).toBe('approval_staged');
    expect(kernel.run.status).toBe('awaiting_approval');
    expect(kernel.autonomyBudget).toMatchObject({
      maxToolSteps: 8,
      maxCouncilCalls: 1,
      mutatingAllowed: false,
      approvalRequired: true,
    });
    expect(kernel.toolSimulations).toHaveLength(7);
    expect(
      kernel.toolSimulations.filter(
        (simulation) => simulation.status === 'block',
      ),
    ).toEqual([]);
    expect(
      kernel.executionSteps.some(
        (step) =>
          step.toolId === 'approval_stage' && step.status === 'approval_staged',
      ),
    ).toBe(true);
    expect(kernel.approvalPackets.length).toBeGreaterThanOrEqual(1);

    const incomplete = assessCognitiveRunQuality(kernel.run);
    expect(incomplete).toMatchObject({
      operationalFailure: true,
      finalized: false,
    });

    finalizeCognitiveKernelOutcome({
      cognitiveRun: kernel,
      evaluationStatus: 'pass',
      evidenceGap: 'none',
      evaluatorFlags: [
        'provider_council_guidance_applied',
        'approval_required',
      ],
      routeUsed: 'bluebubbles.continuity',
      answerClass: 'handled',
    });
    const report = buildCognitiveDoctorReport();
    expect(report.recent).toMatchObject({
      totalRuns: 1,
      safeApprovalRuns: 1,
      operationalFailureRuns: 0,
      finalizedRuns: 1,
      reviewedOutcomeRuns: 0,
    });
    expect(report.recent.qualityScore).toBeGreaterThanOrEqual(0.85);
  });

  it('records internal outcome rewards without self-promoting repeated successes', () => {
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
    expect(skill?.promotionState).toBe('candidate');
    expect(
      listCognitiveRewardSignals({ runId: second.run.runId })[0],
    ).toMatchObject({
      signalKind: 'task_answered',
    });
  });

  it('promotes only after five distinct owner acceptances, complete trajectories, and fresh replay', () => {
    const runs = Array.from({ length: 5 }, (_, index) => {
      const kernel = beginCognitiveKernelRun({
        turnId: `cog-reviewed-promotion-${index + 1}`,
        channel: 'telegram',
        groupFolder: 'main',
        taskFamily: 'assistant',
        goal: 'Give me one grounded next step.',
        requestRoute: 'direct_assistant',
        selectedSkillId: 'assistant.daily_guidance',
        selectedSkillPurpose: 'Offer one grounded next step.',
        selectedSkillApprovalNeed: 'none',
        selectedSkillSideEffectRisk: 'none',
        selectedSkillEvidenceLevel: 'strong',
      });
      finalizeCognitiveKernelOutcome({
        cognitiveRun: kernel,
        evaluationStatus: 'pass',
        evidenceGap: 'none',
        evaluatorFlags: ['none'],
        routeUsed: 'assistant.daily_guidance',
        answerClass: 'handled',
      });
      return kernel;
    });

    for (const [index, run] of runs.entries()) {
      recordCognitiveOwnerReview({
        runId: run.run.runId,
        feedbackId: `promotion-accept-${index + 1}`,
        verdict: 'accepted',
        reviewedAt: `2026-07-12T02:0${index}:00.000Z`,
      });
    }
    expect(
      listCognitiveSkillCards({ taskFamily: 'assistant' }).find(
        (skill) => skill.skillId === runs[0].run.linkedSkillCardId,
      )?.promotionState,
    ).toBe('candidate');

    runCognitiveBenchmarkSuite({
      generatedAt: '2026-07-12T02:10:00.000Z',
    });
    const promoted = recordCognitiveOwnerReview({
      runId: runs[4].run.runId,
      feedbackId: 'promotion-accept-5',
      verdict: 'accepted',
      reviewedAt: '2026-07-12T02:11:00.000Z',
    });

    expect(promoted.promotionState).toBe('promoted');
    expect(promoted.promotionAssessment).toMatchObject({
      reviewedRuns: 5,
      acceptedRuns: 5,
      negativeRuns: 0,
      acceptanceRate: 1,
      trajectoryEvidenceComplete: true,
      freshReplayPass: true,
      eligible: true,
    });
    expect(
      listCognitiveRewardSignals({ limit: 200 }).find(
        (signal) => signal.signalKind === 'skill_promoted',
      )?.flagsJson,
    ).toContain('authority_expanded:false');
    expect(
      listCognitiveRewardSignals({ runId: runs[4].run.runId }).filter(
        (signal) => signal.signalKind === 'user_acceptance',
      ),
    ).toHaveLength(1);
    expect(
      buildSkillLibraryReport({
        groupFolder: 'main',
        now: new Date('2026-07-12T02:11:00.000Z'),
      }).active.some((skill) => skill.skillId.includes('daily_guidance')),
    ).toBe(true);
  });

  it('classifies legacy promoted cards as unverified without deleting them', () => {
    upsertCognitiveSkillCard({
      skillId: 'cogskill:assistant:legacy',
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      groupFolder: 'main',
      taskFamily: 'assistant',
      triggerSummary: 'Legacy trigger.',
      skillSummary: 'Legacy behavior retained pending evidence.',
      requiredToolsJson: '[]',
      evidenceNeedsJson: '{}',
      approvalRulesJson: '{"mutatingActions":"fresh_approval"}',
      failureModesJson: '[]',
      verificationChecklistJson: '{}',
      latestOutcomeScore: 0.9,
      promotionState: 'promoted',
      usageCount: 3,
      lastUsedAt: '2026-06-01T00:00:00.000Z',
    });

    const report = buildCognitiveDoctorReport('2026-07-12T00:00:00.000Z');
    expect(report.skills).toMatchObject({
      promoted: 1,
      trustedPromoted: 0,
      unverifiedPromoted: 1,
    });
    expect(
      listCognitiveSkillCards().find(
        (skill) => skill.skillId === 'cogskill:assistant:legacy',
      )?.promotionState,
    ).toBe('promoted');
    const library = buildSkillLibraryReport({
      groupFolder: 'main',
      now: new Date('2026-07-12T00:00:00.000Z'),
    });
    expect(
      library.active.some((skill) => skill.skillId.includes('legacy')),
    ).toBe(false);
    expect(
      library.suggested.find((skill) => skill.skillId.includes('legacy'))
        ?.nextAction,
    ).toContain('Legacy promotion is preserved but inactive');
  });

  it('links idempotent owner reviews to runs and quarantines a skill after two negative outcomes', () => {
    function runReviewed(turnId: string) {
      const kernel = beginCognitiveKernelRun({
        turnId,
        channel: 'telegram',
        groupFolder: 'main',
        taskFamily: 'assistant',
        goal: 'Give me the best grounded next step.',
        requestRoute: 'direct_assistant',
        selectedSkillId: 'assistant.daily_guidance',
        selectedSkillPurpose: 'Offer one grounded next step.',
        selectedSkillApprovalNeed: 'none',
        selectedSkillSideEffectRisk: 'none',
        selectedSkillEvidenceLevel: 'strong',
      });
      finalizeCognitiveKernelOutcome({
        cognitiveRun: kernel,
        evaluationStatus: 'pass',
        evidenceGap: 'none',
        evaluatorFlags: ['none'],
        routeUsed: 'assistant.daily_guidance',
        answerClass: 'handled',
      });
      return kernel;
    }

    const first = runReviewed('cog-owner-review-1');
    const second = runReviewed('cog-owner-review-2');
    const accepted = recordCognitiveOwnerReview({
      runId: first.run.runId,
      feedbackId: 'feedback-accepted',
      verdict: 'accepted',
      reviewedAt: '2025-07-12T01:00:00.000Z',
    });
    recordCognitiveOwnerReview({
      runId: first.run.runId,
      feedbackId: 'feedback-accepted',
      verdict: 'accepted',
      reviewedAt: '2025-07-12T01:00:00.000Z',
    });

    expect(accepted).toMatchObject({
      recorded: true,
      runId: first.run.runId,
    });
    expect(
      listCognitiveRewardSignals({ runId: first.run.runId }).filter(
        (signal) => signal.signalKind === 'user_acceptance',
      ),
    ).toHaveLength(1);
    expect(buildCognitiveDoctorReport().recent.reviewedOutcomeRuns).toBe(1);

    const firstRejection = recordCognitiveOwnerReview({
      runId: first.run.runId,
      feedbackId: 'feedback-rejected-1',
      verdict: 'rejected',
      reviewedAt: '2026-07-12T01:01:00.000Z',
    });
    expect(firstRejection.promotionState).toBe('candidate');
    const secondRejection = recordCognitiveOwnerReview({
      runId: second.run.runId,
      feedbackId: 'feedback-rejected-2',
      verdict: 'rejected',
      reviewedAt: '2026-07-12T01:02:00.000Z',
    });
    expect(secondRejection.promotionState).toBe('quarantined');
    expect(
      listCognitiveSkillCards({ taskFamily: 'assistant' }).find(
        (skill) => skill.skillId === second.run.linkedSkillCardId,
      )?.promotionState,
    ).toBe('quarantined');
    expect(
      buildSkillLibraryReport({
        groupFolder: 'main',
        now: new Date('2026-07-12T01:03:00.000Z'),
      }).paused.some((skill) => skill.skillId.includes('daily_guidance')),
    ).toBe(true);
    expect(JSON.stringify(secondRejection)).not.toMatch(
      /Give me the best grounded next step/i,
    );
  });

  it('does not quarantine a skill for one safe approval stop and keeps reports redacted', () => {
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

    expect(card?.promotionState).toBe('candidate');
    expect(
      listCognitiveReflections({ taskFamily: 'communication' })[0],
    ).toMatchObject({
      reflectionKind: 'approval_blocked',
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
    expect(
      listCognitiveRuns({ limit: 20 }).every(
        (run) => run.runOrigin === 'replay',
      ),
    ).toBe(true);
    expect(listCognitiveSkillCards()).toEqual([]);

    const doctor = buildCognitiveDoctorReport('2026-06-05T12:01:00.000Z');
    expect(doctor.activeRun).toBeNull();
    expect(doctor.recent).toMatchObject({
      observedRuns: 4,
      totalRuns: 0,
      replayRuns: 4,
      syntheticRuns: 0,
      reviewedOutcomeRuns: 0,
    });
    const rejectedReview = recordCognitiveOwnerReview({
      runId: report.attempts[0]?.runId,
      feedbackId: 'benchmark-owner-review',
      verdict: 'accepted',
      reviewedAt: '2026-06-05T12:02:00.000Z',
    });
    expect(rejectedReview).toMatchObject({
      recorded: false,
      reason:
        'Replay and synthetic cognitive runs cannot receive owner-learning signals.',
    });
    expect(
      listCognitiveRewardSignals({ limit: 200 }).filter(
        (signal) => signal.signalKind === 'user_acceptance',
      ),
    ).toEqual([]);
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
