import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ANDREA_OPENAI_BACKEND_ID,
  AndreaOpenAiBackendHttpError,
} from './andrea-openai-backend.js';
import {
  AndreaOpenAiRuntimeError,
  createAndreaOpenAiRuntimeJob,
  followUpAndreaOpenAiRuntimeGroup,
  followUpAndreaOpenAiRuntimeJob,
  getAndreaOpenAiRuntimeJob,
  getAndreaOpenAiRuntimeJobLogs,
  listAndreaOpenAiRuntimeJobs,
  stopAndreaOpenAiRuntimeJob,
} from './andrea-openai-runtime.js';
import { _initTestDatabase, getRuntimeBackendJob } from './db.js';
import type { RegisteredGroup, RuntimeBackendJob } from './types.js';

const MAIN_GROUP: RegisteredGroup = {
  name: 'Andrea Main',
  folder: 'main',
  trigger: '@andrea',
  added_at: '2026-04-02T20:00:00.000Z',
  requiresTrigger: false,
  isMain: true,
};

function makeJob(
  overrides: Partial<RuntimeBackendJob> = {},
): RuntimeBackendJob {
  return {
    backend: ANDREA_OPENAI_BACKEND_ID,
    jobId: 'job_001',
    kind: 'create',
    status: 'queued',
    stopRequested: false,
    groupFolder: 'main',
    groupJid: 'tg:1',
    threadId: null,
    runtimeRoute: 'local_required',
    requestedRuntime: 'codex_local',
    selectedRuntime: 'codex_local',
    promptPreview: 'Ship the patch',
    latestOutputText: null,
    finalOutputText: null,
    errorText: null,
    logFile: null,
    sourceSystem: 'andrea_nanobot',
    actorType: 'chat',
    actorId: 'tg:1',
    correlationId: 'corr-1',
    createdAt: '2026-04-02T20:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    updatedAt: '2026-04-02T20:00:00.000Z',
    capabilities: {
      followUp: true,
      logs: true,
      stop: true,
    },
    ...overrides,
  };
}

function makeClient() {
  return {
    enabled: true,
    createJob: vi.fn(),
    followUp: vi.fn(),
    getJob: vi.fn(),
    listJobs: vi.fn(),
    followUpTarget: vi.fn(),
    getJobLogs: vi.fn(),
    stopJob: vi.fn(),
    ensureGroupRegistration: vi.fn(),
  };
}

beforeEach(() => {
  _initTestDatabase();
});

