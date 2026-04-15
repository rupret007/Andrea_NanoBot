import {
  ANDREA_OPENAI_BACKEND_ENABLED,
  ANDREA_OPENAI_BACKEND_TIMEOUT_MS,
  ANDREA_OPENAI_BACKEND_URL,
} from './config.js';
import type {
  CompanionRouteDecision,
  OrchestrationSource,
  RegisteredGroup,
  RuntimeBackendJob,
  RuntimeBackendJobList,
  RuntimeBackendJobLogs,
  RuntimeBackendMeta,
  RuntimeBackendStatus,
  RuntimeBackendStopResult,
} from './types.js';

export const ANDREA_OPENAI_BACKEND_ID = 'andrea_openai';

type ErrorCode =
  | 'validation_error'
  | 'not_found'
  | 'conflict'
  | 'method_not_allowed'
  | 'internal_error';

interface ErrorEnvelope {
  error?: {
    code?: ErrorCode;
    message?: string;
  };
}

export interface EnsureBackendGroupRequest {
  jid: string;
  group: RegisteredGroup;
}

export interface AndreaOpenAiBackendClientOptions {
  enabled?: boolean;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class AndreaOpenAiBackendTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AndreaOpenAiBackendTransportError';
  }
}

export class AndreaOpenAiBackendHttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode | null;
  readonly route: string;

  constructor(params: {
    message: string;
    status: number;
    code: ErrorCode | null;
    route: string;
  }) {
    super(params.message);
    this.name = 'AndreaOpenAiBackendHttpError';
    this.status = params.status;
    this.code = params.code;
    this.route = params.route;
  }
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function asErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAbortLikeError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || err.name === 'TimeoutError')
  );
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const raw = await response.text();
  if (!raw.trim()) {
    return {} as T;
  }
  return JSON.parse(raw) as T;
}

