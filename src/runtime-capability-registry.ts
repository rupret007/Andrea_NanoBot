import type { BlueBubblesChannelControlSnapshot } from './types.js';

export type CapabilityActionEffect = 'read' | 'write';

export interface RuntimeCapabilityAction {
  readonly id: string;
  readonly effect: CapabilityActionEffect;
}

export type ToolRegistrationKind = 'host' | 'builtin' | 'mcp';

export interface CapabilityToolRegistration {
  readonly toolId: string;
  readonly kind: ToolRegistrationKind;
  readonly owner: 'channel' | 'integration' | 'runtime';
}

export interface CapabilityToolExposure {
  readonly mode: 'host_orchestrated' | 'direct_model' | 'host_and_model';
  readonly protected: boolean;
}

export interface CapabilityConfirmationPolicy {
  readonly mode: 'none' | 'explicit_request' | 'separate_confirmation';
  readonly actions: readonly string[];
}

export interface CapabilityWritePermission {
  readonly required: boolean;
  readonly scope?: string;
  readonly actions: readonly string[];
}

export interface CapabilityIdempotencyPolicy {
  readonly required: boolean;
  readonly strategy: 'none' | 'stable_action_key';
  readonly actions: readonly string[];
  readonly providerField?: string;
}

export type CapabilityReceiptEvidence =
  | 'provider_receipt_id'
  | 'recipient'
  | 'exact_content';

export interface CapabilityReceiptPolicy {
  readonly required: boolean;
  readonly actions: readonly string[];
  readonly requiredEvidence: readonly CapabilityReceiptEvidence[];
}

export interface RuntimeCapabilityDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly provider: string;
  readonly toolRegistration: CapabilityToolRegistration;
  readonly toolExposure: CapabilityToolExposure;
  readonly supportedActions: readonly RuntimeCapabilityAction[];
  readonly sourceChannels: readonly string[];
  readonly confirmationPolicy: CapabilityConfirmationPolicy;
  readonly writePermission: CapabilityWritePermission;
  readonly idempotency: CapabilityIdempotencyPolicy;
  readonly receipt: CapabilityReceiptPolicy;
  readonly response: {
    readonly verifiedVerb: string;
    readonly targetPreposition: string;
  };
}

export interface RuntimeCapabilityToolBinding {
  readonly capabilityId: string;
  readonly toolId: string;
  readonly execute: (request: unknown) => Promise<unknown> | unknown;
}

export type RuntimeCapabilityImplementationReference = (
  ...args: never[]
) => unknown;

export interface RuntimeCapabilityToolSurfaceAction {
  readonly id: string;
  readonly implementations: readonly RuntimeCapabilityImplementationReference[];
}

/**
 * A real production function surface that implements a capability contract.
 * A surface proves registration and exposure; it does not transfer execution
 * ownership to the registry. Registry-owned dispatch remains an explicit,
 * separate tool binding.
 */
export interface RuntimeCapabilityToolSurface {
  readonly capabilityId: string;
  readonly toolId: string;
  readonly actions: readonly RuntimeCapabilityToolSurfaceAction[];
  readonly sourceChannels: readonly string[];
}

export interface RuntimeCapabilityBindingReplacementContext {
  /** Stable operator, subsystem, or deployment identity requesting replacement. */
  readonly actor: string;
  /** Human-readable reason retained in the in-process replacement audit. */
  readonly reason: string;
  /** Injectable for deterministic tests; defaults to the current wall clock. */
  readonly replacedAt?: string;
}

export interface RuntimeCapabilityBindingReplacementAudit {
  readonly sequence: number;
  readonly capabilityId: string;
  readonly previousToolId: string;
  readonly replacementToolId: string;
  readonly actor: string;
  readonly reason: string;
  readonly replacedAt: string;
}

export type RuntimeCapabilityRegistrationState =
  | 'capability_unregistered'
  | 'tool_unregistered'
  | 'tool_registered';

/**
 * Point-in-time registry truth. A descriptor declares a contract. A validated
 * production surface proves that the contract is registered and exposed in
 * this process; a binding additionally proves that the registry owns dispatch.
 */
