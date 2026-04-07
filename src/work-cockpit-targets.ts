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
