import { describe, expect, it } from 'vitest';

import {
  ADAPTIVE_COGNITION_DOGFOOD_BOUNDARY,
  ADAPTIVE_COGNITION_DOGFOOD_PRIVACY,
  buildAdaptiveCognitionDogfoodReport,
  createAdaptiveCognitionDogfoodTaskRecord,
  type AdaptiveCognitionDogfoodTaskRecord,
  type CreateAdaptiveCognitionDogfoodTaskInput,
} from './adaptive-cognition-dogfood.js';

const WORKING_DATES = [
  '2026-07-06',
  '2026-07-07',
  '2026-07-08',
  '2026-07-09',
  '2026-07-10',
  '2026-07-13',
  '2026-07-14',
  '2026-07-15',
  '2026-07-16',
  '2026-07-17',
] as const;

function taskInput(
  ordinal: number,
  workingDate: string,
  overrides: Partial<CreateAdaptiveCognitionDogfoodTaskInput> = {},
): CreateAdaptiveCognitionDogfoodTaskInput {
  const suffix = String(ordinal).padStart(16, '0');
  return {
    taskId: `task:${suffix}`,
    runId: `run:${suffix}`,
    workingDate,
    completedAt: `${workingDate}T15:00:00.000Z`,
    taskFamily: ordinal % 2 === 0 ? 'verification' : 'analysis',
    outcome: 'completed',
    runOrigin: 'live',
    evidenceOrigin: 'direct_live_observation',
    verifierRefs: [`verifier:${suffix}`],
    evidenceRefs: [`evidence:${suffix}`],
    receiptRefs: [`receipt:${suffix}`],
    ownerVerdict: {
      verdict: 'accepted',
      verdictRef: `verdict:${suffix}`,
      recordedAt: `${workingDate}T15:05:00.000Z`,
    },
    ...overrides,
  };
}

function task(
  ordinal: number,
  workingDate: string,
  overrides: Partial<CreateAdaptiveCognitionDogfoodTaskInput> = {},
): AdaptiveCognitionDogfoodTaskRecord {
  return createAdaptiveCognitionDogfoodTaskRecord(
    taskInput(ordinal, workingDate, overrides),
  );
}