export interface RuntimeCapabilityRegistrationSnapshot {
  readonly capabilityId: string;
  readonly state: RuntimeCapabilityRegistrationState;
  readonly descriptor?: RuntimeCapabilityDescriptor;
  readonly surface?: RuntimeCapabilityToolSurface;
  readonly binding?: RuntimeCapabilityToolBinding;
  readonly toolRegistered: boolean;
  readonly toolExposed: boolean;
  readonly toolDispatchable: boolean;
}

/**
 * Returns the channel contract implemented by the most concrete registered
 * source. A production surface may intentionally narrow the descriptor; a
 * binding-only capability uses the descriptor because the binding has no
 * independent channel metadata.
 */
export function resolveRuntimeCapabilitySourceChannels(
  registration: Pick<
    RuntimeCapabilityRegistrationSnapshot,
    'descriptor' | 'surface'
  >,
): readonly string[] {
  return (
    registration.surface?.sourceChannels ??
    registration.descriptor?.sourceChannels ??
    []
  );
}

/**
 * The default registry is the declarative source of truth shared by routing,
 * preflight, execution, and outcome presentation. Runtime facts (registration,
 * exposure, provider health, permission, and confirmation) are deliberately
 * supplied separately because they can change without changing a capability's
 * contract.
 */
const DEFAULT_RUNTIME_CAPABILITY_DESCRIPTOR_INPUTS = [
  {
    id: 'messages.send.bluebubbles',
    displayName: 'Send iMessage via BlueBubbles',
    provider: 'bluebubbles',
    toolRegistration: {
      toolId: 'host.messages.send.bluebubbles',
      kind: 'host',
      owner: 'channel',
    },
    toolExposure: {
      mode: 'host_orchestrated',
      protected: true,
    },
    supportedActions: [{ id: 'send', effect: 'write' }],
    sourceChannels: ['telegram', 'bluebubbles'],
    confirmationPolicy: {
      mode: 'explicit_request',
      actions: ['send'],
    },
    writePermission: {
      required: true,
      scope: 'bluebubbles:send',
      actions: ['send'],
    },
    idempotency: {
      required: true,
      strategy: 'stable_action_key',
      actions: ['send'],
      providerField: 'tempGuid',
    },
    receipt: {
      required: true,
      actions: ['send'],
      requiredEvidence: ['provider_receipt_id', 'recipient', 'exact_content'],
    },
    response: {
      verifiedVerb: 'Sent',
      targetPreposition: 'to',
    },
  },
  {
    id: 'messages.send.telegram',
    displayName: 'Send Telegram messages',
    provider: 'telegram',
    toolRegistration: {
      toolId: 'host.messages.send.telegram',
      kind: 'host',
      owner: 'channel',
    },
    toolExposure: {
      mode: 'host_orchestrated',
      protected: true,
    },
    supportedActions: [{ id: 'send', effect: 'write' }],
    sourceChannels: ['telegram', 'bluebubbles', 'direct'],
    confirmationPolicy: {
      mode: 'explicit_request',
      actions: ['send'],
    },
    writePermission: {
      required: true,
      scope: 'telegram:send',
      actions: ['send'],
    },
    idempotency: {
      required: true,
      strategy: 'stable_action_key',
      actions: ['send'],
      providerField: 'idempotencyKey',
    },
    receipt: {
      required: true,
      actions: ['send'],
      requiredEvidence: ['provider_receipt_id', 'recipient', 'exact_content'],
    },
    response: {
      verifiedVerb: 'Sent',
      targetPreposition: 'to',
    },
  },
  {
    id: 'calendar.events.google',
    displayName: 'Read and update Google Calendar events',
    provider: 'google_calendar',
    toolRegistration: {
      toolId: 'host.calendar.google.events',
      kind: 'host',
      owner: 'integration',
    },
    toolExposure: {
      mode: 'host_orchestrated',
      protected: true,
    },
    supportedActions: [
      { id: 'list', effect: 'read' },
      { id: 'create', effect: 'write' },
      { id: 'update', effect: 'write' },
      { id: 'delete', effect: 'write' },
    ],
    sourceChannels: ['telegram', 'bluebubbles', 'direct'],
    confirmationPolicy: {
      mode: 'explicit_request',
      actions: ['create', 'update', 'delete'],
    },
    writePermission: {
      required: true,
      scope: 'calendar:write',
      actions: ['create', 'update', 'delete'],
    },
    idempotency: {
      required: true,
      strategy: 'stable_action_key',
      actions: ['create', 'update', 'delete'],
      providerField: 'requestId',
    },
    receipt: {
      required: true,
      actions: ['create', 'update', 'delete'],
      requiredEvidence: ['provider_receipt_id', 'recipient', 'exact_content'],
    },
    response: {
      verifiedVerb: 'Updated',
      targetPreposition: 'for',
    },
  },
  {
    id: 'reminders.local',
    displayName: 'Manage internal reminders and follow-ups',
    provider: 'local_reminders',
    toolRegistration: {
      toolId: 'host.reminders.local',
      kind: 'host',
      owner: 'runtime',
    },
    toolExposure: {
      mode: 'host_orchestrated',
      protected: true,
    },
    supportedActions: [
      { id: 'list', effect: 'read' },
      { id: 'create', effect: 'write' },
      { id: 'complete', effect: 'write' },
      { id: 'delete', effect: 'write' },
    ],
    sourceChannels: ['telegram', 'bluebubbles', 'direct'],
    confirmationPolicy: {
      mode: 'explicit_request',
      actions: ['create', 'complete', 'delete'],
    },
    writePermission: {
      required: true,
      scope: 'reminders:write',
      actions: ['create', 'complete', 'delete'],
    },
    idempotency: {
      required: true,
      strategy: 'stable_action_key',
      actions: ['create', 'complete', 'delete'],
      providerField: 'actionKey',
    },
    receipt: {
      required: true,
      actions: ['create', 'complete', 'delete'],
      requiredEvidence: ['provider_receipt_id', 'recipient', 'exact_content'],
    },
    response: {
      verifiedVerb: 'Updated',
      targetPreposition: 'for',
    },
  },
  {
    id: 'research.web',
    displayName: 'Research the web',
    provider: 'web_research',
    toolRegistration: {
      toolId: 'builtin.research.web',
      kind: 'builtin',
      owner: 'runtime',
    },
    toolExposure: {
      mode: 'direct_model',
      protected: false,
    },
    supportedActions: [
      { id: 'search', effect: 'read' },
      { id: 'open', effect: 'read' },
    ],
    sourceChannels: ['alexa', 'telegram'],
    confirmationPolicy: {
      mode: 'none',
      actions: [],
    },
    writePermission: {
      required: false,
      actions: [],
    },
    idempotency: {
      required: false,
      strategy: 'none',
      actions: [],
    },
    receipt: {
      required: false,
      actions: [],
      requiredEvidence: [],
    },
    response: {
      verifiedVerb: 'Researched',
      targetPreposition: 'for',
    },
  },
] as const satisfies readonly RuntimeCapabilityDescriptor[];

