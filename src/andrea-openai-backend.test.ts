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
          localExecutionState: 'available_authenticated',
          authState: 'authenticated',
          localExecutionDetail:
            'Codex local execution is authenticated and the container runtime is ready.',
          operatorGuidance: null,
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
          localExecutionState: 'not_ready',
          authState: 'unknown',
          localExecutionDetail:
            'Codex local execution is not ready because podman is installed_not_running.',
          operatorGuidance: 'Start or repair podman, then retry the Codex/OpenAI runtime lane.',
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

  it('maps explicit auth-required meta into auth_required status', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          backend: ANDREA_OPENAI_BACKEND_ID,
          transport: 'http',
          enabled: true,
          version: '1.2.3',
          ready: false,
          localExecutionState: 'available_auth_required',
          authState: 'auth_required',
          localExecutionDetail:
            'Codex local execution is reachable on this host, but no usable Codex login or OPENAI_API_KEY is available yet.',
          operatorGuidance:
            'Run codex login on the Andrea_OpenAI_Bot host, or provide OPENAI_API_KEY before retrying codex_local work.',
        }),
        { status: 200 },
      ),
    );
    const client = new AndreaOpenAiBackendClient({
      enabled: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const status = await client.getStatus();

    expect(status.state).toBe('auth_required');
    expect(status.detail).toContain('no usable Codex login');
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
      expect(String(init?.body)).toContain('"requestedRuntime":"openai_cloud"');
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
      requestedRuntime: 'openai_cloud',
      source: {
        system: 'andrea_nanobot',
        actorType: 'chat',
        actorId: 'tg:1',
        correlationId: 'corr',
      },
    });

    expect(job.jobId).toBe('job_777');
  });

  it('routes companion prompts through POST /route', async () => {
    const fetchImpl = vi.fn(async (input, init) => {
      expect(String(input)).toContain('/route');
      expect(init?.method).toBe('POST');
      expect(String(init?.body)).toContain('"channel":"telegram"');
      return new Response(
        JSON.stringify({
          routeKind: 'assistant_capability',
          capabilityId: 'communication.summarize_thread',
          canonicalText: 'summarize my text messages in Pops of Punk',
          arguments: {
            targetChatName: 'Pops of Punk',
            timeWindowKind: 'default_24h',
            timeWindowValue: 24,
          },
          confidence: 'high',
          clarificationPrompt: null,
          reason: 'matched synced-thread summary request',
        }),
        { status: 200 },
      );
    });
    const client = new AndreaOpenAiBackendClient({
      enabled: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const decision = await client.routePrompt({
      channel: 'telegram',
      text: 'summerize Pops of Punk',
      requestRoute: 'direct_assistant',
    });

    expect(decision).toMatchObject({
      routeKind: 'assistant_capability',
      capabilityId: 'communication.summarize_thread',
      arguments: expect.objectContaining({
        targetChatName: 'Pops of Punk',
      }),
    });
  });

  it('supports generic follow-up targets for group-folder continuity', async () => {
    const fetchImpl = vi.fn(async (input, init) => {
      expect(String(input)).toContain('/followups');
      expect(init?.method).toBe('POST');
      expect(String(init?.body)).toContain('"groupFolder":"main"');
      return new Response(JSON.stringify({ job: makeJob('job_followup') }), {
        status: 202,
      });
    });
    const client = new AndreaOpenAiBackendClient({
      enabled: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const job = await client.followUpTarget({
      groupFolder: 'main',
      prompt: 'Keep going',
      source: { system: 'andrea_nanobot' },
    });

    expect(job.jobId).toBe('job_followup');
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

  it('registers backend groups with NanoBot group metadata', async () => {
    const fetchImpl = vi.fn(async (input, init) => {
      expect(String(input)).toContain('/groups/main');
      expect(init?.method).toBe('PUT');
      expect(String(init?.body)).toContain('"jid":"tg:1"');
      expect(String(init?.body)).toContain('"name":"Andrea Main"');
      expect(String(init?.body)).toContain('"trigger":"@andrea"');
      expect(String(init?.body)).toContain('"addedAt":"2026-04-02T20:00:00.000Z"');
      expect(String(init?.body)).toContain('"requiresTrigger":false');
      expect(String(init?.body)).toContain('"isMain":true');
      return new Response(JSON.stringify({ created: true }), { status: 201 });
    });
    const client = new AndreaOpenAiBackendClient({
      enabled: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.ensureGroupRegistration({
      jid: 'tg:1',
      group: {
        name: 'Andrea Main',
        folder: 'main',
        trigger: '@andrea',
        added_at: '2026-04-02T20:00:00.000Z',
        requiresTrigger: false,
        isMain: true,
      },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
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

  it('preserves conflict error codes from backend registration failures', async () => {
    const client = new AndreaOpenAiBackendClient({
      enabled: true,
      fetchImpl: vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'conflict',
              message: 'Group "main" already exists with conflicting metadata.',
            },
          }),
          { status: 409 },
        ),
      ) as unknown as typeof fetch,
    });

    await expect(
      client.ensureGroupRegistration({
        jid: 'tg:1',
        group: {
          name: 'Andrea Main',
          folder: 'main',
          trigger: '@andrea',
          added_at: '2026-04-02T20:00:00.000Z',
          requiresTrigger: false,
          isMain: true,
        },
      }),
    ).rejects.toMatchObject({
      name: 'AndreaOpenAiBackendHttpError',
      status: 409,
      code: 'conflict',
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
