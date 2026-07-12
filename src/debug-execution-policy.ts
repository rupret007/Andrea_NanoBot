export type DebugExecutionMode = 'read_only' | 'isolated_write' | 'live_write';

export interface DebugExecutionPolicy {
  command: string;
  mode: DebugExecutionMode;
  storage: 'none' | 'isolated' | 'live';
  externalEffects: boolean;
}

export interface DebugPersistencePolicy {
  persist: boolean;
  persistenceRequested: boolean;
  dryRun: boolean;
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

/**
 * Diagnostic commands are observational unless persistence is explicit.
 * `--dry-run` and the legacy `--no-persist` flag always win.
 */
export function resolveDebugExecutionPolicy(
  args: readonly string[],
): DebugPersistencePolicy {
  const dryRun = args.includes('--dry-run');
  const persistenceRequested = args.includes('--persist');
  return {
    persist: persistenceRequested && !dryRun && !args.includes('--no-persist'),
    persistenceRequested,
    dryRun,
  };
}

export function resolveDebugLiveExecutionPolicy(
  args: readonly string[],
  command: string,
): DebugExecutionPolicy {
  return args.includes('--live')
    ? {
        command,
        mode: 'live_write',
        storage: 'live',
        externalEffects: true,
      }
    : {
        command,
        mode: 'read_only',
        storage: 'none',
        externalEffects: false,
      };
}
