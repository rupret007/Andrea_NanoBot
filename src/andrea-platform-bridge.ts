import { logger } from './logger.js';
import {
  ANDREA_PLATFORM_COORDINATOR_ENABLED,
  ANDREA_PLATFORM_COORDINATOR_URL,
  ANDREA_PLATFORM_FALLBACK_TO_DIRECT_RUNTIME,
} from './config.js';
import type { ChannelHealthSnapshot, RuntimeBackendStatus } from './types.js';

const SHELL_GATEWAY_BASE_URL = (
  process.env.ANDREA_PLATFORM_SHELL_GATEWAY_URL || ''
)
  .trim()
  .replace(/\/+$/, '');
const COORDINATOR_BASE_URL = (
  ANDREA_PLATFORM_COORDINATOR_ENABLED &&
  !ANDREA_PLATFORM_FALLBACK_TO_DIRECT_RUNTIME
    ? ANDREA_PLATFORM_COORDINATOR_URL
    : ''
)
  .trim()
  .replace(/\/+$/, '');

type IntentResponseOutcome = 'handled' | 'blocked' | 'degraded' | 'fallback';
type ProofState =
  | 'LIVE_PROVEN'
  | 'NEAR_LIVE_ONLY'
  | 'DEGRADED_BUT_USABLE'
  | 'EXTERNALLY_BLOCKED';
type HealthSeverity =
  | 'healthy'
  | 'degraded'
  | 'faulted'
  | 'blocked_external'
  | 'near_live_only';
type TransportKind =
  | 'telegram'
  | 'bluebubbles'
  | 'alexa'
  | 'backend_http'
  | 'dds'
  | 'webhook'
  | 'gateway'
  | 'provider'
  | 'other';
type TraceKind =
  | 'intent'
  | 'route'
  | 'job'
  | 'proof'
  | 'feedback'
  | 'commit'
  | 'operator'
  | 'config'
  | 'replay';

function shellGatewayRoute(path: string): string | null {
  if (!SHELL_GATEWAY_BASE_URL) return null;
  return `${SHELL_GATEWAY_BASE_URL}${path}`;
}

function coordinatorRoute(path: string): string | null {
  if (!COORDINATOR_BASE_URL) return null;
  return `${COORDINATOR_BASE_URL}${path}`;
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

async function postCoordinatorJson(
  path: string,
  payload: object,
): Promise<unknown | null> {
  const url = coordinatorRoute(path);
  if (!url) return null;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      logger.warn(
        {
          component: 'andrea_platform_coordinator_bridge',
          path,
          status: response.status,
        },
        'Andrea platform coordinator bridge returned a non-2xx response.',
      );
      return null;
    }
    return (await response.json()) as unknown;
  } catch (err) {
    logger.debug(
      {
        component: 'andrea_platform_coordinator_bridge',
        path,
        err,
      },
      'Andrea platform coordinator bridge post failed.',
    );
    return null;
  }
}

export function isAndreaPlatformShellBridgeEnabled(): boolean {
  return Boolean(SHELL_GATEWAY_BASE_URL);
}

export async function emitAndreaPlatformShellConfigSnapshot(input: {
  component: string;
  configName: string;
  snapshot: Record<string, unknown>;
}): Promise<void> {
  await postShellGateway('/config/snapshot', {
    source: 'andrea_nanobot',
    component: input.component,
    config_name: input.configName,
    snapshot_json: JSON.stringify(input.snapshot),
  });
}

