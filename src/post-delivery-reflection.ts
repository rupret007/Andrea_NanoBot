import { randomUUID } from 'node:crypto';

import {
  getResponseFeedback,
  listRecentResponseFeedback,
  updateResponseFeedback,
} from './db.js';
import { logger } from './logger.js';
import { recordAssistantMetric } from './personal-assistant-metrics.js';
import type { CognitiveRunOrigin } from './types.js';
import type { PostTurnReflection } from './turn-agent-harness.js';

const REFLECTION_PROCESS_ID = `reflection-process:${randomUUID()}`;
const activeReflections = new Set<Promise<void>>();

function safeErrorClass(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  const normalized = name.replace(/[^a-z0-9_.-]/gi, '').slice(0, 80);
  return normalized || 'unknown_error';
}

export interface PostDeliveryReflectionSchedule {
  groupFolder: string;
  routeKey: string;
  runOrigin: CognitiveRunOrigin;
  feedbackId?: string | null;
  reflect: () => Promise<PostTurnReflection>;
  clock?: () => number;
  now?: () => Date;
}

export interface PostDeliveryReflectionDrainResult {
  attempted: number;
  remaining: number;
  timedOut: boolean;
}

export interface InterruptedReflectionReconciliation {
  inspected: number;
  reconciled: number;
  currentProcessSkipped: number;
}

export function buildPendingPostDeliveryReflectionRefs(startedAt: Date): {
  postDeliveryReflectionState: 'pending';
  postDeliveryReflectionOwnerId: string;
  postDeliveryReflectionStartedAt: string;
} {
  return {
    postDeliveryReflectionState: 'pending',
    postDeliveryReflectionOwnerId: REFLECTION_PROCESS_ID,
    postDeliveryReflectionStartedAt: startedAt.toISOString(),
  };
}

export function reconcileInterruptedPostDeliveryReflections(
  params: {
    now?: Date;
    limit?: number;
  } = {},
): InterruptedReflectionReconciliation {
  const now = params.now || new Date();
  const records = listRecentResponseFeedback({
    limit: Math.max(1, Math.min(params.limit || 2_000, 10_000)),
  });
  let reconciled = 0;
  let currentProcessSkipped = 0;
  for (const record of records) {
    const refs = record.linkedRefs || {};
    if (refs.postDeliveryReflectionState !== 'pending') continue;
    if (refs.postDeliveryReflectionOwnerId === REFLECTION_PROCESS_ID) {
      currentProcessSkipped += 1;
      continue;
    }
    updateResponseFeedback(record.feedbackId, {
      linkedRefs: {
        ...refs,
        postDeliveryReflectionState: 'failed',
        postDeliveryReflectionAt: now.toISOString(),
        postDeliveryReflectionErrorClass: 'interrupted_before_completion',
      },
    });
    reconciled += 1;
  }
  return {
    inspected: records.length,
    reconciled,
    currentProcessSkipped,
  };
}

export async function drainPostDeliveryReflections(
  timeoutMs = 5_000,
): Promise<PostDeliveryReflectionDrainResult> {
  const pending = [...activeReflections];
  if (pending.length === 0) {
    return { attempted: 0, remaining: 0, timedOut: false };
  }
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timedOut = await Promise.race([
    Promise.allSettled(pending).then(() => false),
    new Promise<true>((resolve) => {
      timeout = setTimeout(resolve, Math.max(1, timeoutMs), true);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  return {
    attempted: pending.length,
    remaining: activeReflections.size,
    timedOut,
  };
}

/**
 * Runs learning/verification after the user-facing reply has been delivered.
 * The returned promise always resolves: failures are persisted as bounded
 * metadata and logged, so callers may intentionally detach it without creating
 * an unhandled rejection or silently losing verification state.
 */
export function schedulePostDeliveryReflection(
  schedule: PostDeliveryReflectionSchedule,
): Promise<void> {
  const clock = schedule.clock || Date.now;
  const now = schedule.now || (() => new Date());
  const startedAt = clock();

  const task = Promise.resolve()
    .then(schedule.reflect)
    .then((result) => {
      const completedAt = now().toISOString();
      if (schedule.feedbackId) {
        const current = getResponseFeedback(schedule.feedbackId);
        if (current) {
          const reflection = result.reflection;
          updateResponseFeedback(schedule.feedbackId, {
            linkedRefs: {
              ...(current.linkedRefs || {}),
              postDeliveryReflectionState: 'completed',
              postDeliveryReflectionAt: completedAt,
              postDeliveryReflectionErrorClass: undefined,
              platformTaskLedgerId:
                reflection?.taskLedgerId ||
                current.linkedRefs.platformTaskLedgerId,
              platformProgressLedgerId:
                reflection?.progressLedgerId ||
                current.linkedRefs.platformProgressLedgerId,
              platformReflectionId:
                reflection?.reflectionId ||
                current.linkedRefs.platformReflectionId,
              platformEvaluationId:
                reflection?.evaluationId ||
                current.linkedRefs.platformEvaluationId,
              platformTraceGradeId:
                reflection?.traceGradeId ||
                current.linkedRefs.platformTraceGradeId,
            },
          });
        }
      }
      recordAssistantMetric({
        groupFolder: schedule.groupFolder,
        kind: 'latency_sample',
        value: Math.max(0, clock() - startedAt),
        metadata: {
          latencyClass: 'post_delivery_reflection',
          runOrigin: schedule.runOrigin,
          routeKey: schedule.routeKey,
          outcome: 'completed',
        },
        now: new Date(completedAt),
      });
    })
    .catch((error: unknown) => {
      const failedAt = now().toISOString();
      const errorClass = safeErrorClass(error);
      try {
        recordAssistantMetric({
          groupFolder: schedule.groupFolder,
          kind: 'latency_sample',
          value: Math.max(0, clock() - startedAt),
          metadata: {
            latencyClass: 'post_delivery_reflection',
            runOrigin: schedule.runOrigin,
            routeKey: schedule.routeKey,
            outcome: 'failed',
            errorClass,
          },
          now: new Date(failedAt),
        });
        if (schedule.feedbackId) {
          const current = getResponseFeedback(schedule.feedbackId);
          if (current) {
            updateResponseFeedback(schedule.feedbackId, {
              linkedRefs: {
                ...(current.linkedRefs || {}),
                postDeliveryReflectionState: 'failed',
                postDeliveryReflectionAt: failedAt,
                postDeliveryReflectionErrorClass: errorClass,
              },
            });
          }
        }
      } catch (persistenceError) {
        logger.error(
          {
            component: 'post_delivery_reflection',
            feedbackId: schedule.feedbackId || null,
            routeKey: schedule.routeKey,
            persistenceErrorClass: safeErrorClass(persistenceError),
          },
          'Post-delivery reflection failure metadata could not be persisted.',
        );
      }
      logger.error(
        {
          component: 'post_delivery_reflection',
          feedbackId: schedule.feedbackId || null,
          routeKey: schedule.routeKey,
          runOrigin: schedule.runOrigin,
          errorClass,
        },
        'Post-delivery reflection failed after the reply was delivered.',
      );
    });
  activeReflections.add(task);
  void task.finally(() => activeReflections.delete(task));
  return task;
}
