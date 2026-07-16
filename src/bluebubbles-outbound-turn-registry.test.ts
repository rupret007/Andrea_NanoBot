import { describe, expect, it, vi } from 'vitest';

import {
  executeBlueBubblesOutboundTurn,
  type ExecuteBlueBubblesOutboundTurnParams,
} from './bluebubbles-outbound-turn.js';
import type { ExecuteBlueBubblesOutboundRequestParams } from './bluebubbles-outbound-request.js';
import {
  DEFAULT_RUNTIME_CAPABILITY_DESCRIPTORS,
  RuntimeCapabilityRegistry,
  runtimeCapabilityRegistry,
} from './runtime-capability-registry.js';
import type { RegisteredGroup } from './types.js';

const mainGroup: RegisteredGroup = {
  name: 'Main',
  folder: 'main',
  trigger: '@Andrea',
  added_at: '2026-07-16T00:00:00.000Z',
  requiresTrigger: false,
  isMain: true,
};

describe('BlueBubbles outbound turn registry ownership', () => {
  it('dispatches only through the injected registry and carries that same registry into execution', async () => {
    const registry = new RuntimeCapabilityRegistry([
      DEFAULT_RUNTIME_CAPABILITY_DESCRIPTORS[0],
    ]);
    const execute = vi.fn((request: unknown) => ({
      handled: true as const,
      state: 'unavailable_capability' as const,
      replyText: 'injected registry binding handled the request',
      request,
    }));
    registry.registerToolBinding({
      capabilityId: 'messages.send.bluebubbles',
      toolId: 'host.messages.send.bluebubbles',
      execute,
    });
    expect(
      runtimeCapabilityRegistry.getToolBinding('messages.send.bluebubbles'),
    ).toBeUndefined();

    const result = await executeBlueBubblesOutboundTurn({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      group: mainGroup,
      rawText: 'Text Travis Story: Hello from the injected registry.',
      registry,
      resolveStoredRecipient: () => ({ state: 'missing' }),
      executionDeps: {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        sendToTarget: vi.fn(),
      },
    } satisfies ExecuteBlueBubblesOutboundTurnParams);

    expect(result).toMatchObject({
      handled: true,
      state: 'unavailable_capability',
      replyText: 'injected registry binding handled the request',
    });
    expect(execute).toHaveBeenCalledTimes(1);
    const request = execute.mock.calls[0]?.[0] as
      | ExecuteBlueBubblesOutboundRequestParams
      | undefined;
    expect(request?.capabilityRegistry).toBe(registry);
    expect(request?.capabilityRegistry).not.toBe(runtimeCapabilityRegistry);
  });
});
