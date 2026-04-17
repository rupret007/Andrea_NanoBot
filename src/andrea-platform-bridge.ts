import { logger } from './logger.js';
import type { ChannelHealthSnapshot, RuntimeBackendStatus } from './types.js';

const SHELL_GATEWAY_BASE_URL = (
  process.env.ANDREA_PLATFORM_SHELL_GATEWAY_URL || ''
).trim().replace(/\/+$/, '');

type IntentResponseOutcome = 'handled' | 'blocked' | 'degraded' | 'fallback';
type HealthSeverity =
  | 'healthy'
  | 'degraded'
  | 'faulted'
  | 'blocked_external'
  | 'near_live_only';

function shellGatewayRoute(path: string): string | null {
  if (!SHELL_GATEWAY_BASE_URL) return null;
  return `${SHELL_GATEWAY_BASE_URL}${path}`;
}

async function postShellGateway(path: string, payload: object): Promise<void> {
  const url = shellGatewayRoute(path);
  if (!url) return;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      logger.warn(
        {
          component: 'andrea_platform_shell_bridge',
          path,
          status: response.status,
        },
        'Andrea platform shell bridge returned a non-2xx response.',
      );
    }
  } catch (err) {
    logger.debug(
      {
        component: 'andrea_platform_shell_bridge',
        path,
        err,
      },
      'Andrea platform shell bridge post failed.',
    );
  }
}

export function isAndreaPlatformShellBridgeEnabled(): boolean {
  return Boolean(SHELL_GATEWAY_BASE_URL);
}

export async function emitAndreaPlatformShellHealth(
  input: {
    severity: HealthSeverity;
    summary: string;
    detail?: string | null;
    metadata?: Record<string, string>;
  },
): Promise<void> {
  await postShellGateway('/system/health', {
    source: 'andrea_nanobot',
    component: 'andrea.shell',
    owner: 'shell',
    severity: input.severity,
    summary: input.summary,
    ...(input.detail ? { detail: input.detail } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
}

export async function emitAndreaPlatformIntentRequest(
  input: {
    channel: 'telegram' | 'bluebubbles';
    text: string;
    actorId?: string | null;
    groupFolder?: string | null;
    routeHint?: string | null;
    metadata?: Record<string, string>;
  },
): Promise<void> {
  await postShellGateway('/intent/request', {
    source: 'andrea_nanobot',
    channel: input.channel,
    ...(input.actorId ? { actor_id: input.actorId } : {}),
    ...(input.groupFolder ? { group_folder: input.groupFolder } : {}),
    text: input.text,
    ...(input.routeHint ? { route_hint: input.routeHint } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
}

export async function emitAndreaPlatformIntentResponse(
  input: {
    channel: 'telegram' | 'bluebubbles';
    summary: string;
    outcome: IntentResponseOutcome;
    actorId?: string | null;
    groupFolder?: string | null;
    metadata?: Record<string, string>;
  },
): Promise<void> {
  await postShellGateway('/intent/response', {
    source: 'andrea_nanobot',
    channel: input.channel,
    ...(input.actorId ? { actor_id: input.actorId } : {}),
    ...(input.groupFolder ? { group_folder: input.groupFolder } : {}),
    summary: input.summary,
    outcome: input.outcome,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
}

export function mapShellHealthFromBackendStatus(
  status: RuntimeBackendStatus,
): {
  severity: HealthSeverity;
  summary: string;
  detail?: string | null;
} {
  switch (status.state) {
    case 'available':
      return {
        severity: 'healthy',
        summary: 'NanoBot can reach the loopback runtime backend.',
        detail: status.detail,
      };
    case 'auth_required':
      return {
        severity: 'near_live_only',
        summary: 'NanoBot can reach the runtime backend, but local auth is still required.',
        detail: status.detail,
      };
    case 'not_ready':
      return {
        severity: 'degraded',
        summary: 'NanoBot can reach the runtime backend, but the execution lane is not ready.',
        detail: status.detail,
      };
    case 'not_enabled':
      return {
        severity: 'degraded',
        summary: 'NanoBot runtime backend bridge is disabled.',
        detail: status.detail,
      };
    case 'unavailable':
    default:
      return {
        severity: 'degraded',
        summary: 'NanoBot cannot currently reach the loopback runtime backend.',
        detail: status.detail,
      };
  }
}

export function mapShellHealthFromChannelHealth(
  channelHealth: readonly ChannelHealthSnapshot[],
): {
  severity: HealthSeverity;
  summary: string;
  detail?: string | null;
  metadata?: Record<string, string>;
} {
  const configuredChannels = channelHealth.filter((channel) => channel.configured);
  const readyChannels = configuredChannels.filter((channel) => channel.state === 'ready');
  const unhealthyChannels = configuredChannels.filter((channel) => channel.state !== 'ready');

  if (configuredChannels.length === 0) {
    return {
      severity: 'degraded',
      summary: 'NanoBot shell is running, but no interactive channels are configured yet.',
      detail: 'Configure at least one interactive channel so the platform can treat the shell as live.',
      metadata: {
        configuredChannels: '0',
        readyChannels: '0',
      },
    };
  }

  if (unhealthyChannels.length > 0) {
    const detail = unhealthyChannels
      .map((channel) => {
        const reason = channel.lastError || channel.detail || channel.state;
        return `${channel.name}: ${reason}`;
      })
      .join('; ');
    return {
      severity: 'degraded',
      summary: 'NanoBot shell is running, but one or more configured channels are not ready yet.',
      detail,
      metadata: {
        configuredChannels: String(configuredChannels.length),
        readyChannels: String(readyChannels.length),
      },
    };
  }

  return {
    severity: 'healthy',
    summary: 'NanoBot shell is running and all configured channels are ready.',
    detail: readyChannels.map((channel) => channel.name).join(', '),
    metadata: {
      configuredChannels: String(configuredChannels.length),
      readyChannels: String(readyChannels.length),
    },
  };
}
