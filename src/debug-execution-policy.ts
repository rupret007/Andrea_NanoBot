export type DebugExecutionMode = 'read_only' | 'isolated_write' | 'live_write';

export interface DebugExecutionPolicy {
  command: string;
  mode: DebugExecutionMode;
  storage: 'none' | 'isolated' | 'live';
  externalEffects: boolean;
}

export function assertDebugExecutionPolicy(
  policy: DebugExecutionPolicy,
): DebugExecutionPolicy {
  if (policy.mode === 'read_only') {
    if (policy.storage === 'live' || policy.externalEffects) {
      throw new Error(
        `${policy.command} declares read_only but can mutate state or external systems.`,
      );
    }
  }
  if (policy.mode === 'isolated_write' && policy.storage !== 'isolated') {
    throw new Error(
      `${policy.command} declares isolated_write without isolated storage.`,
    );
  }
  if (policy.mode !== 'live_write' && policy.externalEffects) {
    throw new Error(
      `${policy.command} requires live_write before external effects are allowed.`,
    );
  }
  return policy;
}

export function formatDebugExecutionPolicy(
  policy: DebugExecutionPolicy,
): string[] {
  const checked = assertDebugExecutionPolicy(policy);
  return [
    `execution_mode: ${checked.mode}`,
    `storage: ${checked.storage}`,
    `external_effects: ${checked.externalEffects}`,
  ];
}
