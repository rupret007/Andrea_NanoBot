import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AndreaOpenAiBackendClient,
  AndreaOpenAiBackendHttpError,
  AndreaOpenAiBackendTransportError,
} from './andrea-openai-backend.js';
import { createAndreaRuntimeBackendLane } from './backend-lanes/andrea-runtime-lane.js';
import type { BackendJobDetails } from './backend-lanes/types.js';
import { _initTestDatabase, getRuntimeBackendJob } from './db.js';
import type {
  RegisteredGroup,
  RuntimeBackendJob,
  RuntimeBackendJobCacheRecord,
} from './types.js';
import {
  getRuntimeWorkRecoveryReply,
  resolveRuntimeWorkRecovery,
  type RuntimeWorkRecoveryParams,
} from './work-cockpit-recovery.js';

const JOB_ID = 'selected-runtime-task-123';
const UPDATED_AT = '2026-09-01T00:00:00.000Z';
const NOW = Date.parse('2026-09-05T00:00:00.000Z');

describe('read-only recovery card reply guard', () => {
  it('does not interpret a reply to a recovery card as a continuation', () => {
    expect(getRuntimeWorkRecoveryReply({ readOnlyRecovery: true })).toBe(
      'This is a status-recovery card, not a continuation prompt. Tap Check again to verify the selected task first. Nothing was started, continued, or stopped.',
    );
  });

  it.each([
    undefined,
    null,
    {},
    { readOnlyRecovery: false },
    { readOnlyRecovery: 'true' },
  ])('leaves other existing reply paths unchanged (%j)', (payload) =>
    expect(getRuntimeWorkRecoveryReply(payload)).toBeNull(),
  );
});

function details(
  overrides: Partial<BackendJobDetails> = {},
): BackendJobDetails {
  return {
    handle: { laneId: 'andrea_runtime', jobId: JOB_ID },
    title: 'Codex/OpenAI task',
    status: 'running',
    summary: 'Fixture task',
    updatedAt: UPDATED_AT,
    createdAt: UPDATED_AT,
    laneLabel: 'Codex/OpenAI Runtime',
    capabilities: {
      canCreateJob: true,
      canFollowUp: true,
      canGetLogs: true,
      canStop: true,
      canRefresh: true,
      canViewOutput: true,
      canViewFiles: false,
      actionIds: ['job.refresh', 'job.followup', 'job.stop'],
    },
    metadata: { groupFolder: 'main', groupJid: 'tg:fixture' },
    ...overrides,
  };
}

function cache(
  overrides: Partial<RuntimeBackendJobCacheRecord> = {},
): RuntimeBackendJobCacheRecord {
  return {
    backend_id: 'andrea_openai',
    job_id: JOB_ID,
    group_folder: 'main',
    chat_jid: 'tg:fixture',
    thread_id: 'fixture-thread',
    status: 'running',
    selected_runtime: 'codex_local',
    prompt_preview: 'PRIVATE_FIXTURE_PROMPT',
    latest_output_text: 'PRIVATE_FIXTURE_OUTPUT',
    error_text: 'PRIVATE_FIXTURE_ERROR',
    log_file: '/fixture/private/log.txt',
    created_at: UPDATED_AT,
    updated_at: UPDATED_AT,
    raw_json: 'PRIVATE_FIXTURE_RAW_JSON',
    ...overrides,
  };
}

function params(
  overrides: Partial<RuntimeWorkRecoveryParams> = {},
): RuntimeWorkRecoveryParams {
  return {
    selectedJobId: JOB_ID,
    groupFolder: 'main',
    chatJid: 'tg:fixture',
    getJob: vi.fn(async () => details()),
    getCachedJob: vi.fn(() => cache()),
    ...overrides,
  };
}

