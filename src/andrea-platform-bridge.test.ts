import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChannelHealthSnapshot, RuntimeBackendStatus } from './types.js';

describe('andrea platform shell bridge', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('posts shell intent and health events when the bridge is enabled', async () => {
    vi.stubEnv(
      'ANDREA_PLATFORM_SHELL_GATEWAY_URL',
      'http://127.0.0.1:4401/',
    );

    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: init?.body,
      });
      return new Response(null, { status: 202 });
    });
    vi.stubGlobal('fetch', fetchImpl as unknown as typeof fetch);

    const bridge = await import('./andrea-platform-bridge.js');

    expect(bridge.isAndreaPlatformShellBridgeEnabled()).toBe(true);

    await bridge.emitAndreaPlatformIntentRequest({
      channel: 'telegram',
      actorId: 'user-1',
      groupFolder: 'main',
      text: 'What matters today?',
      routeHint: 'chief_of_staff',
      metadata: { source: 'test' },
    });
    await bridge.emitAndreaPlatformIntentResponse({
      channel: 'telegram',
      actorId: 'user-1',
      groupFolder: 'main',
      summary: 'Shared the current priorities.',
      outcome: 'handled',
      metadata: { source: 'test' },
    });
    await bridge.emitAndreaPlatformShellHealth({
      severity: 'healthy',
      summary: 'Shell is healthy.',
      detail: 'Loopback backend reachable.',
      metadata: { source: 'test' },
    });
    await bridge.emitAndreaPlatformShellConfigSnapshot({
      component: 'andrea.memory',
      configName: 'memory_freshness_rollup',
      snapshot: { semanticMemory: '12 subjects' },
    });
    await bridge.emitAndreaPlatformProofEvent({
      surface: 'telegram',
      journey: 'smoke',
      state: 'LIVE_PROVEN',
      summary: 'Telegram smoke is live-proven.',
      metadata: { source: 'test' },
    });
    await bridge.emitAndreaPlatformTransportEvent({
      transportId: 'telegram',
      transportKind: 'telegram',
      state: 'healthy',
      summary: 'Telegram transport is healthy.',
      deliverySemantics: 'long_polling',
      fallbackTarget: 'none',
      metadata: { source: 'test' },
    });
    await bridge.emitAndreaPlatformTraceEvent({
      traceId: 'feedback-1',
      traceKind: 'feedback',
      title: 'Response feedback captured',
      summary: 'Feedback entered the platform trace chain.',
      refs: { feedbackId: 'feedback-1' },
      metadata: { source: 'test' },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(7);
    expect(calls[0]?.url).toBe('http://127.0.0.1:4401/intent/request');
    expect(calls[1]?.url).toBe('http://127.0.0.1:4401/intent/response');
    expect(calls[2]?.url).toBe('http://127.0.0.1:4401/system/health');
    expect(calls[3]?.url).toBe('http://127.0.0.1:4401/config/snapshot');
    expect(calls[4]?.url).toBe('http://127.0.0.1:4401/proof/event');
    expect(calls[5]?.url).toBe('http://127.0.0.1:4401/transport/event');
    expect(calls[6]?.url).toBe('http://127.0.0.1:4401/trace/event');

    const firstBody = JSON.parse(String(calls[0]?.body ?? '{}'));
    const secondBody = JSON.parse(String(calls[1]?.body ?? '{}'));
    const thirdBody = JSON.parse(String(calls[2]?.body ?? '{}'));
    const fourthBody = JSON.parse(String(calls[3]?.body ?? '{}'));
    const fifthBody = JSON.parse(String(calls[4]?.body ?? '{}'));
    const sixthBody = JSON.parse(String(calls[5]?.body ?? '{}'));
    const seventhBody = JSON.parse(String(calls[6]?.body ?? '{}'));

    expect(firstBody).toMatchObject({
      source: 'andrea_nanobot',
      channel: 'telegram',
      actor_id: 'user-1',
      group_folder: 'main',
      text: 'What matters today?',
      route_hint: 'chief_of_staff',
      metadata: { source: 'test' },
    });
    expect(secondBody).toMatchObject({
      source: 'andrea_nanobot',
      channel: 'telegram',
      actor_id: 'user-1',
      group_folder: 'main',
      summary: 'Shared the current priorities.',
      outcome: 'handled',
      metadata: { source: 'test' },
    });
    expect(thirdBody).toMatchObject({
      source: 'andrea_nanobot',
      component: 'andrea.shell',
      owner: 'shell',
      severity: 'healthy',
      summary: 'Shell is healthy.',
      detail: 'Loopback backend reachable.',
      metadata: { source: 'test' },
    });
    expect(fourthBody).toMatchObject({
      source: 'andrea_nanobot',
      component: 'andrea.memory',
      config_name: 'memory_freshness_rollup',
    });
    expect(JSON.parse(String(fourthBody.snapshot_json))).toEqual({
      semanticMemory: '12 subjects',
    });
    expect(fifthBody).toMatchObject({
      source: 'andrea_nanobot',
      surface: 'telegram',
      journey: 'smoke',
      state: 'LIVE_PROVEN',
      summary: 'Telegram smoke is live-proven.',
      metadata: { source: 'test' },
    });
    expect(sixthBody).toMatchObject({
      source: 'andrea_nanobot',
      transport_id: 'telegram',
      transport_kind: 'telegram',
      state: 'healthy',
      summary: 'Telegram transport is healthy.',
      delivery_semantics: 'long_polling',
      fallback_target: 'none',
      metadata: { source: 'test' },
    });
    expect(seventhBody).toMatchObject({
      source: 'andrea_nanobot',
      trace_id: 'feedback-1',
      trace_kind: 'feedback',
      title: 'Response feedback captured',
      summary: 'Feedback entered the platform trace chain.',
      refs: { feedbackId: 'feedback-1' },
      metadata: { source: 'test' },
    });
  });

  it('maps runtime backend auth requirements to a near-live shell health state', async () => {
    const bridge = await import('./andrea-platform-bridge.js');
    const status: RuntimeBackendStatus = {
      state: 'auth_required',
      backend: 'andrea_openai',
      version: '1.0.0',
      transport: 'http',
      detail: 'Login still required.',
      meta: null,
    };

    expect(bridge.mapShellHealthFromBackendStatus(status)).toEqual({
      severity: 'near_live_only',
      summary:
        'NanoBot can reach the runtime backend, but local auth is still required.',
      detail: 'Login still required.',
    });
  });

  it('posts response-feedback reflections to the platform coordinator when enabled', async () => {
    vi.stubEnv('ANDREA_PLATFORM_COORDINATOR_ENABLED', 'true');
    vi.stubEnv('ANDREA_PLATFORM_COORDINATOR_URL', 'http://127.0.0.1:4400/');
    vi.stubEnv('ANDREA_PLATFORM_FALLBACK_TO_DIRECT_RUNTIME', 'false');

    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: init?.body,
      });
      return new Response(
        JSON.stringify({
          task: { task_ledger_id: 'task-1' },
          progress: { progress_ledger_id: 'progress-1' },
          reflection: { reflection_id: 'reflection-1' },
          evaluation: { evaluation_id: 'evaluation-1' },
          learning: { learning_id: 'learning-1' },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchImpl as unknown as typeof fetch);

    const bridge = await import('./andrea-platform-bridge.js');
    const result = await bridge.emitAndreaPlatformFeedbackReflection({
      feedbackId: 'feedback-1',
      issueId: 'issue-1',
      status: 'awaiting_confirmation',
      classification: 'repo_side_rough_edge',
      taskFamily: 'calendar',
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'telegram:main',
      routeKey: 'calendar_local_fast_path',
      capabilityId: 'calendar.local_lookup',
      blockerOwner: 'repo_side',
      platformMessageId: 'msg-1',
      userMessageId: 'user-msg-1',
      summary: 'User downvoted a calendar answer.',
      originalUserPreview: 'Do I have anything at 3pm tomorrow?',
      assistantReplyPreview: "I don't see anything at 3 PM tomorrow.",
    });

    expect(result).toEqual({
      feedbackId: 'feedback-1',
      taskLedgerId: 'task-1',
      progressLedgerId: 'progress-1',
      reflectionId: 'reflection-1',
      evaluationId: 'evaluation-1',
      learningId: 'learning-1',
    });
    expect(calls[0]?.url).toBe('http://127.0.0.1:4400/feedback/reflection');
    expect(JSON.parse(String(calls[0]?.body ?? '{}'))).toMatchObject({
      feedbackId: 'feedback-1',
      correlationId: 'feedback-1',
      taskFamily: 'calendar',
      sentiment: 'negative',
      outcome: 'degraded',
      metadata: {
        issueId: 'issue-1',
        routeKey: 'calendar_local_fast_path',
        capabilityId: 'calendar.local_lookup',
      },
    });
  });

  it('maps configured ready channels to a healthy shell state', async () => {
    const bridge = await import('./andrea-platform-bridge.js');
    const channelHealth: ChannelHealthSnapshot[] = [
      {
        name: 'telegram',
        configured: true,
        state: 'ready',
        updatedAt: '2026-04-17T14:00:00.000Z',
        detail: 'Telegram is ready.',
      },
      {
        name: 'bluebubbles',
        configured: true,
        state: 'ready',
        updatedAt: '2026-04-17T14:00:00.000Z',
        detail: 'BlueBubbles is ready.',
      },
    ];

    expect(bridge.mapShellHealthFromChannelHealth(channelHealth)).toEqual({
      severity: 'healthy',
      summary: 'NanoBot shell is running and all configured channels are ready.',
      detail: 'telegram, bluebubbles',
      metadata: {
        configuredChannels: '2',
        readyChannels: '2',
      },
    });
  });

  it('maps not-ready configured channels to a degraded shell state', async () => {
    const bridge = await import('./andrea-platform-bridge.js');
    const channelHealth: ChannelHealthSnapshot[] = [
      {
        name: 'telegram',
        configured: true,
        state: 'ready',
        updatedAt: '2026-04-17T14:00:00.000Z',
      },
      {
        name: 'bluebubbles',
        configured: true,
        state: 'starting',
        updatedAt: '2026-04-17T14:00:00.000Z',
        detail: 'Awaiting webhook traffic.',
      },
    ];

    expect(bridge.mapShellHealthFromChannelHealth(channelHealth)).toEqual({
      severity: 'degraded',
      summary:
        'NanoBot shell is running, but one or more configured channels are not ready yet.',
      detail: 'bluebubbles: Awaiting webhook traffic.',
      metadata: {
        configuredChannels: '2',
        readyChannels: '1',
      },
    });
  });
});
