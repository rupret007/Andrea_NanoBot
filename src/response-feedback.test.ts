import { beforeEach, describe, expect, it } from 'vitest';

import {
  appendResponseFeedbackActionRows,
  appendResponseFeedbackInlineRow,
  buildResponseFeedbackActionId,
  buildResponseFeedbackActionRows,
  buildResponseFeedbackRemediationPrompt,
  classifyResponseFeedbackCandidate,
  parseResponseFeedbackAction,
  refreshResponseFeedbackRecordTruth,
  selectResponseFeedbackLane,
  selectResponseFeedbackRetryLane,
} from './response-feedback.js';
import { _initTestDatabase, upsertResponseFeedback } from './db.js';
import type { ResponseFeedbackRecord } from './types.js';

function buildRecord(
  overrides: Partial<ResponseFeedbackRecord> = {},
): ResponseFeedbackRecord {
  return {
    feedbackId: '11111111-2222-3333-4444-555555555555',
    createdAt: '2026-04-14T00:00:00.000Z',
    updatedAt: '2026-04-14T00:00:00.000Z',
    status: 'awaiting_confirmation',
    classification: 'repo_side_broken',
    channel: 'telegram',
    groupFolder: 'main',
    chatJid: 'tg:main',
    threadId: null,
    platformMessageId: '777',
    userMessageId: 'user-1',
    issueId: null,
    routeKey: 'research.answer',
    capabilityId: 'research.answer',
    handlerKind: 'assistant_completion',
    responseSource: 'research_handoff',
    traceReason: 'live research blocked',
    traceNotes: [],
    blockerClass: 'provider_quota_blocked',
    blockerOwner: 'external',
    originalUserText: "what's the news today",
    assistantReplyText: 'I can help with updates and practical follow-through.',
    linkedRefs: {},
    remediationLaneId: null,
    remediationJobId: null,
    remediationRuntimePreference: null,
    remediationPrompt: null,
    operatorNote: 'saved for review',
    ...overrides,
  };
}