describe('adaptive cognition dogfood protocol', () => {
  it('constructs only immutable, metadata-only, directly observed live records', () => {
    const record = task(1, WORKING_DATES[0]);

    expect(record).toMatchObject({
      protocolVersion: 1,
      runOrigin: 'live',
      evidenceOrigin: 'direct_live_observation',
      privacy: ADAPTIVE_COGNITION_DOGFOOD_PRIVACY,
    });
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.verifierRefs)).toBe(true);
    expect(Object.isFrozen(record.ownerVerdict)).toBe(true);
    expect(ADAPTIVE_COGNITION_DOGFOOD_BOUNDARY).toEqual({
      persistsRecords: false,
      sendsMessages: false,
      writesCalendars: false,
      restartsServices: false,
      pushesCode: false,
      mutatesExternalSystems: false,
    });

    expect(() =>
      createAdaptiveCognitionDogfoodTaskRecord({
        ...taskInput(2, WORKING_DATES[0]),
        rawPrompt: 'PRIVATE-CONTENT-MUST-NOT-BE-STORED',
      } as unknown as CreateAdaptiveCognitionDogfoodTaskInput),
    ).toThrow(/unknown_metadata_field/);
    expect(() =>
      createAdaptiveCognitionDogfoodTaskRecord({
        ...taskInput(2, WORKING_DATES[0]),
        verifierRefs: ['https://private.example/path'],
      }),
    ).toThrow(/invalid_verifier_ref/);
    expect(() =>
      createAdaptiveCognitionDogfoodTaskRecord({
        ...taskInput(2, WORKING_DATES[0]),
        evidenceRefs: ['evidence:patient_diagnosis_HIV'],
      }),
    ).toThrow(/invalid_evidence_ref/);
  });

  it('completes only after 20 distinct reviewed live tasks across 10 working dates', () => {
    const candidates = WORKING_DATES.flatMap((workingDate, dayIndex) => [
      task(dayIndex * 2 + 1, workingDate),
      task(dayIndex * 2 + 2, workingDate),
    ]);

    const report = buildAdaptiveCognitionDogfoodReport({
      candidates,
      asOf: '2026-07-17T23:59:00.000Z',
    });

    expect(report).toMatchObject({
      status: 'complete',
      completionEligible: true,
      targetTaskCount: 20,
      targetWorkingDateCount: 10,
      tasksPerWorkingDate: 2,
      candidateCount: 20,
      countedTaskCount: 20,
      remainingTaskCount: 0,
      distinctWorkingDateCount: 10,
      completedWorkingDateCount: 10,
      remainingWorkingDateCount: 0,
      explicitOwnerVerdictCount: 20,
      taskProgressPercent: 100,
      workingDateProgressPercent: 100,
      excludedCandidateCount: 0,
      nextActionCode: 'review_completed_protocol',
    });
    expect(report.workingDates).toHaveLength(10);
    expect(report.workingDates.every((entry) => entry.complete)).toBe(true);
    expect(report.workingDates.every((entry) => entry.taskCount === 2)).toBe(
      true,
    );
    expect(report.ownerVerdictCounts).toEqual({
      accepted: 20,
      corrected: 0,
      rejected: 0,
      blocked: 0,
    });
    expect(report.blockers).toEqual([]);
  });

  it('never counts synthetic, replay, backfilled, inferred, or incomplete evidence', () => {
    const valid = task(1, WORKING_DATES[0]);
    const candidates: unknown[] = [
      valid,
      {
        ...task(2, WORKING_DATES[0]),
        runOrigin: 'synthetic',
      },
      {
        ...task(3, WORKING_DATES[1]),
        runOrigin: 'replay',
      },
      {
        ...task(4, WORKING_DATES[1]),
        evidenceOrigin: 'backfilled',
      },
      {
        ...task(5, WORKING_DATES[2]),
        evidenceOrigin: 'inferred',
      },
      {
        ...task(6, WORKING_DATES[2]),
        receiptRefs: [],
      },
      {
        ...task(7, WORKING_DATES[3]),
        ownerVerdict: null,
      },
    ];

    const report = buildAdaptiveCognitionDogfoodReport({
      candidates,
      asOf: '2026-07-17T23:59:00.000Z',
    });

    expect(report.countedTaskCount).toBe(1);
    expect(report.explicitOwnerVerdictCount).toBe(1);
    expect(report.excludedCandidateCount).toBe(6);
    const reasons = report.exclusions.flatMap((entry) => entry.reasonCodes);
    expect(reasons.filter((reason) => reason === 'not_live')).toHaveLength(2);
    expect(
      reasons.filter((reason) => reason === 'not_direct_live_observation'),
    ).toHaveLength(2);
    expect(reasons).toContain('missing_receipt_refs');
    expect(reasons).toContain('missing_owner_verdict');
    expect(report.completionEligible).toBe(false);
  });

  it('admits no more than two distinct task and run IDs per working date', () => {
    const first = task(1, WORKING_DATES[0]);
    const second = task(2, WORKING_DATES[0]);
    const overflow = task(3, WORKING_DATES[0]);
    const partialNextDay = task(4, WORKING_DATES[1]);
    const duplicate = {
      ...partialNextDay,
      completedAt: `${WORKING_DATES[1]}T16:00:00.000Z`,
      ownerVerdict: {
        ...partialNextDay.ownerVerdict,
        recordedAt: `${WORKING_DATES[1]}T16:05:00.000Z`,
      },
    };

    const report = buildAdaptiveCognitionDogfoodReport({
      candidates: [overflow, duplicate, second, partialNextDay, first],
      asOf: '2026-07-17T23:59:00.000Z',
    });

    expect(report.countedTaskCount).toBe(3);
    expect(report.distinctWorkingDateCount).toBe(2);
    expect(report.completedWorkingDateCount).toBe(1);
    expect(report.explicitOwnerVerdictCount).toBe(3);
    expect(report.exclusions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          candidateRef: overflow.taskId,
          reasonCodes: ['daily_task_limit_exceeded'],
        }),
        expect.objectContaining({
          candidateRef: partialNextDay.taskId,
          reasonCodes: ['duplicate_task_id', 'duplicate_run_id'],
        }),
      ]),
    );
    expect(report.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'daily_task_limit_exceeded' }),
        expect.objectContaining({ code: 'duplicate_task_id' }),
        expect.objectContaining({ code: 'duplicate_run_id' }),
        expect.objectContaining({ code: 'working_date_requires_second_task' }),
      ]),
    );
  });

  it('rejects weekends and future observations instead of filling elapsed days', () => {
    const weekday = task(1, WORKING_DATES[0]);
    const weekend = {
      ...task(2, WORKING_DATES[0]),
      workingDate: '2026-07-11',
      completedAt: '2026-07-11T15:00:00.000Z',
      ownerVerdict: {
        ...task(2, WORKING_DATES[0]).ownerVerdict,
        recordedAt: '2026-07-11T15:05:00.000Z',
      },
    };
    const future = task(3, WORKING_DATES[5]);

    const report = buildAdaptiveCognitionDogfoodReport({
      candidates: [weekday, weekend, future],
      asOf: '2026-07-12T23:59:00.000Z',
    });

    expect(report.countedTaskCount).toBe(1);
    expect(report.exclusions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reasonCodes: ['non_working_date'] }),
        expect.objectContaining({ reasonCodes: ['future_observation'] }),
      ]),
    );
  });

  it('reports task and owner blockers without copying private candidate fields', () => {
    const partialRejected = task(1, WORKING_DATES[0], {
      outcome: 'partial',
      ownerVerdict: {
        verdict: 'rejected',
        verdictRef: 'verdict:0000000000000001',
        recordedAt: `${WORKING_DATES[0]}T15:05:00.000Z`,
      },
    });
    const blocked = task(2, WORKING_DATES[0], {
      outcome: 'blocked',
      ownerVerdict: {
        verdict: 'blocked',
        verdictRef: 'verdict:0000000000000002',
        recordedAt: `${WORKING_DATES[0]}T15:05:00.000Z`,
      },
    });
    const privateSentinel = 'PRIVATE-DOGFOOD-BODY-DO-NOT-STORE';
    const report = buildAdaptiveCognitionDogfoodReport({
      candidates: [
        partialRejected,
        blocked,
        {
          ...task(3, WORKING_DATES[1]),
          rawPrompt: privateSentinel,
        },
      ],
      asOf: '2026-07-17T23:59:00.000Z',
    });

    expect(report.outcomeCounts).toMatchObject({ partial: 1, blocked: 1 });
    expect(report.ownerVerdictCounts).toMatchObject({
      rejected: 1,
      blocked: 1,
    });
    expect(report.blockers.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        'task_outcome_partial',
        'task_outcome_blocked',
        'owner_verdict_rejected',
        'owner_verdict_blocked',
        'unknown_metadata_field',
      ]),
    );
    expect(JSON.stringify(report)).not.toContain(privateSentinel);
    expect(report.privacy).toBe(ADAPTIVE_COGNITION_DOGFOOD_PRIVACY);
    expect(report.boundary).toBe(ADAPTIVE_COGNITION_DOGFOOD_BOUNDARY);
  });
});
