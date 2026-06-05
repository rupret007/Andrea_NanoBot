import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildCouncilTaskEaseReport,
  formatCouncilTaskEaseReport,
} from './council-task-drills.js';
import {
  calibrateCouncilMode,
  recordCouncilRunLedger,
} from './council-quality.js';
import {
  _closeDatabase,
  _initTestDatabase,
  getCouncilRunLedger,
} from './db.js';
import type { AndreaPlatformProviderCouncilResult } from './andrea-platform-bridge.js';

function structuredVerdict(): NonNullable<
  AndreaPlatformProviderCouncilResult['structuredVerdict']
> {
  return {
    status: 'pass',
    recommendedAction: 'answer',
    confidence: 0.9,
    evidenceGrade: 'partial',
    approvalNeed: 'none',
    riskFlags: [],
    evidenceIds: ['local:task'],
    usableMemberCount: 1,
    blockedMemberCount: 0,
    schemaStatusSummary: {
      valid: 1,
      repaired: 0,
      invalid_fallback: 0,
    },
    budget: {
      mode: 'single_model',
      maxRoles: 2,
      roleTimeoutMs: 12_000,
      maxRetries: 0,
      maxConcurrency: 1,
      fallbackAllowed: false,
      estimatedCostTier: 'low',
      usedRoles: 1,
      retryCount: 0,
      loopGuardTriggered: false,
      status: 'within_budget',
    },
    replaySummary: 'Council task drill replay is metadata-only.',
    replayArtifact: {
      replaySummary: 'Council task drill replay is metadata-only.',
      memberStatuses: [
        {
          memberId: 'openai_cloud',
          providerId: 'openai_cloud',
          role: 'planner',
          status: 'completed',
          verdict: 'pass',
          confidence: 0.9,
          schemaStatus: 'valid',
          schemaIssues: [],
          evidenceIds: ['local:task'],
          riskFlags: [],
        },
      ],
    },
  };
}

describe('council task drills', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('builds a redacted task-ease report and records an outcome signal', () => {
    recordCouncilRunLedger({
      councilRunId: 'task-ease-run',
      taskFamily: 'assistant',
      channel: 'system',
      requestedMode: 'single_model',
      chosenMode: 'single_model',
      calibration: calibrateCouncilMode({
        taskFamily: 'assistant',
        requestedMode: 'single_model',
      }),
      structuredVerdict: structuredVerdict(),
      riskFlags: ['phone +14695405551', 'secret sk-proj-should-redact'],
      now: '2026-06-04T12:00:00.000Z',
    });

    const report = buildCouncilTaskEaseReport({
      now: new Date('2026-06-04T12:05:00.000Z'),
      recordOutcomeSignal: true,
    });
    const formatted = formatCouncilTaskEaseReport(report);

    expect(report.status).not.toBe('fail');
    expect(report.outcome.outcomeSignalCount).toBe(1);
    expect(report.sourcePatternCoverage.length).toBeGreaterThan(0);
    expect(getCouncilRunLedger('task-ease-run')?.outcomeSignalCount).toBe(1);
    expect(JSON.stringify(report)).not.toContain('sk-proj-should-redact');
    expect(JSON.stringify(report)).not.toContain('+14695405551');
    expect(formatted).toContain('Council Task-Ease');
  });
});