describe('selected runtime work recovery', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => vi.restoreAllMocks());

  it('does not read the backend or cache when no task is selected', async () => {
    const input = params({ selectedJobId: null });
    expect(await resolveRuntimeWorkRecovery(input)).toEqual({
      kind: 'missing',
      selectedJobId: null,
      reason: 'not-selected',
    });
    expect(input.getJob).not.toHaveBeenCalled();
    expect(input.getCachedJob).not.toHaveBeenCalled();
  });

  it('reads exactly the retained handle and context without a task inventory', async () => {
    const input = params();
    const result = await resolveRuntimeWorkRecovery(input);
    expect(input.getJob).toHaveBeenCalledExactlyOnceWith({
      handle: { laneId: 'andrea_runtime', jobId: JOB_ID },
      groupFolder: 'main',
      chatJid: 'tg:fixture',
    });
    expect(result).toEqual({
      kind: 'available',
      selectedJobId: JOB_ID,
      job: details(),
      freshness: 'current',
    });
    expect(input.getCachedJob).not.toHaveBeenCalled();
  });

  it('treats an explicit null as missing even if an old cache record exists', async () => {
    const input = params({ getJob: vi.fn(async () => null) });
    expect(await resolveRuntimeWorkRecovery(input)).toEqual({
      kind: 'missing',
      selectedJobId: JOB_ID,
      reason: 'not-found',
    });
    expect(input.getCachedJob).not.toHaveBeenCalled();
  });

  it.each([
    'not_enabled',
    'unavailable',
    'not_ready',
    'bootstrap_required',
    'bootstrap_failed',
    'context_mismatch',
  ])(
    'keeps the selected handle on %s without exposing raw errors',
    async (kind) => {
      const input = params({
        getJob: vi.fn(async () => {
          throw Object.assign(new Error('PRIVATE_FIXTURE_BACKEND_ERROR'), {
            kind,
            detail: '/fixture/private/credential',
          });
        }),
      });
      const result = await resolveRuntimeWorkRecovery(input);
      expect(result).toEqual({
        kind: 'unavailable',
        selectedJobId: JOB_ID,
        reason: kind,
        cached: {
          jobId: JOB_ID,
          status: 'running',
          updatedAt: UPDATED_AT,
          freshness: 'stale',
        },
      });
      expect(JSON.stringify(result)).not.toMatch(
        /PRIVATE_FIXTURE|credential|log\.txt/,
      );
      expect(input.getJob).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    new Error('private transport details'),
    { kind: 'not_found' },
    null,
  ])(
    'never turns an unknown thrown failure into authoritative absence (%j)',
    async (error) => {
      const result = await resolveRuntimeWorkRecovery(
        params({
          getJob: vi.fn(async () => {
            throw error;
          }),
        }),
      );
      expect(result).toMatchObject({
        kind: 'unavailable',
        selectedJobId: JOB_ID,
        reason: 'unknown',
      });
    },
  );

  it.each([
    { backend_id: 'cursor' },
    { job_id: 'another-task' },
    { group_folder: 'another-group' },
    { chat_jid: 'tg:another-chat' },
    { status: 'PRIVATE_FIXTURE_STATUS' },
    { updated_at: '' },
    { updated_at: 'yesterday' },
    { updated_at: '2026-02-30T00:00:00.000Z' },
    { updated_at: '2026-09-01T24:00:00.000Z' },
    { updated_at: '2099-09-01T00:00:00.000Z' },
  ])('rejects untrustworthy cached metadata: %j', async (overrides) => {
    const result = await resolveRuntimeWorkRecovery(
      params({
        getJob: vi.fn(async () => {
          throw { kind: 'unavailable' };
        }),
        getCachedJob: vi.fn(() => cache(overrides)),
      }),
    );
    expect(result).toEqual({
      kind: 'unavailable',
      selectedJobId: JOB_ID,
      reason: 'unavailable',
      cached: null,
    });
  });

  it('does not parse or expose cached prompt/output/raw_json', async () => {
    const cached = cache();
    for (const key of ['raw_json', 'prompt_preview', 'latest_output_text']) {
      Object.defineProperty(cached, key, {
        get: () => {
          throw new Error(`Forbidden read: ${key}`);
        },
      });
    }
    const result = await resolveRuntimeWorkRecovery(
      params({
        getJob: vi.fn(async () => {
          throw { kind: 'unavailable' };
        }),
        getCachedJob: vi.fn(() => cached),
      }),
    );
    expect(result).toMatchObject({
      kind: 'unavailable',
      cached: { jobId: JOB_ID, freshness: 'stale' },
    });
  });

  it('preserves the selected handle when the cache also fails', async () => {
    const result = await resolveRuntimeWorkRecovery(
      params({
        getJob: vi.fn(async () => {
          throw { kind: 'unavailable' };
        }),
        getCachedJob: vi.fn(() => {
          throw new Error('PRIVATE_FIXTURE_DB_ERROR');
        }),
      }),
    );
    expect(result).toEqual({
      kind: 'unavailable',
      selectedJobId: JOB_ID,
      reason: 'unavailable',
      cached: null,
    });
  });

  it.each([
    undefined,
    {},
    details({ handle: { laneId: 'cursor', jobId: JOB_ID } }),
    details({ handle: { laneId: 'andrea_runtime', jobId: 'different-task' } }),
    details({ metadata: { groupFolder: 'different-group' } }),
    details({ metadata: null }),
    details({ status: 'PRIVATE_FIXTURE_STATUS' }),
    details({ capabilities: {} as BackendJobDetails['capabilities'] }),
  ])(
    'retains selection when a receipt is malformed or mismatched (%j)',
    async (job) => {
      const result = await resolveRuntimeWorkRecovery(
        params({ getJob: vi.fn(async () => job as BackendJobDetails) }),
      );
      expect(result).toMatchObject({
        kind: 'unavailable',
        selectedJobId: JOB_ID,
        reason: 'invalid_response',
      });
      expect(result).not.toHaveProperty('job');
    },
  );

  it.each(['', '  ', 'task\nforged status', 'task\u0000id', 'x'.repeat(4097)])(
    'retains an invalid pointer without dispatching or misreporting no selection',
    async (selectedJobId) => {
      const input = params({ selectedJobId });
      expect(await resolveRuntimeWorkRecovery(input)).toEqual({
        kind: 'unavailable',
        selectedJobId,
        reason: 'invalid_response',
        cached: null,
      });
      expect(input.getJob).not.toHaveBeenCalled();
      expect(input.getCachedJob).not.toHaveBeenCalled();
    },
  );

  it('recovers the same exact selected task on the next explicit read', async () => {
    const getJob = vi
      .fn<RuntimeWorkRecoveryParams['getJob']>()
      .mockRejectedValueOnce({ kind: 'unavailable' })
      .mockResolvedValueOnce(details({ status: 'succeeded' }));
    const input = params({ getJob });
    const first = await resolveRuntimeWorkRecovery(input);
    const second = await resolveRuntimeWorkRecovery(input);
    expect(first).toMatchObject({ kind: 'unavailable', selectedJobId: JOB_ID });
    expect(second).toMatchObject({
      kind: 'available',
      selectedJobId: JOB_ID,
      freshness: 'current',
      job: { status: 'succeeded' },
    });
    expect(getJob.mock.calls[0]).toEqual(getJob.mock.calls[1]);
    expect(input.getCachedJob).toHaveBeenCalledTimes(1);
  });
});