function normalizeRuntimeCapabilityDescriptor(
  descriptor: RuntimeCapabilityDescriptor,
): RuntimeCapabilityDescriptor {
  return Object.freeze({
    id: descriptor.id,
    displayName: descriptor.displayName,
    provider: descriptor.provider,
    toolRegistration: Object.freeze({
      toolId: descriptor.toolRegistration.toolId,
      kind: descriptor.toolRegistration.kind,
      owner: descriptor.toolRegistration.owner,
    }),
    toolExposure: Object.freeze({
      mode: descriptor.toolExposure.mode,
      protected: descriptor.toolExposure.protected,
    }),
    supportedActions: Object.freeze(
      descriptor.supportedActions.map((action) =>
        Object.freeze({ id: action.id, effect: action.effect }),
      ),
    ),
    sourceChannels: Object.freeze([...descriptor.sourceChannels]),
    confirmationPolicy: Object.freeze({
      mode: descriptor.confirmationPolicy.mode,
      actions: Object.freeze([...descriptor.confirmationPolicy.actions]),
    }),
    writePermission: Object.freeze({
      required: descriptor.writePermission.required,
      scope: descriptor.writePermission.scope,
      actions: Object.freeze([...descriptor.writePermission.actions]),
    }),
    idempotency: Object.freeze({
      required: descriptor.idempotency.required,
      strategy: descriptor.idempotency.strategy,
      actions: Object.freeze([...descriptor.idempotency.actions]),
      providerField: descriptor.idempotency.providerField,
    }),
    receipt: Object.freeze({
      required: descriptor.receipt.required,
      actions: Object.freeze([...descriptor.receipt.actions]),
      requiredEvidence: Object.freeze([...descriptor.receipt.requiredEvidence]),
    }),
    response: Object.freeze({
      verifiedVerb: descriptor.response.verifiedVerb,
      targetPreposition: descriptor.response.targetPreposition,
    }),
  });
}

