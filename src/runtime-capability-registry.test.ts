import { describe, expect, it } from 'vitest';

import './channels/index.js';

import { registerProductionRuntimeCapabilitySurfaces } from './runtime-capability-production-surfaces.js';
import {
  DEFAULT_RUNTIME_CAPABILITY_DESCRIPTORS,
  RuntimeCapabilityRegistry,
  buildBlueBubblesRuntimeCapabilityFacts,
  formatRuntimeCapabilityOutcome,
  formatRuntimeCapabilityEvaluation,
  resolveRuntimeCapabilitySourceChannels,
  runtimeCapabilityRegistry,
  type RuntimeCapabilityFacts,
  type RuntimeCapabilityOutcome,
} from './runtime-capability-registry.js';

const READY_FACTS: RuntimeCapabilityFacts = {
  toolRegistered: true,
  toolExposed: true,
  providerHealth: 'healthy',
  writePermission: 'granted',
  confirmation: 'satisfied',
};

function buildProductionRegistry(): RuntimeCapabilityRegistry {
  return registerProductionRuntimeCapabilitySurfaces(
    new RuntimeCapabilityRegistry(DEFAULT_RUNTIME_CAPABILITY_DESCRIPTORS),
  );
}

const productionRegistry = buildProductionRegistry();

describe('runtime capability registry', () => {
  it('uses one descriptor shape across messaging, calendar, reminders, and research', () => {
    expect(DEFAULT_RUNTIME_CAPABILITY_DESCRIPTORS.map(({ id }) => id)).toEqual([
      'messages.send.bluebubbles',
      'messages.send.telegram',
      'calendar.events.google',
      'reminders.local',
      'research.web',
    ]);

    for (const descriptor of DEFAULT_RUNTIME_CAPABILITY_DESCRIPTORS) {
      expect(descriptor.provider).toBeTruthy();
      expect(descriptor.toolRegistration.toolId).toBeTruthy();
      expect(descriptor.toolRegistration.kind).toMatch(/^(host|builtin|mcp)$/);
      expect(descriptor.toolExposure.mode).toBeTruthy();
      expect(descriptor.supportedActions.length).toBeGreaterThan(0);
      expect(descriptor.sourceChannels.length).toBeGreaterThan(0);
      expect(descriptor.confirmationPolicy).toBeDefined();
      expect(descriptor.writePermission).toBeDefined();
      expect(descriptor.idempotency).toBeDefined();
      expect(descriptor.receipt).toBeDefined();
    }
  });

  it('declares BlueBubbles send as a protected, receipt-grounded write', () => {
    const descriptor = runtimeCapabilityRegistry.get(
      'messages.send.bluebubbles',
    );

    expect(descriptor).toMatchObject({
      provider: 'bluebubbles',
      toolRegistration: {
        toolId: 'host.messages.send.bluebubbles',
        kind: 'host',
      },
      toolExposure: {
        mode: 'host_orchestrated',
        protected: true,
      },
      confirmationPolicy: { mode: 'explicit_request' },
      writePermission: { required: true, scope: 'bluebubbles:send' },
      idempotency: {
        required: true,
        strategy: 'stable_action_key',
        providerField: 'tempGuid',
      },
      receipt: { required: true },
      sourceChannels: ['telegram', 'bluebubbles'],
    });
    expect(descriptor?.supportedActions).toContainEqual({
      id: 'send',
      effect: 'write',
    });
    expect(descriptor?.receipt.requiredEvidence).toEqual([
      'provider_receipt_id',
      'recipient',
      'exact_content',
    ]);
  });

  it('returns available when every registry and runtime requirement is met', () => {
    const evaluation = productionRegistry.evaluate(
      {
        capabilityId: 'messages.send.bluebubbles',
        action: 'send',
        sourceChannel: 'telegram',
      },
      READY_FACTS,
    );

    expect(evaluation.state).toBe('available');
    if (evaluation.state === 'available') {
      expect(evaluation.action).toEqual({ id: 'send', effect: 'write' });
      expect(evaluation.descriptor.provider).toBe('bluebubbles');
    }
  });

  it.each([
    ['messages.send.bluebubbles', 'send', 'telegram'],
    ['messages.send.bluebubbles', 'send', 'bluebubbles'],
    ['messages.send.telegram', 'send', 'bluebubbles'],
    ['calendar.events.google', 'create', 'telegram'],
    ['reminders.local', 'create', 'bluebubbles'],
    ['research.web', 'search', 'alexa'],
  ])(
    'never denies healthy, registered, exposed capability %s',
    (capabilityId, action, sourceChannel) => {
      expect(
        productionRegistry.evaluate(
          { capabilityId, action, sourceChannel },
          READY_FACTS,
        ).state,
      ).toBe('available');
    },
  );

  it.each(['direct', 'operator'])(
    'does not expose BlueBubbles send from the non-production %s channel',
    (sourceChannel) => {
      expect(
        productionRegistry.evaluate(
          {
            capabilityId: 'messages.send.bluebubbles',
            action: 'send',
            sourceChannel,
          },
          READY_FACTS,
        ),
      ).toMatchObject({
        state: 'unavailable_capability',
        reason: 'unsupported_source_channel',
      });
    },
  );

  it.each([
    {
      label: 'an unknown capability',
      request: {
        capabilityId: 'messages.send.unknown',
        action: 'send',
        sourceChannel: 'telegram',
      },
      facts: READY_FACTS,
      reason: 'capability_unregistered',
    },
    {
      label: 'an unsupported action',
      request: {
        capabilityId: 'messages.send.bluebubbles',
        action: 'schedule',
        sourceChannel: 'telegram',
      },
      facts: READY_FACTS,
      reason: 'unsupported_action',
    },
    {
      label: 'an unsupported source channel',
      request: {
        capabilityId: 'messages.send.bluebubbles',
        action: 'send',
        sourceChannel: 'email',
      },
      facts: READY_FACTS,
      reason: 'unsupported_source_channel',
    },
    {
      label: 'an unregistered tool',
      request: {
        capabilityId: 'messages.send.bluebubbles',
        action: 'send',
        sourceChannel: 'telegram',
      },
      facts: { ...READY_FACTS, toolRegistered: false },
      reason: 'tool_unregistered',
    },
    {
      label: 'an unexposed tool',
      request: {
        capabilityId: 'messages.send.bluebubbles',
        action: 'send',
        sourceChannel: 'telegram',
      },
      facts: { ...READY_FACTS, toolExposed: false },
      reason: 'tool_unexposed',
    },
  ])(
    'returns unavailable_capability for $label',
    ({ request, facts, reason }) => {
      expect(productionRegistry.evaluate(request, facts)).toMatchObject({
        state: 'unavailable_capability',
        reason,
      });
    },
  );

  it.each(['unhealthy', 'unknown'] as const)(
    'does not present a %s provider as available',
    (providerHealth) => {
      expect(
        productionRegistry.evaluate(
          {
            capabilityId: 'messages.send.bluebubbles',
            action: 'send',
            sourceChannel: 'telegram',
          },
          { ...READY_FACTS, providerHealth },
        ),
      ).toMatchObject({
        state: 'unhealthy_provider',
        provider: 'bluebubbles',
        health: providerHealth,
      });
    },
  );

  it('allows a degraded but reachable provider to proceed', () => {
    expect(
      productionRegistry.evaluate(
        {
          capabilityId: 'messages.send.bluebubbles',
          action: 'send',
          sourceChannel: 'telegram',
        },
        { ...READY_FACTS, providerHealth: 'degraded' },
      ).state,
    ).toBe('available');
  });

  it('returns missing_permission before evaluating confirmation', () => {
    expect(
      productionRegistry.evaluate(
        {
          capabilityId: 'messages.send.bluebubbles',
          action: 'send',
          sourceChannel: 'telegram',
        },
        {
          ...READY_FACTS,
          writePermission: 'missing',
          confirmation: 'missing',
        },
      ),
    ).toMatchObject({
      state: 'missing_permission',
      permissionScope: 'bluebubbles:send',
    });
  });

  it('returns confirmation_required when an explicit request is absent', () => {
    expect(
      productionRegistry.evaluate(
        {
          capabilityId: 'messages.send.bluebubbles',
          action: 'send',
          sourceChannel: 'telegram',
        },
        { ...READY_FACTS, confirmation: 'missing' },
      ),
    ).toMatchObject({
      state: 'confirmation_required',
      policy: 'explicit_request',
    });
  });

  it('reuses the same evaluation for read actions without write authorization', () => {
    expect(
      productionRegistry.evaluate(
        {
          capabilityId: 'research.web',
          action: 'search',
          sourceChannel: 'alexa',
        },
        {
          ...READY_FACTS,
          writePermission: 'missing',
          confirmation: 'missing',
        },
      ),
    ).toMatchObject({
      state: 'available',
      action: { id: 'search', effect: 'read' },
    });
  });

  it('rejects duplicate capability ids', () => {
    const descriptor = DEFAULT_RUNTIME_CAPABILITY_DESCRIPTORS[0];
    expect(
      () => new RuntimeCapabilityRegistry([descriptor, descriptor]),
    ).toThrow('Runtime capability ids must be unique');
  });

  it('formats availability failures without inventing a manual fallback', () => {
    const evaluation = productionRegistry.evaluate(
      {
        capabilityId: 'messages.send.bluebubbles',
        action: 'send',
        sourceChannel: 'telegram',
      },
      { ...READY_FACTS, providerHealth: 'unhealthy' },
    );
    expect(formatRuntimeCapabilityEvaluation(evaluation)).toContain(
      'did not dispatch',
    );
    expect(formatRuntimeCapabilityEvaluation(evaluation)).not.toContain(
      'send it yourself',
    );
  });

  it('derives live BlueBubbles health and write truth without changing the descriptor', () => {
    const facts = buildBlueBubblesRuntimeCapabilityFacts(
      {
        connected: true,
        enabled: true,
        groupFolder: 'main',
        chatScope: 'contacts_only',
        sendEnabled: true,
        listenerHost: '127.0.0.1',
        listenerPort: 4305,
        configuredBaseUrl: 'http://bluebubbles.test',
        activeBaseUrl: 'http://bluebubbles.test',
        candidateBaseUrls: ['http://bluebubbles.test'],
        publicWebhookUrl: 'http://localhost/webhook',
        serverPublicUrl: null,
        localPort: null,
        imessageAccountLabel: null,
        computerId: null,
        webhookRegistrationState: 'registered',
        webhookRegistrationDetail: 'ok',
        transportState: 'reachable',
        transportDetail: 'ok',
        receiptInboxState: 'reachable',
        shadowPollLastOkAt: 'none',
        shadowPollLastError: 'none',
        shadowPollMostRecentChat: 'none',
        configuredReplyGateMode: 'mention_required',
        effectiveReplyGateMode: 'mention_required',
        lastInboundObservedAt: 'none',
        lastInboundChatJid: 'none',
        lastInboundWasSelfAuthored: null,
        lastOutboundResult: 'none',
        lastOutboundTargetKind: 'none',
        lastOutboundTarget: 'none',
        lastSendErrorDetail: 'none',
        detectionState: 'healthy',
        detectionDetail: 'ok',
        detectionNextAction: 'none',
      },
      {
        explicitlyAuthorized: true,
        toolRegistered: true,
        toolExposed: true,
      },
      productionRegistry,
    );
    expect(facts).toMatchObject({
      toolRegistered: true,
      toolExposed: true,
      providerHealth: 'healthy',
      writePermission: 'granted',
      confirmation: 'satisfied',
    });
  });

  it('keeps descriptor declaration distinct from executable tool registration', () => {
    const registry = new RuntimeCapabilityRegistry([
      DEFAULT_RUNTIME_CAPABILITY_DESCRIPTORS[0],
    ]);
    expect(registry.get('messages.send.bluebubbles')).toBeDefined();
    expect(
      registry.getToolBinding('messages.send.bluebubbles'),
    ).toBeUndefined();
    registry.registerToolBinding({
      capabilityId: 'messages.send.bluebubbles',
      toolId: 'host.messages.send.bluebubbles',
      execute: async () => ({ handled: false }),
    });
    expect(registry.getToolBinding('messages.send.bluebubbles')?.toolId).toBe(
      'host.messages.send.bluebubbles',
    );
  });

  it('registers an observational production surface without claiming registry-owned dispatch', () => {
    const registry = new RuntimeCapabilityRegistry([
      DEFAULT_RUNTIME_CAPABILITY_DESCRIPTORS[1],
    ]);
    const implementation = async () => ({ sent: true });
    registry.registerToolSurface({
      capabilityId: 'messages.send.telegram',
      toolId: 'host.messages.send.telegram',
      actions: [{ id: 'send', implementations: [implementation] }],
      sourceChannels: ['telegram'],
    });

    expect(
      registry.getRegistrationSnapshot('messages.send.telegram'),
    ).toMatchObject({
      state: 'tool_registered',
      toolRegistered: true,
      toolExposed: true,
      toolDispatchable: false,
      surface: {
        toolId: 'host.messages.send.telegram',
        sourceChannels: ['telegram'],
      },
    });
    expect(registry.getToolBinding('messages.send.telegram')).toBeUndefined();
  });

  it('owns a deep-frozen production surface copy and its function references', () => {
    const registry = new RuntimeCapabilityRegistry([
      DEFAULT_RUNTIME_CAPABILITY_DESCRIPTORS[1],
    ]);
    const implementation = async () => ({ sent: true });
    const surface = {
      capabilityId: 'messages.send.telegram',
      toolId: 'host.messages.send.telegram',
      actions: [{ id: 'send', implementations: [implementation] }],
      sourceChannels: ['telegram'],
    };
    registry.registerToolSurface(surface);
    surface.actions[0]!.id = 'rewritten';
    surface.actions[0]!.implementations[0] = async () => ({ sent: false });
    surface.sourceChannels[0] = 'direct';

    const registered = registry.getToolSurface('messages.send.telegram');
    expect(registered?.actions[0]).toMatchObject({ id: 'send' });
    expect(registered?.actions[0]?.implementations[0]).toBe(implementation);
    expect(registered?.sourceChannels).toEqual(['telegram']);
    expect(Object.isFrozen(registered)).toBe(true);
    expect(Object.isFrozen(registered?.actions)).toBe(true);
    expect(Object.isFrozen(registered?.actions[0])).toBe(true);
    expect(Object.isFrozen(registered?.actions[0]?.implementations)).toBe(true);
    expect(Object.isFrozen(registered?.sourceChannels)).toBe(true);
  });

  it('requires exact action coverage and real function references for a surface', () => {
    const descriptor = DEFAULT_RUNTIME_CAPABILITY_DESCRIPTORS[2];
    const implementation = async () => [];

    expect(() =>
      new RuntimeCapabilityRegistry([descriptor]).registerToolSurface({
        capabilityId: descriptor.id,
        toolId: descriptor.toolRegistration.toolId,
        actions: [{ id: 'list', implementations: [implementation] }],
        sourceChannels: ['direct'],
      }),
    ).toThrow('must map exactly its declared actions');
    expect(() =>
      new RuntimeCapabilityRegistry([
        DEFAULT_RUNTIME_CAPABILITY_DESCRIPTORS[1],
      ]).registerToolSurface({
        capabilityId: 'messages.send.telegram',
        toolId: 'host.messages.send.telegram',
        actions: [{ id: 'send', implementations: [] }],
        sourceChannels: ['telegram'],
      }),
    ).toThrow('requires at least one production implementation reference');
  });

  it('rejects duplicate surface ownership and channels outside the declared contract', () => {
    const registry = new RuntimeCapabilityRegistry([
      DEFAULT_RUNTIME_CAPABILITY_DESCRIPTORS[1],
    ]);
    const surface = {
      capabilityId: 'messages.send.telegram',
      toolId: 'host.messages.send.telegram',
      actions: [{ id: 'send', implementations: [async () => undefined] }],
      sourceChannels: ['telegram'],
    };
    registry.registerToolSurface(surface);
    expect(() => registry.registerToolSurface(surface)).toThrow(
      'already has a registered tool surface',
    );
    expect(() =>
      new RuntimeCapabilityRegistry([
        DEFAULT_RUNTIME_CAPABILITY_DESCRIPTORS[1],
      ]).registerToolSurface({ ...surface, sourceChannels: ['email'] }),
    ).toThrow('contains unsupported source channels: email');
  });

  it('enforces the registered surface channel subset at evaluation time', () => {
    const registry = new RuntimeCapabilityRegistry([
      DEFAULT_RUNTIME_CAPABILITY_DESCRIPTORS[1],
    ]);
    registry.registerToolSurface({
      capabilityId: 'messages.send.telegram',
      toolId: 'host.messages.send.telegram',
      actions: [
        { id: 'send', implementations: [async () => ({ sent: true })] },
      ],
      sourceChannels: ['telegram'],
    });

    expect(
      registry.evaluate(
        {
          capabilityId: 'messages.send.telegram',
          action: 'send',
          sourceChannel: 'bluebubbles',
        },
        READY_FACTS,
      ),
    ).toMatchObject({
      state: 'unavailable_capability',
      reason: 'tool_unexposed',
    });
  });

  it('owns a deep-frozen descriptor copy that callers cannot rewrite', () => {
    const input = structuredClone(DEFAULT_RUNTIME_CAPABILITY_DESCRIPTORS[0]);
    const registry = new RuntimeCapabilityRegistry([input]);

    Reflect.set(
      input.toolRegistration,
      'toolId',
      'host.messages.send.silently-replaced',
    );
    Reflect.set(input.sourceChannels, 0, 'email');

    const descriptor = registry.get('messages.send.bluebubbles');
    expect(descriptor).toMatchObject({
      toolRegistration: { toolId: 'host.messages.send.bluebubbles' },
      sourceChannels: ['telegram', 'bluebubbles'],
    });
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor?.toolRegistration)).toBe(true);
    expect(Object.isFrozen(descriptor?.sourceChannels)).toBe(true);
    expect(Object.isFrozen(descriptor?.supportedActions)).toBe(true);
    expect(
      Reflect.set(
        descriptor?.toolRegistration ?? {},
        'toolId',
        'host.messages.send.getter-rewrite',
      ),
    ).toBe(false);
    expect(Reflect.set(descriptor?.sourceChannels ?? [], 0, 'email')).toBe(
      false,
    );
    expect(
      registry.evaluate(
        {
          capabilityId: 'messages.send.bluebubbles',
          action: 'send',
          sourceChannel: 'telegram',
        },
        READY_FACTS,
      ),
    ).toMatchObject({
      state: 'unavailable_capability',
      reason: 'tool_unregistered',
    });
  });

  it('exports deep-frozen default contracts', () => {
    const descriptor = DEFAULT_RUNTIME_CAPABILITY_DESCRIPTORS[0];
    expect(Object.isFrozen(DEFAULT_RUNTIME_CAPABILITY_DESCRIPTORS)).toBe(true);
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.toolRegistration)).toBe(true);
    expect(Object.isFrozen(descriptor.sourceChannels)).toBe(true);
    expect(Object.isFrozen(descriptor.confirmationPolicy.actions)).toBe(true);
    expect(Object.isFrozen(descriptor.receipt.requiredEvidence)).toBe(true);
  });

  it('does not let caller-supplied ready facts invent a missing binding', () => {
    const registry = new RuntimeCapabilityRegistry([
      DEFAULT_RUNTIME_CAPABILITY_DESCRIPTORS[0],
    ]);
    expect(
      registry.evaluate(
        {
          capabilityId: 'messages.send.bluebubbles',
          action: 'send',
          sourceChannel: 'telegram',
        },
        READY_FACTS,
      ),
    ).toMatchObject({
      state: 'unavailable_capability',
      reason: 'tool_unregistered',
    });
  });

  it('rejects duplicate tool registration without replacing the authoritative binding', async () => {
    const registry = new RuntimeCapabilityRegistry([
      DEFAULT_RUNTIME_CAPABILITY_DESCRIPTORS[0],
    ]);
    const original = async () => ({ owner: 'original' });
    registry.registerToolBinding({
      capabilityId: 'messages.send.bluebubbles',
      toolId: 'host.messages.send.bluebubbles',
      execute: original,
    });

    expect(() =>
      registry.registerToolBinding({
        capabilityId: 'messages.send.bluebubbles',
        toolId: 'host.messages.send.bluebubbles',
        execute: async () => ({ owner: 'duplicate' }),
      }),
    ).toThrow('already has a registered tool binding');
    expect(
      await registry.getToolBinding('messages.send.bluebubbles')?.execute({}),
    ).toEqual({ owner: 'original' });
    expect(registry.listToolBindingReplacementAudits()).toEqual([]);
  });

  it('owns a frozen binding copy that caller and getter mutation cannot replace', async () => {
    const registry = new RuntimeCapabilityRegistry([
      DEFAULT_RUNTIME_CAPABILITY_DESCRIPTORS[0],
    ]);
    const binding = {
      capabilityId: 'messages.send.bluebubbles',
      toolId: 'host.messages.send.bluebubbles',
      execute: async () => ({ owner: 'original' }),
    };
    registry.registerToolBinding(binding);

    binding.execute = async () => ({ owner: 'caller-mutation' });
    const registered = registry.getToolBinding('messages.send.bluebubbles');
    expect(Object.isFrozen(registered)).toBe(true);
    expect(
      Reflect.set(registered ?? {}, 'execute', async () => ({
        owner: 'getter-mutation',
      })),
    ).toBe(false);
    const snapshot = registry.getRegistrationSnapshot(
      'messages.send.bluebubbles',
    );
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.binding)).toBe(true);
    expect(await registered?.execute({})).toEqual({ owner: 'original' });
    expect(await snapshot.binding?.execute({})).toEqual({ owner: 'original' });
    expect(registry.listToolBindingReplacementAudits()).toEqual([]);
  });

  it('permits only an explicit replacement and records its audit context', async () => {
    const registry = new RuntimeCapabilityRegistry([
      DEFAULT_RUNTIME_CAPABILITY_DESCRIPTORS[0],
    ]);
    registry.registerToolBinding({
      capabilityId: 'messages.send.bluebubbles',
      toolId: 'host.messages.send.bluebubbles',
      execute: async () => ({ owner: 'original' }),
    });

    const replacement = {
      capabilityId: 'messages.send.bluebubbles',
      toolId: 'host.messages.send.bluebubbles',
      execute: async () => ({ owner: 'replacement' }),
    };
    const audit = registry.replaceToolBinding(replacement, {
      actor: 'runtime-reloader',
      reason: 'verified module reload',
      replacedAt: '2026-07-16T12:00:00.000Z',
    });

    expect(audit).toEqual({
      sequence: 1,
      capabilityId: 'messages.send.bluebubbles',
      previousToolId: 'host.messages.send.bluebubbles',
      replacementToolId: 'host.messages.send.bluebubbles',
      actor: 'runtime-reloader',
      reason: 'verified module reload',
      replacedAt: '2026-07-16T12:00:00.000Z',
    });
    replacement.execute = async () => ({ owner: 'post-replace-mutation' });
    expect(registry.listToolBindingReplacementAudits()).toEqual([audit]);
    expect(
      Object.isFrozen(registry.getToolBinding('messages.send.bluebubbles')),
    ).toBe(true);
    expect(
      await registry.getToolBinding('messages.send.bluebubbles')?.execute({}),
    ).toEqual({ owner: 'replacement' });
  });

  it('rejects unaudited replacement and preserves the existing binding', async () => {
    const registry = new RuntimeCapabilityRegistry([
      DEFAULT_RUNTIME_CAPABILITY_DESCRIPTORS[0],
    ]);
    registry.registerToolBinding({
      capabilityId: 'messages.send.bluebubbles',
      toolId: 'host.messages.send.bluebubbles',
      execute: async () => ({ owner: 'original' }),
    });

    expect(() =>
      registry.replaceToolBinding(
        {
          capabilityId: 'messages.send.bluebubbles',
          toolId: 'host.messages.send.bluebubbles',
          execute: async () => ({ owner: 'replacement' }),
        },
        { actor: ' ', reason: '' },
      ),
    ).toThrow('requires non-empty actor and reason');
    expect(
      await registry.getToolBinding('messages.send.bluebubbles')?.execute({}),
    ).toEqual({ owner: 'original' });
    expect(registry.listToolBindingReplacementAudits()).toEqual([]);
  });

  it('rejects invalid replacement audit timestamps before mutation', async () => {
    const registry = new RuntimeCapabilityRegistry([
      DEFAULT_RUNTIME_CAPABILITY_DESCRIPTORS[0],
    ]);
    registry.registerToolBinding({
      capabilityId: 'messages.send.bluebubbles',
      toolId: 'host.messages.send.bluebubbles',
      execute: async () => ({ owner: 'original' }),
    });

    expect(() =>
      registry.replaceToolBinding(
        {
          capabilityId: 'messages.send.bluebubbles',
          toolId: 'host.messages.send.bluebubbles',
          execute: async () => ({ owner: 'replacement' }),
        },
        {
          actor: 'runtime-reloader',
          reason: 'verified module reload',
          replacedAt: 'not-a-timestamp',
        },
      ),
    ).toThrow('requires a valid replacedAt');
    expect(
      await registry.getToolBinding('messages.send.bluebubbles')?.execute({}),
    ).toEqual({ owner: 'original' });
    expect(registry.listToolBindingReplacementAudits()).toEqual([]);
  });

  it('snapshots descriptor-only and live executable registration truth', () => {
    const registry = new RuntimeCapabilityRegistry([
      DEFAULT_RUNTIME_CAPABILITY_DESCRIPTORS[0],
    ]);
    expect(
      registry.getRegistrationSnapshot('messages.send.bluebubbles'),
    ).toMatchObject({
      state: 'tool_unregistered',
      toolRegistered: false,
      toolExposed: false,
      toolDispatchable: false,
      descriptor: { id: 'messages.send.bluebubbles' },
    });

    registry.registerToolBinding({
      capabilityId: 'messages.send.bluebubbles',
      toolId: 'host.messages.send.bluebubbles',
      execute: async () => ({ handled: true }),
    });
    expect(
      registry.getRegistrationSnapshot('messages.send.bluebubbles'),
    ).toMatchObject({
      state: 'tool_registered',
      toolRegistered: true,
      toolExposed: true,
      toolDispatchable: true,
      binding: { toolId: 'host.messages.send.bluebubbles' },
    });
    expect(
      resolveRuntimeCapabilitySourceChannels(
        registry.getRegistrationSnapshot('messages.send.bluebubbles'),
      ),
    ).toEqual(['telegram', 'bluebubbles']);
    expect(registry.getRegistrationSnapshot('missing.capability')).toEqual({
      capabilityId: 'missing.capability',
      state: 'capability_unregistered',
      toolRegistered: false,
      toolExposed: false,
      toolDispatchable: false,
    });
  });
});

