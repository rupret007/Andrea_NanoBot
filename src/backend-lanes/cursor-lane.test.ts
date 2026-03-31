import { describe, expect, it } from 'vitest';

import { createCursorBackendLane } from './cursor-lane.js';
import type { CursorAgentView } from '../cursor-jobs.js';

function makeRecord(
  overrides: Partial<CursorAgentView> = {},
): CursorAgentView {
  return {
    provider: 'cloud',
    id: 'bc_test_123',
    groupFolder: 'main',
    chatJid: 'tg:1',
    status: 'RUNNING',
    model: 'default',
    promptText: 'Ship it',
    sourceRepository: 'https://github.com/example/repo',
    sourceRef: 'main',
    sourcePrUrl: null,
    targetUrl: 'https://cursor.com/agents/bc_test_123',
    targetPrUrl: null,
    targetBranchName: null,
    autoCreatePr: false,
    openAsCursorGithubApp: false,
    skipReviewerRequest: false,
    summary: null,
    createdBy: 'tg:owner',
    createdAt: '2026-03-30T10:00:00.000Z',
    updatedAt: '2026-03-30T10:01:00.000Z',
    lastSyncedAt: '2026-03-30T10:01:00.000Z',
    ...overrides,
  };
}

describe('createCursorBackendLane', () => {
  it('advertises Cursor-specific capabilities', () => {
    const lane = createCursorBackendLane();

    expect(lane.id).toBe('cursor');
    expect(lane.getCapabilities().actionIds).toEqual(
      expect.arrayContaining([
        'cursor.sync',
        'cursor.text',
        'cursor.files',
        'cursor.download',
        'cursor.terminal_status',
      ]),
    );
  });

  it('builds cloud and desktop action sets without flattening Cursor richness', () => {
    const lane = createCursorBackendLane();
    const cloud = lane.getActionDescriptors(makeRecord());
    const desktop = lane.getActionDescriptors(
      makeRecord({
        provider: 'desktop',
        id: 'desk_local_123',
        targetUrl: null,
      }),
    );

    expect(cloud.map((action) => action.actionId)).toEqual([
      'cursor.sync',
      'cursor.text',
      'cursor.files',
      'cursor.open',
      'cursor.stop',
    ]);
    expect(desktop.map((action) => action.actionId)).toEqual([
      'cursor.sync',
      'cursor.text',
      'cursor.terminal_status',
      'cursor.terminal_log',
      'cursor.terminal_help',
    ]);
  });
});
