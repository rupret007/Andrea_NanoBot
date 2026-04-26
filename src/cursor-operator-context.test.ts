import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, upsertCursorOperatorContext } from './db.js';
import {
  buildCursorReplyContextMissingMessage,
  buildCursorCloudTaskActions,
  buildCursorJobCardActions,
  buildCursorListSelectionActions,
  buildCursorTerminalCardActions,
  clearSelectedLaneJob,
  detectCursorReplyProvider,
  flattenCursorJobInventory,
  formatCursorDisplayId,
  formatCursorTaskNextStepMessage,
  getBackendContextGuidance,
  getActiveCursorMessageContext,
  getActiveCursorOperatorContext,
  getSelectedLaneJobId,
  looksLikeCursorTargetToken,
  rememberCursorDashboardMessage,
  rememberCursorJobList,
  rememberCursorMessageContext,
  rememberCursorOperatorSelection,
  resolveCursorReplyContext,
  resolveBackendTarget,
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

  it('keeps per-lane selections when switching between cursor and runtime jobs', () => {
    rememberCursorOperatorSelection({
      chatJid: 'tg:1',
      threadId: '42',
      laneId: 'cursor',
      agentId: 'bc_current',
    });
    rememberCursorOperatorSelection({
      chatJid: 'tg:1',
      threadId: '42',
      laneId: 'andrea_runtime',
      agentId: 'runtime-job-1',
    });

    const context = getActiveCursorOperatorContext('tg:1', '42');
    expect(context?.selectedLaneId).toBe('andrea_runtime');
    expect(getSelectedLaneJobId('tg:1', '42', 'cursor')).toBe('bc_current');
    expect(getSelectedLaneJobId('tg:1', '42', 'andrea_runtime')).toBe(
      'runtime-job-1',
    );
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

  it('resolves runtime ordinals and reply contexts without clobbering cursor snapshots', () => {
    rememberCursorJobList({
      chatJid: 'tg:1',
      threadId: '42',
      selectedLaneId: 'cursor',
      items: [
        { laneId: 'cursor', id: 'bc_123', provider: 'cloud' },
        { laneId: 'cursor', id: 'desk_456', provider: 'desktop' },
      ],
    });
    rememberCursorJobList({
      chatJid: 'tg:1',
      threadId: '42',
      selectedLaneId: 'andrea_runtime',
      items: [
        { laneId: 'andrea_runtime', id: 'runtime-job-1', provider: null },
        { laneId: 'andrea_runtime', id: 'runtime-job-2', provider: null },
      ],
    });
    rememberCursorMessageContext({
      chatJid: 'tg:1',
      platformMessageId: '9002',
      contextKind: 'runtime_job_card',
      laneId: 'andrea_runtime',
      agentId: 'runtime-job-reply',
      payload: { groupFolder: 'main' },
    });

    const runtimeOrdinal = resolveBackendTarget({
      chatJid: 'tg:1',
      threadId: '42',
      requestedTarget: '2',
      laneId: 'andrea_runtime',
      parseExplicitTarget(raw) {
        return /^runtime-job-/.test(raw) ? raw : null;
      },
    });
    const cursorOrdinal = resolveCursorTarget({
      chatJid: 'tg:1',
      threadId: '42',
      requestedTarget: '1',
    });
    const runtimeReply = resolveBackendTarget({
      chatJid: 'tg:1',
      replyToMessageId: '9002',
      laneId: 'andrea_runtime',
      parseExplicitTarget(raw) {
        return /^runtime-job-/.test(raw) ? raw : null;
      },
    });

    expect(runtimeOrdinal.target?.agentId).toBe('runtime-job-2');
    expect(cursorOrdinal.target?.agentId).toBe('bc_123');
    expect(runtimeReply.target?.agentId).toBe('runtime-job-reply');
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

  it('returns runtime guidance when runtime context is missing', () => {
    const resolved = resolveBackendTarget({
      chatJid: 'tg:1',
      laneId: 'andrea_runtime',
      parseExplicitTarget(raw) {
        return /^runtime-job-/.test(raw) ? raw : null;
      },
    });

    expect(resolved.target).toBeNull();
    expect(resolved.failureMessage).toBe(
      getBackendContextGuidance('andrea_runtime'),
    );
    expect(resolved.failureMessage).toContain('/cursor` -> `Codex/OpenAI`');
  });
});

describe('operator context helpers', () => {
  it('returns fresh message context payloads', () => {
    rememberCursorMessageContext({
      chatJid: 'tg:1',
      platformMessageId: '9001',
      contextKind: 'cursor_job_card',
      agentId: 'bc_123',
      payload: {
        provider: 'cloud',
        taskContextType: 'output',
        taskSummary: 'Tighten the launch copy',
        outputPreview: 'Launch faster with one assistant.',
      },
    });

    const context = getActiveCursorMessageContext('tg:1', '9001');
    expect(context?.agentId).toBe('bc_123');
    expect(context?.laneId).toBe('cursor');
    expect(context?.payload?.provider).toBe('cloud');
    expect(context?.payload?.taskContextType).toBe('output');
    expect(context?.payload?.taskSummary).toBe('Tighten the launch copy');
    expect(context?.payload?.outputPreview).toBe(
      'Launch faster with one assistant.',
    );
  });

  it('keeps current-task buttons human-readable', () => {
    const actions = buildCursorJobCardActions(makeInventory().cloudTracked[0]);
    expect(actions.map((action) => action.label)).toEqual([
      'Refresh',
      'View Output',
      'Results',
      'Open in Cursor',
      'Stop Run',
    ]);
    expect(actions[0].actionId).toBe('/cursor-sync');
    expect(actions[1].actionId).toBe('/cursor-conversation');
  });

  it('builds cloud and terminal task action families for panel-first replies', () => {
    expect(
      buildCursorCloudTaskActions('https://cursor.example/task').map(
        (action) => action.label,
      ),
    ).toEqual([
      'Refresh',
      'View Output',
      'Results',
      'Open in Cursor',
      'Stop Run',
    ]);
    expect(
      buildCursorTerminalCardActions().map((action) => action.label),
    ).toEqual(['Refresh', 'Terminal Status', 'Terminal Log', 'Terminal Help']);
  });

  it('gives exact-id fallback guidance for both Cursor Cloud and desktop sessions', () => {
    expect(
      formatCursorTaskNextStepMessage(makeInventory().cloudTracked[0]),
    ).toContain('/cursor-sync bc-11111111-2222-3333-4444-555555555555');
    expect(
      formatCursorTaskNextStepMessage(makeInventory().cloudTracked[0]),
    ).toContain('/cursor-results bc-11111111-2222-3333-4444-555555555555');
    expect(
      formatCursorTaskNextStepMessage(makeInventory().cloudTracked[0]),
    ).toContain('Reply with plain text to continue this task.');

    expect(
      formatCursorTaskNextStepMessage(makeInventory().desktopTracked[0]),
    ).toContain('/cursor-terminal-status desk_local_123');
    expect(
      formatCursorTaskNextStepMessage(makeInventory().desktopTracked[0]),
    ).toContain('/cursor-terminal-log desk_local_123');
    expect(
      formatCursorTaskNextStepMessage(makeInventory().desktopTracked[0]),
    ).not.toContain('Reply with plain text to continue this task.');
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

  it('does not clear an existing lane selection when a dashboard refresh omits selection fields', () => {
    rememberCursorOperatorSelection({
      chatJid: 'tg:1',
      threadId: '42',
      laneId: 'andrea_runtime',
      agentId: 'runtime-job-1',
    });

    rememberCursorDashboardMessage({
      chatJid: 'tg:1',
      threadId: '42',
      dashboardMessageId: '9002',
    });

    const context = getActiveCursorOperatorContext('tg:1', '42');
    expect(context?.dashboardMessageId).toBe('9002');
    expect(context?.selectedLaneId).toBe('andrea_runtime');
    expect(context?.selectedAgentId).toBe('runtime-job-1');
    expect(context?.selectedJobsByLane?.andrea_runtime).toBe('runtime-job-1');
  });

  it('can clear the selected job for one lane without inventing a replacement', () => {
    rememberCursorOperatorSelection({
      chatJid: 'tg:1',
      threadId: '42',
      laneId: 'cursor',
      agentId: 'bc_123',
    });

    clearSelectedLaneJob({
      chatJid: 'tg:1',
      threadId: '42',
      laneId: 'cursor',
    });

    const context = getActiveCursorOperatorContext('tg:1', '42');
    expect(context?.selectedLaneId).toBeNull();
    expect(context?.selectedJobsByLane?.cursor).toBeNull();
  });

  it('returns dashboard-first lane guidance', () => {
    expect(getBackendContextGuidance('cursor')).toContain(
      'Open `/cursor`, then tap `Jobs` or `Current Job`',
    );
    expect(getBackendContextGuidance('andrea_runtime')).toContain(
      'Open `/cursor` -> `Codex/OpenAI` -> `Recent Work`',
    );
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

  it('classifies fresh, missing, and expired cursor reply contexts', () => {
    expect(
      resolveCursorReplyContext({
        replyMessageId: '500',
        replyText: 'Task bc_123\nLane: Cursor Cloud',
        contextMessageId: '500',
        contextAgentId: 'bc_123',
        contextCreatedAt: '2026-04-03T10:00:00.000Z',
        nowIso: '2026-04-04T09:00:00.000Z',
      }),
    ).toEqual({
      kind: 'ready',
      provider: 'cloud',
      agentId: 'bc_123',
    });

    expect(
      resolveCursorReplyContext({
        replyMessageId: '500',
        replyText: 'Session desk_123\nLane: Cursor Desktop',
        nowIso: '2026-04-04T09:00:00.000Z',
      }),
    ).toEqual({
      kind: 'missing',
      provider: 'desktop',
      agentId: null,
    });

    expect(
      resolveCursorReplyContext({
        replyMessageId: '500',
        replyText: 'Task bc_123\nLane: Cursor Cloud',
        contextMessageId: '500',
        contextAgentId: 'bc_123',
        contextCreatedAt: '2026-03-20T10:00:00.000Z',
        nowIso: '2026-04-04T09:00:00.000Z',
      }),
    ).toEqual({
      kind: 'expired',
      provider: 'cloud',
      agentId: null,
    });
  });

  it('renders lane-appropriate guidance for stale cursor replies', () => {
    expect(detectCursorReplyProvider('Lane: Cursor Desktop')).toBe('desktop');
    expect(buildCursorReplyContextMissingMessage('desktop')).toContain(
      '/cursor-terminal-status',
    );
    expect(buildCursorReplyContextMissingMessage('cloud')).toContain(
      '/cursor-followup [AGENT_ID|LIST_NUMBER|current] TEXT',
    );
  });
});
