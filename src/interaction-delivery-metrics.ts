import os from 'node:os';

import { recordAssistantMetric } from './personal-assistant-metrics.js';

export type InteractionLatencyTargetClass =
  | 'local_command'
  | 'ordinary_response';

export type InteractionRunOrigin = 'synthetic' | 'replay' | 'live';

export type HostPressureClass = 'normal' | 'elevated' | 'high' | 'unknown';

export interface HostPressureSnapshot {
  pressureClass: HostPressureClass;
  load1mPerCpu?: number;
  freeMemoryRatio?: number;
}

export interface InteractionDeliveryMetricContext {
  groupFolder: string;
  routeKey: string;
  channel: string;
  responseSource: string;
  handlerKind: string;
  capabilityId: string;
  providerId?: string;
  modelId?: string;
  endpointMode?: string;
  routingProviderId?: string;
  routingModelId?: string;
  routingEndpointMode?: string;
  toolClass?: string;
  turnId: string;
  deliveryOrdinal: number;
  runOrigin: InteractionRunOrigin;
  latencyTargetClass: InteractionLatencyTargetClass;
  turnStartedAtMs: number;
  turnDequeuedAtMs?: number;
  harnessStartedAtMs: number;
  harnessCompletedAtMs: number;
  harnessBypassed?: boolean;
  hostPressure?: HostPressureSnapshot;
}

export interface InteractionDeliveryStages {
  queueWaitMs: number;
  preprocessingMs: number;
  harnessMs: number;
  responsePreparationMs: number;
  channelDeliveryMs: number;
  slowStage:
    | 'queue_wait'
    | 'request_preprocessing'
    | 'turn_harness'
    | 'response_preparation'
    | 'channel_delivery';
}

export interface DeliveredAssistantReply<T> {
  result: T;
  deliveryOutcome: 'confirmed' | 'partial' | 'unknown';
  deliveredAtMs: number;
  latencyMs: number;
  stages: InteractionDeliveryStages;
  metricRecorded: boolean;
  metricSkipped: boolean;
  deliveryCommitSucceeded: boolean;
  timingValid: boolean;
}

export interface InteractionDeliveryClassification {
  outcome: 'confirmed' | 'partial' | 'unknown' | 'rejected';
  confirmedReceiptCount?: number;
  nextUnconfirmedChunkIndex?: number;
}

/**
 * Stops the current workflow after an input cursor has been committed for an
 * incomplete or transport-ambiguous primary reply. The fixed message and
 * bounded fields are safe to log; channel payloads and provider errors are
 * deliberately excluded.
 */
export class CommittedIncompleteDeliveryError extends Error {
  readonly deliveryOutcome: 'partial' | 'unknown';
  readonly confirmedReceiptCount: number;
  readonly nextUnconfirmedChunkIndex?: number;

  constructor(params: {
    deliveryOutcome: 'partial' | 'unknown';
    confirmedReceiptCount?: number;
    nextUnconfirmedChunkIndex?: number;
  }) {
    super('Assistant reply delivery was incomplete or uncertain.');
    this.name = 'CommittedIncompleteDeliveryError';
    this.deliveryOutcome = params.deliveryOutcome;
    this.confirmedReceiptCount = Math.max(
      0,
      Math.floor(params.confirmedReceiptCount || 0),
    );
    this.nextUnconfirmedChunkIndex = params.nextUnconfirmedChunkIndex;
  }
}

export function isCommittedIncompleteDeliveryError(
  error: unknown,
): error is CommittedIncompleteDeliveryError {
  return error instanceof CommittedIncompleteDeliveryError;
}

type MetricRecorder = typeof recordAssistantMetric;

function notifyWithoutThrowing(
  observer: ((error: unknown) => void) | undefined,
  error: unknown,
): void {
  try {
    observer?.(error);
  } catch {
    // Observability must never turn an already delivered reply into a retry.
  }
}

function elapsed(startedAtMs: number, completedAtMs: number): number {
  return Math.max(0, completedAtMs - startedAtMs);
}

function roundedRatio(numerator: number, denominator: number): number {
  return Number((numerator / denominator).toFixed(3));
}

