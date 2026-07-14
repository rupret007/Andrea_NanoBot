import { beforeEach, describe, expect, it } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  getResponseFeedback,
  listAssistantMetricEvents,
  updateResponseFeedback,
  upsertResponseFeedback,
} from './db.js';
import { buildAssistantIntelligenceReport } from './assistant-intelligence-report.js';
import {
  buildPendingPostDeliveryReflectionRefs,
  drainPostDeliveryReflections,
  reconcileInterruptedPostDeliveryReflections,
  schedulePostDeliveryReflection,
} from './post-delivery-reflection.js';
import type { PostTurnReflection } from './turn-agent-harness.js';
import type { ResponseFeedbackRecord } from './types.js';

function seedFeedback(
  overrides: Partial<ResponseFeedbackRecord> = {},
): ResponseFeedbackRecord {
  const record: ResponseFeedbackRecord = {
    feedbackId: 'feedback-post-delivery',
    createdAt: '2026-07-12T06:00:00.000Z',
    updatedAt: '2026-07-12T06:00:00.000Z',
    status: 'awaiting_confirmation',
    classification: 'repo_side_rough_edge',
    channel: 'bluebubbles',
    groupFolder: 'main',
    chatJid: 'bb:iMessage;-;+12025550101',
    threadId: null,
    platformMessageId: 'message-1',
    userMessageId: 'user-message-1',
    issueId: null,
    routeKey: 'bluebubbles_fluid_direct_reply',
    capabilityId: null,
    handlerKind: 'messages_fluidity',
    responseSource: 'local_companion',
    traceReason: 'handled a direct turn',
    traceNotes: [],
    blockerClass: null,
    blockerOwner: 'repo_side',
    originalUserText: '[private BlueBubbles request omitted]',
    assistantReplyText: '[private BlueBubbles response omitted]',
    linkedRefs: { postDeliveryReflectionState: 'pending' },
    remediationLaneId: null,
    remediationJobId: null,
    remediationRuntimePreference: null,
    remediationPrompt: null,
    operatorNote: 'saved before reflection',
    ...overrides,
  };
  upsertResponseFeedback(record);
  return record;
}

