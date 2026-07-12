import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildAutonomousImprovementLabReport,
  formatAutonomousImprovementLabReport,
} from './autonomous-improvement-lab.js';
import { _closeDatabase, _initTestDatabase } from './db.js';

describe('autonomous improvement persistence boundary', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('keeps a generated report usable and truthfully defers a busy writer', () => {
    const report = buildAutonomousImprovementLabReport({
      now: new Date('2026-07-11T20:00:00.000Z'),
      persist: true,
      persistenceWriter: () => {
        const error = new Error('database is locked') as Error & {
          code: string;
        };
        error.code = 'SQLITE_BUSY';
        throw error;
      },
    });

    expect(report.persistence).toMatchObject({
      requested: true,
      status: 'deferred_database_busy',
      atomic: true,
      retrySafe: true,
    });
    expect(report.persistence.detail).toMatch(/retry/i);
    expect(formatAutonomousImprovementLabReport(report)).toContain(
      'Persistence: deferred_database_busy',
    );
  });

  it('propagates unexpected persistence failures instead of hiding them', () => {
    expect(() =>
      buildAutonomousImprovementLabReport({
        persist: true,
        persistenceWriter: () => {
          throw new Error('schema corruption');
        },
      }),
    ).toThrow(/schema corruption/);
  });

  it('records explicit read-only operation without invoking the writer', () => {
    let called = false;
    const report = buildAutonomousImprovementLabReport({
      persist: false,
      persistenceWriter: () => {
        called = true;
      },
    });

    expect(called).toBe(false);
    expect(report.persistence.status).toBe('disabled');
  });
});
