import {
  ANDREA_OPENAI_BACKEND_ENABLED,
  ANDREA_OPENAI_BACKEND_TIMEOUT_MS,
  ANDREA_OPENAI_BACKEND_URL,
  ANDREA_PLATFORM_COORDINATOR_ENABLED,
  ANDREA_PLATFORM_COORDINATOR_URL,
  ANDREA_PLATFORM_FALLBACK_TO_DIRECT_RUNTIME,
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

interface RuntimeBackendDispatchSurface {
  metaRoute: string;
  statusRoute: string;
  jobsCollectionRoute: string;
  jobItemRoute: string;
  jobFollowUpRoute: string;
  jobLogsRoute: string;
  jobStopRoute: string;
  followUpsCollectionRoute: string;
  groupsCollectionRoute: string;
}

interface RuntimeBackendRuntimeSnapshot {
  defaultRuntime: string;
  fallbackRuntime: string;
  codexLocalEnabled: boolean;
  codexLocalModel: string | null;
  codexLocalReady: boolean;
  hostCodexAuthPresent: boolean;
  openAiModelFallback: string;
  openAiApiKeyPresent: boolean;
  openAiCloudReady: boolean;
  openAiBaseUrl: string | null;
  activeThreadCount: number;
  activeJobCount: number;
  containerRuntimeName: string;
  containerRuntimeStatus: string;
}

interface RuntimeBackendStatusSnapshot extends RuntimeBackendMeta {
  dispatchSurface: RuntimeBackendDispatchSurface;
  runtime: RuntimeBackendRuntimeSnapshot;
}

interface PlatformCoordinatorJobSummary {
  job_id: string;
  group_folder?: string | null;
  thread_id?: string | null;
  state: string;
  selected_runtime?: string | null;
  summary?: string | null;
  error_text?: string | null;
  updated_at?: string | null;
}

interface PlatformCoordinatorSnapshot {
  lifecycle_state: string;
  lifecycle_reason: string;
  component_rollup: Record<string, string>;
  active_blockers: string[];
  faults: Record<string, Record<string, unknown>>;
  recent_jobs: PlatformCoordinatorJobSummary[];
  proof_rollup: Record<string, string>;
  memory_freshness_rollup?: Record<string, string>;
  integration_health_rollup?: Record<string, string>;
  ritual_status_rollup?: Record<string, string>;
  trace_rollup?: Record<string, string>;
  determinism_audit_rollup?: Record<string, string>;
  replay_validation_rollup?: Record<string, string>;
  metadata: Record<string, string>;
}

interface PlatformCoordinatorStatusBundle {
  snapshot: PlatformCoordinatorSnapshot;
  backend_status: RuntimeBackendStatus;
  system_manager?: Record<string, unknown> | null;
  health_monitor?: Record<string, unknown> | null;
  last_intent_request?: Record<string, unknown> | null;
  last_intent_response?: Record<string, unknown> | null;
  trace_index?: Record<string, string> | null;
  determinism_audit?: Record<string, unknown> | null;
  replay_validation?: Record<string, unknown> | null;
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

function looksLikeRuntimeBackendStatusSnapshot(
  value: unknown,
): value is RuntimeBackendStatusSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Record<string, unknown>;
  return (
    typeof snapshot.backend === 'string' &&
    typeof snapshot.transport === 'string' &&
    typeof snapshot.enabled === 'boolean' &&
    typeof snapshot.ready === 'boolean' &&
    typeof snapshot.localExecutionState === 'string' &&
    typeof snapshot.authState === 'string' &&
    snapshot.dispatchSurface !== undefined &&
    snapshot.runtime !== undefined
  );
}

function looksLikePlatformCoordinatorStatusBundle(
  value: unknown,
): value is PlatformCoordinatorStatusBundle {
  if (!value || typeof value !== 'object') return false;
  const bundle = value as Record<string, unknown>;
  const snapshot = bundle.snapshot as Record<string, unknown> | undefined;
  const backendStatus = bundle.backend_status as Record<string, unknown> | undefined;
  return (
    snapshot !== undefined &&
    typeof snapshot.lifecycle_state === 'string' &&
    backendStatus !== undefined &&
    typeof backendStatus.state === 'string'
  );
}

function buildPlatformLifecycleDetail(
  snapshot: PlatformCoordinatorSnapshot | null | undefined,
  existingDetail: string | null | undefined,
): string | null {
  if (!snapshot) {
    return existingDetail || null;
  }

  const details = [
    `Platform lifecycle: ${snapshot.lifecycle_state}.`,
    snapshot.lifecycle_reason ? `Reason: ${snapshot.lifecycle_reason}` : null,
    snapshot.active_blockers.length > 0
      ? `Blockers: ${snapshot.active_blockers.join(' | ')}`
      : null,
    snapshot.recent_jobs.length > 0
      ? `Recent jobs tracked: ${snapshot.recent_jobs.length}`
      : null,
    snapshot.trace_rollup?.trace_events
      ? `Trace events: ${snapshot.trace_rollup.trace_events}`
      : null,
    snapshot.determinism_audit_rollup?.status
      ? `Determinism audit: ${snapshot.determinism_audit_rollup.status}`
      : null,
    snapshot.replay_validation_rollup?.last_passed
      ? `Replay validation last passed: ${snapshot.replay_validation_rollup.last_passed}`
      : null,
    snapshot.memory_freshness_rollup &&
    Object.keys(snapshot.memory_freshness_rollup).length > 0
      ? `Memory registry keys: ${Object.keys(snapshot.memory_freshness_rollup).length}`
      : null,
    snapshot.integration_health_rollup &&
    Object.keys(snapshot.integration_health_rollup).length > 0
      ? `Integration health entries: ${Object.keys(snapshot.integration_health_rollup).length}`
      : null,
    existingDetail || null,
  ].filter((line): line is string => Boolean(line));

  return details.length > 0 ? details.join(' ') : null;
}

function mapMetaToRuntimeBackendStatus(
  meta: RuntimeBackendMeta,
  detailOverride?: string | null,
): RuntimeBackendStatus {
  if (meta.backend !== ANDREA_OPENAI_BACKEND_ID) {
    return {
      state: 'unavailable',
      backend: meta.backend,
      version: meta.version,
      transport: 'http',
      detail: `Unexpected backend identity "${meta.backend}" from configured runtime lane.`,
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
        detailOverride ||
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
        detailOverride ||
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
    detail: detailOverride || null,
    meta,
  };
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
    const resolvedBaseUrl =
      options.baseUrl ??
      (ANDREA_PLATFORM_COORDINATOR_ENABLED &&
      !ANDREA_PLATFORM_FALLBACK_TO_DIRECT_RUNTIME
        ? ANDREA_PLATFORM_COORDINATOR_URL
        : ANDREA_OPENAI_BACKEND_URL);
    this.baseUrl = trimTrailingSlashes(
      resolvedBaseUrl,
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

  private async getStatusSnapshot():
    Promise<RuntimeBackendStatusSnapshot | PlatformCoordinatorStatusBundle | null> {
    try {
      const snapshot = await requestJson<unknown>(
        this.fetchImpl,
        this.baseUrl,
        this.timeoutMs,
        '/status',
        { method: 'GET' },
      );
      if (
        looksLikeRuntimeBackendStatusSnapshot(snapshot) ||
        looksLikePlatformCoordinatorStatusBundle(snapshot)
      ) {
        return snapshot;
      }
      return null;
    } catch (err) {
      if (
        err instanceof AndreaOpenAiBackendHttpError &&
        err.route === '/status' &&
        err.status === 404
      ) {
        return null;
      }
      throw err;
    }
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
      const snapshot = await this.getStatusSnapshot();
      if (snapshot) {
        if (looksLikePlatformCoordinatorStatusBundle(snapshot)) {
          return {
            ...snapshot.backend_status,
            detail: buildPlatformLifecycleDetail(
              snapshot.snapshot,
              snapshot.backend_status.detail,
            ),
          };
        }

        return mapMetaToRuntimeBackendStatus(
          snapshot,
          buildPlatformLifecycleDetail(null, snapshot.localExecutionDetail),
        );
      }

      const meta = await this.getMeta();
      return mapMetaToRuntimeBackendStatus(meta);
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

  async getPlatformTrace(traceId: string): Promise<Record<string, unknown>> {
    return requestJson<Record<string, unknown>>(
      this.fetchImpl,
      this.baseUrl,
      this.timeoutMs,
      `/trace/${encodeURIComponent(traceId)}`,
      { method: 'GET' },
    );
  }

  async getPlatformDeterminismAudit(): Promise<Record<string, unknown>> {
    return requestJson<Record<string, unknown>>(
      this.fetchImpl,
      this.baseUrl,
      this.timeoutMs,
      '/audit/determinism',
      { method: 'GET' },
    );
  }

  async getPlatformProofReport(): Promise<Record<string, unknown>> {
    return requestJson<Record<string, unknown>>(
      this.fetchImpl,
      this.baseUrl,
      this.timeoutMs,
      '/proof-report',
      { method: 'GET' },
    );
  }

  async capturePlatformReplay(input: {
    sessionId?: string;
    notes?: string;
  } = {}): Promise<Record<string, unknown>> {
    return requestJson<Record<string, unknown>>(
      this.fetchImpl,
      this.baseUrl,
      this.timeoutMs,
      '/replay/capture',
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    );
  }

  async validatePlatformReplay(input: {
    sessionId?: string;
    artifactPath?: string;
  }): Promise<Record<string, unknown>> {
    return requestJson<Record<string, unknown>>(
      this.fetchImpl,
      this.baseUrl,
      this.timeoutMs,
      '/replay/validate',
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    );
  }

  async createJob(input: {
    groupFolder: string;
    prompt: string;
    requestedRuntime?: 'codex_local' | 'openai_cloud' | 'claude_legacy' | null;
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
        body: JSON.stringify({
          channel: input.channel,
          text: input.text,
          requestRoute: input.requestRoute,
          ...(input.conversationSummary
            ? { conversationSummary: input.conversationSummary }
            : {}),
          ...(input.replyText ? { replyText: input.replyText } : {}),
          ...(input.priorPersonName
            ? { priorPersonName: input.priorPersonName }
            : {}),
          ...(input.priorThreadTitle
            ? { priorThreadTitle: input.priorThreadTitle }
            : {}),
          ...(input.priorLastAnswerSummary
            ? { priorLastAnswerSummary: input.priorLastAnswerSummary }
            : {}),
        }),
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
