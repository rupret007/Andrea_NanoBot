import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildCognitiveBlackboard } from './cognitive-blackboard.js';
import {
  _closeDatabase,
  _initTestDatabase,
  listReliabilityObservations,
  listToolReliabilityRollups,
  listToolReliabilitySubjects,
  upsertReliabilityObservation,
  upsertToolDependencyLink,
  upsertToolReliabilityRollup,
  upsertToolReliabilitySubject,
} from './db.js';
import {
  buildToolReliabilityDoctorReport,
  listCurrentToolReliabilityRollups,
  listCurrentToolReliabilitySubjects,
  rebuildToolReliabilityRollups,
  scoreRouteCandidate,
} from './tool-reliability.js';
import type { ToolReliabilitySubject } from './types.js';

const observedAt = '2026-10-14T12:00:00.000Z';
const registrySources = JSON.stringify([
  'cognitive_executive',
  'integration_doctor',
]);

function storeBlockedSubject(
  subjectId: string,
  channels: string[],
  overrides: Partial<ToolReliabilitySubject> = {},
): void {
  upsertToolReliabilitySubject({
    subjectId,
    subjectKind: 'integration',
    displayName: subjectId,
    aliasesJson: '[]',
    riskLevel: 'medium',
    approvalRequirement: 'manual_external',
    channelsJson: JSON.stringify(channels),
    sourceRefsJson: registrySources,
    privacyJson: '{}',
    ...overrides,
  });
  upsertReliabilityObservation({
    observationId: `observation:${subjectId}`,
    subjectId,
    observedAt,
    sourceKind: 'integration_doctor',
    outcome: 'blocked',
    failureClass: 'manual_proof',
    confidence: 0.9,
    fallbackUsed: false,
    summary: `Proof is pending for ${subjectId}.`,
    nextAction: `Prove ${subjectId}.`,
    evidenceIdsJson: '[]',
    privacyJson: '{}',
  });
  upsertToolReliabilityRollup({
    subjectId,
    updatedAt: observedAt,
    sampleCount: 1,
    successRate: 0,
    degradedRate: 0,
    blockedRate: 1,
    fallbackRate: 0,
    reliabilityScore: 0,
    currentHealth: 'blocked',
    confidenceCap: 0.22,
    nextAction: `Prove ${subjectId}.`,
    privacyJson: '{}',
  });
}