function completedReflection(): PostTurnReflection {
  return {
    routeUsed: 'bluebubbles_fluid_direct_reply',
    answerClass: 'handled',
    blockerClass: null,
    fallbackUsed: false,
    reflection: {
      taskLedgerId: 'task-ledger-1',
      progressLedgerId: 'progress-ledger-1',
      reflectionId: 'reflection-1',
      evaluationId: 'evaluation-1',
      traceGradeId: 'trace-grade-1',
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('post-delivery reflection', () => {
  beforeEach(() => _initTestDatabase());

  it('reconciles only pending work owned by a prior process generation', () => {
    seedFeedback({
      feedbackId: 'feedback-prior-process',
      linkedRefs: {
        postDeliveryReflectionState: 'pending',
        postDeliveryReflectionOwnerId: 'reflection-process:prior',
        postDeliveryReflectionStartedAt: '2026-07-12T05:59:00.000Z',
      },
    });
    seedFeedback({
      feedbackId: 'feedback-current-process',
      linkedRefs: buildPendingPostDeliveryReflectionRefs(
        new Date('2026-07-12T06:00:00.000Z'),
      ),
    });
    seedFeedback({
      feedbackId: 'feedback-complete',
      linkedRefs: { postDeliveryReflectionState: 'completed' },
    });

    expect(
      reconcileInterruptedPostDeliveryReflections({
        now: new Date('2026-07-12T06:01:00.000Z'),
      }),
    ).toMatchObject({ reconciled: 1, currentProcessSkipped: 1 });
    expect(
      getResponseFeedback('feedback-prior-process')?.linkedRefs,
    ).toMatchObject({
      postDeliveryReflectionState: 'failed',
      postDeliveryReflectionAt: '2026-07-12T06:01:00.000Z',
      postDeliveryReflectionErrorClass: 'interrupted_before_completion',
    });
    expect(
      getResponseFeedback('feedback-current-process')?.linkedRefs,
    ).toMatchObject({ postDeliveryReflectionState: 'pending' });
    expect(getResponseFeedback('feedback-complete')?.linkedRefs).toMatchObject({
      postDeliveryReflectionState: 'completed',
    });
    expect(
      buildAssistantIntelligenceReport({ groupFolder: 'main' })
        .postDeliveryReflection,
    ).toEqual({ pending: 1, completed: 1, failed: 1 });
  });

  it('runs after the delivery path yields and links completed evidence', async () => {
    seedFeedback();
    const pending = deferred<PostTurnReflection>();
    let reflectionStarted = false;
    let tick = 100;
    const scheduled = schedulePostDeliveryReflection({
      groupFolder: 'main',
      routeKey: 'bluebubbles_fluid_direct_reply',
      runOrigin: 'live',
      feedbackId: 'feedback-post-delivery',
      reflect: () => {
        reflectionStarted = true;
        return pending.promise;
      },
      clock: () => tick,
      now: () => new Date('2026-07-12T06:00:01.000Z'),
    });

    expect(reflectionStarted).toBe(false);
    expect(
      getResponseFeedback('feedback-post-delivery')?.linkedRefs,
    ).toMatchObject({ postDeliveryReflectionState: 'pending' });
    await Promise.resolve();
    expect(reflectionStarted).toBe(true);
    tick = 350;
    pending.resolve(completedReflection());
    await scheduled;

    expect(
      getResponseFeedback('feedback-post-delivery')?.linkedRefs,
    ).toMatchObject({
      postDeliveryReflectionState: 'completed',
      postDeliveryReflectionAt: '2026-07-12T06:00:01.000Z',
      platformReflectionId: 'reflection-1',
      platformEvaluationId: 'evaluation-1',
      platformTraceGradeId: 'trace-grade-1',
    });
    expect(listAssistantMetricEvents({ groupFolder: 'main' })).toEqual([
      expect.objectContaining({
        kind: 'latency_sample',
        value: 250,
        metadataJson: expect.stringContaining(
          '"latencyClass":"post_delivery_reflection"',
        ),
      }),
    ]);
  });

  it('merges evidence without overwriting a concurrent owner review', async () => {
    seedFeedback();
    const pending = deferred<PostTurnReflection>();
    const scheduled = schedulePostDeliveryReflection({
      groupFolder: 'main',
      routeKey: 'bluebubbles_fluid_direct_reply',
      runOrigin: 'live',
      feedbackId: 'feedback-post-delivery',
      reflect: () => pending.promise,
      now: () => new Date('2026-07-12T06:00:02.000Z'),
    });
    await Promise.resolve();
    updateResponseFeedback('feedback-post-delivery', {
      status: 'accepted',
      linkedRefs: {
        postDeliveryReflectionState: 'pending',
        cognitiveOwnerReviewSignalId: 'owner-review-1',
      },
    });
    pending.resolve(completedReflection());
    await scheduled;

    expect(getResponseFeedback('feedback-post-delivery')).toMatchObject({
      status: 'accepted',
      linkedRefs: {
        cognitiveOwnerReviewSignalId: 'owner-review-1',
        postDeliveryReflectionState: 'completed',
        platformReflectionId: 'reflection-1',
      },
    });
  });

  it('records a redacted failure state and never rejects the detached task', async () => {
    seedFeedback();
    const privateError =
      'private message content sk-example-should-not-persist';
    await expect(
      schedulePostDeliveryReflection({
        groupFolder: 'main',
        routeKey: 'bluebubbles_fluid_direct_reply',
        runOrigin: 'live',
        feedbackId: 'feedback-post-delivery',
        reflect: async () => {
          throw new Error(privateError);
        },
        clock: () => 500,
        now: () => new Date('2026-07-12T06:00:03.000Z'),
      }),
    ).resolves.toBeUndefined();

    const feedback = getResponseFeedback('feedback-post-delivery');
    expect(feedback?.linkedRefs).toMatchObject({
      postDeliveryReflectionState: 'failed',
      postDeliveryReflectionAt: '2026-07-12T06:00:03.000Z',
      postDeliveryReflectionErrorClass: 'Error',
    });
    const persisted = JSON.stringify({
      feedback,
      metrics: listAssistantMetricEvents({ groupFolder: 'main' }),
    });
    expect(persisted).not.toContain(privateError);
    expect(persisted).not.toContain('sk-example');
  });

  it('still resolves when storage closes before a detached failure settles', async () => {
    seedFeedback();
    const pending = deferred<PostTurnReflection>();
    const scheduled = schedulePostDeliveryReflection({
      groupFolder: 'main',
      routeKey: 'bluebubbles_fluid_direct_reply',
      runOrigin: 'live',
      feedbackId: 'feedback-post-delivery',
      reflect: () => pending.promise,
    });
    await Promise.resolve();
    _closeDatabase();
    pending.reject(new Error('reflection transport closed during shutdown'));
    await expect(scheduled).resolves.toBeUndefined();
  });

  it('drains active reflection tasks within the graceful-shutdown bound', async () => {
    const pending = deferred<PostTurnReflection>();
    const scheduled = schedulePostDeliveryReflection({
      groupFolder: 'main',
      routeKey: 'bluebubbles_fluid_direct_reply',
      runOrigin: 'live',
      reflect: () => pending.promise,
    });
    await Promise.resolve();
    const draining = drainPostDeliveryReflections(1_000);
    pending.resolve(completedReflection());
    await expect(draining).resolves.toEqual({
      attempted: 1,
      remaining: 0,
      timedOut: false,
    });
    await scheduled;
  });
});