export function captureHostPressureSnapshot(
  params: {
    load1m?: number;
    cpuCount?: number;
    freeMemoryBytes?: number;
    totalMemoryBytes?: number;
  } = {},
): HostPressureSnapshot {
  const load1m = params.load1m ?? os.loadavg()[0];
  const cpuCount = params.cpuCount ?? os.cpus().length;
  const freeMemoryBytes = params.freeMemoryBytes ?? os.freemem();
  const totalMemoryBytes = params.totalMemoryBytes ?? os.totalmem();
  const load1mPerCpu =
    Number.isFinite(load1m) && Number.isFinite(cpuCount) && cpuCount > 0
      ? roundedRatio(Math.max(0, load1m), cpuCount)
      : undefined;
  const freeMemoryRatio =
    Number.isFinite(freeMemoryBytes) &&
    Number.isFinite(totalMemoryBytes) &&
    totalMemoryBytes > 0
      ? roundedRatio(
          Math.max(0, Math.min(freeMemoryBytes, totalMemoryBytes)),
          totalMemoryBytes,
        )
      : undefined;
  const pressureClass: HostPressureClass =
    load1mPerCpu === undefined && freeMemoryRatio === undefined
      ? 'unknown'
      : (load1mPerCpu ?? 0) >= 1 || (freeMemoryRatio ?? 1) <= 0.05
        ? 'high'
        : (load1mPerCpu ?? 0) >= 0.75 || (freeMemoryRatio ?? 1) <= 0.1
          ? 'elevated'
          : 'normal';
  return {
    pressureClass,
    ...(load1mPerCpu === undefined ? {} : { load1mPerCpu }),
    ...(freeMemoryRatio === undefined ? {} : { freeMemoryRatio }),
  };
}

export function resolveInteractionTurnStartedAtMs(params: {
  inboundTimestamps: Array<string | null | undefined>;
  dequeuedAtMs: number;
}): number {
  const dequeuedAtMs = Number.isFinite(params.dequeuedAtMs)
    ? params.dequeuedAtMs
    : Date.now();
  const valid = params.inboundTimestamps
    .map((timestamp) => Date.parse(timestamp || ''))
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp >= 0)
    .map((timestamp) => Math.min(timestamp, dequeuedAtMs));
  return valid.length > 0 ? Math.min(...valid) : dequeuedAtMs;
}

function slowestStage(
  stages: Omit<InteractionDeliveryStages, 'slowStage'>,
): InteractionDeliveryStages['slowStage'] {
  const entries: Array<
    readonly [InteractionDeliveryStages['slowStage'], number]
  > = [
    ['queue_wait', stages.queueWaitMs],
    ['request_preprocessing', stages.preprocessingMs],
    ['turn_harness', stages.harnessMs],
    ['response_preparation', stages.responsePreparationMs],
    ['channel_delivery', stages.channelDeliveryMs],
  ];
  return entries.sort((left, right) => right[1] - left[1])[0][0];
}

export async function runPostDeliveryEnrichment(params: {
  run: () => void | Promise<void>;
  onError: (error: unknown) => void;
}): Promise<boolean> {
  try {
    await params.run();
    return true;
  } catch (error) {
    notifyWithoutThrowing(params.onError, error);
    return false;
  }
}

/**
 * Executes the real channel send and records delivery latency only after the
 * send resolves successfully. Callers must classify the target explicitly so
 * local commands are never inferred from incidental timing data.
 */
