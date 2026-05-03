import { beforeEach, describe, expect, it } from 'vitest';

import {
  appendResponseFeedbackActionRows,
  appendResponseFeedbackInlineRow,
  buildResponseFeedbackActionId,
  buildResponseFeedbackActionRows,
  buildResponseFeedbackCaptureReply,
  buildResponseFeedbackRemediationPrompt,
  classifyResponseFeedbackCandidate,
  parseResponseFeedbackAction,
  refreshResponseFeedbackRecordTruth,
  resolvePendingResponseFeedbackApproval,
  selectResponseFeedbackLane,
  selectResponseFeedbackRetryLane,
  shouldCancelPendingContinuationForFeedback,
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
    expect(
      parseResponseFeedbackAction(
        'feedback:11111111-2222-3333-4444-555555555555:approve_local',
      ),
    ).toEqual({
      feedbackId: '11111111-2222-3333-4444-555555555555',
        operation: 'approve_local',
      });
    expect(
      parseResponseFeedbackAction(
        'feedback:11111111-2222-3333-4444-555555555555:approve_landing',
      ),
    ).toEqual({
      feedbackId: '11111111-2222-3333-4444-555555555555',
      operation: 'approve_landing',
    });
  });

  it('binds natural-language approval to the freshest pending cloud repair', () => {
    const older = buildRecord({
      feedbackId: '22222222-2222-3333-4444-555555555555',
      updatedAt: '2026-05-02T04:00:00.000Z',
      linkedRefs: { platformRepairPlanId: 'repair-plan-old' },
      remediationLaneId: 'andrea_runtime',
      remediationRuntimePreference: 'codex_cloud',
    });
    const newest = buildRecord({
      feedbackId: '33333333-2222-3333-4444-555555555555',
      updatedAt: '2026-05-02T04:10:00.000Z',
      linkedRefs: { platformRepairPlanId: 'repair-plan-new' },
      remediationLaneId: 'cursor',
      remediationRuntimePreference: 'cursor_cloud',
    });

    const result = resolvePendingResponseFeedbackApproval(
      'Ok you have my approval',
      [older, newest],
      { now: new Date('2026-05-02T04:12:00.000Z') },
    );

    expect(result.state).toBe('ready');
    expect(result.state === 'ready' ? result.action : null).toEqual({
      feedbackId: '33333333-2222-3333-4444-555555555555',
      operation: 'start',
    });
  });

  it('absorbs approval-utterance feedback into the prior pending repair', () => {
    const priorRepair = buildRecord({
      feedbackId: '22222222-2222-3333-4444-555555555555',
      originalUserText: 'Ok I want you to take that repo and improve your self',
      assistantReplyText: 'I staged a bounded repair plan.',
      updatedAt: '2026-05-02T04:08:00.000Z',
      linkedRefs: { platformRepairPlanId: 'repair-plan-prior' },
      remediationLaneId: 'cursor',
      remediationRuntimePreference: 'cursor_cloud',
    });
    const orphanApproval = buildRecord({
      feedbackId: '33333333-2222-3333-4444-555555555555',
      originalUserText: 'Ok you have my approval',
      assistantReplyText:
        'Thanks, Jeff. What would you like me to help you with next?',
      updatedAt: '2026-05-02T04:10:00.000Z',
      linkedRefs: { platformRepairPlanId: 'repair-plan-orphan' },
      remediationLaneId: 'cursor',
      remediationRuntimePreference: 'cursor_cloud',
    });

    const result = resolvePendingResponseFeedbackApproval(
      'do it',
      [orphanApproval, priorRepair],
      { now: new Date('2026-05-02T04:12:00.000Z') },
    );

    expect(result.state).toBe('ready');
    expect(result.state === 'ready' ? result.action : null).toEqual({
      feedbackId: '22222222-2222-3333-4444-555555555555',
      operation: 'start',
    });
    expect(
      result.state === 'ready' ? result.absorbedRecord?.feedbackId : null,
    ).toBe('33333333-2222-3333-4444-555555555555');
  });

  it('requires explicit local fallback wording before natural approval maps to approve_local', () => {
    const record = buildRecord({
      updatedAt: '2026-05-02T04:10:00.000Z',
      linkedRefs: { platformRepairPlanId: 'repair-plan-local' },
      remediationLaneId: 'andrea_runtime',
      remediationRuntimePreference: 'codex_local',
    });

    expect(
      resolvePendingResponseFeedbackApproval('do it', [record], {
        now: new Date('2026-05-02T04:12:00.000Z'),
      }),
    ).toMatchObject({
      state: 'ready',
      action: {
        feedbackId: '11111111-2222-3333-4444-555555555555',
        operation: 'start',
      },
    });
    expect(
      resolvePendingResponseFeedbackApproval(
        'approve local fallback',
        [record],
        {
          now: new Date('2026-05-02T04:12:00.000Z'),
        },
      ),
    ).toMatchObject({
      state: 'ready',
      action: {
        feedbackId: '11111111-2222-3333-4444-555555555555',
        operation: 'approve_local',
      },
    });
  });

  it('does not silently approve stale or external repair records', () => {
    expect(
      resolvePendingResponseFeedbackApproval(
        'start the repair',
        [
          buildRecord({
            updatedAt: '2026-05-01T00:00:00.000Z',
            linkedRefs: { platformRepairPlanId: 'repair-plan-stale' },
            remediationLaneId: 'cursor',
            remediationRuntimePreference: 'cursor_cloud',
          }),
        ],
        {
          now: new Date('2026-05-02T04:12:00.000Z'),
          maxAgeMs: 60 * 60 * 1000,
        },
      ).state,
    ).toBe('stale');
    expect(
      resolvePendingResponseFeedbackApproval(
        'you have my approval',
        [
          buildRecord({
            classification: 'externally_blocked',
            blockerOwner: 'external',
            linkedRefs: { platformRepairPlanId: 'repair-plan-external' },
            remediationLaneId: 'cursor',
            remediationRuntimePreference: 'cursor_cloud',
          }),
        ],
        { now: new Date('2026-05-02T04:12:00.000Z') },
      ).state,
    ).toBe('not_found');
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
          actionId: 'feedback:11111111-2222-3333-4444-555555555555:capture',
        },
      ],
    ]);
  });

  it('marks pending calendar create continuations as unsafe after a downvote', () => {
    expect(
      shouldCancelPendingContinuationForFeedback(
        buildRecord({
          routeKey: 'google_calendar.create_event',
          capabilityId: 'calendar.google_create',
          handlerKind: 'google_calendar_create_local',
        }),
      ),
    ).toBe(true);
    expect(
      shouldCancelPendingContinuationForFeedback(
        buildRecord({
          routeKey: 'communication.open_loops',
          capabilityId: 'communication.open_loops',
          handlerKind: 'assistant_capability',
        }),
      ),
    ).toBe(false);
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
          label: 'Approve landing',
          actionId:
            'feedback:11111111-2222-3333-4444-555555555555:approve_landing',
        },
      ],
      [
        {
          label: 'Commit + push',
          actionId: 'feedback:11111111-2222-3333-4444-555555555555:commit_push',
        },
        {
          label: 'Commit only',
          actionId: 'feedback:11111111-2222-3333-4444-555555555555:commit_only',
        },
      ],
      [
        {
          label: 'Keep local',
          actionId: 'feedback:11111111-2222-3333-4444-555555555555:keep_local',
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

  it('requires an explicit local-fallback approval action for codex local repairs', () => {
    const rows = buildResponseFeedbackActionRows(
      buildRecord({
        status: 'awaiting_confirmation',
        remediationLaneId: 'andrea_runtime',
        remediationRuntimePreference: 'codex_local',
        linkedRefs: {
          platformRepairPlanId: 'repair-plan-1',
          repairFallbackPolicy:
            'cloud_unavailable_explicit_local_fallback_required',
        },
      }),
    );

    expect(rows?.[0]?.[0]).toEqual({
      label: 'Approve local fallback',
      actionId: 'feedback:11111111-2222-3333-4444-555555555555:approve_local',
    });
    expect(rows?.[0]?.map((action) => action.actionId)).not.toContain(
      'feedback:11111111-2222-3333-4444-555555555555:start',
    );
  });

  it('renders a bounded approval card once a repair plan is staged', () => {
    const reply = buildResponseFeedbackCaptureReply(
      buildRecord({
        status: 'awaiting_confirmation',
        classification: 'repo_side_rough_edge',
        remediationLaneId: 'cursor',
        remediationRuntimePreference: 'cursor_cloud',
        linkedRefs: {
          platformRepairPlanId: 'repair-plan-1',
          repairApprovalScope: 'feedback:111; repo:Andrea_NanoBot',
        },
      }),
      'Platform staged the repair plan.',
    );

    expect(reply).toContain('staged a bounded repair plan');
    expect(reply).toContain('Selected lane: Cursor Cloud');
    expect(reply).toContain('One approval is scoped');
    expect(reply).toContain('no secrets or external-account changes');
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
          label: 'Approve landing',
          actionId:
            'feedback:11111111-2222-3333-4444-555555555555:approve_landing',
        },
      ],
      [
        {
          label: 'Commit + push',
          actionId: 'feedback:11111111-2222-3333-4444-555555555555:commit_push',
        },
        {
          label: 'Commit only',
          actionId: 'feedback:11111111-2222-3333-4444-555555555555:commit_only',
        },
      ],
      [
        {
          label: 'Keep local',
          actionId: 'feedback:11111111-2222-3333-4444-555555555555:keep_local',
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
      assistantReplyText:
        'Please import the interaction model and Build Model.',
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
      assistantReplyText:
        'Image generation is blocked by provider quota right now.',
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

  it('prefers cloud repair lanes before falling back to codex local, and never auto-selects cursor desktop', () => {
    expect(
      selectResponseFeedbackLane({
        runtimeAvailable: true,
        runtimeLocalPreferred: true,
        runtimeCloudAllowed: true,
        cursorCloudAvailable: true,
        cursorDesktopAvailable: true,
      }).runtimePreference,
    ).toBe('cursor_cloud');

    expect(
      selectResponseFeedbackLane({
        runtimeAvailable: true,
        runtimeLocalPreferred: false,
        runtimeCloudAllowed: true,
        cursorCloudAvailable: true,
        cursorDesktopAvailable: true,
      }).runtimePreference,
    ).toBe('cursor_cloud');

    expect(
      selectResponseFeedbackLane({
        runtimeAvailable: true,
        runtimeLocalPreferred: false,
        runtimeCloudAllowed: true,
        cursorCloudAvailable: false,
        cursorDesktopAvailable: true,
      }).runtimePreference,
    ).toBe('codex_cloud');

    expect(
      selectResponseFeedbackLane({
        runtimeAvailable: true,
        runtimeLocalPreferred: true,
        runtimeCloudAllowed: false,
        cursorCloudAvailable: false,
        cursorDesktopAvailable: true,
      }).runtimePreference,
    ).toBe('codex_local');

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

  it('keeps retries on the healthiest cloud repair lane after a codex-local failure', () => {
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

    expect(selection.laneId).toBe('cursor');
    expect(selection.runtimePreference).toBe('cursor_cloud');
    expect(selection.label).toBe('Cursor Cloud');

    const noCursorSelection = selectResponseFeedbackRetryLane({
      record: buildRecord({
        status: 'failed',
        remediationRuntimePreference: 'codex_local',
      }),
      availability: {
        runtimeAvailable: true,
        runtimeLocalPreferred: true,
        runtimeCloudAllowed: true,
        cursorCloudAvailable: false,
        cursorDesktopAvailable: false,
      },
    });

    expect(noCursorSelection.laneId).toBe('andrea_runtime');
    expect(noCursorSelection.runtimePreference).toBe('codex_cloud');
    expect(noCursorSelection.label).toBe('Codex cloud');
  });

  it('builds a remediation prompt with the ask, validation, and approval-scoped landing rules', () => {
    const prompt = buildResponseFeedbackRemediationPrompt({
      record: buildRecord({
        classification: 'repo_side_broken',
        responseSource: 'assistant_completion',
        blockerClass: null,
        blockerOwner: 'repo_side',
        linkedRefs: {
          repairApprovalScope:
            'feedback:111; repos:Andrea_NanoBot; landing:commit_push_restart',
          repairFallbackPolicy:
            'cloud_preferred_no_local_fallback_without_new_approval',
        },
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
    expect(prompt).toContain('Repair approval scope: feedback:111');
    expect(prompt).toContain(
      'Fallback policy: cloud_preferred_no_local_fallback_without_new_approval',
    );
    expect(prompt).toContain('Commit, push, restart, or deploy only when');
    expect(prompt).toContain('restart with npm run services:restart');
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

  it('refreshes a stale awaiting-confirmation remediation record to failed when the linked task already died', async () => {
    const record = buildRecord({
      status: 'awaiting_confirmation',
      classification: 'repo_side_rough_edge',
      blockerOwner: 'repo_side',
      responseSource: 'assistant_completion',
      remediationLaneId: 'andrea_runtime',
      remediationJobId: 'runtime-job-stale-failed',
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

  it('keeps a succeeded remediation in review when no new local hotfix exists yet', async () => {
    const record = buildRecord({
      status: 'running',
      classification: 'repo_side_rough_edge',
      blockerOwner: 'repo_side',
      responseSource: 'assistant_completion',
      remediationLaneId: 'cursor',
      remediationJobId: 'cursor-job-2',
      remediationRuntimePreference: 'cursor_cloud',
      operatorNote: 'Saved for review.',
    });
    upsertResponseFeedback(record);

    const refreshed = await refreshResponseFeedbackRecordTruth(record, {
      cursorStatusLookup: () => 'succeeded',
      localHotfixReadyCheck: () => false,
    });

    expect(refreshed.status).toBe('captured');
    expect(refreshed.operatorNote).toContain(
      'do not see a new local hotfix on this host yet',
    );
  });

  it('keeps a succeeded runtime remediation in review because the runtime lane is read-only', async () => {
    const record = buildRecord({
      status: 'running',
      classification: 'repo_side_rough_edge',
      blockerOwner: 'repo_side',
      responseSource: 'assistant_completion',
      remediationLaneId: 'andrea_runtime',
      remediationJobId: 'runtime-job-readonly',
      remediationRuntimePreference: 'codex_cloud',
      operatorNote: 'Saved for review.',
    });
    upsertResponseFeedback(record);

    const refreshed = await refreshResponseFeedbackRecordTruth(record, {
      runtimeStatusLookup: async () => 'succeeded',
      localHotfixReadyCheck: () => true,
    });

    expect(refreshed.status).toBe('captured');
    expect(refreshed.operatorNote).toContain(
      'runtime lane is read-only on this host',
    );
  });
});