function normalizeRuntimeCapabilityToolBinding(
  binding: RuntimeCapabilityToolBinding,
): RuntimeCapabilityToolBinding {
  return Object.freeze({
    capabilityId: binding.capabilityId,
    toolId: binding.toolId,
    execute: binding.execute,
  });
}

function normalizeRuntimeCapabilityToolSurface(
  surface: RuntimeCapabilityToolSurface,
): RuntimeCapabilityToolSurface {
  return Object.freeze({
    capabilityId: surface.capabilityId,
    toolId: surface.toolId,
    actions: Object.freeze(
      surface.actions.map((action) =>
        Object.freeze({
          id: action.id,
          implementations: Object.freeze([...action.implementations]),
        }),
      ),
    ),
    sourceChannels: Object.freeze([...surface.sourceChannels]),
  });
}

export const DEFAULT_RUNTIME_CAPABILITY_DESCRIPTORS: readonly RuntimeCapabilityDescriptor[] =
  Object.freeze(
    DEFAULT_RUNTIME_CAPABILITY_DESCRIPTOR_INPUTS.map(
      normalizeRuntimeCapabilityDescriptor,
    ),
  );

export type RuntimeProviderHealth =
  | 'healthy'
  | 'degraded'
  | 'unhealthy'
  | 'unknown';

export interface RuntimeCapabilityFacts {
  toolRegistered: boolean;
  toolExposed: boolean;
  providerHealth: RuntimeProviderHealth;
  writePermission: 'granted' | 'missing' | 'not_required';
  confirmation: 'satisfied' | 'missing' | 'not_required';
}

export interface RuntimeCapabilityRequest {
  capabilityId: string;
  action: string;
  sourceChannel: string;
}

export type UnavailableCapabilityReason =
  | 'capability_unregistered'
  | 'tool_unregistered'
  | 'tool_unexposed'
  | 'unsupported_action'
  | 'unsupported_source_channel';

export type RuntimeCapabilityEvaluation =
  | {
      state: 'available';
      descriptor: RuntimeCapabilityDescriptor;
      action: RuntimeCapabilityAction;
    }
  | {
      state: 'unavailable_capability';
      reason: UnavailableCapabilityReason;
      descriptor?: RuntimeCapabilityDescriptor;
    }
  | {
      state: 'unhealthy_provider';
      provider: string;
      health: RuntimeProviderHealth;
      descriptor: RuntimeCapabilityDescriptor;
    }
  | {
      state: 'missing_permission';
      permissionScope?: string;
      descriptor: RuntimeCapabilityDescriptor;
    }
  | {
      state: 'confirmation_required';
      policy: CapabilityConfirmationPolicy['mode'];
      descriptor: RuntimeCapabilityDescriptor;
    };

function appliesToAction(actions: readonly string[], action: string): boolean {
  return actions.includes(action);
}

export class RuntimeCapabilityRegistry {
  private readonly byId: ReadonlyMap<string, RuntimeCapabilityDescriptor>;

  private readonly surfaces = new Map<string, RuntimeCapabilityToolSurface>();

  private readonly bindings = new Map<string, RuntimeCapabilityToolBinding>();

