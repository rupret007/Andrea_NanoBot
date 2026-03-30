import { CursorCloudApiError, type CursorCloudStatus } from './cursor-cloud.js';
import type { CursorDesktopStatus } from './cursor-desktop.js';
import type { CursorGatewayStatus } from './cursor-gateway.js';
import { formatUserFacingOperationFailure } from './user-facing-error.js';

export type CursorDesktopAgentJobsStatus =
  | 'validated'
  | 'conditional'
  | 'unavailable';

export interface CursorCapabilitySummary {
  cloudCodingJobsReady: boolean;
  desktopTerminalReady: boolean;
  desktopAgentJobs: CursorDesktopAgentJobsStatus;
  canListModels: boolean;
  cursorRoutingReady: boolean;
  nextStep: string | null;
}

function isDesktopBridgeReachable(status: CursorDesktopStatus): boolean {
  return status.enabled && status.probeStatus === 'ok';
}

function resolveDesktopAgentJobsStatus(
  status: CursorDesktopStatus,
): CursorDesktopAgentJobsStatus {
  if (!isDesktopBridgeReachable(status) || !status.terminalAvailable) {
    return 'unavailable';
  }

  if (status.agentJobCompatibility === 'validated') {
    return 'validated';
  }

  if (status.agentJobCompatibility === 'failed') {
    return 'unavailable';
  }

  return 'conditional';
}

function normalizePrefix(prefix: string): string {
  return prefix.trim().replace(/[. ]+$/, '');
}

function buildNextStep(
  desktopStatus: CursorDesktopStatus,
  cloudStatus: CursorCloudStatus,
  gatewayStatus: CursorGatewayStatus,
): string | null {
  const desktopReachable = isDesktopBridgeReachable(desktopStatus);
  const desktopAgentJobs = resolveDesktopAgentJobsStatus(desktopStatus);
  const cloudReady = cloudStatus.enabled;

  if (cloudReady && desktopReachable && desktopAgentJobs === 'validated') {
    return gatewayStatus.mode === 'configured'
      ? 'Cursor Cloud coding jobs, desktop bridge terminal control, and Cursor-backed runtime routing are all ready.'
      : 'Cursor Cloud coding jobs are ready, and desktop bridge terminal control is ready. Configure 9router only if you also want Cursor-backed runtime routing.';
  }

  if (cloudReady && desktopReachable && desktopAgentJobs === 'conditional') {
    return 'Cursor Cloud coding jobs are ready, and desktop bridge terminal control is ready. Desktop agent-run compatibility on this machine is still conditional.';
  }

  if (cloudReady && desktopReachable && desktopAgentJobs === 'unavailable') {
    return 'Cursor Cloud coding jobs are ready. Desktop bridge terminal control is ready, but desktop agent jobs are unavailable on this machine.';
  }

  if (desktopStatus.enabled && desktopStatus.probeStatus === 'failed') {
    return cloudReady
      ? 'Cursor Cloud coding jobs are ready, but the desktop bridge is unhealthy. Fix the bridge URL/token or reachability before relying on terminal control.'
      : 'Fix the desktop bridge URL/token or bridge reachability before relying on desktop terminal control.';
  }

  if (cloudReady) {
    return gatewayStatus.mode === 'configured'
      ? 'Cursor Cloud coding jobs are ready, and Cursor-backed runtime routing is configured.'
      : 'Cursor Cloud coding jobs are ready. Configure 9router only if you also want Cursor-backed runtime routing.';
  }

  if (desktopReachable) {
    return desktopAgentJobs === 'validated'
      ? 'Desktop bridge terminal control and desktop agent jobs are ready. Configure Cursor Cloud if you also want queued heavy-lift coding jobs.'
      : 'Desktop bridge terminal control is ready. Configure Cursor Cloud if you want queued heavy-lift coding jobs.';
  }

  return 'Configure CURSOR_API_KEY for queued Cursor coding jobs, or configure CURSOR_DESKTOP_BRIDGE_URL + CURSOR_DESKTOP_BRIDGE_TOKEN for desktop terminal control.';
}

