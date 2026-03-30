import { readEnvFile } from './env.js';

const CURSOR_RELEVANT_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'OPENAI_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'CURSOR_GATEWAY_HINT',
  'NANOCLAW_AGENT_MODEL',
  'CLAUDE_CODE_MODEL',
  'CLAUDE_MODEL',
] as const;

type CursorMode = 'disabled' | 'partial' | 'configured';
type CursorProbeStatus = 'ok' | 'failed' | 'skipped';
type CursorSmokeStatus = 'ok' | 'failed' | 'skipped';

interface CursorGatewayConfig {
  endpoint: string | null;
  authTokenConfigured: boolean;
  model: string | null;
  viaNineRouter: boolean;
  cursorGatewayHinted: boolean;
  modelLooksCursorBacked: boolean;
}

export interface CursorGatewayStatus extends CursorGatewayConfig {
  mode: CursorMode;
  probeStatus: CursorProbeStatus;
  probeDetail: string | null;
}

export interface CursorGatewaySmokeTestResult {
  status: CursorSmokeStatus;
  detail: string;
  endpoint: string | null;
  model: string | null;
}

interface CursorGatewayStatusOptions {
  env?: Record<string, string | undefined>;
  envFileValues?: Record<string, string>;
  probe?: boolean;
  fetchImpl?: typeof fetch;
}

interface CursorGatewaySmokeTestOptions extends CursorGatewayStatusOptions {
  status?: CursorGatewayStatus;
}

function normalizeEndpoint(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, '');
}

function looksLikeNineRouterEndpoint(endpoint: string | null): boolean {
  if (!endpoint) return false;
  try {
    const parsed = new URL(
      /^https?:\/\//i.test(endpoint) ? endpoint : `http://${endpoint}`,
    );
    if (parsed.port === '20128') return true;
    return parsed.hostname.toLowerCase().includes('9router');
  } catch {
    return false;
  }
}

function looksLikeCursorModel(model: string | null): boolean {
  if (!model) return false;
  return model.trim().toLowerCase().startsWith('cu/');
}

function hasCursorGatewayHint(value: string | undefined): boolean {
  const normalized = (value || '').trim().toLowerCase();
  return normalized === '9router' || normalized === 'cursor';
}

