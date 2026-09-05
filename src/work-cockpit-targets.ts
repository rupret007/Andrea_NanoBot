import type { CursorDashboardState } from './cursor-dashboard.js';

export interface RuntimeDashboardActionContext {
  laneId: 'cursor' | 'andrea_runtime';
  agentId: string | null;
  state: CursorDashboardState;
}

export interface WorkCockpitCurrentSelection {
  laneId: 'cursor' | 'andrea_runtime';
  jobId: string;
}

/** Orders read-only presentation updates; it never grants execution authority. */
export function createWorkCockpitReadGuard(): {
  begin(key: string): () => boolean;
} {
  const newestReads = new Map<string, symbol>();
  return {
    begin(key) {
      const token = Symbol();
      newestReads.delete(key);
      newestReads.set(key, token);
      if (newestReads.size > 256) {
        const oldestKey = newestReads.keys().next().value;
        if (oldestKey !== undefined) newestReads.delete(oldestKey);
      }
      return () => newestReads.get(key) === token;
    },
  };
}

/** Keeps a delivered card and its stored action context in the same order. */
export function createWorkCockpitPresentationQueue(): {
  run<T>(key: string, callback: () => Promise<T>): Promise<T>;
} {
  const pending = new Map<string, Promise<void>>();
  return {
    run<T>(key: string, callback: () => Promise<T>): Promise<T> {
      const previous = pending.get(key) ?? Promise.resolve();
      const result = previous.then(callback);
      const settled = result.then(
        () => undefined,
        () => undefined,
      );
      pending.set(key, settled);
      void settled.then(() => {
        if (pending.get(key) === settled) pending.delete(key);
      });
      return result;
    },
  };
}

export function resolveRuntimeDashboardJobId(
  context: RuntimeDashboardActionContext | null,
): string | null {
  if (!context?.agentId) {
    return null;
  }
  if (context.laneId === 'andrea_runtime') {
    return context.agentId;
  }
  if (context.state.kind === 'runtime_current') {
    return context.agentId;
  }
  return null;
}

export function reconcileWorkCockpitCurrentSelection(params: {
  currentSelection: WorkCockpitCurrentSelection | null;
  cursorJobId?: string | null;
  runtimeJobId?: string | null;
}): WorkCockpitCurrentSelection | null {
  if (params.currentSelection?.jobId) {
    return params.currentSelection;
  }
  if (params.runtimeJobId) {
    return {
      laneId: 'andrea_runtime',
      jobId: params.runtimeJobId,
    };
  }
  if (params.cursorJobId) {
    return {
      laneId: 'cursor',
      jobId: params.cursorJobId,
    };
  }
  return null;
}

export function shouldClearStaleWorkCockpitSelection(params: {
  selectedJobId?: string | null;
  selectedExists: boolean;
  status?: string | null;
}): boolean {
  if (!params.selectedJobId) {
    return false;
  }
  return !params.selectedExists;
}