  private readonly bindingReplacementAudits: RuntimeCapabilityBindingReplacementAudit[] =
    [];

  constructor(descriptors: readonly RuntimeCapabilityDescriptor[]) {
    const entries = descriptors.map(
      (descriptor) =>
        [
          descriptor.id,
          normalizeRuntimeCapabilityDescriptor(descriptor),
        ] as const,
    );
    if (new Set(entries.map(([id]) => id)).size !== entries.length) {
      throw new Error('Runtime capability ids must be unique');
    }
    this.byId = new Map(entries);
  }

  get(capabilityId: string): RuntimeCapabilityDescriptor | undefined {
    return this.byId.get(capabilityId);
  }

  list(): readonly RuntimeCapabilityDescriptor[] {
    return Object.freeze([...this.byId.values()]);
  }

  private validateToolBinding(
    binding: RuntimeCapabilityToolBinding,
  ): RuntimeCapabilityDescriptor {
    const descriptor = this.get(binding.capabilityId);
    if (!descriptor) {
      throw new Error(`Cannot bind unknown capability ${binding.capabilityId}`);
    }
    if (descriptor.toolRegistration.toolId !== binding.toolId) {
      throw new Error(
        `Capability ${binding.capabilityId} requires tool ${descriptor.toolRegistration.toolId}`,
      );
    }
    if (typeof binding.execute !== 'function') {
      throw new Error(
        `Capability ${binding.capabilityId} requires an executable tool binding`,
      );
    }
    return descriptor;
  }

  registerToolBinding(binding: RuntimeCapabilityToolBinding): void {
    this.validateToolBinding(binding);
    if (this.bindings.has(binding.capabilityId)) {
      throw new Error(
        `Capability ${binding.capabilityId} already has a registered tool binding; use replaceToolBinding with audit context to replace it`,
      );
    }
    this.bindings.set(
      binding.capabilityId,
      normalizeRuntimeCapabilityToolBinding(binding),
    );
  }

  /**
   * Replaces an existing binding through an explicit, auditable path. This is
   * intentionally separate from registration so module reloads and competing
   * owners cannot silently take over an authoritative capability.
   */
  replaceToolBinding(
    binding: RuntimeCapabilityToolBinding,
    context: RuntimeCapabilityBindingReplacementContext,
  ): RuntimeCapabilityBindingReplacementAudit {
    this.validateToolBinding(binding);
    const previous = this.bindings.get(binding.capabilityId);
    if (!previous) {
      throw new Error(
        `Capability ${binding.capabilityId} has no registered tool binding to replace`,
      );
    }
    const actor = context.actor.trim();
    const reason = context.reason.trim();
    if (!actor || !reason) {
      throw new Error(
        'Tool binding replacement requires non-empty actor and reason audit context',
      );
    }
    const replacedAt = context.replacedAt ?? new Date().toISOString();
    if (!replacedAt.trim() || !Number.isFinite(Date.parse(replacedAt))) {
      throw new Error(
        'Tool binding replacement requires a valid replacedAt audit timestamp',
      );
    }

    const replacement = normalizeRuntimeCapabilityToolBinding(binding);
    const audit: RuntimeCapabilityBindingReplacementAudit = Object.freeze({
      sequence: this.bindingReplacementAudits.length + 1,
      capabilityId: binding.capabilityId,
      previousToolId: previous.toolId,
      replacementToolId: replacement.toolId,
      actor,
      reason,
      replacedAt,
    });
    this.bindings.set(binding.capabilityId, replacement);
    this.bindingReplacementAudits.push(audit);
    return audit;
  }

  listToolBindingReplacementAudits(): readonly RuntimeCapabilityBindingReplacementAudit[] {
    return Object.freeze([...this.bindingReplacementAudits]);
  }

  getToolBinding(
    capabilityId: string,
  ): RuntimeCapabilityToolBinding | undefined {
    return this.bindings.get(capabilityId);
  }