export function summarizeCursorCapabilities(input: {
  desktopStatus: CursorDesktopStatus;
  cloudStatus: CursorCloudStatus;
  gatewayStatus: CursorGatewayStatus;
}): CursorCapabilitySummary {
  const { desktopStatus, cloudStatus, gatewayStatus } = input;
  const desktopReachable = isDesktopBridgeReachable(desktopStatus);

  return {
    cloudCodingJobsReady: cloudStatus.enabled,
    desktopTerminalReady: desktopReachable && desktopStatus.terminalAvailable,
    desktopAgentJobs: resolveDesktopAgentJobsStatus(desktopStatus),
    canListModels: cloudStatus.enabled,
    cursorRoutingReady: gatewayStatus.mode === 'configured',
    nextStep: buildNextStep(desktopStatus, cloudStatus, gatewayStatus),
  };
}

export function formatCursorCapabilitySummaryMessage(
  summary: CursorCapabilitySummary,
): string {
  const lines = [
    '*Cursor Capability Summary*',
    `- Cloud coding jobs: ${summary.cloudCodingJobsReady ? 'ready' : 'unavailable'}`,
    `- Desktop bridge terminal control: ${summary.desktopTerminalReady ? 'ready' : 'unavailable'}`,
    `- Desktop bridge agent jobs: ${summary.desktopAgentJobs}`,
    `- /cursor_models: ${summary.canListModels ? 'enabled via Cursor Cloud (results depend on API response)' : 'requires Cursor Cloud API'}`,
    `- Cursor-backed runtime route: ${summary.cursorRoutingReady ? 'configured' : 'not configured'}`,
  ];

  if (summary.nextStep) {
    lines.push(`- Next step: ${summary.nextStep}`);
  }

  return lines.join('\n');
}

function getCursorOperatorDetail(err: unknown): string | null {
  const message =
    err instanceof Error
      ? err.message.trim()
      : typeof err === 'string'
        ? err.trim()
        : '';

  if (err instanceof CursorCloudApiError) {
    const body =
      err.body && typeof err.body === 'object'
        ? (err.body as Record<string, unknown>)
        : null;
    const detailRows = Array.isArray(body?.details)
      ? body.details.filter(
          (entry): entry is Record<string, unknown> =>
            Boolean(entry) && typeof entry === 'object',
        )
      : [];
    const detailText = detailRows
      .map((entry) =>
        typeof entry.message === 'string' ? entry.message.trim() : '',
      )
      .filter(Boolean)
      .join(' ');

    if (
      err.status === 400 &&
      /invalid agent id/i.test(message + ' ' + detailText)
    ) {
      return 'Cursor Cloud could not use that agent id. Use an id like bc-<uuid> or a full Cursor URL that contains ?id=<agent_id>.';
    }

    if (err.status === 404 && /\/v0\/agents\//i.test(message)) {
      return 'Cursor Cloud could not find that agent id.';
    }

    if (
      err.status === 400 &&
      /\/stop\b/i.test(message) &&
      /cloud agent not running|no longer available/i.test(
        message + ' ' + detailText,
      )
    ) {
      return 'That Cursor Cloud job is no longer running, so there is nothing left to stop. Use /cursor_sync to refresh its final state.';
    }
  }

  if (!message) return null;

  if (/repository is required/i.test(message)) {
    return 'Cursor Cloud needs a repository for that job. Use `/cursor_create --repo <url> ...` or configure a default repository in Cursor settings.';
  }

  const safePatterns = [
    /^cursor is not configured\./i,
    /^cursor cloud is not configured\./i,
    /^cursor cloud is required for queued coding jobs in the current product\./i,
    /^cursor desktop bridge is not configured\./i,
    /^cursor cloud job control is only supported for cursor cloud jobs in the current product\./i,
    /^cursor model listing is only available through the cursor cloud api right now\./i,
    /^cursor artifact listing is only available for cursor cloud jobs in the current product\./i,
    /^cursor artifact links are only available for cursor cloud jobs in the current product\./i,
    /^desktop bridge sessions are not part of the queued cloud follow-up flow in the current product\./i,
    /^desktop bridge sessions are not part of the queued cloud stop flow in the current product\./i,
    /^cursor desktop sessions do not expose artifact download links through this path\./i,
    /^cursor terminal control is only available for desktop bridge sessions on your own machine\./i,
    /^cursor agent id is required\./i,
    /^invalid cursor agent id /i,
  ];

  return safePatterns.some((pattern) => pattern.test(message)) ? message : null;
}

export function formatCursorOperationFailure(
  prefix: string,
  err: unknown,
): string {
  const operatorDetail = getCursorOperatorDetail(err);
  if (operatorDetail) {
    return `${normalizePrefix(prefix)}. ${operatorDetail}`;
  }

  return formatUserFacingOperationFailure(prefix, err);
}
