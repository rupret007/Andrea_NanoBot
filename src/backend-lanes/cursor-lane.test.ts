import { describe, expect, it } from 'vitest';

import { createCursorBackendLane } from './cursor-lane.js';
describe('createCursorBackendLane', () => {
  it('advertises Cursor-specific capabilities', () => {
    const lane = createCursorBackendLane();

    expect(lane.id).toBe('cursor');
    expect(lane.getCapabilities().actionIds).toEqual(
      expect.arrayContaining([
        'job.refresh',
        'job.output',
        'job.files',
        'job.followup',
        'job.stop',
        'cursor.download',
        'cursor.terminal_status',
      ]),
    );
    expect(lane.getCapabilities().canRefresh).toBe(true);
    expect(lane.getCapabilities().canViewOutput).toBe(true);
    expect(lane.getCapabilities().canViewFiles).toBe(true);
  });

  it('builds cloud and desktop action sets without flattening Cursor richness', () => {
    const lane = createCursorBackendLane();
    const cloud = lane.getActionDescriptors({
      handle: { laneId: 'cursor', jobId: 'bc_test_123' },
      title: 'Cursor Cloud job',
      status: 'RUNNING',
      summary: 'Ship it',
      updatedAt: '2026-03-30T10:01:00.000Z',
      createdAt: '2026-03-30T10:00:00.000Z',
      sourceRepository: 'https://github.com/example/repo',
      targetUrl: 'https://cursor.com/agents/bc_test_123',
      laneLabel: 'Cursor',
      capabilities: lane.getCapabilities(),
      metadata: { provider: 'cloud' },
    });
    const desktop = lane.getActionDescriptors({
      handle: { laneId: 'cursor', jobId: 'desk_local_123' },
      title: 'Desktop bridge session',
      status: 'IDLE',
      summary: null,
      updatedAt: '2026-03-30T10:03:00.000Z',
      createdAt: '2026-03-30T10:02:00.000Z',
      sourceRepository: null,
      targetUrl: null,
      laneLabel: 'Cursor',
      capabilities: lane.getCapabilities(),
      metadata: { provider: 'desktop' },
    });

    expect(cloud.map((action) => action.actionId)).toEqual([
      'job.refresh',
      'job.output',
      'job.files',
      'cursor.open',
      'job.followup',
      'job.stop',
    ]);
    expect(cloud.map((action) => action.label)).toEqual([
      'Refresh',
      'View Output',
      'Results',
      'Open in Cursor',
      'Continue',
      'Stop Run',
    ]);
    expect(desktop.map((action) => action.actionId)).toEqual([
      'job.refresh',
      'job.output',
      'cursor.terminal_status',
      'cursor.terminal_log',
      'cursor.terminal_help',
    ]);
    expect(desktop.map((action) => action.label)).toEqual([
      'Refresh',
      'View Output',
      'Terminal Status',
      'Terminal Log',
      'Terminal Help',
    ]);
  });
});