  private validateToolSurface(
    surface: RuntimeCapabilityToolSurface,
  ): RuntimeCapabilityDescriptor {
    const descriptor = this.get(surface.capabilityId);
    if (!descriptor) {
      throw new Error(
        `Cannot register a tool surface for unknown capability ${surface.capabilityId}`,
      );
    }
    if (descriptor.toolRegistration.toolId !== surface.toolId) {
      throw new Error(
        `Capability ${surface.capabilityId} requires tool ${descriptor.toolRegistration.toolId}`,
      );
    }

    const actionIds = surface.actions.map((action) => action.id);
    if (new Set(actionIds).size !== actionIds.length) {
      throw new Error(
        `Capability ${surface.capabilityId} tool surface action ids must be unique`,
      );
    }
    for (const action of surface.actions) {
      if (!action.implementations.length) {
        throw new Error(
          `Capability ${surface.capabilityId} action ${action.id || '<empty>'} requires at least one production implementation reference`,
        );
      }
      if (
        action.implementations.some(
          (implementation) => typeof implementation !== 'function',
        )
      ) {
        throw new Error(
          `Capability ${surface.capabilityId} action ${action.id || '<empty>'} requires production implementation functions`,
        );
      }
      if (
        new Set(action.implementations).size !== action.implementations.length
      ) {
        throw new Error(
          `Capability ${surface.capabilityId} action ${action.id || '<empty>'} production implementation references must be unique`,
        );
      }
    }
    const expectedActionIds = descriptor.supportedActions.map(
      (action) => action.id,
    );
    const missingActionIds = expectedActionIds.filter(
      (actionId) => !actionIds.includes(actionId),
    );
    const extraActionIds = actionIds.filter(
      (actionId) => !expectedActionIds.includes(actionId),
    );
    if (missingActionIds.length || extraActionIds.length) {
      throw new Error(
        `Capability ${surface.capabilityId} tool surface must map exactly its declared actions (missing: ${missingActionIds.join(', ') || 'none'}; extra: ${extraActionIds.join(', ') || 'none'})`,
      );
    }

    if (!surface.sourceChannels.length) {
      throw new Error(
        `Capability ${surface.capabilityId} tool surface requires at least one source channel`,
      );
    }
    if (
      new Set(surface.sourceChannels).size !== surface.sourceChannels.length
    ) {
      throw new Error(
        `Capability ${surface.capabilityId} tool surface source channels must be unique`,
      );
    }
    const unsupportedChannels = surface.sourceChannels.filter(
      (channel) => !descriptor.sourceChannels.includes(channel),
    );
    if (unsupportedChannels.length) {
      throw new Error(
        `Capability ${surface.capabilityId} tool surface contains unsupported source channels: ${unsupportedChannels.join(', ')}`,
      );
    }
    return descriptor;
  }

  registerToolSurface(surface: RuntimeCapabilityToolSurface): void {
    this.validateToolSurface(surface);
    if (this.surfaces.has(surface.capabilityId)) {
      throw new Error(
        `Capability ${surface.capabilityId} already has a registered tool surface`,
      );
    }
    this.surfaces.set(
      surface.capabilityId,
      normalizeRuntimeCapabilityToolSurface(surface),
    );
  }

  getToolSurface(
    capabilityId: string,
  ): RuntimeCapabilityToolSurface | undefined {
    return this.surfaces.get(capabilityId);
  }

  getRegistrationSnapshot(
    capabilityId: string,
  ): RuntimeCapabilityRegistrationSnapshot {
    const descriptor = this.get(capabilityId);
    if (!descriptor) {
      return Object.freeze({
        capabilityId,
        state: 'capability_unregistered',
        toolRegistered: false,
        toolExposed: false,
        toolDispatchable: false,
      });
    }
    const surface = this.getToolSurface(capabilityId);
    const binding = this.getToolBinding(capabilityId);
    if (!surface && !binding) {
      return Object.freeze({
        capabilityId,
        state: 'tool_unregistered',
        descriptor,
        toolRegistered: false,
        toolExposed: false,
        toolDispatchable: false,
      });
    }
    return Object.freeze({
      capabilityId,
      state: 'tool_registered',
      descriptor,
      ...(surface ? { surface } : {}),
      ...(binding ? { binding } : {}),
      toolRegistered: true,
      toolExposed: Boolean(
        surface?.sourceChannels.length ||
        (binding && descriptor.sourceChannels.length),
      ),
      toolDispatchable: Boolean(binding),
    });
  }

