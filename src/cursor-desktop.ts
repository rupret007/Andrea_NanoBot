import { readEnvFile } from './env.js';

const CURSOR_DESKTOP_ENV_KEYS = [
  'CURSOR_DESKTOP_BRIDGE_URL',
  'CURSOR_DESKTOP_BRIDGE_TOKEN',
  'CURSOR_DESKTOP_BRIDGE_TIMEOUT_MS',
  'CURSOR_DESKTOP_BRIDGE_LABEL',
] as const;

const DEFAULT_CURSOR_DESKTOP_TIMEOUT_MS = 30_000;

type CursorDesktopProbeStatus = 'ok' | 'failed' | 'skipped';

export interface CursorDesktopConfig {
  baseUrl: string;
  token: string;
  timeoutMs: number;
  label: string | null;
}

export interface CursorDesktopStatus {
  enabled: boolean;
  baseUrl: string | null;
  hasToken: boolean;
  timeoutMs: number;
  label: string | null;
  probeStatus: CursorDesktopProbeStatus;
  probeDetail: string | null;
  machineName: string | null;
  cliPath: string | null;
  activeRuns: number | null;
  trackedSessions: number | null;
}

export interface CursorDesktopConversationMessage {
  role: string;
  content: string;
  createdAt: string | null;
}

export interface CursorDesktopSession {
  id: string;
  status: string;
  model: string | null;
  promptText: string;
  groupFolder: string | null;
  chatJid: string | null;
  sourceRepository: string | null;
  sourceRef: string | null;
  sourcePrUrl: string | null;
  targetUrl: string | null;
  targetPrUrl: string | null;
  targetBranchName: string | null;
  autoCreatePr: boolean;
  openAsCursorGithubApp: boolean;
  skipReviewerRequest: boolean;
  summary: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  lastSyncedAt: string | null;
  provider: 'desktop';
  cursorSessionId: string | null;
  cwd: string | null;
}

export interface CursorDesktopHealth {
  ok: boolean;
  machineName: string | null;
  cliPath: string | null;
  activeRuns: number;
  trackedSessions: number;
  defaultCwd: string | null;
}

export interface CursorDesktopCreateSessionRequest {
  promptText: string;
  requestedBy?: string;
  model?: string;
  groupFolder?: string;
  chatJid?: string;
  cwd?: string;
  sourceRepository?: string;
  sourceRef?: string;
  sourcePrUrl?: string;
  branchName?: string;
  autoCreatePr?: boolean;
  openAsCursorGithubApp?: boolean;
  skipReviewerRequest?: boolean;
}

export interface CursorDesktopFollowupRequest {
  promptText: string;
}

function normalizeBaseUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, '');
}

function normalizeTimeoutMs(value: string | undefined): number {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_CURSOR_DESKTOP_TIMEOUT_MS;
  }
  return Math.min(120_000, parsed);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

function parseJsonSafely(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}

function toNullableString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function toBoolean(value: unknown): boolean {
  return value === true;
}

function mapSession(value: unknown): CursorDesktopSession {
  const row = asRecord(value) || {};

  const createdAt =
    toNullableString(row.createdAt) || new Date(0).toISOString();
  const updatedAt = toNullableString(row.updatedAt) || createdAt;

  return {
    id: String(row.id || ''),
    status: String(row.status || 'UNKNOWN'),
    model: toNullableString(row.model),
    promptText: toNullableString(row.promptText) || '',
    groupFolder: toNullableString(row.groupFolder),
    chatJid: toNullableString(row.chatJid),
    sourceRepository: toNullableString(row.sourceRepository),
    sourceRef: toNullableString(row.sourceRef),
    sourcePrUrl: toNullableString(row.sourcePrUrl),
    targetUrl: toNullableString(row.targetUrl),
    targetPrUrl: toNullableString(row.targetPrUrl),
    targetBranchName: toNullableString(row.targetBranchName),
    autoCreatePr: toBoolean(row.autoCreatePr),
    openAsCursorGithubApp: toBoolean(row.openAsCursorGithubApp),
    skipReviewerRequest: toBoolean(row.skipReviewerRequest),
    summary: toNullableString(row.summary),
    createdBy: toNullableString(row.createdBy),
    createdAt,
    updatedAt,
    lastSyncedAt: toNullableString(row.lastSyncedAt),
    provider: 'desktop',
    cursorSessionId: toNullableString(row.cursorSessionId),
    cwd: toNullableString(row.cwd),
  };
}

