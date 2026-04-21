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

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(calls[0]?.url).toBe('http://127.0.0.1:4401/intent/request');
    expect(calls[1]?.url).toBe('http://127.0.0.1:4401/intent/response');
    expect(calls[2]?.url).toBe('http://127.0.0.1:4401/system/health');
    expect(calls[3]?.url).toBe('http://127.0.0.1:4401/config/snapshot');

    const firstBody = JSON.parse(String(calls[0]?.body ?? '{}'));
    const secondBody = JSON.parse(String(calls[1]?.body ?? '{}'));
    const thirdBody = JSON.parse(String(calls[2]?.body ?? '{}'));
    const fourthBody = JSON.parse(String(calls[3]?.body ?? '{}'));

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