  evaluate(
    request: RuntimeCapabilityRequest,
    facts: RuntimeCapabilityFacts,
  ): RuntimeCapabilityEvaluation {
    const descriptor = this.get(request.capabilityId);
    if (!descriptor) {
      return {
        state: 'unavailable_capability',
        reason: 'capability_unregistered',
      };
    }

    const action = descriptor.supportedActions.find(
      (candidate) => candidate.id === request.action,
    );
    if (!action) {
      return {
        state: 'unavailable_capability',
        reason: 'unsupported_action',
        descriptor,
      };
    }
    if (!descriptor.sourceChannels.includes(request.sourceChannel)) {
      return {
        state: 'unavailable_capability',
        reason: 'unsupported_source_channel',
        descriptor,
      };
    }
    const registration = this.getRegistrationSnapshot(request.capabilityId);
    if (!registration.toolRegistered || !facts.toolRegistered) {
      return {
        state: 'unavailable_capability',
        reason: 'tool_unregistered',
        descriptor,
      };
    }
    if (
      registration.surface &&
      !registration.surface.sourceChannels.includes(request.sourceChannel)
    ) {
      return {
        state: 'unavailable_capability',
        reason: 'tool_unexposed',
        descriptor,
      };
    }
    if (!registration.toolExposed || !facts.toolExposed) {
      return {
        state: 'unavailable_capability',
        reason: 'tool_unexposed',
        descriptor,
      };
    }
    if (
      facts.providerHealth === 'unhealthy' ||
      facts.providerHealth === 'unknown'
    ) {
      return {
        state: 'unhealthy_provider',
        provider: descriptor.provider,
        health: facts.providerHealth,
        descriptor,
      };
    }
    if (
      action.effect === 'write' &&
      descriptor.writePermission.required &&
      appliesToAction(descriptor.writePermission.actions, action.id) &&
      facts.writePermission !== 'granted'
    ) {
      return {
        state: 'missing_permission',
        permissionScope: descriptor.writePermission.scope,
        descriptor,
      };
    }
    if (
      descriptor.confirmationPolicy.mode !== 'none' &&
      appliesToAction(descriptor.confirmationPolicy.actions, action.id) &&
      facts.confirmation !== 'satisfied'
    ) {
      return {
        state: 'confirmation_required',
        policy: descriptor.confirmationPolicy.mode,
        descriptor,
      };
    }
    return { state: 'available', descriptor, action };
  }
}

export const runtimeCapabilityRegistry = new RuntimeCapabilityRegistry(
  DEFAULT_RUNTIME_CAPABILITY_DESCRIPTORS,
);

export function evaluateRuntimeCapability(
  request: RuntimeCapabilityRequest,
  facts: RuntimeCapabilityFacts,
): RuntimeCapabilityEvaluation {
  return runtimeCapabilityRegistry.evaluate(request, facts);
}

export function buildBlueBubblesRuntimeCapabilityFacts(
  control: BlueBubblesChannelControlSnapshot | null,
  options: {
    explicitlyAuthorized: boolean;
    toolRegistered?: boolean;
    toolExposed?: boolean;
  },
  registry: RuntimeCapabilityRegistry = runtimeCapabilityRegistry,
): RuntimeCapabilityFacts {
  const registration = registry.getRegistrationSnapshot(
    'messages.send.bluebubbles',
  );
  const receiptInboxReady =
    control?.receiptInboxState === 'reachable' ||
    control?.receiptInboxState === 'not_required';
  const providerHealth: RuntimeProviderHealth = !control
    ? 'unhealthy'
    : control.transportState === 'not_checked'
      ? 'unknown'
      : control.enabled &&
          control.connected &&
          control.transportState === 'reachable' &&
          receiptInboxReady
        ? 'healthy'
        : 'unhealthy';
  return {
    toolRegistered:
      registration.toolRegistered && (options.toolRegistered ?? true),
    toolExposed: registration.toolExposed && (options.toolExposed ?? true),
    providerHealth,
    writePermission: control?.sendEnabled ? 'granted' : 'missing',
    confirmation: options.explicitlyAuthorized ? 'satisfied' : 'missing',
  };
}

