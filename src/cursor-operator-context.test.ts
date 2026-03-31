import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, upsertCursorOperatorContext } from './db.js';
import {
  buildCursorJobCardActions,
  buildCursorListSelectionActions,
  flattenCursorJobInventory,
  formatCursorDisplayId,
  getActiveCursorMessageContext,
  getActiveCursorOperatorContext,
  looksLikeCursorTargetToken,
  rememberCursorDashboardMessage,
  rememberCursorJobList,
  rememberCursorMessageContext,
  rememberCursorOperatorSelection,
  resolveCursorTarget,
} from './cursor-operator-context.js';
import type { CursorJobInventory } from './cursor-jobs.js';

beforeEach(() => {
  _initTestDatabase();
});

function makeInventory(): CursorJobInventory {
  return {
    hasCloud: true,
    hasDesktop: true,
    warning: null,
    cloudTracked: [
      {
        provider: 'cloud',
        id: 'bc-11111111-2222-3333-4444-555555555555',
        groupFolder: 'main',
        chatJid: 'tg:1',
        status: 'RUNNING',
        model: 'default',
        promptText: 'Ship docs',
        sourceRepository: 'https://github.com/example/repo',
        sourceRef: 'main',
        sourcePrUrl: null,
        targetUrl:
          'https://cursor.com/agents/bc-11111111-2222-3333-4444-555555555555',
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
      },
    ],
    desktopTracked: [
      {
        provider: 'desktop',
        id: 'desk_local_123',
        groupFolder: 'main',
        chatJid: 'tg:1',
        status: 'IDLE',
        model: null,
        promptText: 'desktop',
        sourceRepository: null,
        sourceRef: null,
        sourcePrUrl: null,
        targetUrl: null,
        targetPrUrl: null,
        targetBranchName: null,
        autoCreatePr: false,
        openAsCursorGithubApp: false,
        skipReviewerRequest: false,
        summary: null,
        createdBy: 'tg:owner',
        createdAt: '2026-03-30T10:02:00.000Z',
        updatedAt: '2026-03-30T10:03:00.000Z',
        lastSyncedAt: '2026-03-30T10:03:00.000Z',
      },
    ],
    cloudRecoverable: [],
    desktopRecoverable: [],
  };
}

describe('flattenCursorJobInventory', () => {
  it('assigns stable ordinals across cloud and desktop sections', () => {
    const flattened = flattenCursorJobInventory(makeInventory());

    expect(flattened).toHaveLength(2);
    expect(flattened[0].ordinal).toBe(1);
    expect(flattened[0].id).toContain('bc-11111111');
    expect(flattened[1].ordinal).toBe(2);
    expect(flattened[1].id).toBe('desk_local_123');
  });
});