export async function emitAndreaPlatformShellHealth(input: {
  severity: HealthSeverity;
  summary: string;
  detail?: string | null;
  metadata?: Record<string, string>;
}): Promise<void> {
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

export async function emitAndreaPlatformProofEvent(input: {
  surface: string;
  state: ProofState;
  summary: string;
  journey?: string | null;
  blocker?: string | null;
  nextAction?: string | null;
  metadata?: Record<string, string>;
}): Promise<void> {
  await postShellGateway('/proof/event', {
    source: 'andrea_nanobot',
    surface: input.surface,
    ...(input.journey ? { journey: input.journey } : {}),
    state: input.state,
    summary: input.summary,
    ...(input.blocker ? { blocker: input.blocker } : {}),
    ...(input.nextAction ? { next_action: input.nextAction } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
}

export async function emitAndreaPlatformTransportEvent(input: {
  transportId: string;
  transportKind: TransportKind;
  state: HealthSeverity;
  summary: string;
  detail?: string | null;
  latencyMs?: number | null;
  freshnessSeconds?: number | null;
  deliverySemantics?: string | null;
  fallbackTarget?: string | null;
  blocker?: string | null;
  nextAction?: string | null;
  metadata?: Record<string, string>;
}): Promise<void> {
  await postShellGateway('/transport/event', {
    source: 'andrea_nanobot',
    transport_id: input.transportId,
    transport_kind: input.transportKind,
    state: input.state,
    summary: input.summary,
    ...(input.detail ? { detail: input.detail } : {}),
    ...(input.latencyMs !== undefined && input.latencyMs !== null
      ? { latency_ms: input.latencyMs }
      : {}),
    ...(input.freshnessSeconds !== undefined && input.freshnessSeconds !== null
      ? { freshness_seconds: input.freshnessSeconds }
      : {}),
    ...(input.deliverySemantics
      ? { delivery_semantics: input.deliverySemantics }
      : {}),
    ...(input.fallbackTarget ? { fallback_target: input.fallbackTarget } : {}),
    ...(input.blocker ? { blocker: input.blocker } : {}),
    ...(input.nextAction ? { next_action: input.nextAction } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
}

export async function emitAndreaPlatformTraceEvent(input: {
  traceId: string;
  traceKind: TraceKind;
  title: string;
  summary: string;
  refs?: Record<string, string>;
  metadata?: Record<string, string>;
}): Promise<void> {
  await postShellGateway('/trace/event', {
    source: 'andrea_nanobot',
    trace_id: input.traceId,
    trace_kind: input.traceKind,
    title: input.title,
    summary: input.summary,
    ...(input.refs ? { refs: input.refs } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
}

export interface AndreaPlatformFeedbackReflectionResult {
  feedbackId: string;
  taskLedgerId?: string;
  progressLedgerId?: string;
  reflectionId?: string;
  evaluationId?: string;
  learningId?: string;
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export async function emitAndreaPlatformFeedbackReflection(input: {
  feedbackId: string;
  issueId?: string | null;
  status: string;
  classification: string;
  taskFamily:
    | 'calendar'
    | 'communication'
    | 'research'
    | 'media'
    | 'assistant'
    | 'operator'
    | 'code'
    | 'unknown';
  channel: 'telegram';
  groupFolder: string;
  chatJid: string;
  threadId?: string | null;
  routeKey?: string | null;
  capabilityId?: string | null;
  handlerKind?: string | null;
  responseSource?: string | null;
  blockerClass?: string | null;
  blockerOwner?: string | null;
  platformMessageId?: string | null;
  userMessageId?: string | null;
  remediationLaneId?: string | null;
  remediationJobId?: string | null;
  originalUserPreview?: string | null;
  assistantReplyPreview?: string | null;
  summary: string;
  nextAction?: string | null;
}): Promise<AndreaPlatformFeedbackReflectionResult | null> {
  const response = await postCoordinatorJson('/feedback/reflection', {
    feedbackId: input.feedbackId,
    correlationId: input.feedbackId,
    taskFamily: input.taskFamily,
    sentiment: 'negative',
    outcome:
      input.classification === 'externally_blocked' ||
      input.classification === 'manual_sync_only'
        ? 'blocked'
        : 'degraded',
    normalizedGoal: `Review user feedback for ${input.taskFamily} response ${input.feedbackId}.`,
    summary: input.summary,
    channel: input.channel,
    sourceSystem: 'andrea_nanobot',
    nextAction:
      input.nextAction ||
      'Use this downvote to guide the next narrow fix or routing rule.',
    jobId: input.remediationJobId || undefined,
    metadata: {
      feedbackId: input.feedbackId,
      issueId: input.issueId || '',
      status: input.status,
      classification: input.classification,
      groupFolder: input.groupFolder,
      chatJid: input.chatJid,
      threadId: input.threadId || '',
      routeKey: input.routeKey || '',
      capabilityId: input.capabilityId || '',
      handlerKind: input.handlerKind || '',
      responseSource: input.responseSource || '',
      blockerClass: input.blockerClass || '',
      blockerOwner: input.blockerOwner || '',
      platformMessageId: input.platformMessageId || '',
      userMessageId: input.userMessageId || '',
      remediationLaneId: input.remediationLaneId || '',
      remediationJobId: input.remediationJobId || '',
      originalUserPreview: input.originalUserPreview || '',
      assistantReplyPreview: input.assistantReplyPreview || '',
    },
  });
  if (!response || typeof response !== 'object') return null;
  const body = response as Record<string, unknown>;
  const task = body.task as Record<string, unknown> | undefined;
  const progress = body.progress as Record<string, unknown> | undefined;
  const reflection = body.reflection as Record<string, unknown> | undefined;
  const evaluation = body.evaluation as Record<string, unknown> | undefined;
  const learning = body.learning as Record<string, unknown> | undefined;
  return {
    feedbackId: input.feedbackId,
    taskLedgerId: pickString(task?.task_ledger_id),
    progressLedgerId: pickString(progress?.progress_ledger_id),
    reflectionId: pickString(reflection?.reflection_id),
    evaluationId: pickString(evaluation?.evaluation_id),
    learningId: pickString(learning?.learning_id),
  };
}

export async function emitAndreaPlatformIntentRequest(input: {
  channel: 'telegram' | 'bluebubbles';
  text: string;
  actorId?: string | null;
  groupFolder?: string | null;
  routeHint?: string | null;
  metadata?: Record<string, string>;
}): Promise<void> {
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

export async function emitAndreaPlatformIntentResponse(input: {
  channel: 'telegram' | 'bluebubbles';
  summary: string;
  outcome: IntentResponseOutcome;
  actorId?: string | null;
  groupFolder?: string | null;
  metadata?: Record<string, string>;
}): Promise<void> {
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

export function mapShellHealthFromBackendStatus(status: RuntimeBackendStatus): {
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
        summary:
          'NanoBot can reach the runtime backend, but local auth is still required.',
        detail: status.detail,
      };
    case 'not_ready':
      return {
        severity: 'degraded',
        summary:
          'NanoBot can reach the runtime backend, but the execution lane is not ready.',
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
  const configuredChannels = channelHealth.filter(
    (channel) => channel.configured,
  );
  const readyChannels = configuredChannels.filter(
    (channel) => channel.state === 'ready',
  );
  const unhealthyChannels = configuredChannels.filter(
    (channel) => channel.state !== 'ready',
  );

  if (configuredChannels.length === 0) {
    return {
      severity: 'degraded',
      summary:
        'NanoBot shell is running, but no interactive channels are configured yet.',
      detail:
        'Configure at least one interactive channel so the platform can treat the shell as live.',
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
      summary:
        'NanoBot shell is running, but one or more configured channels are not ready yet.',
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
