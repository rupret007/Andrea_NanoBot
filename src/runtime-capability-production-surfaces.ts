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
import {
  RuntimeCapabilityRegistry,
  runtimeCapabilityRegistry,
  type RuntimeCapabilityToolBinding,
  type RuntimeCapabilityToolSurface,
} from './runtime-capability-registry.js';

const BLUEBUBBLES_PRODUCTION_SOURCE_CHANNELS = [
  'telegram',
  'bluebubbles',
] as const;

function sourceChannelsFor(
  registry: RuntimeCapabilityRegistry,
  capabilityId: string,
): readonly string[] {
  const descriptor = registry.get(capabilityId);
  if (!descriptor) {
    throw new Error(
      `Production runtime composition requires capability ${capabilityId}`,
    );
  }
  return [...descriptor.sourceChannels];
}

function sameOrderedStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function assertProductionSurfaceCompatible(
  registry: RuntimeCapabilityRegistry,
  surface: RuntimeCapabilityToolSurface,
): void {
  const existing = registry.getToolSurface(surface.capabilityId);
  if (!existing) return;

  const sameActions =
    existing.actions.length === surface.actions.length &&
    existing.actions.every(
      (action, index) =>
        action.id === surface.actions[index]?.id &&
        action.implementations.length ===
          surface.actions[index]!.implementations.length &&
        action.implementations.every(
          (implementation, implementationIndex) =>
            implementation ===
            surface.actions[index]!.implementations[implementationIndex],
        ),
    );
  if (
    existing.toolId !== surface.toolId ||
    !sameActions ||
    !sameOrderedStrings(existing.sourceChannels, surface.sourceChannels)
  ) {
    throw new Error(
      `Capability ${surface.capabilityId} already has a conflicting tool surface`,
    );
  }
}

function assertBlueBubblesBindingCompatible(
  registry: RuntimeCapabilityRegistry,
  binding: RuntimeCapabilityToolBinding,
): void {
  const existing = registry.getToolBinding(binding.capabilityId);
  if (!existing) return;
  if (
    existing.toolId !== binding.toolId ||
    existing.execute !== binding.execute
  ) {
    throw new Error(
      `Capability ${binding.capabilityId} already has a conflicting registry-owned binding`,
    );
  }
}

/**
 * Registers the real functions exposed by the production process. Importing
 * this module does not mutate the registry; composition roots call this helper
 * explicitly. BlueBubbles additionally owns registry dispatch. The other
 * entries are observational surfaces for existing host-owned execution paths.
 */
export function registerProductionRuntimeCapabilitySurfaces(
  registry: RuntimeCapabilityRegistry = runtimeCapabilityRegistry,
): RuntimeCapabilityRegistry {
  const telegramChannelFactory = getChannelFactory('telegram');
  if (!telegramChannelFactory) {
    throw new Error(
      'Production runtime composition requires the installed Telegram channel factory',
    );
  }

  const blueBubblesBinding: RuntimeCapabilityToolBinding = {
    capabilityId: 'messages.send.bluebubbles',
    toolId: 'host.messages.send.bluebubbles',
    execute:
      executeBlueBubblesOutboundRequest as RuntimeCapabilityToolBinding['execute'],
  };
  const surfaces: RuntimeCapabilityToolSurface[] = [
    {
      capabilityId: 'messages.send.bluebubbles',
      toolId: 'host.messages.send.bluebubbles',
      actions: [
        {
          id: 'send',
          implementations: [
            executeBlueBubblesOutboundTurn,
            executeBlueBubblesOutboundRequest,
          ],
        },
      ],
      sourceChannels: BLUEBUBBLES_PRODUCTION_SOURCE_CHANNELS,
    },
    {
      capabilityId: 'messages.send.telegram',
      toolId: 'host.messages.send.telegram',
      actions: [
        {
          id: 'send',
          implementations: [
            executeExplicitlyAuthorizedMessageAction,
            telegramChannelFactory,
          ],
        },
      ],
      sourceChannels: sourceChannelsFor(registry, 'messages.send.telegram'),
    },
    {
      capabilityId: 'calendar.events.google',
      toolId: 'host.calendar.google.events',
      actions: [
        { id: 'list', implementations: [listGoogleCalendarEvents] },
        { id: 'create', implementations: [createGoogleCalendarEvent] },
        { id: 'update', implementations: [updateGoogleCalendarEvent] },
        { id: 'delete', implementations: [deleteGoogleCalendarEvent] },
      ],
      sourceChannels: sourceChannelsFor(registry, 'calendar.events.google'),
    },
    {
      capabilityId: 'reminders.local',
      toolId: 'host.reminders.local',
      actions: [
        { id: 'list', implementations: [getAllTasks] },
        { id: 'create', implementations: [persistReminderOperation] },
        { id: 'complete', implementations: [updateTask] },
        { id: 'delete', implementations: [deleteTask] },
      ],
      sourceChannels: sourceChannelsFor(registry, 'reminders.local'),
    },
    {
      capabilityId: 'research.web',
      toolId: 'builtin.research.web',
      actions: [
        { id: 'search', implementations: [runResearchOrchestrator] },
        { id: 'open', implementations: [runResearchOrchestrator] },
      ],
      sourceChannels: sourceChannelsFor(registry, 'research.web'),
    },
  ];

  assertBlueBubblesBindingCompatible(registry, blueBubblesBinding);
  for (const surface of surfaces) {
    assertProductionSurfaceCompatible(registry, surface);
  }

  // Validate the complete desired composition before mutating the target so a
  // custom or drifted descriptor cannot leave a partially composed registry.
  const validationRegistry = new RuntimeCapabilityRegistry(registry.list());
  validationRegistry.registerToolBinding(blueBubblesBinding);
  for (const surface of surfaces) {
    validationRegistry.registerToolSurface(surface);
  }

  if (!registry.getToolBinding(blueBubblesBinding.capabilityId)) {
    registry.registerToolBinding(blueBubblesBinding);
  }
  for (const surface of surfaces) {
    if (!registry.getToolSurface(surface.capabilityId)) {
      registry.registerToolSurface(surface);
    }
  }

  return registry;
}