function buildModelsUrl(endpoint: string): string {
  const parsed = new URL(
    /^https?:\/\//i.test(endpoint) ? endpoint : `http://${endpoint}`,
  );
  const trimmedPath = parsed.pathname.replace(/\/+$/, '');
  parsed.pathname = trimmedPath.endsWith('/v1')
    ? `${trimmedPath}/models`
    : `${trimmedPath}/v1/models`;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function buildChatCompletionsUrl(endpoint: string): string {
  const parsed = new URL(
    /^https?:\/\//i.test(endpoint) ? endpoint : `http://${endpoint}`,
  );
  const trimmedPath = parsed.pathname.replace(/\/+$/, '');
  parsed.pathname = trimmedPath.endsWith('/v1')
    ? `${trimmedPath}/chat/completions`
    : `${trimmedPath}/v1/chat/completions`;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function resolveCursorGatewayConfig(
  options: CursorGatewayStatusOptions = {},
): CursorGatewayConfig {
  const envFileValues =
    options.envFileValues ?? readEnvFile([...CURSOR_RELEVANT_ENV_KEYS]);
  const env = options.env ?? process.env;

  const endpoint = normalizeEndpoint(
    env.ANTHROPIC_BASE_URL ||
      envFileValues.ANTHROPIC_BASE_URL ||
      env.OPENAI_BASE_URL ||
      envFileValues.OPENAI_BASE_URL,
  );
  const model =
    env.NANOCLAW_AGENT_MODEL ||
    envFileValues.NANOCLAW_AGENT_MODEL ||
    env.CLAUDE_CODE_MODEL ||
    envFileValues.CLAUDE_CODE_MODEL ||
    env.CLAUDE_MODEL ||
    envFileValues.CLAUDE_MODEL ||
    null;
  const authTokenConfigured = Boolean(
    env.ANTHROPIC_AUTH_TOKEN ||
    envFileValues.ANTHROPIC_AUTH_TOKEN ||
    env.ANTHROPIC_API_KEY ||
    envFileValues.ANTHROPIC_API_KEY ||
    env.OPENAI_API_KEY ||
    envFileValues.OPENAI_API_KEY,
  );

  const viaNineRouter = looksLikeNineRouterEndpoint(endpoint);
  const cursorGatewayHinted = hasCursorGatewayHint(
    env.CURSOR_GATEWAY_HINT || envFileValues.CURSOR_GATEWAY_HINT,
  );
  const modelLooksCursorBacked = looksLikeCursorModel(model);

  return {
    endpoint,
    authTokenConfigured,
    model,
    viaNineRouter,
    cursorGatewayHinted,
    modelLooksCursorBacked,
  };
}

function resolveAuthToken(
  options: CursorGatewayStatusOptions = {},
): string | undefined {
  const envFileValues =
    options.envFileValues ?? readEnvFile([...CURSOR_RELEVANT_ENV_KEYS]);
  const env = options.env ?? process.env;
  return (
    env.ANTHROPIC_AUTH_TOKEN ||
    envFileValues.ANTHROPIC_AUTH_TOKEN ||
    env.ANTHROPIC_API_KEY ||
    envFileValues.ANTHROPIC_API_KEY ||
    env.OPENAI_API_KEY ||
    envFileValues.OPENAI_API_KEY
  );
}

function extractAssistantText(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const maybeChoices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(maybeChoices) || maybeChoices.length === 0) return null;
  const firstChoice = maybeChoices[0];
  if (!firstChoice || typeof firstChoice !== 'object') return null;
  const message = (firstChoice as { message?: unknown }).message;
  if (!message || typeof message !== 'object') return null;
  const content = (message as { content?: unknown }).content;
  return typeof content === 'string' ? content : null;
}

async function probeCursorGateway(
  endpoint: string,
  token: string | undefined,
  fetchImpl: typeof fetch,
): Promise<{ status: CursorProbeStatus; detail: string | null }> {
  if (!token) {
    return {
      status: 'skipped',
      detail: 'Auth token/key is not configured.',
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);

  try {
    const url = buildModelsUrl(endpoint);
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        'x-api-key': token,
      },
      signal: controller.signal,
    });

    if (response.ok) {
      return { status: 'ok', detail: null };
    }

    return {
      status: 'failed',
      detail: `Gateway responded with HTTP ${response.status}.`,
    };
  } catch (err) {
    return {
      status: 'failed',
      detail: `Gateway probe failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function getCursorGatewayStatus(
  options: CursorGatewayStatusOptions = {},
): Promise<CursorGatewayStatus> {
  const config = resolveCursorGatewayConfig(options);

  const cursorSignalsEnabled =
    config.viaNineRouter ||
    config.cursorGatewayHinted ||
    config.modelLooksCursorBacked;
  const mode: CursorMode = !cursorSignalsEnabled
    ? 'disabled'
    : config.endpoint && config.authTokenConfigured
      ? 'configured'
      : 'partial';

  if (!options.probe || !config.endpoint || !cursorSignalsEnabled) {
    return {
      ...config,
      mode,
      probeStatus: 'skipped',
      probeDetail:
        cursorSignalsEnabled && !config.endpoint
          ? 'Endpoint is missing.'
          : null,
    };
  }

  const authToken = resolveAuthToken(options);

  const fetchImpl = options.fetchImpl ?? fetch;
  const probe = await probeCursorGateway(config.endpoint, authToken, fetchImpl);

  return {
    ...config,
    mode,
    probeStatus: probe.status,
    probeDetail: probe.detail,
  };
}

export async function runCursorGatewaySmokeTest(
  options: CursorGatewaySmokeTestOptions = {},
): Promise<CursorGatewaySmokeTestResult> {
  const status =
    options.status ??
    (await getCursorGatewayStatus({ ...options, probe: false }));

  if (status.mode === 'disabled') {
    return {
      status: 'skipped',
      detail: 'Cursor routing is not enabled in current config.',
      endpoint: status.endpoint,
      model: status.model,
    };
  }

  if (!status.endpoint) {
    return {
      status: 'skipped',
      detail: 'Cursor endpoint is missing.',
      endpoint: status.endpoint,
      model: status.model,
    };
  }

  const authToken = resolveAuthToken(options);
  if (!authToken) {
    return {
      status: 'skipped',
      detail: 'Auth token/key is not configured.',
      endpoint: status.endpoint,
      model: status.model,
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const smokeModel = status.model || 'cu/default';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetchImpl(buildChatCompletionsUrl(status.endpoint), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${authToken}`,
        'x-api-key': authToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: smokeModel,
        messages: [
          {
            role: 'user',
            content: 'Reply with exactly: OK',
          },
        ],
        max_tokens: 12,
        temperature: 0,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        status: 'failed',
        detail: `Smoke test failed with HTTP ${response.status}.`,
        endpoint: status.endpoint,
        model: smokeModel,
      };
    }

    const payload = await response.json();
    const assistantText = extractAssistantText(payload);

    if (!assistantText) {
      return {
        status: 'failed',
        detail: 'Gateway returned no assistant text payload.',
        endpoint: status.endpoint,
        model: smokeModel,
      };
    }

    const normalized = assistantText.trim();
    if (/^ok$/i.test(normalized)) {
      return {
        status: 'ok',
        detail: 'Smoke test succeeded.',
        endpoint: status.endpoint,
        model: smokeModel,
      };
    }

    return {
      status: 'ok',
      detail: `Gateway responded, but output was "${normalized.slice(0, 60)}".`,
      endpoint: status.endpoint,
      model: smokeModel,
    };
  } catch (err) {
    return {
      status: 'failed',
      detail: `Smoke test request failed: ${err instanceof Error ? err.message : String(err)}`,
      endpoint: status.endpoint,
      model: smokeModel,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function formatCursorGatewayStatusMessage(
  status: CursorGatewayStatus,
): string {
  const lines = [
    '*Cursor Integration Status*',
    `- Mode: ${status.mode}`,
    `- Endpoint: ${status.endpoint || 'not configured'}`,
    `- Model: ${status.model || 'default'}`,
    `- Cursor route detected: ${status.viaNineRouter || status.cursorGatewayHinted || status.modelLooksCursorBacked ? 'yes' : 'no'}`,
    `- Auth configured: ${status.authTokenConfigured ? 'yes' : 'no'}`,
    `- Gateway probe: ${status.probeStatus}`,
  ];

  if (status.cursorGatewayHinted) {
    lines.push('- Gateway hint: explicit');
  }

  if (status.probeDetail) {
    lines.push(`- Probe detail: ${status.probeDetail}`);
  }

  if (status.mode === 'partial') {
    lines.push(
      '- Next step: set both `ANTHROPIC_BASE_URL` and a valid auth token/key only if you want Cursor-backed runtime routing. This route is optional and separate from Cursor Cloud jobs and desktop bridge terminal control. Add `CURSOR_GATEWAY_HINT=9router` when using a remote/custom 9router URL.',
    );
  } else if (status.mode === 'disabled') {
    lines.push(
      '- Next step: leave this disabled unless you want Cursor-backed runtime routing. It is optional and separate from Cursor Cloud jobs and desktop bridge terminal control. To enable it, configure 9router + `NANOCLAW_AGENT_MODEL=cu/default`. For remote/custom 9router URLs, also set `CURSOR_GATEWAY_HINT=9router`.',
    );
  }

  return lines.join('\n');
}

export function formatCursorGatewaySmokeTestMessage(
  status: CursorGatewayStatus,
  smoke: CursorGatewaySmokeTestResult,
): string {
  const lines = [
    '*Cursor End-to-End Test*',
    `- Integration mode: ${status.mode}`,
    `- Endpoint: ${smoke.endpoint || status.endpoint || 'not configured'}`,
    `- Model: ${smoke.model || status.model || 'default'}`,
    `- Status probe: ${status.probeStatus}`,
    `- E2E smoke: ${smoke.status}`,
    `- Detail: ${smoke.detail}`,
  ];

  if (smoke.status !== 'ok') {
    lines.push(
      '- Next step: verify endpoint/auth/model values in `.env`, then run `/cursor_test` again.',
    );
  }

  return lines.join('\n');
}
