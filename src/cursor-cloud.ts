import crypto from 'crypto';

import { readEnvFile } from './env.js';

const CURSOR_ENV_KEYS = [
  'CURSOR_API_BASE_URL',
  'CURSOR_API_KEY',
  'CURSOR_WEBHOOK_SECRET',
  'CURSOR_API_TIMEOUT_MS',
] as const;

const DEFAULT_CURSOR_API_BASE_URL = 'https://api.cursor.com';
const DEFAULT_CURSOR_API_TIMEOUT_MS = 20_000;

export interface CursorCloudConfig {
  baseUrl: string;
  apiKey: string;
  webhookSecret: string | null;
  timeoutMs: number;
}

export interface CursorCloudStatus {
  enabled: boolean;
  baseUrl: string;
  hasApiKey: boolean;
  hasWebhookSecret: boolean;
  timeoutMs: number;
}

export interface CursorCloudStatusOptions {
  env?: Record<string, string | undefined>;
  envFileValues?: Record<string, string>;
}

export interface CursorPromptImageDimension {
  width: number;
  height: number;
}

export interface CursorPromptImage {
  data: string;
  dimension: CursorPromptImageDimension;
}

export interface CursorPromptInput {
  text: string;
  images?: CursorPromptImage[];
}

export interface CursorAgentSource {
  repository?: string;
  ref?: string;
  prUrl?: string;
}

export interface CursorAgentTarget {
  autoCreatePr?: boolean;
  openAsCursorGithubApp?: boolean;
  skipReviewerRequest?: boolean;
  branchName?: string;
  autoBranch?: boolean;
}

export interface CursorAgentWebhook {
  url: string;
  secret?: string;
}

export interface CursorCreateAgentRequest {
  prompt: CursorPromptInput;
  model?: string;
  source?: CursorAgentSource;
  target?: CursorAgentTarget;
  webhook?: CursorAgentWebhook;
}

export interface CursorFollowupRequest {
  prompt: CursorPromptInput;
}

export interface CursorAgentRecord {
  id: string;
  name?: string;
  status?: string;
  summary?: string;
  model?: string;
  source?: CursorAgentSource;
  target?: CursorAgentTarget & {
    url?: string;
    prUrl?: string;
  };
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface CursorListAgentsResponse {
  agents: CursorAgentRecord[];
  nextCursor?: string | null;
  [key: string]: unknown;
}

export interface CursorConversationMessage {
  role: string;
  content: string;
  createdAt?: string;
  [key: string]: unknown;
}

export interface CursorConversationResponse {
  messages: CursorConversationMessage[];
  [key: string]: unknown;
}

export interface CursorArtifactRecord {
  absolutePath: string;
  sizeBytes?: number;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface CursorListArtifactsResponse {
  artifacts: CursorArtifactRecord[];
  [key: string]: unknown;
}

export interface CursorArtifactDownloadResponse {
  url: string;
  expiresAt?: string;
  [key: string]: unknown;
}

export interface CursorModelRecord {
  id: string;
  name?: string;
  [key: string]: unknown;
}

export interface CursorListModelsResponse {
  models: CursorModelRecord[];
  [key: string]: unknown;
}

export class CursorCloudApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'CursorCloudApiError';
    this.status = status;
    this.body = body;
  }
}

function normalizeCursorBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return DEFAULT_CURSOR_API_BASE_URL;
  return trimmed.replace(/\/+$/, '');
}

function normalizeTimeoutMs(raw: string | undefined): number {
  const parsed = Number.parseInt(raw || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_CURSOR_API_TIMEOUT_MS;
  }
  return parsed;
}

function resolveCursorEnv(
  options: CursorCloudStatusOptions = {},
): Record<string, string | undefined> {
  const envFileValues =
    options.envFileValues ?? readEnvFile([...CURSOR_ENV_KEYS]);
  const env = options.env ?? process.env;

  return {
    CURSOR_API_BASE_URL:
      env.CURSOR_API_BASE_URL || envFileValues.CURSOR_API_BASE_URL,
    CURSOR_API_KEY: env.CURSOR_API_KEY || envFileValues.CURSOR_API_KEY,
    CURSOR_WEBHOOK_SECRET:
      env.CURSOR_WEBHOOK_SECRET || envFileValues.CURSOR_WEBHOOK_SECRET,
    CURSOR_API_TIMEOUT_MS:
      env.CURSOR_API_TIMEOUT_MS || envFileValues.CURSOR_API_TIMEOUT_MS,
  };
}

