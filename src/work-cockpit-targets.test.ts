import { describe, expect, it } from 'vitest';

import { resolveRuntimeDashboardJobId } from './work-cockpit-targets.js';

describe('resolveRuntimeDashboardJobId', () => {
  it('uses the exact runtime job id from a unified current-work card', () => {
    expect(
      resolveRuntimeDashboardJobId({
        laneId: 'andrea_runtime',
        agentId: 'runtime-job-1',
        state: { kind: 'work_current' },
      }),
    ).toBe('runtime-job-1');
  });

  it('uses the exact runtime job id from a runtime-current card', () => {
    expect(
      resolveRuntimeDashboardJobId({
        laneId: 'cursor',
        agentId: 'runtime-job-2',
        state: { kind: 'runtime_current' },
      }),
    ).toBe('runtime-job-2');
  });

  it('does not treat cursor work cards as runtime targets', () => {
    expect(
      resolveRuntimeDashboardJobId({
        laneId: 'cursor',
        agentId: 'bc-task-1',
        state: { kind: 'work_current' },
      }),
    ).toBeNull();
  });
});