export function formatRuntimeCapabilityEvaluation(
  evaluation: RuntimeCapabilityEvaluation,
): string | null {
  if (evaluation.state === 'available') return null;
  if (evaluation.state === 'unavailable_capability') {
    return `The requested capability is unavailable (${evaluation.reason.replace(/_/g, ' ')}). I did not execute or claim the action.`;
  }
  if (evaluation.state === 'unhealthy_provider') {
    return `The ${evaluation.provider} provider is ${evaluation.health}. I did not dispatch the action or claim success.`;
  }
  if (evaluation.state === 'missing_permission') {
    return `The capability is installed, but its required write permission${evaluation.permissionScope ? ` (${evaluation.permissionScope})` : ''} is missing. I did not dispatch the action.`;
  }
  return `The capability requires ${evaluation.policy.replace(/_/g, ' ')} before execution. I did not dispatch the action.`;
}

export type RuntimeCapabilityOutcomeState =
  | 'verified_success'
  | 'execution_failure'
  | 'uncertain_outcome'
  | 'ambiguous_entity';

export interface VerifiedRuntimeCapabilityReceipt {
  verification: 'verified';
  providerReceiptId: string;
  recipient: string;
  exactContent: string;
  recordedAt?: string;
  idempotencyKey?: string;
}

export type RuntimeCapabilityOutcome =
  | {
      state: 'verified_success';
      capabilityId: string;
      receipt: VerifiedRuntimeCapabilityReceipt;
    }
  | {
      state: 'execution_failure';
      capabilityId: string;
      message?: string;
      errorCode?: string;
    }
  | {
      state: 'uncertain_outcome';
      capabilityId: string;
      message?: string;
    }
  | {
      state: 'ambiguous_entity';
      capabilityId: string;
      entity: string;
      candidates?: readonly string[];
    };

export function hasVerifiedRuntimeReceiptEvidence(
  receipt: VerifiedRuntimeCapabilityReceipt | undefined,
): receipt is VerifiedRuntimeCapabilityReceipt {
  return Boolean(
    receipt &&
    receipt.verification === 'verified' &&
    receipt.providerReceiptId.trim() &&
    receipt.recipient.trim() &&
    receipt.exactContent.trim(),
  );
}

/**
 * Formats execution outcomes without allowing an unverified result to become a
 * success claim. Verified message results name both the resolved recipient and
 * the exact content that was sent.
 */
export function formatRuntimeCapabilityOutcome(
  outcome: RuntimeCapabilityOutcome,
  registry: RuntimeCapabilityRegistry = runtimeCapabilityRegistry,
): string {
  const descriptor = registry.get(outcome.capabilityId);

  if (outcome.state === 'verified_success') {
    if (!hasVerifiedRuntimeReceiptEvidence(outcome.receipt)) {
      return 'I cannot verify that the action completed, so I will not claim success.';
    }
    const verb = descriptor?.response.verifiedVerb || 'Completed';
    const preposition = descriptor?.response.targetPreposition || 'for';
    return `${verb} ${preposition} ${outcome.receipt.recipient}: “${outcome.receipt.exactContent}” (verified receipt ${outcome.receipt.providerReceiptId}).`;
  }

  if (outcome.state === 'ambiguous_entity') {
    const suffix = outcome.candidates?.length
      ? ` Candidates: ${outcome.candidates.join(', ')}.`
      : '';
    return `I could not execute the action because ${outcome.entity} is ambiguous.${suffix}`;
  }

  if (outcome.state === 'uncertain_outcome') {
    return (
      outcome.message ||
      'The provider outcome is uncertain. I will not retry or claim success without verification.'
    );
  }

  return (
    outcome.message ||
    'The action failed before a verified result was recorded.'
  );
}
