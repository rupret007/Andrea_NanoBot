import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createAndreaRuntimeBackendLane,
  followUpAndreaRuntimeLaneGroup,
} from './andrea-runtime-lane.js';
import {
  ANDREA_OPENAI_BACKEND_ID,
  type AndreaOpenAiBackendClient,
} from '../andrea-openai-backend.js';
import { _initTestDatabase } from '../db.js';
import type { RegisteredGroup, RuntimeBackendJob } from '../types.js';

const MAIN_GROUP: RegisteredGroup = {
  name: 'Andrea Main',
  folder: 'main',
  trigger: '@andrea',
  added_at: '2026-04-02T20:00:00.000Z',
  requiresTrigger: false,
  isMain: true,
};

function buildJob(overrides: Partial<RuntimeBackendJob> = {}): RuntimeBackendJob {
  return {
    backend: ANDREA_OPENAI_BACKEND_ID,
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
    selectedRuntime: 'codex_local',
    promptPreview: 'Build it',
    latestOutputText: null,
    finalOutputText: null,
    errorText: null,
    logFile: null,
    sourceSystem: 'andrea_nanobot',
    actorType: 'chat',
    actorId: 'tg:main',
    correlationId: 'corr-1',
    createdAt: '2026-03-30T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    updatedAt: '2026-03-30T00:00:00.000Z',
    capabilities: {
      followUp: true,
      logs: true,
      stop: true,
    },
    ...overrides,
  };
}

function makeClient(): AndreaOpenAiBackendClient {
  return {
    enabled: true,
    getMeta: vi.fn(),
    getStatus: vi.fn(),
    createJob: vi.fn(async () => buildJob()),
    followUp: vi.fn(async () =>
      buildJob({
        kind: 'follow_up',
        jobId: 'runtime-job-2',
        parentJobId: 'runtime-job-1',
        threadId: 'thread-123',
        promptPreview: 'Continue',
        logFile: 'C:\\logs\\runtime.log',
      }),
    ),
    followUpTarget: vi.fn(async () =>
      buildJob({
        kind: 'follow_up',
        jobId: 'runtime-job-group',
        parentJobId: 'runtime-job-1',
        threadId: 'thread-123',
        promptPreview: 'Continue from workspace',
      }),
    ),
    getJob: vi.fn(async (jobId: string) =>
      buildJob({
        jobId,
        status: 'running',
        threadId: 'thread-123',
        latestOutputText: 'latest',
        logFile: 'C:\\logs\\runtime.log',
        startedAt: '2026-03-30T00:00:01.000Z',
        updatedAt: '2026-03-30T00:00:02.000Z',
      }),
    ),
    listJobs: vi.fn(async () => ({
      jobs: [buildJob({ jobId: 'runtime-job-9' })],
      nextBeforeJobId: null,
    })),
    getJobLogs: vi.fn(async () => ({
      jobId: 'runtime-job-1',
      logFile: 'C:\\logs\\runtime.log',
      logText: 'tail',
      lines: 1,
    })),
    stopJob: vi.fn(async () => ({
      liveStopAccepted: true,
      job: buildJob({
        status: 'running',
        stopRequested: true,
        threadId: 'thread-123',
        latestOutputText: 'latest',
        logFile: 'C:\\logs\\runtime.log',
        startedAt: '2026-03-30T00:00:01.000Z',
        updatedAt: '2026-03-30T00:00:02.000Z',
      }),
    })),
    ensureGroupRegistration: vi.fn(),
  } as unknown as AndreaOpenAiBackendClient;
}

function resolveGroupByFolder(folder: string) {
  return folder === 'main' ? { jid: 'tg:main', group: MAIN_GROUP } : null;
}

describe('createAndreaRuntimeBackendLane', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('maps backend runtime jobs onto the shared lane contract', async () => {
    const client = makeClient();
    const lane = createAndreaRuntimeBackendLane({
      client,
      resolveGroupByFolder,
    });

    const created = await lane.createJob({
      groupFolder: 'main',
      chatJid: 'tg:main',
      promptText: 'Build it',
      requestedBy: 'tg:operator',
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
    expect(created.laneLabel).toBe('Codex/OpenAI Runtime');
    expect(logs.logText).toBe('tail');
    expect(output.text).toBe('latest');
    expect(files.supported).toBe(false);
    expect(lane.getCapabilities().actionIds).toEqual([
      'job.refresh',
      'job.output',
      'job.followup',
      'job.stop',
    ]);
    expect(
      lane
        .getActionDescriptors({
          ...created,
          status: 'running',
        })
        .map((action) => action.label),
    ).toEqual(['Refresh', 'View Output', 'Continue', 'Stop Run']);
  });

  it('preserves legacy group-folder follow-up continuity through the backend', async () => {
    const client = makeClient();

    const followed = await followUpAndreaRuntimeLaneGroup({
      client,
      resolveGroupByFolder,
      groupFolder: 'main',
      chatJid: 'tg:main',
      promptText: 'Keep going',
    });

    expect(followed.handle).toEqual({
      laneId: 'andrea_runtime',
      jobId: 'runtime-job-group',
    });
    expect(client.followUpTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        groupFolder: 'main',
        prompt: 'Keep going',
      }),
    );
  });
});