describe('recovery through the real runtime lane with a fixture client', () => {
  const group: RegisteredGroup = {
    name: 'Fixture',
    folder: 'main',
    trigger: '@fixture',
    added_at: UPDATED_AT,
    requiresTrigger: false,
    isMain: true,
  };

  function fixtureJob(
    overrides: Partial<RuntimeBackendJob> = {},
  ): RuntimeBackendJob {
    return {
      backend: 'andrea_openai',
      jobId: JOB_ID,
      kind: 'create',
      status: 'running',
      stopRequested: false,
      groupFolder: 'main',
      groupJid: 'tg:fixture',
      runtimeRoute: 'cloud_allowed',
      promptPreview: 'Fixture task',
      sourceSystem: 'andrea_nanobot',
      createdAt: UPDATED_AT,
      updatedAt: UPDATED_AT,
      capabilities: { followUp: true, logs: true, stop: true },
      ...overrides,
    };
  }

  function fixtureLane() {
    const client = {
      enabled: true,
      getJob: vi.fn(async () => fixtureJob()),
      listJobs: vi.fn(),
      ensureGroupRegistration: vi.fn(),
      createJob: vi.fn(),
      followUp: vi.fn(),
      followUpTarget: vi.fn(),
      stopJob: vi.fn(),
      getStatus: vi.fn(),
      getMeta: vi.fn(),
    };
    const lane = createAndreaRuntimeBackendLane({
      client: client as unknown as AndreaOpenAiBackendClient,
      resolveGroupByFolder: () => ({ group, jid: 'tg:fixture' }),
    });
    const input = params({
      getJob: (request) => lane.getJob(request),
      getCachedJob: (id) => getRuntimeBackendJob('andrea_openai', id),
    });
    return { client, input };
  }

  function expectNoOtherActions(
    client: ReturnType<typeof fixtureLane>['client'],
  ) {
    for (const key of [
      'listJobs',
      'ensureGroupRegistration',
      'createJob',
      'followUp',
      'followUpTarget',
      'stopJob',
      'getStatus',
      'getMeta',
    ] as const) {
      expect(client[key], key).not.toHaveBeenCalled();
    }
  }

  beforeEach(() => {
    _initTestDatabase();
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => vi.restoreAllMocks());

  it('uses an exact read on outage and recovery, with only scoped stale cache in between', async () => {
    const { client, input } = fixtureLane();
    expect(await resolveRuntimeWorkRecovery(input)).toMatchObject({
      kind: 'available',
    });
    client.getJob.mockRejectedValueOnce(
      new AndreaOpenAiBackendTransportError('PRIVATE_FIXTURE_TRANSPORT'),
    );
    const outage = await resolveRuntimeWorkRecovery(input);
    expect(outage).toEqual({
      kind: 'unavailable',
      selectedJobId: JOB_ID,
      reason: 'unavailable',
      cached: {
        jobId: JOB_ID,
        status: 'running',
        updatedAt: UPDATED_AT,
        freshness: 'stale',
      },
    });
    client.getJob.mockResolvedValueOnce(fixtureJob({ status: 'succeeded' }));
    expect(await resolveRuntimeWorkRecovery(input)).toMatchObject({
      kind: 'available',
      job: { status: 'succeeded' },
    });
    expect(client.getJob.mock.calls).toEqual([[JOB_ID], [JOB_ID], [JOB_ID]]);
    expectNoOtherActions(client);
  });

  it('maps a backend item 404 to missing without inventory or group registration', async () => {
    const { client, input } = fixtureLane();
    client.getJob.mockRejectedValueOnce(
      new AndreaOpenAiBackendHttpError({
        status: 404,
        code: 'not_found',
        route: `/jobs/${JOB_ID}`,
        message: `No runtime job found for "${JOB_ID}".`,
      }),
    );
    expect(await resolveRuntimeWorkRecovery(input)).toEqual({
      kind: 'missing',
      selectedJobId: JOB_ID,
      reason: 'not-found',
    });
    expectNoOtherActions(client);
  });

  it.each([
    { code: null, message: `No runtime job found for "${JOB_ID}".` },
    { code: 'not_found', message: `No route found for /jobs/${JOB_ID}.` },
    {
      code: 'not_found',
      message: 'No registered group found for folder "main".',
    },
    { code: 'not_found', message: 'Not found' },
    {
      code: 'not_found',
      message: 'No runtime job found for "different-task".',
    },
    {
      code: 'not_found',
      message: `No runtime job found for "${JOB_ID}".`,
      route: '/jobs/different-task',
    },
    {
      code: 'not_found',
      message: `No runtime job found for "${JOB_ID}".`,
      route: `/jobs?jobId=${JOB_ID}`,
    },
    {
      code: 'internal_error',
      message: `No runtime job found for "${JOB_ID}".`,
    },
  ] as const)(
    'keeps selection when a 404 does not prove exact item absence: %j',
    async (failure) => {
      const { client, input } = fixtureLane();
      client.getJob.mockRejectedValueOnce(
        new AndreaOpenAiBackendHttpError({
          status: 404,
          route: `/jobs/${JOB_ID}`,
          ...failure,
        }),
      );
      expect(await resolveRuntimeWorkRecovery(input)).toEqual({
        kind: 'unavailable',
        selectedJobId: JOB_ID,
        reason: 'unavailable',
        cached: null,
      });
      expectNoOtherActions(client);
    },
  );

  it.each([
    'http://direct-runtime.invalid:9999',
    'http://coordinator.invalid:9998',
  ])(
    'accepts the canonical item404 through the actual client at %s',
    async (baseUrl) => {
      const selectedJobId = 'fixture/task ?#';
      const fetchImpl = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: 'not_found',
                message: `No runtime job found for "${selectedJobId}".`,
              },
            }),
            { status: 404 },
          ),
      );
      const client = new AndreaOpenAiBackendClient({
        enabled: true,
        baseUrl,
        fetchImpl,
      });
      const lane = createAndreaRuntimeBackendLane({
        client,
        resolveGroupByFolder: () => ({ group, jid: 'tg:fixture' }),
      });
      expect(
        await resolveRuntimeWorkRecovery(
          params({
            selectedJobId,
            getJob: (request) => lane.getJob(request),
          }),
        ),
      ).toEqual({ kind: 'missing', selectedJobId, reason: 'not-found' });
      expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
        `${baseUrl}/jobs/${encodeURIComponent(selectedJobId)}`,
        expect.objectContaining({ method: 'GET' }),
      );
    },
  );

  it.each([{ backend: 'another-backend' }, { jobId: 'another-task' }])(
    'does not cache a response with a mismatched backend/task identity: %j',
    async (overrides) => {
      const { client, input } = fixtureLane();
      client.getJob.mockResolvedValueOnce(
        fixtureJob({
          ...overrides,
          promptPreview: 'PRIVATE_FIXTURE_MISMATCHED_RECEIPT',
        }),
      );
      const result = await resolveRuntimeWorkRecovery(input);
      expect(result).toEqual({
        kind: 'unavailable',
        selectedJobId: JOB_ID,
        reason: 'context_mismatch',
        cached: null,
      });
      expect(getRuntimeBackendJob('andrea_openai', JOB_ID)).toBeUndefined();
      expect(
        getRuntimeBackendJob(
          overrides.backend || 'andrea_openai',
          overrides.jobId || JOB_ID,
        ),
      ).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain('PRIVATE_FIXTURE');
      expectNoOtherActions(client);
    },
  );

  it('keeps a disabled runtime selected and does not attempt any client request', async () => {
    const { client, input } = fixtureLane();
    client.enabled = false;
    expect(await resolveRuntimeWorkRecovery(input)).toEqual({
      kind: 'unavailable',
      selectedJobId: JOB_ID,
      reason: 'not_enabled',
      cached: null,
    });
    expect(client.getJob).not.toHaveBeenCalled();
    expectNoOtherActions(client);
  });

  it('rejects a different backend group without leaking its job', async () => {
    const { client, input } = fixtureLane();
    client.getJob.mockResolvedValueOnce(
      fixtureJob({
        groupFolder: 'another-group',
        promptPreview: 'PRIVATE_FIXTURE_OTHER_GROUP',
      }),
    );
    const result = await resolveRuntimeWorkRecovery(input);
    expect(result).toEqual({
      kind: 'unavailable',
      selectedJobId: JOB_ID,
      reason: 'context_mismatch',
      cached: null,
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_FIXTURE');
    expectNoOtherActions(client);
  });

  it('does not reuse the same backend cache entry in a different chat', async () => {
    const { client, input } = fixtureLane();
    await resolveRuntimeWorkRecovery(input);
    expect(
      await resolveRuntimeWorkRecovery({ ...input, chatJid: 'tg:other' }),
    ).toEqual({
      kind: 'unavailable',
      selectedJobId: JOB_ID,
      reason: 'context_mismatch',
      cached: null,
    });
    expectNoOtherActions(client);
  });
});
