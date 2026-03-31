import { describe, expect, it, vi } from 'vitest';

import { createAndreaRuntimeBackendLane } from './andrea-runtime-lane.js';
import type { RuntimeOrchestrationService } from '../andrea-runtime/orchestration.js';
import type {
  RuntimeJobLogsResult,
  RuntimeOrchestrationJob,
  StopRuntimeJobResult,
} from '../andrea-runtime/types.js';

function buildJob(
  overrides: Partial<RuntimeOrchestrationJob> = {},
): RuntimeOrchestrationJob {
  return {
    jobId: 'runtime-job-1',
    kind: 'create',
    status: 'queued',
    stopRequested: false,
    groupFolder: 'main',
    groupJid: 'tg:main',
    parentJobId: null,
    threadId: null,
    runtimeRoute: 'cloud_allowed',
    requestedRuntime: 'codex_local',
    selectedRuntime: null,
    promptPreview: 'Build it',
    latestOutputText: null,
    finalOutputText: null,
    errorText: null,
    logFile: null,
    sourceSystem: 'test',
    correlationId: null,
    replyRef: null,
    createdAt: '2026-03-30T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    updatedAt: '2026-03-30T00:00:00.000Z',
    ...overrides,
  };
}

function buildLogsResult(
  overrides: Partial<RuntimeJobLogsResult> = {},
): RuntimeJobLogsResult {
  return {
    jobId: 'runtime-job-1',
    logFile: 'C:\\logs\\runtime.log',
    logText: 'tail',
    lines: 1,
    ...overrides,
  };
}

function buildStopResult(
  overrides: Partial<StopRuntimeJobResult> = {},
): StopRuntimeJobResult {
  return {
    liveStopAccepted: true,
    job: buildJob({
      status: 'running',
      stopRequested: true,
      threadId: 'thread-123',
      selectedRuntime: 'codex_local',
      logFile: 'C:\\logs\\runtime.log',
      latestOutputText: 'latest',
      startedAt: '2026-03-30T00:00:01.000Z',
      updatedAt: '2026-03-30T00:00:02.000Z',
    }),
    ...overrides,
  };
}

function makeService(): RuntimeOrchestrationService {
  return {
    createJob: vi.fn(async () => buildJob()),
    followUp: vi.fn(async () =>
      buildJob({
        kind: 'follow_up',
        parentJobId: 'runtime-job-0',
        threadId: 'thread-123',
        requestedRuntime: null,
        selectedRuntime: 'codex_local',
        promptPreview: 'Continue',
        logFile: 'C:\\logs\\runtime.log',
      }),
    ),
    getJob: vi.fn((jobId: string) =>
      buildJob({
        jobId,
        status: 'running',
        threadId: 'thread-123',
        selectedRuntime: 'codex_local',
        latestOutputText: 'latest',
        logFile: 'C:\\logs\\runtime.log',
        startedAt: '2026-03-30T00:00:01.000Z',
        updatedAt: '2026-03-30T00:00:02.000Z',
      }),
    ),
    listJobs: vi.fn(() => ({
      jobs: [],
      nextBeforeJobId: null,
    })),
    getJobLogs: vi.fn(() => buildLogsResult()),
    stopJob: vi.fn(async () => buildStopResult()),
  };
}

describe('createAndreaRuntimeBackendLane', () => {
  it('maps runtime jobs onto the shared lane contract', async () => {
    const service = makeService();
    const lane = createAndreaRuntimeBackendLane(service);

    const created = await lane.createJob({
      groupFolder: 'main',
      chatJid: 'tg:main',
      promptText: 'Build it',
      requestedBy: 'tg:operator',
      options: { requestedRuntime: 'codex_local' },
    });
    const logs = await lane.getJobLogs({
      handle: { laneId: 'andrea_runtime', jobId: 'runtime-job-1' },
      groupFolder: 'main',
      chatJid: 'tg:main',
      limit: 10,
    });
    const output = await lane.getPrimaryOutput({
      handle: { laneId: 'andrea_runtime', jobId: 'runtime-job-1' },
      groupFolder: 'main',
      chatJid: 'tg:main',
      limit: 10,
    });
    const files = await lane.getFiles({
      handle: { laneId: 'andrea_runtime', jobId: 'runtime-job-1' },
      groupFolder: 'main',
      chatJid: 'tg:main',
    });

    expect(created.handle).toEqual({
      laneId: 'andrea_runtime',
      jobId: 'runtime-job-1',
    });
    expect(created.laneLabel).toBe('Andrea Runtime');
    expect(logs.logText).toBe('tail');
    expect(output.text).toBe('latest');
    expect(files.supported).toBe(false);
    expect(lane.getCapabilities().canRefresh).toBe(true);
    expect(lane.getCapabilities().canViewOutput).toBe(true);
    expect(lane.getCapabilities().canViewFiles).toBe(false);
    expect(lane.getCapabilities().actionIds).toEqual([
      'job.refresh',
      'job.output',
      'job.followup',
      'job.stop',
    ]);
  });
});