export function getCursorCloudStatus(
  options: CursorCloudStatusOptions = {},
): CursorCloudStatus {
  const resolved = resolveCursorEnv(options);
  const baseUrl = normalizeCursorBaseUrl(resolved.CURSOR_API_BASE_URL);
  const apiKey = resolved.CURSOR_API_KEY?.trim() || '';
  const webhookSecret = resolved.CURSOR_WEBHOOK_SECRET?.trim() || '';
  const timeoutMs = normalizeTimeoutMs(resolved.CURSOR_API_TIMEOUT_MS);

  return {
    enabled: apiKey.length > 0,
    baseUrl,
    hasApiKey: apiKey.length > 0,
    hasWebhookSecret: webhookSecret.length > 0,
    timeoutMs,
  };
}

export function resolveCursorCloudConfig(
  options: CursorCloudStatusOptions = {},
): CursorCloudConfig | null {
  const resolved = resolveCursorEnv(options);
  const apiKey = resolved.CURSOR_API_KEY?.trim() || '';
  if (!apiKey) return null;

  return {
    baseUrl: normalizeCursorBaseUrl(resolved.CURSOR_API_BASE_URL),
    apiKey,
    webhookSecret: resolved.CURSOR_WEBHOOK_SECRET?.trim() || null,
    timeoutMs: normalizeTimeoutMs(resolved.CURSOR_API_TIMEOUT_MS),
  };
}

export function formatCursorCloudStatusMessage(
  status: CursorCloudStatus,
): string {
  const lines = [
    '*Cursor Cloud Agents Status*',
    `- Enabled: ${status.enabled ? 'yes' : 'no'}`,
    `- API Base URL: ${status.baseUrl}`,
    `- API key configured: ${status.hasApiKey ? 'yes' : 'no'}`,
    `- Webhook secret configured: ${status.hasWebhookSecret ? 'yes' : 'no'}`,
    `- Request timeout: ${status.timeoutMs}ms`,
  ];

  if (!status.hasApiKey) {
    lines.push(
      '- Next step: set `CURSOR_API_KEY` to enable Cloud Agents mode.',
    );
  }

  return lines.join('\n');
}

