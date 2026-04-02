import { describe, expect, it, vi } from 'vitest';

import {
  ANDREA_OPENAI_BACKEND_ID,
  AndreaOpenAiBackendClient,
  AndreaOpenAiBackendHttpError,
  AndreaOpenAiBackendTransportError,
} from './andrea-openai-backend.js';

function makeJob(jobId = 'job_001') {
  return {
    backend: ANDREA_OPENAI_BACKEND_ID,
    jobId,
    kind: 'create' as const,
    status: 'queued' as const,
    stopRequested: false,
    groupFolder: 'main',
    groupJid: 'tg:1',
    threadId: null,
    runtimeRoute: 'local_required' as const,
    requestedRuntime: 'codex_local' as const,
    selectedRuntime: 'codex_local' as const,
    promptPreview: 'Ship it',
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
  };
}

describe('AndreaOpenAiBackendClient', () => {
  it('returns not_enabled status when the lane is disabled', async () => {
    const client = new AndreaOpenAiBackendClient({
      enabled: false,
      fetchImpl: vi.fn(),
    });

    const status = await client.getStatus();

    expect(status.state).toBe('not_enabled');
    expect(status.backend).toBe(ANDREA_OPENAI_BACKEND_ID);
  });

  it('maps /meta into available status', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          backend: ANDREA_OPENAI_BACKEND_ID,
          transport: 'http',
          enabled: true,
          version: '1.2.3',
          ready: true,
        }),
        { status: 200 },
      ),
    );
    const client = new AndreaOpenAiBackendClient({
      enabled: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const status = await client.getStatus();

    expect(status.state).toBe('available');
    expect(status.version).toBe('1.2.3');
  });

  it('maps /meta into not_ready status', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          backend: ANDREA_OPENAI_BACKEND_ID,
          transport: 'http',
          enabled: true,
          version: null,
          ready: false,
        }),
        { status: 200 },
      ),
    );
    const client = new AndreaOpenAiBackendClient({
      enabled: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const status = await client.getStatus();

    expect(status.state).toBe('not_ready');
  });

  it('maps transport failures into unavailable status', async () => {
    const client = new AndreaOpenAiBackendClient({
      enabled: true,
      fetchImpl: vi.fn(async () => {
        throw new Error('connect ECONNREFUSED');
      }) as unknown as typeof fetch,
    });

    const status = await client.getStatus();

    expect(status.state).toBe('unavailable');
    expect(status.detail).toContain('ECONNREFUSED');
  });

  it('creates jobs with the generic source shape', async () => {
    const fetchImpl = vi.fn(async (_input, init) => {
      expect(init?.method).toBe('POST');
      expect(String(init?.body)).toContain('"system":"andrea_nanobot"');
      return new Response(JSON.stringify({ job: makeJob('job_777') }), {
        status: 202,
      });
    });
    const client = new AndreaOpenAiBackendClient({
      enabled: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const job = await client.createJob({
      groupFolder: 'main',
      prompt: 'Do the work',
      source: {
        system: 'andrea_nanobot',
        actorType: 'chat',
        actorId: 'tg:1',
        correlationId: 'corr',
      },
    });

    expect(job.jobId).toBe('job_777');
  });

  it('passes list pagination through without reshaping it', async () => {
    const fetchImpl = vi.fn(async (input) => {
      expect(String(input)).toContain('groupFolder=main');
      expect(String(input)).toContain('limit=10');
      expect(String(input)).toContain('beforeJobId=job_050');
      return new Response(
        JSON.stringify({
          jobs: [makeJob('job_040')],
          nextBeforeJobId: 'job_040',
        }),
        { status: 200 },
      );
    });
    const client = new AndreaOpenAiBackendClient({
      enabled: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.listJobs({
      groupFolder: 'main',
      limit: 10,
      beforeJobId: 'job_050',
    });

    expect(result.jobs[0]?.jobId).toBe('job_040');
    expect(result.nextBeforeJobId).toBe('job_040');
  });

  it('returns logs and stop payloads', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jobId: 'job_123',
            logFile: 'container-job_123.log',
            logText: 'tail output',
            lines: 40,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            job: makeJob('job_123'),
            liveStopAccepted: true,
          }),
          { status: 200 },
        ),
      );
    const client = new AndreaOpenAiBackendClient({
      enabled: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const logs = await client.getJobLogs({ jobId: 'job_123', lines: 40 });
    const stop = await client.stopJob({ jobId: 'job_123' });

    expect(logs.logText).toBe('tail output');
    expect(stop.liveStopAccepted).toBe(true);
  });

  it('surfaces structured backend HTTP errors', async () => {
    const client = new AndreaOpenAiBackendClient({
      enabled: true,
      fetchImpl: vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'not_found',
              message: 'No runtime job found for "missing".',
            },
          }),
          { status: 404 },
        ),
      ) as unknown as typeof fetch,
    });

    await expect(client.getJob('missing')).rejects.toMatchObject({
      name: 'AndreaOpenAiBackendHttpError',
      status: 404,
      code: 'not_found',
    } satisfies Partial<AndreaOpenAiBackendHttpError>);
  });

  it('surfaces transport failures directly', async () => {
    const client = new AndreaOpenAiBackendClient({
      enabled: true,
      fetchImpl: vi.fn(async () => {
        throw new Error('socket hang up');
      }) as unknown as typeof fetch,
    });

    await expect(client.getMeta()).rejects.toBeInstanceOf(
      AndreaOpenAiBackendTransportError,
    );
  });
});
