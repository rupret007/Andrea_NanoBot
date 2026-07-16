import { describe, expect, it } from 'vitest';

import './channels/index.js';

import { executeBlueBubblesOutboundRequest } from './bluebubbles-outbound-request.js';
import { executeBlueBubblesOutboundTurn } from './bluebubbles-outbound-turn.js';
import { getChannelFactory } from './channels/registry.js';
import { deleteTask, getAllTasks, updateTask } from './db.js';
import {
  createGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
  listGoogleCalendarEvents,
  updateGoogleCalendarEvent,
} from './google-calendar.js';
import { executeExplicitlyAuthorizedMessageAction } from './message-actions.js';
import { persistReminderOperation } from './reminder-operation.js';
import { runResearchOrchestrator } from './research-orchestrator.js';
import { registerProductionRuntimeCapabilitySurfaces } from './runtime-capability-production-surfaces.js';
import {
  DEFAULT_RUNTIME_CAPABILITY_DESCRIPTORS,
  RuntimeCapabilityRegistry,
  runtimeCapabilityRegistry,
} from './runtime-capability-registry.js';

function freshRegistry(): RuntimeCapabilityRegistry {
  return new RuntimeCapabilityRegistry(DEFAULT_RUNTIME_CAPABILITY_DESCRIPTORS);
}

describe('production runtime capability surfaces', () => {
  it('does not mutate the default registry merely by being imported', () => {
    for (const descriptor of DEFAULT_RUNTIME_CAPABILITY_DESCRIPTORS) {
      expect(
        runtimeCapabilityRegistry.getRegistrationSnapshot(descriptor.id),
      ).toMatchObject({
        state: 'tool_unregistered',
        toolRegistered: false,
        toolExposed: false,
        toolDispatchable: false,
      });
    }
  });

  it('composes only real production functions and keeps dispatch ownership truthful', () => {
    const registry =
      registerProductionRuntimeCapabilitySurfaces(freshRegistry());
    const telegramFactory = getChannelFactory('telegram');
    expect(telegramFactory).toBeTypeOf('function');

    const blueBubbles = registry.getRegistrationSnapshot(
      'messages.send.bluebubbles',
    );
    expect(blueBubbles).toMatchObject({
      state: 'tool_registered',
      toolRegistered: true,
      toolExposed: true,
      toolDispatchable: true,
      binding: { toolId: 'host.messages.send.bluebubbles' },
      surface: {
        actions: [{ id: 'send' }],
        sourceChannels: ['telegram', 'bluebubbles'],
      },
    });
    expect(blueBubbles.binding?.execute).toBe(
      executeBlueBubblesOutboundRequest,
    );
    expect(blueBubbles.surface?.actions[0]?.implementations).toEqual([
      executeBlueBubblesOutboundTurn,
      executeBlueBubblesOutboundRequest,
    ]);

    const telegram = registry.getRegistrationSnapshot('messages.send.telegram');
    expect(telegram).toMatchObject({
      state: 'tool_registered',
      toolDispatchable: false,
      surface: {
        actions: [{ id: 'send' }],
      },
    });
    expect(telegram.surface?.actions[0]?.implementations).toEqual([
      executeExplicitlyAuthorizedMessageAction,
      telegramFactory,
    ]);
    expect(telegram.binding).toBeUndefined();

    expect(
      registry
        .getToolSurface('calendar.events.google')
        ?.actions.map(({ id, implementations }) => [id, implementations[0]]),
    ).toEqual([
      ['list', listGoogleCalendarEvents],
      ['create', createGoogleCalendarEvent],
      ['update', updateGoogleCalendarEvent],
      ['delete', deleteGoogleCalendarEvent],
    ]);
    expect(
      registry
        .getToolSurface('reminders.local')
        ?.actions.map(({ id, implementations }) => [id, implementations[0]]),
    ).toEqual([
      ['list', getAllTasks],
      ['create', persistReminderOperation],
      ['complete', updateTask],
      ['delete', deleteTask],
    ]);
    expect(
      registry
        .getToolSurface('research.web')
        ?.actions.map(({ id, implementations }) => [id, implementations[0]]),
    ).toEqual([
      ['search', runResearchOrchestrator],
      ['open', runResearchOrchestrator],
    ]);
    expect(registry.getToolSurface('research.web')?.sourceChannels).toEqual([
      'alexa',
      'telegram',
    ]);

    for (const capabilityId of [
      'messages.send.telegram',
      'calendar.events.google',
      'reminders.local',
      'research.web',
    ]) {
      expect(registry.getRegistrationSnapshot(capabilityId)).toMatchObject({
        toolRegistered: true,
        toolExposed: true,
        toolDispatchable: false,
      });
      expect(registry.getToolBinding(capabilityId)).toBeUndefined();
    }
  });

  it('is idempotent for identical production references and rejects a conflicting surface', () => {
    const registry = freshRegistry();
    expect(registerProductionRuntimeCapabilitySurfaces(registry)).toBe(
      registry,
    );
    const binding = registry.getToolBinding('messages.send.bluebubbles');
    const blueBubblesSurface = registry.getToolSurface(
      'messages.send.bluebubbles',
    );
    const telegramSurface = registry.getToolSurface('messages.send.telegram');
    expect(registerProductionRuntimeCapabilitySurfaces(registry)).toBe(
      registry,
    );
    expect(registry.getToolBinding('messages.send.bluebubbles')).toBe(binding);
    expect(registry.getToolSurface('messages.send.bluebubbles')).toBe(
      blueBubblesSurface,
    );
    expect(registry.getToolSurface('messages.send.telegram')).toBe(
      telegramSurface,
    );

    const conflicting = freshRegistry();
    conflicting.registerToolSurface({
      capabilityId: 'messages.send.telegram',
      toolId: 'host.messages.send.telegram',
      actions: [{ id: 'send', implementations: [async () => undefined] }],
      sourceChannels: ['telegram', 'bluebubbles', 'direct'],
    });
    expect(() =>
      registerProductionRuntimeCapabilitySurfaces(conflicting),
    ).toThrow('already has a conflicting tool surface');
    expect(
      conflicting.getToolBinding('messages.send.bluebubbles'),
    ).toBeUndefined();

    const bindingConflict = freshRegistry();
    bindingConflict.registerToolBinding({
      capabilityId: 'messages.send.bluebubbles',
      toolId: 'host.messages.send.bluebubbles',
      execute: async () => ({ conflicting: true }),
    });
    expect(() =>
      registerProductionRuntimeCapabilitySurfaces(bindingConflict),
    ).toThrow('already has a conflicting registry-owned binding');
    expect(
      bindingConflict.getToolSurface('messages.send.telegram'),
    ).toBeUndefined();
  });
});
