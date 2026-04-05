import type { CursorDashboardState } from './cursor-dashboard.js';

export interface RuntimeDashboardActionContext {
  laneId: 'cursor' | 'andrea_runtime';
  agentId: string | null;
  state: CursorDashboardState;
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