export async function deliverAssistantReplyWithMetric<T>(params: {
  context: InteractionDeliveryMetricContext;
  send: () => Promise<T>;
  onMetricError: (error: unknown) => void;
  onDelivered?: () => void;
  onDeliveryCommitError?: (error: unknown) => void;
  validateDelivery?: (result: T) => boolean;
  classifyDelivery?: (result: T) => InteractionDeliveryClassification;
  recordMetricEnabled?: boolean;
  nowMs?: () => number;
  recordMetric?: MetricRecorder;
}): Promise<DeliveredAssistantReply<T>> {
  const nowMs = params.nowMs || Date.now;
  const recordMetric = params.recordMetric || recordAssistantMetric;
  const channelDeliveryStartedAtMs = nowMs();
  const result = await params.send();
  const deliveryClassification = params.classifyDelivery?.(result) || {
    outcome:
      !params.validateDelivery || params.validateDelivery(result)
        ? 'confirmed'
        : 'rejected',
  };
  if (deliveryClassification.outcome === 'rejected') {
    throw new Error('Channel delivery did not return a confirmed receipt.');
  }
  const deliveryOutcome = deliveryClassification.outcome;
  const deliveredAtMs = nowMs();
  let deliveryCommitSucceeded = true;
  try {
    params.onDelivered?.();
  } catch (error) {
    deliveryCommitSucceeded = false;
    notifyWithoutThrowing(params.onDeliveryCommitError, error);
  }
  const turnDequeuedAtMs = Number.isFinite(params.context.turnDequeuedAtMs)
    ? Number(params.context.turnDequeuedAtMs)
    : params.context.turnStartedAtMs;
  const effectiveHarnessCompletedAtMs = params.context.harnessBypassed
    ? params.context.harnessStartedAtMs
    : params.context.harnessCompletedAtMs;
  const baseStages = {
    queueWaitMs: elapsed(params.context.turnStartedAtMs, turnDequeuedAtMs),
    preprocessingMs: elapsed(
      turnDequeuedAtMs,
      params.context.harnessStartedAtMs,
    ),
    harnessMs: elapsed(
      params.context.harnessStartedAtMs,
      effectiveHarnessCompletedAtMs,
    ),
    responsePreparationMs: elapsed(
      effectiveHarnessCompletedAtMs,
      channelDeliveryStartedAtMs,
    ),
    channelDeliveryMs: elapsed(channelDeliveryStartedAtMs, deliveredAtMs),
  };
  const stages: InteractionDeliveryStages = {
    ...baseStages,
    slowStage: slowestStage(baseStages),
  };
  const latencyMs = elapsed(params.context.turnStartedAtMs, deliveredAtMs);
  const boundaries = [
    params.context.turnStartedAtMs,
    turnDequeuedAtMs,
    params.context.harnessStartedAtMs,
    effectiveHarnessCompletedAtMs,
    channelDeliveryStartedAtMs,
    deliveredAtMs,
  ];
  const stageTotal =
    stages.queueWaitMs +
    stages.preprocessingMs +
    stages.harnessMs +
    stages.responsePreparationMs +
    stages.channelDeliveryMs;
  const timingValid =
    boundaries.every(Number.isFinite) &&
    boundaries.every(
      (value, index) => index === 0 || value >= boundaries[index - 1]!,
    ) &&
    Math.abs(stageTotal - latencyMs) <= 1;

  const metricSkipped = params.recordMetricEnabled === false;
  let metricRecorded = false;
  if (!timingValid) {
    notifyWithoutThrowing(
      params.onMetricError,
      new Error(
        'Interaction delivery timing boundaries were invalid; latency evidence was omitted.',
      ),
    );
  } else if (!metricSkipped) {
    try {
      recordMetric({
        groupFolder: params.context.groupFolder,
        kind: 'latency_sample',
        value: latencyMs,
        metadata: {
          latencyClass:
            deliveryOutcome === 'confirmed'
              ? 'interaction_delivery'
              : 'interaction_delivery_degraded',
          deliveryOutcome,
          ...(deliveryClassification.confirmedReceiptCount === undefined
            ? {}
            : {
                confirmedReceiptCount: Math.max(
                  0,
                  Math.floor(deliveryClassification.confirmedReceiptCount),
                ),
              }),
          ...(deliveryClassification.nextUnconfirmedChunkIndex === undefined
            ? {}
            : {
                nextUnconfirmedChunkIndex: Math.max(
                  0,
                  Math.floor(deliveryClassification.nextUnconfirmedChunkIndex),
                ),
              }),
          runOrigin: params.context.runOrigin,
          routeKey: params.context.routeKey,
          channel: params.context.channel,
          responseSource: params.context.responseSource,
          handlerKind: params.context.handlerKind,
          capabilityId: params.context.capabilityId,
          providerId: (params.context.providerId || 'unknown').slice(0, 120),
          ...(params.context.modelId
            ? { modelId: params.context.modelId.slice(0, 160) }
            : {}),
          ...(params.context.endpointMode
            ? { endpointMode: params.context.endpointMode.slice(0, 80) }
            : {}),
          ...(params.context.routingProviderId
            ? {
                routingProviderId: params.context.routingProviderId.slice(
                  0,
                  120,
                ),
              }
            : {}),
          ...(params.context.routingModelId
            ? { routingModelId: params.context.routingModelId.slice(0, 160) }
            : {}),
          ...(params.context.routingEndpointMode
            ? {
                routingEndpointMode: params.context.routingEndpointMode.slice(
                  0,
                  80,
                ),
              }
            : {}),
          toolClass: (
            params.context.toolClass ||
            params.context.capabilityId ||
            'unknown'
          ).slice(0, 120),
          turnId: params.context.turnId,
          deliveryOrdinal: params.context.deliveryOrdinal,
          queueWaitMs: stages.queueWaitMs,
          preprocessingMs: stages.preprocessingMs,
          harnessMs: stages.harnessMs,
          responsePreparationMs: stages.responsePreparationMs,
          channelDeliveryMs: stages.channelDeliveryMs,
          slowStage: stages.slowStage,
          deliveryInstrumentationVersion: 3,
          latencyTargetClass: params.context.latencyTargetClass,
          hostPressureClass:
            params.context.hostPressure?.pressureClass || 'unknown',
          ...(params.context.hostPressure?.load1mPerCpu === undefined
            ? {}
            : {
                hostLoad1mPerCpu: params.context.hostPressure.load1mPerCpu,
              }),
          ...(params.context.hostPressure?.freeMemoryRatio === undefined
            ? {}
            : {
                hostFreeMemoryRatio:
                  params.context.hostPressure.freeMemoryRatio,
              }),
        },
        now: new Date(deliveredAtMs),
      });
      metricRecorded = true;
    } catch (error) {
      notifyWithoutThrowing(params.onMetricError, error);
    }
  }

  return {
    result,
    deliveryOutcome,
    deliveredAtMs,
    latencyMs,
    stages,
    metricRecorded,
    metricSkipped,
    deliveryCommitSucceeded,
    timingValid,
  };
}