describe('current reliability subjects', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('excludes the retired Alexa subject even when 500+ other subjects precede it', () => {
    for (let i = 0; i < 500; i += 1) {
      upsertToolReliabilitySubject({
        subjectId: `capability:aaa_custom_${String(i).padStart(3, '0')}`,
        subjectKind: 'capability',
        displayName: `Custom ${i}`,
        aliasesJson: '[]',
        riskLevel: 'low',
        approvalRequirement: 'none',
        channelsJson: JSON.stringify(['telegram']),
        sourceRefsJson: JSON.stringify(['custom']),
        privacyJson: '{}',
      });
    }
    storeBlockedSubject('integration:alexa', ['alexa']);

    // Stored history is retained.
    expect(
      listToolReliabilityRollups().some(
        (rollup) => rollup.subjectId === 'integration:alexa',
      ),
    ).toBe(true);
    expect(
      listReliabilityObservations({ subjectId: 'integration:alexa' }),
    ).toHaveLength(1);
    expect(
      listCurrentToolReliabilityRollups({ limit: 500 }).some(
        (rollup) => rollup.subjectId === 'integration:alexa',
      ),
    ).toBe(false);
    const doctor = JSON.stringify(buildToolReliabilityDoctorReport());
    expect(doctor).not.toContain('integration:alexa');
    expect(doctor).not.toMatch(/Prove integration:alexa/);
    const blackboard = buildCognitiveBlackboard({
      now: observedAt,
      persist: false,
      providerHealthSnapshots: [],
      integrationReport: {
        generatedAt: observedAt,
        statuses: [],
        summary: {
          total: 0,
          healthy: 0,
          actionNeeded: 0,
          needsProof: 0,
          manualOrExternal: 0,
        },
        secretsRedacted: true,
      },
    });
    expect(blackboard.toolReliabilitySummary).not.toContain(
      'integration:alexa',
    );
    expect(blackboard.recommendedNextStep).not.toContain('integration:alexa');
  });

  it('keeps retired built-in records intact while excluding them from current blockers', () => {
    const subjectId = 'integration:retired_voice';
    storeBlockedSubject(subjectId, ['retired_voice']);
    upsertToolDependencyLink({
      linkId: 'retired-dependency',
      subjectId: 'route:current_route',
      dependencySubjectId: subjectId,
      dependencyKind: 'integration',
      reason: 'Historical dependency.',
      privacyJson: '{}',
    });
    const storedSubject = listToolReliabilitySubjects()[0];
    const storedRollup = listToolReliabilityRollups()[0];
    const storedObservations = listReliabilityObservations({ subjectId });

    expect(listCurrentToolReliabilitySubjects()).toEqual([]);
    expect(listCurrentToolReliabilityRollups()).toEqual([]);
    expect(rebuildToolReliabilityRollups(new Date(observedAt))).toEqual([]);
    const doctor = buildToolReliabilityDoctorReport(new Date(observedAt));
    expect(doctor.subjects.map((subject) => subject.subjectId)).not.toContain(
      subjectId,
    );
    expect(doctor.rollups).toEqual([]);
    expect(doctor.degradedSubjectCount).toBe(0);
    expect(doctor.nextAction).not.toContain(subjectId);
    expect(
      scoreRouteCandidate({ routeKey: 'current_route', baseConfidence: 0.9 }),
    ).toMatchObject({
      confidence: 0.9,
      cap: 0.95,
      reasons: [],
    });
    const blackboard = buildCognitiveBlackboard({
      now: observedAt,
      persist: false,
      providerHealthSnapshots: [],
      integrationReport: {
        generatedAt: observedAt,
        statuses: [],
        summary: {
          total: 0,
          healthy: 0,
          actionNeeded: 0,
          needsProof: 0,
          manualOrExternal: 0,
        },
        secretsRedacted: true,
      },
    });
    expect(blackboard.toolReliabilitySummary).not.toContain(subjectId);
    expect(blackboard.recommendedNextStep).not.toContain(subjectId);
    expect(
      listToolReliabilitySubjects().find(
        (subject) => subject.subjectId === subjectId,
      ),
    ).toEqual(storedSubject);
    expect(listToolReliabilityRollups()).toEqual([storedRollup]);
    expect(listReliabilityObservations({ subjectId })).toEqual(
      storedObservations,
    );
  });

  it('preserves supported, custom, and unscoped subjects as current', () => {
    storeBlockedSubject('integration:mixed', ['retired_voice', 'telegram']);
    storeBlockedSubject('integration:custom', ['custom_channel'], {
      sourceRefsJson: '["custom_plugin"]',
    });
    storeBlockedSubject('integration:unscoped', []);
    storeBlockedSubject('integration:legacy_metadata', [], {
      channelsJson: 'not-json',
    });
    const expectedIds = [
      'integration:custom',
      'integration:legacy_metadata',
      'integration:mixed',
      'integration:unscoped',
    ];

    expect(
      listCurrentToolReliabilitySubjects()
        .map((subject) => subject.subjectId)
        .sort(),
    ).toEqual(expectedIds);
    expect(
      listCurrentToolReliabilityRollups()
        .map((rollup) => rollup.subjectId)
        .sort(),
    ).toEqual(expectedIds);
    const doctor = buildToolReliabilityDoctorReport(new Date(observedAt));
    expect(doctor.degradedSubjectCount).toBe(4);
    expect(doctor.topDegraded.map((rollup) => rollup.subjectId).sort()).toEqual(
      expectedIds,
    );
  });
});