describe('runtime capability outcome formatting', () => {
  it('claims success only from verified receipt evidence', () => {
    const exactContent =
      'Hi from Andrea — your aroma has entered its experimental era. 😄';
    const output = formatRuntimeCapabilityOutcome({
      state: 'verified_success',
      capabilityId: 'messages.send.bluebubbles',
      receipt: {
        verification: 'verified',
        providerReceiptId: 'message-123',
        recipient: 'Travis Story',
        exactContent,
        idempotencyKey: 'action-456',
      },
    });

    expect(output).toBe(
      `Sent to Travis Story: “${exactContent}” (verified receipt message-123).`,
    );
  });

  it('refuses a success claim when receipt evidence is incomplete at runtime', () => {
    const incompleteOutcome = {
      state: 'verified_success',
      capabilityId: 'messages.send.bluebubbles',
      receipt: {
        verification: 'verified',
        providerReceiptId: '',
        recipient: 'Travis Story',
        exactContent: 'hello',
      },
    } as RuntimeCapabilityOutcome;

    const output = formatRuntimeCapabilityOutcome(incompleteOutcome);
    expect(output).toContain('cannot verify');
    expect(output).not.toContain('Sent to');
  });

  it.each([
    {
      outcome: {
        state: 'execution_failure',
        capabilityId: 'messages.send.bluebubbles',
      } as RuntimeCapabilityOutcome,
      expected: 'failed before a verified result',
    },
    {
      outcome: {
        state: 'uncertain_outcome',
        capabilityId: 'messages.send.bluebubbles',
      } as RuntimeCapabilityOutcome,
      expected: 'outcome is uncertain',
    },
    {
      outcome: {
        state: 'ambiguous_entity',
        capabilityId: 'messages.send.bluebubbles',
        entity: 'Travis',
        candidates: ['Travis Story', 'Travis Smith'],
      } as RuntimeCapabilityOutcome,
      expected: 'Travis is ambiguous',
    },
  ])(
    'formats $outcome.state without a success claim',
    ({ outcome, expected }) => {
      const output = formatRuntimeCapabilityOutcome(outcome);
      expect(output).toContain(expected);
      expect(output).not.toContain('Sent to');
      expect(output).not.toContain('verified receipt');
    },
  );
});
