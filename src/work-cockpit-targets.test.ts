import { describe, expect, it } from 'vitest';

import {
  reconcileWorkCockpitCurrentSelection,
  resolveRuntimeDashboardJobId,
} from './work-cockpit-targets.js';

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

describe('reconcileWorkCockpitCurrentSelection', () => {
  it('keeps an explicit current-work selection when one already exists', () => {
    expect(
      reconcileWorkCockpitCurrentSelection({
        currentSelection: {
          laneId: 'cursor',
          jobId: 'cursor-job-1',
        },
        runtimeJobId: 'runtime-job-1',
      }),
    ).toEqual({
      laneId: 'cursor',
      jobId: 'cursor-job-1',
    });
  });

  it('promotes the current runtime task when the shared selection is missing', () => {
    expect(
      reconcileWorkCockpitCurrentSelection({
        currentSelection: null,
        runtimeJobId: 'runtime-job-2',
      }),
    ).toEqual({
      laneId: 'andrea_runtime',
      jobId: 'runtime-job-2',
    });
  });

  it('falls back to the current cursor task when no runtime task is selected', () => {
    expect(
      reconcileWorkCockpitCurrentSelection({
        currentSelection: null,
        cursorJobId: 'cursor-job-2',
      }),
    ).toEqual({
      laneId: 'cursor',
      jobId: 'cursor-job-2',
    });
  });
});