function mapHealth(value: unknown): CursorDesktopHealth {
  const row = asRecord(value) || {};
  const activeRuns =
    typeof row.activeRuns === 'number' && Number.isFinite(row.activeRuns)
      ? Math.max(0, Math.floor(row.activeRuns))
      : 0;
  const trackedSessions =
    typeof row.trackedSessions === 'number' &&
    Number.isFinite(row.trackedSessions)
      ? Math.max(0, Math.floor(row.trackedSessions))
      : 0;

  return {
    ok: row.ok !== false,
    machineName: toNullableString(row.machineName),
    cliPath: toNullableString(row.cliPath),
    activeRuns,
    trackedSessions,
    defaultCwd: toNullableString(row.defaultCwd),
  };
}

function buildUrl(baseUrl: string, suffix: string): string {
  const normalizedSuffix = suffix.startsWith('/') ? suffix : `/${suffix}`;
  return `${baseUrl}${normalizedSuffix}`;
}

function resolveDesktopEnv(
  options: CursorDesktopStatusOptions = {},
): Record<string, string | undefined> {
  const envFileValues =
    options.envFileValues ?? readEnvFile([...CURSOR_DESKTOP_ENV_KEYS]);
  const env = options.env ?? process.env;

  return {
    CURSOR_DESKTOP_BRIDGE_URL:
      env.CURSOR_DESKTOP_BRIDGE_URL || envFileValues.CURSOR_DESKTOP_BRIDGE_URL,
    CURSOR_DESKTOP_BRIDGE_TOKEN:
      env.CURSOR_DESKTOP_BRIDGE_TOKEN ||
      envFileValues.CURSOR_DESKTOP_BRIDGE_TOKEN,
    CURSOR_DESKTOP_BRIDGE_TIMEOUT_MS:
      env.CURSOR_DESKTOP_BRIDGE_TIMEOUT_MS ||
      envFileValues.CURSOR_DESKTOP_BRIDGE_TIMEOUT_MS,
    CURSOR_DESKTOP_BRIDGE_LABEL:
      env.CURSOR_DESKTOP_BRIDGE_LABEL ||
      envFileValues.CURSOR_DESKTOP_BRIDGE_LABEL,
  };
}

export interface CursorDesktopStatusOptions {
  env?: Record<string, string | undefined>;
  envFileValues?: Record<string, string>;
  probe?: boolean;
  fetchImpl?: typeof fetch;
}

export function resolveCursorDesktopConfig(
  options: CursorDesktopStatusOptions = {},
): CursorDesktopConfig | null {
  const resolved = resolveDesktopEnv(options);
  const baseUrl = normalizeBaseUrl(resolved.CURSOR_DESKTOP_BRIDGE_URL);
  const token = resolved.CURSOR_DESKTOP_BRIDGE_TOKEN?.trim() || '';
  if (!baseUrl || !token) return null;

  return {
    baseUrl,
    token,
    timeoutMs: normalizeTimeoutMs(resolved.CURSOR_DESKTOP_BRIDGE_TIMEOUT_MS),
    label: toNullableString(resolved.CURSOR_DESKTOP_BRIDGE_LABEL),
  };
}

export async function getCursorDesktopStatus(
  options: CursorDesktopStatusOptions = {},
): Promise<CursorDesktopStatus> {
  const resolved = resolveDesktopEnv(options);
  const baseUrl = normalizeBaseUrl(resolved.CURSOR_DESKTOP_BRIDGE_URL);
  const hasToken = Boolean(resolved.CURSOR_DESKTOP_BRIDGE_TOKEN?.trim());
  const timeoutMs = normalizeTimeoutMs(
    resolved.CURSOR_DESKTOP_BRIDGE_TIMEOUT_MS,
  );
  const label = toNullableString(resolved.CURSOR_DESKTOP_BRIDGE_LABEL);

  const baseStatus: CursorDesktopStatus = {
    enabled: Boolean(baseUrl && hasToken),
    baseUrl,
    hasToken,
    timeoutMs,
    label,
    probeStatus: 'skipped',
    probeDetail: null,
    machineName: null,
    cliPath: null,
    activeRuns: null,
    trackedSessions: null,
  };

  if (!options.probe) return baseStatus;
  if (!baseUrl) {
    return {
      ...baseStatus,
      probeDetail: 'Bridge URL is missing.',
    };
  }
  if (!hasToken) {
    return {
      ...baseStatus,
      probeDetail: 'Bridge token is missing.',
    };
  }

  try {
    const client = new CursorDesktopClient(
      {
        baseUrl,
        token: resolved.CURSOR_DESKTOP_BRIDGE_TOKEN!.trim(),
        timeoutMs,
        label,
      },
      { fetchImpl: options.fetchImpl },
    );
    const health = await client.health();
    return {
      ...baseStatus,
      probeStatus: 'ok',
      probeDetail: null,
      machineName: health.machineName,
      cliPath: health.cliPath,
      activeRuns: health.activeRuns,
      trackedSessions: health.trackedSessions,
    };
  } catch (err) {
    return {
      ...baseStatus,
      probeStatus: 'failed',
      probeDetail: err instanceof Error ? err.message : String(err),
    };
  }
}

