import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  getVerifiedDeepWorkPacket,
  listAgentOSEpisodes,
  listAgentOSSkillProposals,
  listAssistantMetricEvents,
  listCognitiveRewardSignals,
  listCognitiveSkillCards,
  upsertVerifiedDeepWorkPacket,
} from './db.js';
import {
  assessCognitiveSkillPromotion,
  beginCognitiveKernelRun,
  buildCognitiveDoctorReport,
  finalizeCognitiveKernelOutcome,
} from './cognitive-kernel.js';
import {
  assessDeepWorkSkillPromotion,
  buildDeepWorkReviewInvitation,
  buildDeepWorkDogfoodReport,
  handleDeepWorkApprenticeshipCommand,
  linkDeepWorkMission,
  REPO_DEEP_WORK_SKILL_ID,
  recordDeepWorkModelRoute,
  reviewDeepWorkMission,
} from './deep-work-apprenticeship.js';
import { createVerifiedDeepWorkPacket } from './verified-deep-work.js';

describe('deep-work apprenticeship', () => {
  beforeEach(() => _initTestDatabase());

  function createReviewed(
    index: number,
    verdict: 'verified' | 'rejected' = 'verified',
  ) {
    const packet = createVerifiedDeepWorkPacket({
      groupFolder: 'main',
      taskFamily: 'coding',
      objective: `Ship bounded repo mission ${index}`,
      now: new Date(
        `2026-07-${String(index + 1).padStart(2, '0')}T12:00:00.000Z`,
      ),
    });
    upsertVerifiedDeepWorkPacket({
      ...packet,
      artifacts: [`artifact:${index}`],
      checks: [
        {
          name: 'deterministic test suite',
          passed: true,
          evidenceRef: `test:${index}`,
        },
      ],
    });
    linkDeepWorkMission({
      packetId: packet.packetId,
      missionId: `mission-${index}`,
      repository: {
        root: '/repo',
        branch: 'main',
        headSha: `sha-${index}`,
        dirtyPaths: [],
        capturedAt: packet.createdAt,
      },
    });
    return reviewDeepWorkMission({
      packetId: packet.packetId,
      verdict,
      summary:
        verdict === 'verified'
          ? 'Owner verified checks and artifact.'
          : 'Owner rejected the result.',
      now: new Date(
        `2026-07-${String(index + 1).padStart(2, '0')}T13:00:00.000Z`,
      ),
    });
  }

  it('links mission and repository context without a schema migration', () => {
    const snapshot = createReviewed(1);
    expect(snapshot.packet).toMatchObject({
      missionId: 'mission-1',
      status: 'completed',
      review: { verdict: 'verified', ownerAccepted: true },
    });
  });

  it('creates a candidate after three verified outcomes and promotes after five', () => {
    createReviewed(1);
    createReviewed(2);
    expect(assessDeepWorkSkillPromotion('main').state).toBe(
      'insufficient_evidence',
    );
    createReviewed(3);
    expect(assessDeepWorkSkillPromotion('main').state).toBe('candidate');
    createReviewed(4);
    createReviewed(5);
    expect(assessDeepWorkSkillPromotion('main')).toMatchObject({
      state: 'promoted',
      verifiedMissions: 5,
      acceptanceRate: 1,
    });
    expect(
      listCognitiveSkillCards({ taskFamily: 'coding' }).find(
        (skill) => skill.skillId === REPO_DEEP_WORK_SKILL_ID,
      )?.promotionState,
    ).toBe('promoted');
    expect(
      listAgentOSSkillProposals({ taskFamily: 'coding' })[0],
    ).toMatchObject({ status: 'accepted' });
  });

  it('blocks promotion after two owner corrections or rejections', () => {
    createReviewed(1);
    createReviewed(2);
    createReviewed(3);
    createReviewed(4, 'rejected');
    createReviewed(5, 'rejected');
    expect(assessDeepWorkSkillPromotion('main').state).toBe('blocked');
  });

  it('shows and reviews the latest mission through chat commands', () => {
    const packet = createVerifiedDeepWorkPacket({
      groupFolder: 'main',
      taskFamily: 'coding',
      objective: 'Ship a reviewable chat mission',
    });
    upsertVerifiedDeepWorkPacket({
      ...packet,
      artifacts: ['artifact:chat'],
      checks: [
        {
          name: 'deterministic chat test',
          passed: true,
          evidenceRef: 'test:chat',
        },
      ],
    });
    expect(
      handleDeepWorkApprenticeshipCommand({
        groupFolder: 'main',
        text: "show today's mission evidence",
      }),
    ).toContain(packet.objective);
    expect(
      handleDeepWorkApprenticeshipCommand({
        groupFolder: 'main',
        text: 'mark this mission verified',
        ownerReviewAllowed: true,
      }),
    ).toContain('Owner review: verified');
    expect(getVerifiedDeepWorkPacket(packet.packetId)?.review?.verdict).toBe(
      'verified',
    );
  });

  it('fails closed outside the private owner surface and explains incomplete verification', () => {
    const complete = createVerifiedDeepWorkPacket({
      groupFolder: 'main',
      taskFamily: 'coding',
      objective: 'Protect owner review integrity',
      now: new Date('2026-07-12T15:00:00.000Z'),
    });
    upsertVerifiedDeepWorkPacket({
      ...complete,
      artifacts: ['artifact:owner-integrity'],
      checks: [
        {
          name: 'deterministic owner review test',
          passed: true,
          evidenceRef: 'test:owner-integrity',
        },
      ],
    });

    expect(
      handleDeepWorkApprenticeshipCommand({
        groupFolder: 'main',
        text: 'mark this mission verified',
      }),
    ).toContain('only the private owner chat');
    expect(
      getVerifiedDeepWorkPacket(complete.packetId)?.review,
    ).toBeUndefined();

    const incomplete = createVerifiedDeepWorkPacket({
      groupFolder: 'main',
      taskFamily: 'coding',
      objective: 'Explain incomplete mission evidence',
      now: new Date('2026-07-12T16:00:00.000Z'),
    });
    const reply = handleDeepWorkApprenticeshipCommand({
      groupFolder: 'main',
      text: 'mark this mission verified',
      ownerReviewAllowed: true,
    });
    expect(reply).toContain('cannot mark this mission verified yet');
    expect(reply).toContain('an artifact, a recorded check');
    expect(
      getVerifiedDeepWorkPacket(incomplete.packetId)?.review,
    ).toBeUndefined();
  });

  it('uses the shared review priority and explains bounded evidence in chat', () => {
    const coding = createVerifiedDeepWorkPacket({
      groupFolder: 'main',
      taskFamily: 'coding',
      objective: 'Review this completed coding result',
      now: new Date('2026-07-12T10:00:00.000Z'),
    });
    upsertVerifiedDeepWorkPacket({
      ...coding,
      status: 'completed',
      currentStage: 'record_outcome',
      artifacts: ['artifact:bounded'],
      checks: [
        {
          name: 'deterministic test suite',
          passed: true,
          evidenceRef: 'test:bounded',
        },
      ],
    });
    createVerifiedDeepWorkPacket({
      groupFolder: 'main',
      taskFamily: 'operator',
      objective: 'Newer operational status packet',
      now: new Date('2026-07-12T11:00:00.000Z'),
    });

    const reply = handleDeepWorkApprenticeshipCommand({
      groupFolder: 'main',
      text: "show today's mission evidence",
    });
    expect(reply).toContain(coding.objective);
    expect(reply).toContain('Task family: coding');
    expect(reply).toContain('deterministic test suite passed');
    expect(reply).toContain('Deterministic replay evidence: passed');
    expect(reply).toContain('Review options: verified, partial');
  });

  it('invites a separate mission verdict without turning helpfulness into verification', () => {
    const packet = createVerifiedDeepWorkPacket({
      groupFolder: 'main',
      taskFamily: 'coding',
      objective: 'Invite an explicit owner verdict',
    });
    expect(buildDeepWorkReviewInvitation(packet)).toContain(
      'show today’s mission evidence',
    );

    const complete = {
      ...packet,
      artifacts: ['artifact:invitation'],
      checks: [
        {
          name: 'deterministic invitation test',
          passed: true,
          evidenceRef: 'test:invitation',
        },
      ],
    };
    expect(buildDeepWorkReviewInvitation(complete)).toContain(
      'Mission completion is still a separate owner decision',
    );
    expect(buildDeepWorkReviewInvitation(complete)).toContain(
      'mark this mission verified',
    );
    expect(
      buildDeepWorkReviewInvitation({
        ...complete,
        review: {
          verdict: 'verified',
          ownerAccepted: true,
          summary: 'Owner verified the mission.',
          reviewedAt: '2026-07-12T18:00:00.000Z',
        },
      }),
    ).toBeNull();
    expect(getVerifiedDeepWorkPacket(packet.packetId)?.review).toBeUndefined();
  });

  it('refuses verified promotion when evidence or deterministic replay is missing', () => {
    const packet = createVerifiedDeepWorkPacket({
      groupFolder: 'main',
      taskFamily: 'coding',
      objective: 'Incomplete repository mission',
    });
    expect(() =>
      reviewDeepWorkMission({
        packetId: packet.packetId,
        verdict: 'verified',
        summary: 'Looks done.',
      }),
    ).toThrow('cannot be marked verified');
  });

  it('tracks working-day dogfood and bounded model route evidence', () => {
    const snapshot = createReviewed(1);
    recordDeepWorkModelRoute({
      packetId: snapshot.packet.packetId,
      provider: 'openai',
      model: 'gpt-test',
      latencyMs: 1250,
      costUsd: 0.02,
      now: new Date('2026-07-02T14:00:00.000Z'),
    });
    expect(
      buildDeepWorkDogfoodReport('main', new Date('2026-07-11T12:00:00.000Z')),
    ).toMatchObject({
      targetWorkingDays: 10,
      attemptedWorkingDays: 1,
      reviewedMissions: 1,
      baselineEligible: false,
    });
    expect(listAssistantMetricEvents({ groupFolder: 'main' })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'latency_sample',
          value: 1250,
          metadataJson: expect.stringContaining(
            '"latencyClass":"deep_work_route"',
          ),
        }),
        expect.objectContaining({ kind: 'live_eval_cost', value: 0.02 }),
        expect.objectContaining({
          kind: 'recommendation_accepted',
          metadataJson: expect.stringContaining('"metricClass":"owner_review"'),
        }),
      ]),
    );
  });

  it('does not mislabel non-coding reviews as repository skill evidence', () => {
    const packet = createVerifiedDeepWorkPacket({
      groupFolder: 'main',
      taskFamily: 'research',
      objective: 'Compare current provider capabilities.',
    });

    const reviewed = reviewDeepWorkMission({
      packetId: packet.packetId,
      verdict: 'blocked',
      summary: 'Owner confirmed the provider evidence is unavailable.',
    });

    expect(reviewed.packet.taskFamily).toBe('research');
    expect(reviewed.packet).not.toHaveProperty('trajectoryEvalId');
    expect(reviewed.packet).not.toHaveProperty('skillProposalId');
    expect(reviewed.packet).not.toHaveProperty('skillCandidateId');
    expect(listAgentOSEpisodes({ taskFamily: 'coding' })).toEqual([]);
    expect(listAgentOSSkillProposals({ taskFamily: 'coding' })).toEqual([]);
  });

  it('bridges owner mission verdicts into the linked live cognitive trajectory without inflating partial evidence', () => {
    const cognitive = beginCognitiveKernelRun({
      turnId: 'deep-work-owner-review',
      channel: 'telegram',
      groupFolder: 'main',
      taskFamily: 'operator',
      goal: 'Deliver a bounded repository improvement.',
      requestRoute: 'direct_assistant',
      selectedSkillId: 'operator.runtime_work',
      selectedSkillPurpose: 'Deliver verified repository work.',
      selectedSkillApprovalNeed: 'none',
      selectedSkillSideEffectRisk: 'none',
      selectedSkillEvidenceLevel: 'strong',
    });
    finalizeCognitiveKernelOutcome({
      cognitiveRun: cognitive,
      evaluationStatus: 'pass',
      evidenceGap: 'none',
      evaluatorFlags: ['none'],
      routeUsed: 'operator.runtime_work',
      answerClass: 'handled',
    });
    const packet = createVerifiedDeepWorkPacket({
      groupFolder: 'main',
      taskFamily: 'coding',
      objective: 'Deliver a bounded repository improvement.',
      cognitiveRunId: cognitive.run.runId,
    });
    upsertVerifiedDeepWorkPacket({
      ...packet,
      artifacts: ['artifact:bounded-improvement'],
      checks: [
        {
          name: 'deterministic test suite',
          passed: true,
          evidenceRef: 'test:bounded-improvement',
        },
      ],
    });

    const partial = reviewDeepWorkMission({
      packetId: packet.packetId,
      verdict: 'partial',
      summary: 'Owner confirmed a useful partial result.',
      now: new Date('2026-07-12T14:00:00.000Z'),
    });
    const partialSignals = listCognitiveRewardSignals({
      runId: cognitive.run.runId,
    }).filter((signal) => signal.signalKind === 'user_review');
    const partialPromotion = assessCognitiveSkillPromotion(
      listCognitiveSkillCards({ taskFamily: 'operator' }).find(
        (skill) => skill.skillId === cognitive.run.linkedSkillCardId,
      )!,
      '2026-07-12T14:00:00.000Z',
    );

    expect(partial.packet).toMatchObject({
      cognitiveRunId: cognitive.run.runId,
      cognitiveOwnerReviewSignalId: partialSignals[0]?.signalId,
    });
    expect(partialSignals).toHaveLength(1);
    expect(partialSignals[0]?.flagsJson).toContain('owner_partial');
    expect(partialPromotion).toMatchObject({
      reviewedRuns: 1,
      acceptedRuns: 0,
      negativeRuns: 0,
      eligible: false,
    });
    expect(buildCognitiveDoctorReport().recent.reviewedOutcomeRuns).toBe(1);

    reviewDeepWorkMission({
      packetId: packet.packetId,
      verdict: 'blocked',
      summary: 'Owner confirmed the remaining prerequisite is external.',
      now: new Date('2026-07-12T14:03:00.000Z'),
    });
    expect(
      listCognitiveRewardSignals({ runId: cognitive.run.runId }).filter(
        (signal) => signal.signalKind === 'user_review',
      ),
    ).toEqual([
      expect.objectContaining({
        signalId: partialSignals[0]?.signalId,
        flagsJson: expect.stringContaining('owner_blocked'),
      }),
    ]);

    reviewDeepWorkMission({
      packetId: packet.packetId,
      verdict: 'verified',
      summary: 'Owner verified the completed result.',
      now: new Date('2026-07-12T14:05:00.000Z'),
    });
    expect(
      listCognitiveRewardSignals({ runId: cognitive.run.runId }).filter(
        (signal) =>
          signal.signalKind === 'user_review' ||
          signal.signalKind === 'user_acceptance',
      ),
    ).toEqual([
      expect.objectContaining({
        signalId: partialSignals[0]?.signalId,
        signalKind: 'user_acceptance',
        flagsJson: expect.stringContaining('owner_accepted'),
      }),
    ]);
  });
});
