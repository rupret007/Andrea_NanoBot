import { describe, expect, it } from 'vitest';

import { createBackendLaneRegistry } from './registry.js';
import type { BackendLane } from './types.js';

function makeLane(id: 'cursor' | 'andrea_runtime'): BackendLane {
  return {
    id,
    label: id,
    getCapabilities() {
      return {
        canCreateJob: true,
        canFollowUp: true,
        canGetLogs: true,
        canStop: true,
        canRefresh: true,
        canViewOutput: true,
        canViewFiles: false,
        actionIds: [],
      };
    },
    async createJob() {
      throw new Error('not used');
    },
    async followUp() {
      throw new Error('not used');
    },
    async getJob() {
      throw new Error('not used');
    },
    async listJobs() {
      throw new Error('not used');
    },
    async refreshJob() {
      throw new Error('not used');
    },
    async getPrimaryOutput() {
      throw new Error('not used');
    },
    async getFiles() {
      throw new Error('not used');
    },
    getActionDescriptors() {
      return [];
    },
    async getJobLogs() {
      throw new Error('not used');
    },
    async stopJob() {
      throw new Error('not used');
    },
  };
}

describe('createBackendLaneRegistry', () => {
  it('registers and resolves backend lanes by id', () => {
    const registry = createBackendLaneRegistry();
    const cursorLane = makeLane('cursor');
    const runtimeLane = makeLane('andrea_runtime');

    registry.register(cursorLane);
    registry.register(runtimeLane);

    expect(registry.has('cursor')).toBe(true);
    expect(registry.has('andrea_runtime')).toBe(true);
    expect(registry.get('cursor')).toBe(cursorLane);
    expect(registry.get('andrea_runtime')).toBe(runtimeLane);
    expect(registry.list()).toEqual([cursorLane, runtimeLane]);
  });
});
