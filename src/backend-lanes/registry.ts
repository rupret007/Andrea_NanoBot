import type { BackendLane, BackendLaneId } from './types.js';

export interface BackendLaneRegistry {
  register(lane: BackendLane): void;
  get(laneId: BackendLaneId): BackendLane;
  has(laneId: BackendLaneId): boolean;
  list(): BackendLane[];
}

export function createBackendLaneRegistry(
  initialLanes: BackendLane[] = [],
): BackendLaneRegistry {
  const lanes = new Map<BackendLaneId, BackendLane>();
  for (const lane of initialLanes) {
    lanes.set(lane.id, lane);
  }

  return {
    register(lane) {
      lanes.set(lane.id, lane);
    },
    get(laneId) {
      const lane = lanes.get(laneId);
      if (!lane) {
        throw new Error(`Backend lane "${laneId}" is not registered.`);
      }
      return lane;
    },
    has(laneId) {
      return lanes.has(laneId);
    },
    list() {
      return [...lanes.values()];
    },
  };
}
