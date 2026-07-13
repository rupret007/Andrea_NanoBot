export type DurablePolicyEffectClass =
  | 'read_only'
  | 'repository_write'
  | 'local_write'
  | 'external_effect';

export interface DurableActionPolicy {
  readonly allowedEffects: readonly DurablePolicyEffectClass[];
  readonly requiresApproval: boolean;
}

const READ_ONLY: DurableActionPolicy = Object.freeze({
  allowedEffects: Object.freeze(['read_only'] as const),
  requiresApproval: false,
});
const LOCAL_WRITE: DurableActionPolicy = Object.freeze({
  allowedEffects: Object.freeze(['local_write'] as const),
  requiresApproval: false,
});
const REPOSITORY_WRITE: DurableActionPolicy = Object.freeze({
  allowedEffects: Object.freeze(['repository_write'] as const),
  requiresApproval: true,
});
const EXTERNAL_EFFECT: DurableActionPolicy = Object.freeze({
  allowedEffects: Object.freeze(['external_effect'] as const),
  requiresApproval: true,
});
const APPROVED_LOCAL_WRITE: DurableActionPolicy = Object.freeze({
  allowedEffects: Object.freeze(['local_write'] as const),
  requiresApproval: true,
});

const ACTION_POLICIES = Object.freeze({
  repository_read: READ_ONLY,
  repository_state: READ_ONLY,
  verification_test: READ_ONLY,
  verification_typecheck: READ_ONLY,
  verification_build: READ_ONLY,
  verification_lint: READ_ONLY,
  verification_format: READ_ONLY,
  research_collect: READ_ONLY,
  calendar_plan: READ_ONLY,
  provider_primary: READ_ONLY,
  provider_fallback: READ_ONLY,
  local_lookup: READ_ONLY,
  read_only_integration: READ_ONLY,
  council: READ_ONLY,
  approval_gate: READ_ONLY,
  local_save: LOCAL_WRITE,
  research_synthesis: LOCAL_WRITE,
  local_delivery_record: LOCAL_WRITE,
  draft: LOCAL_WRITE,
  repository_write: REPOSITORY_WRITE,
  edit_file: REPOSITORY_WRITE,
  commit: REPOSITORY_WRITE,
  migration: REPOSITORY_WRITE,
  dependency_change: REPOSITORY_WRITE,
  send: EXTERNAL_EFFECT,
  calendar_write: EXTERNAL_EFFECT,
  purchase: EXTERNAL_EFFECT,
  admin: EXTERNAL_EFFECT,
  deploy: EXTERNAL_EFFECT,
  delete: EXTERNAL_EFFECT,
  push: EXTERNAL_EFFECT,
  external_effect: EXTERNAL_EFFECT,
  operator_change: APPROVED_LOCAL_WRITE,
} satisfies Record<string, DurableActionPolicy>);

export type DurableActionClass = keyof typeof ACTION_POLICIES;

const APPROVAL_BOUND_ACTION_CLASSES = Object.freeze(
  (Object.keys(ACTION_POLICIES) as DurableActionClass[]).filter(
    (actionClass) => ACTION_POLICIES[actionClass].requiresApproval,
  ),
);

export function durableApprovalBoundActionClasses(): readonly DurableActionClass[] {
  return APPROVAL_BOUND_ACTION_CLASSES;
}

export function durableActionPolicy(
  actionClass: string,
): DurableActionPolicy | null {
  return ACTION_POLICIES[actionClass as DurableActionClass] || null;
}

export function durableActionRequiresApproval(actionClass: string): boolean {
  // Unknown action classes fail closed at lower-level atomic consumption even
  // when an older or corrupt row bypassed the normal plan/grant validators.
  return durableActionPolicy(actionClass)?.requiresApproval ?? true;
}

export function assertDurableActionClass(actionClass: string): void {
  if (!durableActionPolicy(actionClass)) {
    throw new Error('Durable action class is not in the closed policy set.');
  }
}

export function assertDurableActionEffectPolicy(
  actionClass: string,
  effectClass: DurablePolicyEffectClass,
): void {
  const policy = durableActionPolicy(actionClass);
  if (!policy || !policy.allowedEffects.includes(effectClass)) {
    throw new Error(
      'Durable action and effect classes do not match the closed execution policy.',
    );
  }
}