function parseJsonSafely(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

function buildBasicAuthHeader(apiKey: string): string {
  const token = Buffer.from(`${apiKey}:`, 'utf-8').toString('base64');
  return `Basic ${token}`;
}

function buildUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string>,
): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`${baseUrl}${normalizedPath}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

export interface CursorCloudClientOptions {
  fetchImpl?: typeof fetch;
}

export class CursorCloudClient {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly config: CursorCloudConfig,
    options: CursorCloudClientOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async listModels(): Promise<CursorListModelsResponse> {
    const payload = await this.request<unknown>('GET', '/v0/models');
    const root = asRecord(payload);
    if (!root) return { models: [] };

    const modelsRaw = root.models;
    const models = Array.isArray(modelsRaw)
      ? modelsRaw
          .filter((entry) => asRecord(entry) !== null)
          .map((entry) => {
            const row = asRecord(entry)!;
            return {
              ...(row as CursorModelRecord),
              id: String(row.id || row.name || 'unknown'),
            };
          })
      : [];

    return {
      ...root,
      models,
    } as CursorListModelsResponse;
  }

  async createAgent(
    request: CursorCreateAgentRequest,
  ): Promise<CursorAgentRecord> {
    return this.request<CursorAgentRecord>('POST', '/v0/agents', request);
  }

  async listAgents(
    params: {
      limit?: number;
      cursor?: string;
      status?: string;
    } = {},
  ): Promise<CursorListAgentsResponse> {
    const query: Record<string, string> = {};
    if (params.limit && Number.isFinite(params.limit)) {
      query.limit = String(
        Math.max(1, Math.min(200, Math.floor(params.limit))),
      );
    }
    if (params.cursor) query.cursor = params.cursor;
    if (params.status) query.status = params.status;

    const payload = await this.request<unknown>(
      'GET',
      '/v0/agents',
      undefined,
      query,
    );
    const root = asRecord(payload);
    if (!root) return { agents: [] };

    const agentsRaw = root.agents;
    const agents = Array.isArray(agentsRaw)
      ? agentsRaw
          .filter((entry) => asRecord(entry) !== null)
          .map((entry) => {
            const row = asRecord(entry)!;
            return {
              ...(row as CursorAgentRecord),
              id: String(row.id || ''),
            };
          })
      : [];

    return {
      ...root,
      agents,
    } as CursorListAgentsResponse;
  }

  async getAgent(agentId: string): Promise<CursorAgentRecord> {
    return this.request<CursorAgentRecord>(
      'GET',
      `/v0/agents/${encodeURIComponent(agentId)}`,
    );
  }

  async getConversation(agentId: string): Promise<CursorConversationResponse> {
    const payload = await this.request<unknown>(
      'GET',
      `/v0/agents/${encodeURIComponent(agentId)}/conversation`,
    );
    const root = asRecord(payload);
    if (!root) return { messages: [] };

    const rawMessages = root.messages;
    const messages = Array.isArray(rawMessages)
      ? rawMessages
          .filter((entry) => asRecord(entry) !== null)
          .map((entry) => {
            const row = asRecord(entry)!;
            return {
              ...(row as CursorConversationMessage),
              role: String(row.role || 'assistant'),
              content: String(row.content || ''),
            };
          })
      : [];

    return {
      ...root,
      messages,
    } as CursorConversationResponse;
  }

  async followupAgent(
    agentId: string,
    request: CursorFollowupRequest,
  ): Promise<CursorAgentRecord> {
    return this.request<CursorAgentRecord>(
      'POST',
      `/v0/agents/${encodeURIComponent(agentId)}/followup`,
      request,
    );
  }

  async stopAgent(agentId: string): Promise<CursorAgentRecord> {
    return this.request<CursorAgentRecord>(
      'POST',
      `/v0/agents/${encodeURIComponent(agentId)}/stop`,
      {},
    );
  }

  async listArtifacts(agentId: string): Promise<CursorListArtifactsResponse> {
    const payload = await this.request<unknown>(
      'GET',
      `/v0/agents/${encodeURIComponent(agentId)}/artifacts`,
    );
    const root = asRecord(payload);
    if (!root) return { artifacts: [] };

    const rawArtifacts = root.artifacts;
    const artifacts = Array.isArray(rawArtifacts)
      ? rawArtifacts
          .filter((entry) => asRecord(entry) !== null)
          .map((entry) => {
            const row = asRecord(entry)!;
            return {
              ...(row as CursorArtifactRecord),
              absolutePath: String(row.absolutePath || ''),
            };
          })
      : [];

    return {
      ...root,
      artifacts,
    } as CursorListArtifactsResponse;
  }

  async getArtifactDownloadLink(
    agentId: string,
    absolutePath: string,
  ): Promise<CursorArtifactDownloadResponse> {
    return this.request<CursorArtifactDownloadResponse>(
      'GET',
      `/v0/agents/${encodeURIComponent(agentId)}/artifacts/download`,
      undefined,
      { path: absolutePath },
    );
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    const url = buildUrl(this.config.baseUrl, path, query);
    try {
      const response = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: buildBasicAuthHeader(this.config.apiKey),
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      const rawText = await response.text();
      const parsed = rawText ? parseJsonSafely(rawText) : null;

      if (!response.ok) {
        const record = asRecord(parsed);
        const detail =
          (record?.error as string | undefined) ||
          (record?.message as string | undefined) ||
          (typeof parsed === 'string' ? parsed : null);
        throw new CursorCloudApiError(
          `Cursor API ${method} ${path} failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
          response.status,
          parsed,
        );
      }

      return parsed as T;
    } catch (err) {
      if (err instanceof CursorCloudApiError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(
          `Cursor API ${method} ${path} timed out after ${this.config.timeoutMs}ms`,
          { cause: err },
        );
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export interface CursorWebhookPayload {
  event?: string;
  timestamp?: string;
  id?: string;
  status?: string;
  summary?: string;
  [key: string]: unknown;
}

export function computeCursorWebhookSignature(
  secret: string,
  rawBody: string | Buffer,
): string {
  return `sha256=${crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex')}`;
}

export function verifyCursorWebhookSignature(
  secret: string,
  rawBody: string | Buffer,
  signatureHeader: string | null | undefined,
): boolean {
  if (!secret || !signatureHeader) return false;
  const expected = computeCursorWebhookSignature(secret, rawBody);
  const received = signatureHeader.trim();
  const expectedBuffer = Buffer.from(expected, 'utf-8');
  const receivedBuffer = Buffer.from(received, 'utf-8');
  if (expectedBuffer.length !== receivedBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}