async function requestJson<T>(
  fetchImpl: typeof fetch,
  baseUrl: string,
  timeoutMs: number,
  route: string,
  init: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}${route}`, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers || {}),
      },
    });
  } catch (err) {
    if (isAbortLikeError(err)) {
      throw new AndreaOpenAiBackendTransportError(
        `Andrea OpenAI backend request to ${route} timed out after ${timeoutMs} ms.`,
      );
    }
    throw new AndreaOpenAiBackendTransportError(
      `Andrea OpenAI backend is unavailable at ${baseUrl}: ${asErrorMessage(err)}`,
    );
  }

  const rawText = await response.text();
  let parsed: unknown = null;
  if (rawText.trim()) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      throw new AndreaOpenAiBackendTransportError(
        `Andrea OpenAI backend returned invalid JSON for ${route}.`,
      );
    }
  }

  if (!response.ok) {
    const envelope = (parsed || {}) as ErrorEnvelope;
    throw new AndreaOpenAiBackendHttpError({
      message:
        envelope.error?.message ||
        `Andrea OpenAI backend request failed for ${route} with status ${response.status}.`,
      status: response.status,
      code: envelope.error?.code || null,
      route,
    });
  }

  return (parsed || {}) as T;
}

export class AndreaOpenAiBackendClient {
  readonly enabled: boolean;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AndreaOpenAiBackendClientOptions = {}) {
    this.enabled = options.enabled ?? ANDREA_OPENAI_BACKEND_ENABLED;
    this.baseUrl = trimTrailingSlashes(
      options.baseUrl ?? ANDREA_OPENAI_BACKEND_URL,
    );
    this.timeoutMs = options.timeoutMs ?? ANDREA_OPENAI_BACKEND_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getMeta(): Promise<RuntimeBackendMeta> {
    return requestJson<RuntimeBackendMeta>(
      this.fetchImpl,
      this.baseUrl,
      this.timeoutMs,
      '/meta',
      { method: 'GET' },
    );
  }

  async getStatus(): Promise<RuntimeBackendStatus> {
    if (!this.enabled) {
      return {
        state: 'not_enabled',
        backend: ANDREA_OPENAI_BACKEND_ID,
        version: null,
        transport: 'http',
        detail:
          'Set ANDREA_OPENAI_BACKEND_ENABLED=true to enable the local OpenAI backend lane.',
        meta: null,
      };
    }

    try {
      const meta = await this.getMeta();
      if (meta.backend !== ANDREA_OPENAI_BACKEND_ID) {
        return {
          state: 'unavailable',
          backend: meta.backend,
          version: meta.version,
          transport: 'http',
          detail: `Unexpected backend identity "${meta.backend}" from ${this.baseUrl}.`,
          meta,
        };
      }
      if (
        meta.localExecutionState === 'available_auth_required' ||
        meta.authState === 'auth_required'
      ) {
        return {
          state: 'auth_required',
          backend: meta.backend,
          version: meta.version,
          transport: 'http',
          detail:
            meta.localExecutionDetail ||
            meta.operatorGuidance ||
            'Codex local execution requires a real login on the backend host.',
          meta,
        };
      }
      if (!meta.ready) {
        return {
          state: 'not_ready',
          backend: meta.backend,
          version: meta.version,
          transport: 'http',
          detail:
            meta.localExecutionDetail ||
            meta.operatorGuidance ||
            'Andrea OpenAI backend is reachable but does not currently have a ready execution lane.',
          meta,
        };
      }
      return {
        state: 'available',
        backend: meta.backend,
        version: meta.version,
        transport: 'http',
        detail: null,
        meta,
      };
    } catch (err) {
      return {
        state: 'unavailable',
        backend: ANDREA_OPENAI_BACKEND_ID,
        version: null,
        transport: 'http',
        detail: asErrorMessage(err),
        meta: null,
      };
    }
  }

  async createJob(input: {
    groupFolder: string;
    prompt: string;
    source: OrchestrationSource;
  }): Promise<RuntimeBackendJob> {
    const response = await requestJson<{ job: RuntimeBackendJob }>(
      this.fetchImpl,
      this.baseUrl,
      this.timeoutMs,
      '/jobs',
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    );
    return response.job;
  }

  async followUp(input: {
    jobId: string;
    prompt: string;
    source: OrchestrationSource;
  }): Promise<RuntimeBackendJob> {
    const encodedJobId = encodeURIComponent(input.jobId);
    const response = await requestJson<{ job: RuntimeBackendJob }>(
      this.fetchImpl,
      this.baseUrl,
      this.timeoutMs,
      `/jobs/${encodedJobId}/followup`,
      {
        method: 'POST',
        body: JSON.stringify({
          prompt: input.prompt,
          source: input.source,
        }),
      },
    );
    return response.job;
  }

  async routePrompt(input: {
    channel: 'telegram' | 'bluebubbles';
    text: string;
    requestRoute: 'direct_assistant' | 'protected_assistant';
    conversationSummary?: string | null;
    replyText?: string | null;
    priorPersonName?: string | null;
    priorThreadTitle?: string | null;
    priorLastAnswerSummary?: string | null;
  }): Promise<CompanionRouteDecision> {
    return requestJson<CompanionRouteDecision>(
      this.fetchImpl,
      this.baseUrl,
      this.timeoutMs,
      '/route',
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    );
  }

  async followUpTarget(input: {
    prompt: string;
    source: OrchestrationSource;
    jobId?: string;
    threadId?: string;
    groupFolder?: string;
  }): Promise<RuntimeBackendJob> {
    const response = await requestJson<{ job: RuntimeBackendJob }>(
      this.fetchImpl,
      this.baseUrl,
      this.timeoutMs,
      '/followups',
      {
        method: 'POST',
        body: JSON.stringify({
          prompt: input.prompt,
          source: input.source,
          ...(input.jobId ? { jobId: input.jobId } : {}),
          ...(input.threadId ? { threadId: input.threadId } : {}),
          ...(input.groupFolder ? { groupFolder: input.groupFolder } : {}),
        }),
      },
    );
    return response.job;
  }

  async getJob(jobId: string): Promise<RuntimeBackendJob> {
    const encodedJobId = encodeURIComponent(jobId);
    const response = await requestJson<{ job: RuntimeBackendJob }>(
      this.fetchImpl,
      this.baseUrl,
      this.timeoutMs,
      `/jobs/${encodedJobId}`,
      { method: 'GET' },
    );
    return response.job;
  }

  async listJobs(input: {
    groupFolder: string;
    limit?: number;
    beforeJobId?: string;
  }): Promise<RuntimeBackendJobList> {
    const search = new URLSearchParams();
    search.set('groupFolder', input.groupFolder);
    if (input.limit) search.set('limit', String(input.limit));
    if (input.beforeJobId) search.set('beforeJobId', input.beforeJobId);
    return requestJson<RuntimeBackendJobList>(
      this.fetchImpl,
      this.baseUrl,
      this.timeoutMs,
      `/jobs?${search.toString()}`,
      { method: 'GET' },
    );
  }

  async getJobLogs(input: {
    jobId: string;
    lines?: number;
  }): Promise<RuntimeBackendJobLogs> {
    const encodedJobId = encodeURIComponent(input.jobId);
    const search = new URLSearchParams();
    if (input.lines) search.set('lines', String(input.lines));
    const suffix = search.size > 0 ? `?${search.toString()}` : '';
    return requestJson<RuntimeBackendJobLogs>(
      this.fetchImpl,
      this.baseUrl,
      this.timeoutMs,
      `/jobs/${encodedJobId}/logs${suffix}`,
      { method: 'GET' },
    );
  }

  async stopJob(input: {
    jobId: string;
    source?: OrchestrationSource;
  }): Promise<RuntimeBackendStopResult> {
    const encodedJobId = encodeURIComponent(input.jobId);
    return requestJson<RuntimeBackendStopResult>(
      this.fetchImpl,
      this.baseUrl,
      this.timeoutMs,
      `/jobs/${encodedJobId}/stop`,
      {
        method: 'POST',
        body: JSON.stringify(input.source ? { source: input.source } : {}),
      },
    );
  }

  async ensureGroupRegistration(
    input: EnsureBackendGroupRequest,
  ): Promise<void> {
    const encodedGroupFolder = encodeURIComponent(input.group.folder);
    await requestJson<Record<string, unknown>>(
      this.fetchImpl,
      this.baseUrl,
      this.timeoutMs,
      `/groups/${encodedGroupFolder}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          jid: input.jid,
          name: input.group.name,
          trigger: input.group.trigger,
          addedAt: input.group.added_at,
          requiresTrigger: input.group.requiresTrigger ?? true,
          isMain: input.group.isMain === true,
        }),
      },
    );
  }
}