describe('andrea-openai-runtime', () => {
  it('creates a backend job and caches it locally', async () => {
    const client = makeClient();
    client.createJob.mockResolvedValue(makeJob());

    const job = await createAndreaOpenAiRuntimeJob(
      {
        chatJid: 'tg:1',
        group: MAIN_GROUP,
        prompt: 'Ship it',
        actorId: 'tg:user',
        requestedRuntime: 'openai_cloud',
      },
      client as never,
    );

    expect(job.jobId).toBe('job_001');
    expect(client.createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedRuntime: 'openai_cloud',
      }),
    );
    expect(
      getRuntimeBackendJob(ANDREA_OPENAI_BACKEND_ID, 'job_001'),
    ).toMatchObject({
      chat_jid: 'tg:1',
      group_folder: 'main',
    });
  });

  it('classifies missing-group create failures as bootstrap_required when the backend lacks a registration route', async () => {
    const client = makeClient();
    client.createJob.mockRejectedValue(
      new AndreaOpenAiBackendHttpError({
        message: 'No registered group found for folder "main".',
        status: 404,
        code: 'not_found',
        route: '/jobs',
      }),
    );
    client.ensureGroupRegistration.mockRejectedValue(
      new AndreaOpenAiBackendHttpError({
        message: 'No route found for /groups/main.',
        status: 404,
        code: 'not_found',
        route: '/groups/main',
      }),
    );

    await expect(
      createAndreaOpenAiRuntimeJob(
        {
          chatJid: 'tg:1',
          group: MAIN_GROUP,
          prompt: 'Ship it',
        },
        client as never,
      ),
    ).rejects.toMatchObject({
      name: 'AndreaOpenAiRuntimeError',
      kind: 'bootstrap_required',
      groupFolder: 'main',
    } satisfies Partial<AndreaOpenAiRuntimeError>);
  });

  it('retries create after successful backend group bootstrap', async () => {
    const client = makeClient();
    client.createJob
      .mockRejectedValueOnce(
        new AndreaOpenAiBackendHttpError({
          message: 'No registered group found for folder "main".',
          status: 404,
          code: 'not_found',
          route: '/jobs',
        }),
      )
      .mockResolvedValueOnce(makeJob({ jobId: 'job_retry' }));
    client.ensureGroupRegistration.mockResolvedValue(undefined);

    const job = await createAndreaOpenAiRuntimeJob(
      {
        chatJid: 'tg:1',
        group: MAIN_GROUP,
        prompt: 'Retry it',
      },
      client as never,
    );

    expect(job.jobId).toBe('job_retry');
    expect(client.ensureGroupRegistration).toHaveBeenCalledTimes(1);
    expect(client.createJob).toHaveBeenCalledTimes(2);
    expect(client.ensureGroupRegistration).toHaveBeenCalledWith({
      jid: 'tg:1',
      group: MAIN_GROUP,
    });
  });

  it('fails honestly when backend group registration conflicts', async () => {
    const client = makeClient();
    client.createJob.mockRejectedValue(
      new AndreaOpenAiBackendHttpError({
        message: 'No registered group found for folder "main".',
        status: 404,
        code: 'not_found',
        route: '/jobs',
      }),
    );
    client.ensureGroupRegistration.mockRejectedValue(
      new AndreaOpenAiBackendHttpError({
        message: 'Group "main" already exists with conflicting metadata.',
        status: 409,
        code: 'conflict',
        route: '/groups/main',
      }),
    );

    await expect(
      createAndreaOpenAiRuntimeJob(
        {
          chatJid: 'tg:1',
          group: MAIN_GROUP,
          prompt: 'Ship it',
        },
        client as never,
      ),
    ).rejects.toMatchObject({
      name: 'AndreaOpenAiRuntimeError',
      kind: 'bootstrap_failed',
      groupFolder: 'main',
    } satisfies Partial<AndreaOpenAiRuntimeError>);
    expect(client.createJob).toHaveBeenCalledTimes(1);
  });

  it('retries create only once after backend registration succeeds', async () => {
    const client = makeClient();
    client.createJob
      .mockRejectedValueOnce(
        new AndreaOpenAiBackendHttpError({
          message: 'No registered group found for folder "main".',
          status: 404,
          code: 'not_found',
          route: '/jobs',
        }),
      )
      .mockRejectedValueOnce(
        new AndreaOpenAiBackendHttpError({
          message: 'Prompt validation failed on retry.',
          status: 400,
          code: 'validation_error',
          route: '/jobs',
        }),
      );
    client.ensureGroupRegistration.mockResolvedValue(undefined);

    await expect(
      createAndreaOpenAiRuntimeJob(
        {
          chatJid: 'tg:1',
          group: MAIN_GROUP,
          prompt: 'Retry it',
        },
        client as never,
      ),
    ).rejects.toMatchObject({
      name: 'AndreaOpenAiRuntimeError',
      kind: 'bootstrap_failed',
      groupFolder: 'main',
    } satisfies Partial<AndreaOpenAiRuntimeError>);

    expect(client.ensureGroupRegistration).toHaveBeenCalledTimes(1);
    expect(client.createJob).toHaveBeenCalledTimes(2);
  });

  it('lists backend jobs and preserves pagination truth', async () => {
    const client = makeClient();
    client.listJobs.mockResolvedValue({
      jobs: [makeJob({ jobId: 'job_100' })],
      nextBeforeJobId: 'job_100',
    });

    const result = await listAndreaOpenAiRuntimeJobs(
      {
        chatJid: 'tg:1',
        group: MAIN_GROUP,
        limit: 10,
        beforeJobId: 'job_200',
      },
      client as never,
    );

    expect(client.listJobs).toHaveBeenCalledWith({
      groupFolder: 'main',
      limit: 10,
      beforeJobId: 'job_200',
    });
    expect(result.nextBeforeJobId).toBe('job_100');
  });

  it('supports group-folder follow-up continuity through the backend', async () => {
    const client = makeClient();
    client.followUpTarget.mockResolvedValue(
      makeJob({
        jobId: 'job_group_followup',
        kind: 'follow_up',
        parentJobId: 'job_001',
        threadId: 'thread-123',
      }),
    );

    const job = await followUpAndreaOpenAiRuntimeGroup(
      {
        chatJid: 'tg:1',
        group: MAIN_GROUP,
        prompt: 'Keep going',
      },
      client as never,
    );

    expect(job.jobId).toBe('job_group_followup');
    expect(client.followUpTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        groupFolder: 'main',
        prompt: 'Keep going',
      }),
    );
  });

  it('retries list once after backend group bootstrap succeeds', async () => {
    const client = makeClient();
    client.listJobs
      .mockRejectedValueOnce(
        new AndreaOpenAiBackendHttpError({
          message: 'No registered group found for folder "main".',
          status: 404,
          code: 'not_found',
          route: '/jobs',
        }),
      )
      .mockResolvedValueOnce({
        jobs: [makeJob({ jobId: 'job_200' })],
        nextBeforeJobId: 'job_200',
      });
    client.ensureGroupRegistration.mockResolvedValue(undefined);

    const result = await listAndreaOpenAiRuntimeJobs(
      {
        chatJid: 'tg:1',
        group: MAIN_GROUP,
        limit: 5,
      },
      client as never,
    );

    expect(result.jobs[0]?.jobId).toBe('job_200');
    expect(client.ensureGroupRegistration).toHaveBeenCalledWith({
      jid: 'tg:1',
      group: MAIN_GROUP,
    });
    expect(client.listJobs).toHaveBeenCalledTimes(2);
  });

  it('fetches a single job and enforces current-group context', async () => {
    const client = makeClient();
    client.getJob.mockResolvedValue(makeJob({ groupFolder: 'other' }));

    await expect(
      getAndreaOpenAiRuntimeJob(
        {
          chatJid: 'tg:1',
          group: MAIN_GROUP,
          jobId: 'job_001',
        },
        client as never,
      ),
    ).rejects.toMatchObject({
      name: 'AndreaOpenAiRuntimeError',
      kind: 'context_mismatch',
    } satisfies Partial<AndreaOpenAiRuntimeError>);
  });

  it('maps follow-up, logs, and stop through the backend job handle', async () => {
    const client = makeClient();
    client.getJob.mockResolvedValue(makeJob({ jobId: 'job_010' }));
    client.followUp.mockResolvedValue(
      makeJob({
        jobId: 'job_011',
        kind: 'follow_up',
        threadId: 'thread_010',
        status: 'running',
      }),
    );
    client.getJobLogs.mockResolvedValue({
      jobId: 'job_010',
      logFile: 'container-job_010.log',
      logText: 'tail output',
      lines: 40,
    });
    client.stopJob.mockResolvedValue({
      job: makeJob({ jobId: 'job_010', status: 'failed', stopRequested: true }),
      liveStopAccepted: true,
    });

    const follow = await followUpAndreaOpenAiRuntimeJob(
      {
        chatJid: 'tg:1',
        group: MAIN_GROUP,
        jobId: 'job_010',
        prompt: 'Continue',
      },
      client as never,
    );
    const logs = await getAndreaOpenAiRuntimeJobLogs(
      {
        chatJid: 'tg:1',
        group: MAIN_GROUP,
        jobId: 'job_010',
        lines: 40,
      },
      client as never,
    );
    const stop = await stopAndreaOpenAiRuntimeJob(
      {
        chatJid: 'tg:1',
        group: MAIN_GROUP,
        jobId: 'job_010',
      },
      client as never,
    );

    expect(follow.kind).toBe('follow_up');
    expect(logs.logText).toBe('tail output');
    expect(stop.liveStopAccepted).toBe(true);
  });
});