describe('resolveCursorTarget', () => {
  it('resolves explicit ids directly', () => {
    const resolved = resolveCursorTarget({
      chatJid: 'tg:1',
      requestedTarget: 'bc_123',
    });

    expect(resolved.target?.agentId).toBe('bc_123');
    expect(resolved.target?.via).toBe('explicit');
  });

  it('resolves ordinals from the latest cursor jobs snapshot', () => {
    rememberCursorJobList({
      chatJid: 'tg:1',
      threadId: '42',
      items: [
        { laneId: 'cursor', id: 'bc_123', provider: 'cloud' },
        { laneId: 'cursor', id: 'desk_456', provider: 'desktop' },
      ],
    });

    const resolved = resolveCursorTarget({
      chatJid: 'tg:1',
      threadId: '42',
      requestedTarget: '2',
    });

    expect(resolved.target?.agentId).toBe('desk_456');
    expect(resolved.target?.via).toBe('ordinal');
  });

  it('resolves current from remembered selection', () => {
    rememberCursorOperatorSelection({
      chatJid: 'tg:1',
      threadId: '42',
      agentId: 'bc_current',
    });

    const resolved = resolveCursorTarget({
      chatJid: 'tg:1',
      threadId: '42',
      requestedTarget: 'current',
    });

    expect(resolved.target?.agentId).toBe('bc_current');
    expect(resolved.target?.via).toBe('current');
  });

  it('resolves reply context when no explicit target is provided', () => {
    rememberCursorMessageContext({
      chatJid: 'tg:1',
      platformMessageId: '9001',
      contextKind: 'cursor_job_card',
      agentId: 'bc_reply',
      payload: { provider: 'cloud' },
    });

    const resolved = resolveCursorTarget({
      chatJid: 'tg:1',
      replyToMessageId: '9001',
    });

    expect(resolved.target?.agentId).toBe('bc_reply');
    expect(resolved.target?.via).toBe('reply');
  });

  it('ignores stale selection context after seven days', () => {
    rememberCursorJobList({
      chatJid: 'tg:1',
      items: [{ laneId: 'cursor', id: 'bc_old', provider: 'cloud' }],
      selectedAgentId: 'bc_old',
    });
    rememberCursorOperatorSelection({
      chatJid: 'tg:1',
      agentId: 'bc_old',
    });

    // overwrite with a stale timestamp
    const staleTime = '2026-03-20T00:00:00.000Z';
    rememberCursorJobList({
      chatJid: 'tg:1',
      items: [{ laneId: 'cursor', id: 'bc_old', provider: 'cloud' }],
      selectedAgentId: 'bc_old',
    });
    // direct DB update via helper keeps data but ages it out
    upsertCursorOperatorContext({
      chatJid: 'tg:1',
      selectedAgentId: 'bc_old',
      lastListSnapshotJson: JSON.stringify([
        { laneId: 'cursor', id: 'bc_old', provider: 'cloud' },
      ]),
      updatedAt: staleTime,
    });

    const resolved = resolveCursorTarget({
      chatJid: 'tg:1',
      requestedTarget: 'current',
    });

    expect(resolved.target).toBeNull();
    expect(resolved.failureMessage).toContain('/cursor');
  });
});

describe('operator context helpers', () => {
  it('returns fresh message context payloads', () => {
    rememberCursorMessageContext({
      chatJid: 'tg:1',
      platformMessageId: '9001',
      contextKind: 'cursor_job_card',
      agentId: 'bc_123',
      payload: { provider: 'cloud' },
    });

    const context = getActiveCursorMessageContext('tg:1', '9001');
    expect(context?.agentId).toBe('bc_123');
    expect(context?.laneId).toBe('cursor');
    expect(context?.payload?.provider).toBe('cloud');
  });

  it('keeps cursor-results and cursor-download buttons human-readable', () => {
    const actions = buildCursorJobCardActions(makeInventory().cloudTracked[0]);
    expect(actions.map((action) => action.label)).toEqual([
      'Sync',
      'Text',
      'Files',
      'Open',
      'Stop',
    ]);
    expect(actions[0].actionId).toBe('/cursor-sync');
    expect(actions[1].actionId).toBe('/cursor-conversation');
  });

  it('builds numbered selector buttons plus refresh', () => {
    expect(
      buildCursorListSelectionActions(3).map((action) => action.label),
    ).toEqual(['1', '2', '3', 'Refresh']);
  });

  it('keeps dashboard message ids and selected jobs per chat/thread', () => {
    rememberCursorDashboardMessage({
      chatJid: 'tg:1',
      threadId: '42',
      dashboardMessageId: '9001',
      selectedAgentId: 'bc_123',
    });

    const context = getActiveCursorOperatorContext('tg:1', '42');
    expect(context?.dashboardMessageId).toBe('9001');
    expect(context?.selectedAgentId).toBe('bc_123');
    expect(context?.selectedLaneId).toBe('cursor');
    expect(context?.selectedJobsByLane?.cursor).toBe('bc_123');
  });

  it('recognizes target-like tokens without mistaking normal paths', () => {
    expect(looksLikeCursorTargetToken('current')).toBe(true);
    expect(looksLikeCursorTargetToken('2')).toBe(true);
    expect(looksLikeCursorTargetToken('bc_123')).toBe(true);
    expect(looksLikeCursorTargetToken('C:\\temp\\output.txt')).toBe(false);
  });

  it('shortens long cursor ids for job cards', () => {
    expect(
      formatCursorDisplayId('bc-11111111-2222-3333-4444-555555555555'),
    ).toMatch(/\.\.\./);
  });
});
