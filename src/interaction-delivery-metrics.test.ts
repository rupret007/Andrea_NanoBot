import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  listAssistantMetricEvents,
} from './db.js';
import {
  captureHostPressureSnapshot,
  CommittedIncompleteDeliveryError,
  deliverAssistantReplyWithMetric,
  isCommittedIncompleteDeliveryError,
  resolveInteractionTurnStartedAtMs,
  runPostDeliveryEnrichment,
} from './interaction-delivery-metrics.js';
import { InFlightTurnCursorRegistry } from './in-flight-turn-cursors.js';

function metadataFor(groupFolder: string): Record<string, unknown> {
  const [event] = listAssistantMetricEvents({ groupFolder });
  return JSON.parse(event?.metadataJson || '{}') as Record<string, unknown>;
}

describe('assistant interaction delivery metrics', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('represents a committed incomplete reply with bounded retry-safe metadata', () => {
    const error = new CommittedIncompleteDeliveryError({
      deliveryOutcome: 'partial',
      confirmedReceiptCount: 1,
      nextUnconfirmedChunkIndex: 1,
    });

    expect(isCommittedIncompleteDeliveryError(error)).toBe(true);
    expect(isCommittedIncompleteDeliveryError(new Error('other'))).toBe(false);
    expect(error).toMatchObject({
      name: 'CommittedIncompleteDeliveryError',
      message: 'Assistant reply delivery was incomplete or uncertain.',
      deliveryOutcome: 'partial',
      confirmedReceiptCount: 1,
      nextUnconfirmedChunkIndex: 1,
    });
  });

  it('persists an explicitly classified non-review local command only after delivery', async () => {
    let resolveSend!: (value: { platformMessageId: string }) => void;
    const send = new Promise<{ platformMessageId: string }>((resolve) => {
      resolveSend = resolve;
    });
    const times = [1_300, 1_500];
    const delivery = deliverAssistantReplyWithMetric({
      context: {
        groupFolder: 'main',
        routeKey: 'integrations.doctor',
        channel: 'telegram',
        responseSource: 'local_control',
        handlerKind: 'local_integration_doctor',
        capabilityId: 'integrations.status',
        providerId: 'local_runtime',
        toolClass: 'integration_doctor',
        turnId: 'turn-local-1',
        deliveryOrdinal: 1,
        runOrigin: 'live',
        latencyTargetClass: 'local_command',
        turnStartedAtMs: 900,
        turnDequeuedAtMs: 950,
        harnessStartedAtMs: 1_000,
        harnessCompletedAtMs: 1_100,
        hostPressure: {
          pressureClass: 'high',
          load1mPerCpu: 2.4,
          freeMemoryRatio: 0.02,
        },
      },
      send: () => send,
      onMetricError: () => undefined,
      nowMs: () => times.shift() as number,
    });

    expect(listAssistantMetricEvents({ groupFolder: 'main' })).toEqual([]);
    resolveSend({ platformMessageId: 'message-1' });

    await expect(delivery).resolves.toMatchObject({
      result: { platformMessageId: 'message-1' },
      deliveredAtMs: 1_500,
      latencyMs: 600,
      metricRecorded: true,
      stages: {
        queueWaitMs: 50,
        preprocessingMs: 50,
        harnessMs: 100,
        responsePreparationMs: 200,
        channelDeliveryMs: 200,
        slowStage: 'response_preparation',
      },
    });
    const [event] = listAssistantMetricEvents({ groupFolder: 'main' });
    expect(event).toMatchObject({
      groupFolder: 'main',
      kind: 'latency_sample',
      value: 600,
      createdAt: '1970-01-01T00:00:01.500Z',
    });
    expect(metadataFor('main')).toEqual({
      latencyClass: 'interaction_delivery',
      deliveryOutcome: 'confirmed',
      runOrigin: 'live',
      routeKey: 'integrations.doctor',
      channel: 'telegram',
      responseSource: 'local_control',
      handlerKind: 'local_integration_doctor',
      capabilityId: 'integrations.status',
      providerId: 'local_runtime',
      toolClass: 'integration_doctor',
      turnId: 'turn-local-1',
      deliveryOrdinal: 1,
      queueWaitMs: 50,
      preprocessingMs: 50,
      harnessMs: 100,
      responsePreparationMs: 200,
      channelDeliveryMs: 200,
      slowStage: 'response_preparation',
      deliveryInstrumentationVersion: 3,
      latencyTargetClass: 'local_command',
      hostPressureClass: 'high',
      hostLoad1mPerCpu: 2.4,
      hostFreeMemoryRatio: 0.02,
    });
  });

  it('records an ordinary response with a bypassed harness as an explicit target', async () => {
    const times = [2_200, 2_260];
    await deliverAssistantReplyWithMetric({
      context: {
        groupFolder: 'ordinary',
        routeKey: 'direct_assistant',
        channel: 'bluebubbles',
        responseSource: 'container_agent',
        handlerKind: 'agent_response',
        capabilityId: 'general_assistance',
        providerId: 'claude',
        modelId: 'claude-test-model',
        endpointMode: 'anthropic_messages',
        routingProviderId: 'openai_cloud',
        routingModelId: 'gpt-router-test',
        routingEndpointMode: 'direct_openai',
        toolClass: 'container_agent',
        turnId: 'turn-ordinary-1',
        deliveryOrdinal: 1,
        runOrigin: 'replay',
        latencyTargetClass: 'ordinary_response',
        turnStartedAtMs: 2_000,
        harnessStartedAtMs: 2_000,
        harnessCompletedAtMs: 2_150,
        harnessBypassed: true,
      },
      send: async () => ({ platformMessageId: 'message-2' }),
      onMetricError: () => undefined,
      nowMs: () => times.shift() as number,
    });

    expect(metadataFor('ordinary')).toMatchObject({
      routeKey: 'direct_assistant',
      channel: 'bluebubbles',
      responseSource: 'container_agent',
      handlerKind: 'agent_response',
      capabilityId: 'general_assistance',
      providerId: 'claude',
      modelId: 'claude-test-model',
      endpointMode: 'anthropic_messages',
      routingProviderId: 'openai_cloud',
      routingModelId: 'gpt-router-test',
      routingEndpointMode: 'direct_openai',
      toolClass: 'container_agent',
      runOrigin: 'replay',
      preprocessingMs: 0,
      harnessMs: 0,
      responsePreparationMs: 200,
      channelDeliveryMs: 60,
      slowStage: 'response_preparation',
      latencyTargetClass: 'ordinary_response',
    });
  });

  it('does not persist latency when the channel send fails', async () => {
    await expect(
      deliverAssistantReplyWithMetric({
        context: {
          groupFolder: 'main',
          routeKey: 'council_doctor',
          channel: 'telegram',
          responseSource: 'local_control',
          handlerKind: 'local_council_doctor',
          capabilityId: 'council_doctor',
          turnId: 'turn-failed-send',
          deliveryOrdinal: 1,
          runOrigin: 'live',
          latencyTargetClass: 'local_command',
          turnStartedAtMs: 3_000,
          harnessStartedAtMs: 3_000,
          harnessCompletedAtMs: 3_010,
        },
        send: async () => {
          throw new Error('channel unavailable');
        },
        onMetricError: () => undefined,
        nowMs: () => 3_020,
      }),
    ).rejects.toThrow('channel unavailable');

    expect(listAssistantMetricEvents({ groupFolder: 'main' })).toEqual([]);
  });

  it('does not commit or measure a resolved send without a platform receipt', async () => {
    const cursors = new InFlightTurnCursorRegistry();
    cursors.begin('tg:receipt', 'cursor-before-send');
    await expect(
      deliverAssistantReplyWithMetric({
        context: {
          groupFolder: 'main',
          routeKey: 'direct_assistant',
          channel: 'telegram',
          responseSource: 'container_agent',
          handlerKind: 'agent_response',
          capabilityId: 'general_assistance',
          turnId: 'turn-empty-receipt',
          deliveryOrdinal: 1,
          runOrigin: 'live',
          latencyTargetClass: 'ordinary_response',
          turnStartedAtMs: 3_100,
          turnDequeuedAtMs: 3_100,
          harnessStartedAtMs: 3_100,
          harnessCompletedAtMs: 3_110,
        },
        send: async (): Promise<{
          platformMessageId?: string;
          platformMessageIds?: string[];
        }> => ({}),
        validateDelivery: (result) =>
          Boolean(
            result.platformMessageId || result.platformMessageIds?.length,
          ),
        onDelivered: () => cursors.markDelivered('tg:receipt'),
        onMetricError: () => undefined,
        nowMs: () => 3_120,
      }),
    ).rejects.toThrow('did not return a confirmed receipt');

    expect(cursors.size).toBe(1);
    expect(listAssistantMetricEvents({ groupFolder: 'main' })).toEqual([]);
    expect(cursors.rollbackAll(() => undefined)).toBe(1);
  });

  it('commits a partial delivery without recording it as a successful latency sample', async () => {
    const cursors = new InFlightTurnCursorRegistry();
    cursors.begin('tg:partial', 'cursor-before-send');
    const times = [3_200, 3_260];
    const delivered = await deliverAssistantReplyWithMetric({
      context: {
        groupFolder: 'partial-delivery',
        routeKey: 'direct_assistant',
        channel: 'telegram',
        responseSource: 'container_agent',
        handlerKind: 'agent_response',
        capabilityId: 'general_assistance',
        turnId: 'turn-partial-receipt',
        deliveryOrdinal: 1,
        runOrigin: 'live',
        latencyTargetClass: 'ordinary_response',
        turnStartedAtMs: 3_150,
        turnDequeuedAtMs: 3_150,
        harnessStartedAtMs: 3_160,
        harnessCompletedAtMs: 3_180,
      },
      send: async () => ({
        platformMessageId: 'confirmed-chunk-1',
        platformMessageIds: ['confirmed-chunk-1'],
        deliveryState: 'partial' as const,
        nextUnconfirmedChunkIndex: 1,
      }),
      classifyDelivery: (result) => ({
        outcome: result.deliveryState,
        confirmedReceiptCount: result.platformMessageIds.length,
        nextUnconfirmedChunkIndex: result.nextUnconfirmedChunkIndex,
      }),
      onDelivered: () => cursors.markDelivered('tg:partial'),
      onMetricError: () => undefined,
      nowMs: () => times.shift() as number,
    });

    expect(delivered).toMatchObject({
      deliveryOutcome: 'partial',
      deliveryCommitSucceeded: true,
      metricRecorded: true,
    });
    expect(cursors.size).toBe(0);
    expect(metadataFor('partial-delivery')).toMatchObject({
      latencyClass: 'interaction_delivery_degraded',
      deliveryOutcome: 'partial',
      confirmedReceiptCount: 1,
      nextUnconfirmedChunkIndex: 1,
    });
  });

  it('commits an unknown delivery with no receipt to prevent unsafe replay', async () => {
    const cursors = new InFlightTurnCursorRegistry();
    cursors.begin('tg:unknown', 'cursor-before-send');
    const times = [3_300, 3_350];
    const delivered = await deliverAssistantReplyWithMetric({
      context: {
        groupFolder: 'unknown-delivery',
        routeKey: 'direct_assistant',
        channel: 'telegram',
        responseSource: 'container_agent',
        handlerKind: 'agent_response',
        capabilityId: 'general_assistance',
        turnId: 'turn-unknown-receipt',
        deliveryOrdinal: 1,
        runOrigin: 'live',
        latencyTargetClass: 'ordinary_response',
        turnStartedAtMs: 3_280,
        harnessStartedAtMs: 3_280,
        harnessCompletedAtMs: 3_290,
      },
      send: async () => ({
        platformMessageIds: [] as string[],
        deliveryState: 'unknown' as const,
        nextUnconfirmedChunkIndex: 0,
      }),
      classifyDelivery: (result) => ({
        outcome: result.deliveryState,
        confirmedReceiptCount: result.platformMessageIds.length,
        nextUnconfirmedChunkIndex: result.nextUnconfirmedChunkIndex,
      }),
      onDelivered: () => cursors.markDelivered('tg:unknown'),
      onMetricError: () => undefined,
      nowMs: () => times.shift() as number,
    });

    expect(delivered.deliveryOutcome).toBe('unknown');
    expect(cursors.size).toBe(0);
    expect(metadataFor('unknown-delivery')).toMatchObject({
      latencyClass: 'interaction_delivery_degraded',
      deliveryOutcome: 'unknown',
      confirmedReceiptCount: 0,
      nextUnconfirmedChunkIndex: 0,
    });
  });

  it('uses bounded inbound time and aggregate host state for honest attribution', () => {
    expect(
      resolveInteractionTurnStartedAtMs({
        inboundTimestamps: [
          'invalid',
          '2026-07-13T05:00:01.000Z',
          '2026-07-13T05:00:00.000Z',
        ],
        dequeuedAtMs: Date.parse('2026-07-13T05:00:03.000Z'),
      }),
    ).toBe(Date.parse('2026-07-13T05:00:00.000Z'));
    expect(
      resolveInteractionTurnStartedAtMs({
        inboundTimestamps: ['2099-01-01T00:00:00.000Z'],
        dequeuedAtMs: 5_000,
      }),
    ).toBe(5_000);
    expect(
      captureHostPressureSnapshot({
        load1m: 19.2,
        cpuCount: 8,
        freeMemoryBytes: 2,
        totalMemoryBytes: 100,
      }),
    ).toEqual({
      pressureClass: 'high',
      load1mPerCpu: 2.4,
      freeMemoryRatio: 0.02,
    });
    expect(
      captureHostPressureSnapshot({
        load1m: Number.NaN,
        cpuCount: 0,
        freeMemoryBytes: Number.NaN,
        totalMemoryBytes: 0,
      }),
    ).toEqual({ pressureClass: 'unknown' });
  });

  it('returns the delivered result and reports a post-send metric failure without causing a resend', async () => {
    let sendCount = 0;
    let metricError: unknown;
    const times = [4_100, 4_200];
    const delivered = await deliverAssistantReplyWithMetric({
      context: {
        groupFolder: 'main',
        routeKey: 'integrations.doctor',
        channel: 'telegram',
        responseSource: 'local_control',
        handlerKind: 'local_integration_doctor',
        capabilityId: 'integrations.status',
        turnId: 'turn-metric-failure',
        deliveryOrdinal: 1,
        runOrigin: 'live',
        latencyTargetClass: 'local_command',
        turnStartedAtMs: 4_000,
        harnessStartedAtMs: 4_000,
        harnessCompletedAtMs: 4_050,
      },
      send: async () => {
        sendCount += 1;
        return { platformMessageId: 'message-already-delivered' };
      },
      recordMetric: () => {
        throw new Error('metric database unavailable');
      },
      onMetricError: (error) => {
        metricError = error;
      },
      nowMs: () => times.shift() as number,
    });

    expect(sendCount).toBe(1);
    expect(delivered).toMatchObject({
      result: { platformMessageId: 'message-already-delivered' },
      metricRecorded: false,
    });
    expect(metricError).toEqual(new Error('metric database unavailable'));
  });

  it('reports post-delivery enrichment failure without throwing into the send retry path', async () => {
    let observedError: unknown;
    await expect(
      runPostDeliveryEnrichment({
        run: () => {
          throw new Error('feedback database unavailable');
        },
        onError: (error) => {
          observedError = error;
        },
      }),
    ).resolves.toBe(false);
    expect(observedError).toEqual(new Error('feedback database unavailable'));
  });

  it('commits the cursor at delivery and cannot resend after metric, enrichment, observer, and shutdown failures', async () => {
    const cursors = new InFlightTurnCursorRegistry();
    cursors.begin('chat-1', 'previous-cursor');
    let sendCount = 0;
    const times = [5_100, 5_200];
    const delivered = await deliverAssistantReplyWithMetric({
      context: {
        groupFolder: 'main',
        routeKey: 'direct_assistant',
        channel: 'telegram',
        responseSource: 'container_agent',
        handlerKind: 'container_direct_assistant',
        capabilityId: 'general_assistance',
        turnId: 'turn-restart-boundary',
        deliveryOrdinal: 1,
        runOrigin: 'live',
        latencyTargetClass: 'ordinary_response',
        turnStartedAtMs: 5_000,
        harnessStartedAtMs: 5_000,
        harnessCompletedAtMs: 5_050,
      },
      send: async () => {
        sendCount += 1;
        return { platformMessageId: 'delivered-once' };
      },
      onDelivered: () => {
        cursors.markDelivered('chat-1');
      },
      recordMetric: () => {
        throw new Error('metric store unavailable');
      },
      onMetricError: () => {
        throw new Error('observer failure must stay post-delivery');
      },
      nowMs: () => times.shift() as number,
    });

    await expect(
      runPostDeliveryEnrichment({
        run: () => {
          throw new Error('enrichment unavailable');
        },
        onError: () => {
          throw new Error('enrichment observer also failed');
        },
      }),
    ).resolves.toBe(false);
    const rolledBack: string[] = [];
    expect(
      cursors.rollbackAll((chatJid) => {
        rolledBack.push(chatJid);
      }),
    ).toBe(0);
    expect(rolledBack).toEqual([]);
    expect(sendCount).toBe(1);
    expect(delivered).toMatchObject({
      metricRecorded: false,
      metricSkipped: false,
      deliveryCommitSucceeded: true,
      timingValid: true,
    });
  });

  it('rolls back an unsent turn and omits non-monotonic delivery timing', async () => {
    const cursors = new InFlightTurnCursorRegistry();
    cursors.begin('chat-unsent', 'cursor-before-turn');
    const rolledBack: Array<[string, string]> = [];
    expect(
      cursors.rollbackAll((...entry) => {
        rolledBack.push(entry);
      }),
    ).toBe(1);
    expect(rolledBack).toEqual([['chat-unsent', 'cursor-before-turn']]);

    let observedTimingError: unknown;
    const times = [6_040, 6_020];
    const delivered = await deliverAssistantReplyWithMetric({
      context: {
        groupFolder: 'invalid-timing',
        routeKey: 'direct_assistant',
        channel: 'telegram',
        responseSource: 'container_agent',
        handlerKind: 'container_direct_assistant',
        capabilityId: 'general_assistance',
        turnId: 'turn-invalid-timing',
        deliveryOrdinal: 1,
        runOrigin: 'live',
        latencyTargetClass: 'ordinary_response',
        turnStartedAtMs: 6_000,
        harnessStartedAtMs: 6_010,
        harnessCompletedAtMs: 6_030,
      },
      send: async () => ({ platformMessageId: 'sent-with-bad-clock' }),
      onMetricError: (error) => {
        observedTimingError = error;
      },
      nowMs: () => times.shift() as number,
    });
    expect(delivered).toMatchObject({
      metricRecorded: false,
      timingValid: false,
    });
    expect(observedTimingError).toEqual(
      new Error(
        'Interaction delivery timing boundaries were invalid; latency evidence was omitted.',
      ),
    );
    expect(
      listAssistantMetricEvents({ groupFolder: 'invalid-timing' }),
    ).toEqual([]);
  });

  it('commits a deferred send that settles during transport shutdown before the final rollback', async () => {
    const cursors = new InFlightTurnCursorRegistry();
    cursors.begin('chat-shutdown-race', 'cursor-before-turn');
    let resolveSend!: (value: { platformMessageId: string }) => void;
    const send = new Promise<{ platformMessageId: string }>((resolve) => {
      resolveSend = resolve;
    });
    const times = [7_030, 7_040];
    const delivery = deliverAssistantReplyWithMetric({
      context: {
        groupFolder: 'main',
        routeKey: 'direct_assistant',
        channel: 'telegram',
        responseSource: 'container_agent',
        handlerKind: 'container_direct_assistant',
        capabilityId: 'general_assistance',
        turnId: 'turn-shutdown-race',
        deliveryOrdinal: 1,
        runOrigin: 'live',
        latencyTargetClass: 'ordinary_response',
        turnStartedAtMs: 7_000,
        harnessStartedAtMs: 7_010,
        harnessCompletedAtMs: 7_020,
      },
      send: () => send,
      onDelivered: () => {
        cursors.markDelivered('chat-shutdown-race');
      },
      onMetricError: () => undefined,
      recordMetricEnabled: false,
      nowMs: () => times.shift() as number,
    });

    // Shutdown waits for transport disconnects before its final synchronous
    // rollback. Model the in-flight send resolving during that disconnect.
    resolveSend({ platformMessageId: 'delivered-during-disconnect' });
    await expect(delivery).resolves.toMatchObject({
      deliveryCommitSucceeded: true,
    });
    expect(cursors.rollbackAll(() => undefined)).toBe(0);

    // A transport that is still unresolved at the final boundary is rewound.
    cursors.begin('chat-still-pending', 'cursor-before-pending-turn');
    const rolledBack: Array<[string, string]> = [];
    expect(cursors.rollbackAll((...entry) => rolledBack.push(entry))).toBe(1);
    expect(rolledBack).toEqual([
      ['chat-still-pending', 'cursor-before-pending-turn'],
    ]);
  });
});