describe('response feedback helpers', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('parses and builds action ids', () => {
    const actionId = buildResponseFeedbackActionId(
      '11111111-2222-3333-4444-555555555555',
      'capture',
    );
    expect(actionId).toBe(
      'feedback:11111111-2222-3333-4444-555555555555:capture',
    );
    expect(parseResponseFeedbackAction(actionId)).toEqual({
      feedbackId: '11111111-2222-3333-4444-555555555555',
      operation: 'capture',
    });
    expect(
      parseResponseFeedbackAction(
        'feedback:11111111-2222-3333-4444-555555555555:commit_push',
      ),
    ).toEqual({
      feedbackId: '11111111-2222-3333-4444-555555555555',
      operation: 'commit_push',
    });
    expect(parseResponseFeedbackAction('/help')).toBeNull();
  });

  it('appends a not-helpful row without clobbering existing inline rows', () => {
    const options = appendResponseFeedbackInlineRow(
      {
        inlineActionRows: [[{ label: 'Keep', actionId: 'keep' }]],
      },
      '11111111-2222-3333-4444-555555555555',
    );

    expect(options.inlineActionRows).toEqual([
      [{ label: 'Keep', actionId: 'keep' }],
      [
        {
          label: 'Not helpful',
          actionId:
            'feedback:11111111-2222-3333-4444-555555555555:capture',
        },
      ],
    ]);
  });

  it('offers landing actions after a local hotfix resolves', () => {
    const rows = buildResponseFeedbackActionRows(
      buildRecord({
        status: 'resolved_locally',
      }),
    );

    expect(rows).toEqual([
      [
        {
          label: 'Commit + push',
          actionId:
            'feedback:11111111-2222-3333-4444-555555555555:commit_push',
        },
        {
          label: 'Commit only',
          actionId:
            'feedback:11111111-2222-3333-4444-555555555555:commit_only',
        },
      ],
      [
        {
          label: 'Keep local',
          actionId:
            'feedback:11111111-2222-3333-4444-555555555555:keep_local',
        },
        {
          label: 'Why',
          actionId: 'feedback:11111111-2222-3333-4444-555555555555:why',
        },
      ],
    ]);
  });

  it('offers retry actions after a remediation task fails', () => {
    const rows = buildResponseFeedbackActionRows(
      buildRecord({
        status: 'failed',
      }),
    );

    expect(rows).toEqual([
      [
        {
          label: 'Retry fix',
          actionId: 'feedback:11111111-2222-3333-4444-555555555555:start',
        },
        {
          label: 'Why',
          actionId: 'feedback:11111111-2222-3333-4444-555555555555:why',
        },
        {
          label: 'Not now',
          actionId: 'feedback:11111111-2222-3333-4444-555555555555:not_now',
        },
      ],
    ]);
  });

  it('appends landing rows after existing task actions when a hotfix is local-only', () => {
    const rows = appendResponseFeedbackActionRows({
      record: buildRecord({ status: 'resolved_locally' }),
      inlineActions: [
        { label: 'Refresh', actionId: '/runtime-status' },
        { label: 'Open Work', actionId: '/runtime-jobs' },
      ],
    });

    expect(rows).toEqual([
      [
        { label: 'Refresh', actionId: '/runtime-status' },
        { label: 'Open Work', actionId: '/runtime-jobs' },
      ],
      [
        {
          label: 'Commit + push',
          actionId:
            'feedback:11111111-2222-3333-4444-555555555555:commit_push',
        },
        {
          label: 'Commit only',
          actionId:
            'feedback:11111111-2222-3333-4444-555555555555:commit_only',
        },
      ],
      [
        {
          label: 'Keep local',
          actionId:
            'feedback:11111111-2222-3333-4444-555555555555:keep_local',
        },
        {
          label: 'Why',
          actionId: 'feedback:11111111-2222-3333-4444-555555555555:why',
        },
      ],
    ]);
  });

  it('classifies manual-sync-only misses', () => {
    const result = classifyResponseFeedbackCandidate({
      originalUserText: 'why did Alexa miss that',
      assistantReplyText: 'Please import the interaction model and Build Model.',
      routeKey: 'alexa.answer',
      capabilityId: 'alexa.answer',
      responseSource: 'fallback',
      traceReason: 'manual sync required',
      blockerClass: 'manual_surface_sync',
    });

    expect(result.classification).toBe('manual_sync_only');
    expect(result.status).toBe('manual_sync_only');
  });

  it('classifies blocked-provider misses', () => {
    const result = classifyResponseFeedbackCandidate({
      originalUserText: 'make me an image of a waterfall',
      assistantReplyText: 'Image generation is blocked by provider quota right now.',
      routeKey: 'media.image_generate',
      capabilityId: 'media.image_generate',
      responseSource: 'media_handoff',
      traceReason: 'quota blocked',
      blockerClass: 'provider_quota_blocked',
    });

    expect(result.classification).toBe('externally_blocked');
    expect(result.status).toBe('blocked_external');
  });

  it('treats honest blocked-live news fallbacks as externally blocked', () => {
    const result = classifyResponseFeedbackCandidate({
      originalUserText: "what's the news today",
      assistantReplyText:
        "I can't check that live right now because the live lookup was unavailable.",
      routeKey: 'assistant_completion',
      capabilityId: 'assistant_completion',
      responseSource: 'assistant_completion',
      traceReason: 'live lookup was unavailable',
      blockerClass: null,
    });

    expect(result.classification).toBe('externally_blocked');
    expect(result.status).toBe('blocked_external');
  });

  it('treats canned-news misses as repo-side broken', () => {
    const result = classifyResponseFeedbackCandidate({
      originalUserText: "what's the news today",
      assistantReplyText: 'I can help you stay on top of things.',
      routeKey: 'assistant_completion',
      capabilityId: 'assistant_completion',
      responseSource: 'assistant_completion',
      traceReason: 'generic fallback',
      blockerClass: null,
    });

    expect(result.classification).toBe('repo_side_broken');
    expect(result.status).toBe('awaiting_confirmation');
  });

  it('prefers codex local, then codex cloud, then cursor cloud, and never auto-selects cursor desktop', () => {
    expect(
      selectResponseFeedbackLane({
        runtimeAvailable: true,
        runtimeLocalPreferred: true,
        runtimeCloudAllowed: true,
        cursorCloudAvailable: true,
        cursorDesktopAvailable: true,
      }).runtimePreference,
    ).toBe('codex_local');

    expect(
      selectResponseFeedbackLane({
        runtimeAvailable: true,
        runtimeLocalPreferred: false,
        runtimeCloudAllowed: true,
        cursorCloudAvailable: true,
        cursorDesktopAvailable: true,
      }).runtimePreference,
    ).toBe('codex_cloud');

    expect(
      selectResponseFeedbackLane({
        runtimeAvailable: false,
        runtimeLocalPreferred: false,
        runtimeCloudAllowed: false,
        cursorCloudAvailable: true,
        cursorDesktopAvailable: true,
      }).runtimePreference,
    ).toBe('cursor_cloud');

    const desktopOnly = selectResponseFeedbackLane({
      runtimeAvailable: false,
      runtimeLocalPreferred: false,
      runtimeCloudAllowed: false,
      cursorCloudAvailable: false,
      cursorDesktopAvailable: true,
    });
    expect(desktopOnly.laneId).toBeNull();
    expect(desktopOnly.runtimePreference).toBe('cursor_local');
  });

  it('falls back to codex cloud when retrying after a codex-local failure', () => {
    const selection = selectResponseFeedbackRetryLane({
      record: buildRecord({
        status: 'failed',
        remediationRuntimePreference: 'codex_local',
      }),
      availability: {
        runtimeAvailable: true,
        runtimeLocalPreferred: true,
        runtimeCloudAllowed: true,
        cursorCloudAvailable: true,
        cursorDesktopAvailable: false,
      },
    });

    expect(selection.laneId).toBe('andrea_runtime');
    expect(selection.runtimePreference).toBe('codex_cloud');
    expect(selection.label).toBe('Codex cloud');
  });

  it('builds a remediation prompt with the ask, validation, restart, and no-commit rules', () => {
    const prompt = buildResponseFeedbackRemediationPrompt({
      record: buildRecord({
        classification: 'repo_side_broken',
        responseSource: 'assistant_completion',
        blockerClass: null,
        blockerOwner: 'repo_side',
      }),
      laneSelection: {
        laneId: 'andrea_runtime',
        runtimePreference: 'codex_local',
        label: 'Codex local',
        promptPrefix: '[runtime: local]',
        reason: 'Codex local is healthy.',
      },
      hostTruthLines: [
        'Telegram: live_proven',
        'Research: externally_blocked (provider quota blocked)',
      ],
    });

    expect(prompt).toContain("Original ask: what's the news today");
    expect(prompt).toContain('Andrea reply: I can help with updates');
    expect(prompt).toContain('npm run typecheck');
    expect(prompt).toContain('npm run build');
    expect(prompt).toContain('restart with npm run services:restart');
    expect(prompt).toContain('Do not commit or push');
  });

  it('refreshes a running remediation record to failed when the live task already died', async () => {
    const record = buildRecord({
      status: 'running',
      classification: 'repo_side_rough_edge',
      blockerOwner: 'repo_side',
      responseSource: 'assistant_completion',
      remediationLaneId: 'andrea_runtime',
      remediationJobId: 'runtime-job-1',
      remediationRuntimePreference: 'codex_local',
      operatorNote: 'Saved for review.',
    });
    upsertResponseFeedback(record);

    const refreshed = await refreshResponseFeedbackRecordTruth(record, {
      runtimeStatusLookup: async () => 'failed',
    });

    expect(refreshed.status).toBe('failed');
    expect(refreshed.operatorNote).toContain(
      'failed before it produced a clean local hotfix',
    );
  });
});
