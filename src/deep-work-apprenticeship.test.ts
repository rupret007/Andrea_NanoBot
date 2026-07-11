import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  getVerifiedDeepWorkPacket,
  listAgentOSSkillProposals,
  listAssistantMetricEvents,
  listCognitiveSkillCards,
  upsertVerifiedDeepWorkPacket,
} from './db.js';
import {
  assessDeepWorkSkillPromotion,
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
      }),
    ).toContain('Owner review: verified');
    expect(getVerifiedDeepWorkPacket(packet.packetId)?.review?.verdict).toBe(
      'verified',
    );
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
        expect.objectContaining({ kind: 'latency_sample', value: 1250 }),
        expect.objectContaining({ kind: 'live_eval_cost', value: 0.02 }),
      ]),
    );
  });
});
