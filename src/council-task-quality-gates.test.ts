import { describe, expect, it } from 'vitest';

import { evaluateCouncilTaskQualityGates } from './council-task-quality-gates.js';

describe('council task quality gates', () => {
  it('scores family-level gates with pass/warn/fail statuses', () => {
    const report = evaluateCouncilTaskQualityGates([
      {
        gateId: 'schema_validity.latest',
        family: 'schema_validity',
        metric: 'schema_invalid_runs',
        actual: 1,
        floor: 1,
        summary: 'No invalid schema artifacts.',
      },
      {
        gateId: 'evidence_contract.citation',
        family: 'evidence_contract',
        metric: 'citation_coverage',
        actual: 0.9,
        floor: 1,
        warnFloor: 0.85,
        summary: 'Most evidence cards are cited.',
      },
      {
        gateId: 'outcome_signal.capture',
        family: 'outcome_signal',
        metric: 'outcome_signal_count',
        actual: 0,
        floor: 1,
        summary: 'No outcome signal was attached.',
      },
    ]);

    expect(report.total).toBe(3);
    expect(report.pass).toBe(false);
    expect(report.score).toBeCloseTo(0.5, 3);
    expect(report.gates.map((gate) => gate.status)).toEqual([
      'pass',
      'warn',
      'fail',
    ]);
  });
});