export function formatCursorDesktopStatusMessage(
  status: CursorDesktopStatus,
): string {
  const lines = [
    '*Cursor Desktop Bridge Status*',
    `- Enabled: ${status.enabled ? 'yes' : 'no'}`,
    `- URL: ${status.baseUrl || 'not configured'}`,
    `- Auth configured: ${status.hasToken ? 'yes' : 'no'}`,
    `- Probe: ${status.probeStatus}`,
  ];

  if (status.label) {
    lines.push(`- Label: ${status.label}`);
  }
  if (status.machineName) {
    lines.push(`- Machine: ${status.machineName}`);
  }
  if (status.cliPath) {
    lines.push(`- CLI path: ${status.cliPath}`);
  }
  if (status.activeRuns !== null) {
    lines.push(`- Active runs: ${status.activeRuns}`);
  }
  if (status.trackedSessions !== null) {
    lines.push(`- Tracked sessions: ${status.trackedSessions}`);
  }
  if (status.probeDetail) {
    lines.push(`- Probe detail: ${status.probeDetail}`);
  }
  if (!status.enabled) {
    lines.push(
      '- Next step: set `CURSOR_DESKTOP_BRIDGE_URL` and `CURSOR_DESKTOP_BRIDGE_TOKEN` to reach your normal Cursor machine.',
    );
  }

  return lines.join('\n');
}

export interface CursorDesktopClientOptions {
  fetchImpl?: typeof fetch;
}

export class CursorDesktopClient {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly config: CursorDesktopConfig,
    options: CursorDesktopClientOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async health(): Promise<CursorDesktopHealth> {
    const payload = await this.request('GET', '/health');
    return mapHealth(payload);
  }

  async listSessions(limit = 50): Promise<CursorDesktopSession[]> {
    const safeLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(200, Math.floor(limit)))
      : 50;
    const payload = await this.request(
      'GET',
      `/v1/sessions?limit=${safeLimit}`,
    );
    const row = asRecord(payload) || {};
    const sessions = Array.isArray(row.sessions) ? row.sessions : [];
    return sessions.map(mapSession);
  }

  async createSession(
    request: CursorDesktopCreateSessionRequest,
  ): Promise<CursorDesktopSession> {
    const payload = await this.request('POST', '/v1/sessions', request);
    return mapSession(payload);
  }

  async getSession(id: string): Promise<CursorDesktopSession> {
    const payload = await this.request(
      'GET',
      `/v1/sessions/${encodeURIComponent(id)}`,
    );
    return mapSession(payload);
  }

  async followupSession(
    id: string,
    request: CursorDesktopFollowupRequest,
  ): Promise<CursorDesktopSession> {
    const payload = await this.request(
      'POST',
      `/v1/sessions/${encodeURIComponent(id)}/followup`,
      request,
    );
    return mapSession(payload);
  }

  async stopSession(id: string): Promise<CursorDesktopSession> {
    const payload = await this.request(
      'POST',
      `/v1/sessions/${encodeURIComponent(id)}/stop`,
      {},
    );
    return mapSession(payload);
  }

  async getConversation(
    id: string,
    limit = 20,
  ): Promise<CursorDesktopConversationMessage[]> {
    const safeLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(200, Math.floor(limit)))
      : 20;
    const payload = await this.request(
      'GET',
      `/v1/sessions/${encodeURIComponent(id)}/conversation?limit=${safeLimit}`,
    );
    const row = asRecord(payload) || {};
    const messages = Array.isArray(row.messages) ? row.messages : [];
    return messages.map((message) => {
      const record = asRecord(message) || {};
      return {
        role: toNullableString(record.role) || 'assistant',
        content: toNullableString(record.content) || '',
        createdAt: toNullableString(record.createdAt),
      };
    });
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await this.fetchImpl(
        buildUrl(this.config.baseUrl, path),
        {
          method,
          headers: {
            authorization: `Bearer ${this.config.token}`,
            'content-type': 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        },
      );

      const rawText = await response.text();
      const payload = rawText ? parseJsonSafely(rawText) : {};
      if (!response.ok) {
        const row = asRecord(payload);
        const detail =
          toNullableString(row?.error) ||
          toNullableString(row?.message) ||
          (typeof payload === 'string' && payload.trim()
            ? payload.trim()
            : null) ||
          `HTTP ${response.status}`;
        throw new Error(detail);
      }
      if (typeof payload === 'string') {
        throw new Error(
          'Cursor desktop bridge returned an invalid JSON response.',
        );
      }
      return payload;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(
          `Cursor desktop bridge timed out after ${this.config.timeoutMs}ms`,
          { cause: err },
        );
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}
