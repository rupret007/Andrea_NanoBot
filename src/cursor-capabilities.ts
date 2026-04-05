import { CursorCloudApiError, type CursorCloudStatus } from './cursor-cloud.js';
import type { CursorDesktopStatus } from './cursor-desktop.js';
import type { CursorGatewayStatus } from './cursor-gateway.js';
import { formatBackendOperationFailure } from './backend-lane-errors.js';

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

const CURSOR_CLOUD_ENABLEMENT_MESSAGE =
  'Cursor Cloud coding jobs are unavailable because `CURSOR_API_KEY` is not configured. Add it to enable queued heavy-lift Cloud workflows such as `/cursor-create`, `/cursor-followup`, `/cursor-stop`, `/cursor-models`, `/cursor-results`, and `/cursor-download`.';
const CURSOR_DESKTOP_ENABLEMENT_MESSAGE =
  "Desktop bridge terminal control is unavailable because `CURSOR_DESKTOP_BRIDGE_URL` and `CURSOR_DESKTOP_BRIDGE_TOKEN` are not fully configured. Add both on Andrea's host and run the bridge on your normal machine if you want operator-only session recovery and line-oriented terminal control.";
const CURSOR_DESKTOP_OPTIONAL_MESSAGE =
  "Desktop bridge remains optional. Add `CURSOR_DESKTOP_BRIDGE_URL` and `CURSOR_DESKTOP_BRIDGE_TOKEN` on Andrea's host, then run the bridge on your normal machine only if you want operator-only session recovery and line-oriented terminal control.";
const CURSOR_RUNTIME_ROUTE_OPTIONAL_MESSAGE =
  'Cursor-backed runtime routing remains optional and separate from Cursor Cloud jobs and desktop bridge terminal control.';

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
      : `Cursor Cloud coding jobs and desktop bridge terminal control are ready. ${CURSOR_RUNTIME_ROUTE_OPTIONAL_MESSAGE}`;
  }

  if (cloudReady && desktopReachable && desktopAgentJobs === 'conditional') {
    return `Cursor Cloud coding jobs are ready, and desktop bridge terminal control is ready. Desktop agent-run compatibility on this machine is still conditional. ${CURSOR_RUNTIME_ROUTE_OPTIONAL_MESSAGE}`;
  }

  if (cloudReady && desktopReachable && desktopAgentJobs === 'unavailable') {
    return `Cursor Cloud coding jobs are ready. Desktop bridge terminal control is ready, but desktop agent jobs are unavailable on this machine. ${CURSOR_RUNTIME_ROUTE_OPTIONAL_MESSAGE}`;
  }

  if (desktopStatus.enabled && desktopStatus.probeStatus === 'failed') {
    return cloudReady
      ? 'Cursor Cloud coding jobs are ready, but desktop bridge terminal control is unavailable because the configured bridge is unhealthy. Fix the bridge URL/token or private-tunnel reachability before relying on `/cursor-terminal*`.'
      : `${CURSOR_CLOUD_ENABLEMENT_MESSAGE} Desktop bridge terminal control is also unavailable because the configured bridge is unhealthy. Fix the bridge URL/token or private-tunnel reachability before relying on \`/cursor-terminal*\`.`;
  }

  if (cloudReady) {
    return gatewayStatus.mode === 'configured'
      ? 'Cursor Cloud coding jobs are ready, and Cursor-backed runtime routing is configured. Desktop bridge remains optional and separate.'
      : `Cursor Cloud coding jobs are ready. ${CURSOR_DESKTOP_OPTIONAL_MESSAGE} ${CURSOR_RUNTIME_ROUTE_OPTIONAL_MESSAGE}`;
  }

  if (desktopReachable) {
    return desktopAgentJobs === 'validated'
      ? `Desktop bridge terminal control and desktop agent jobs are ready. ${CURSOR_CLOUD_ENABLEMENT_MESSAGE} ${CURSOR_RUNTIME_ROUTE_OPTIONAL_MESSAGE}`
      : `Desktop bridge terminal control is ready. ${CURSOR_CLOUD_ENABLEMENT_MESSAGE} ${CURSOR_RUNTIME_ROUTE_OPTIONAL_MESSAGE}`;
  }

  return `${CURSOR_CLOUD_ENABLEMENT_MESSAGE} ${CURSOR_DESKTOP_ENABLEMENT_MESSAGE} ${CURSOR_RUNTIME_ROUTE_OPTIONAL_MESSAGE}`;
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
    `- /cursor-models: ${summary.canListModels ? 'enabled via Cursor Cloud (results depend on API response)' : 'requires Cursor Cloud API (`CURSOR_API_KEY`)'}`,
    `- Cursor-backed runtime route: ${summary.cursorRoutingReady ? 'configured' : 'not configured'}`,
  ];

  if (summary.nextStep) {
    lines.push(
      `- ${summary.cloudCodingJobsReady ? 'Optional next step' : 'Next step'}: ${summary.nextStep}`,
    );
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
      return 'That Cursor Cloud job is no longer running, so there is nothing left to stop. Use /cursor-sync to refresh its final state.';
    }
  }

  if (!message) return null;

  if (/repository is required/i.test(message)) {
    return 'Cursor Cloud needs a repository for that job. Use `/cursor-create --repo <url> ...` or configure a default repository in Cursor settings.';
  }

  const safePatterns = [
    /^cursor is not configured\./i,
    /^cursor cloud is not configured\./i,
    /^cursor cloud is required for queued coding jobs in the current product\./i,
    /^cursor desktop bridge is not configured\./i,
    /^cursor cloud job control is only supported for cursor cloud jobs in the current product\./i,
    /^cursor model listing is only available through the cursor cloud api right now\./i,
    /^cursor results are only available for cursor cloud jobs in the current product\./i,
    /^cursor artifact listing is only available for cursor cloud jobs in the current product\./i,
    /^cursor download links are only available for cursor cloud jobs in the current product\./i,
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

export function shouldClearCursorSelectionForError(err: unknown): boolean {
  if (err instanceof CursorCloudApiError) {
    const message = err.message.toLowerCase();
    const body =
      err.body && typeof err.body === 'object'
        ? (err.body as Record<string, unknown>)
        : null;
    const detailText = Array.isArray(body?.details)
      ? body.details
          .map((entry) =>
            entry &&
            typeof entry === 'object' &&
            typeof (entry as Record<string, unknown>).message === 'string'
              ? ((entry as Record<string, unknown>).message as string)
                  .trim()
                  .toLowerCase()
              : '',
          )
          .filter(Boolean)
          .join(' ')
      : '';
    const combined = `${message} ${detailText}`.trim();
    if (err.status === 404 && /\/v0\/agents\//i.test(err.message)) {
      return true;
    }
    if (
      err.status === 400 &&
      /\/stop\b/i.test(err.message) &&
      /cloud agent not running|no longer available|nothing left to stop/.test(
        combined,
      )
    ) {
      return true;
    }
  }

  const operatorDetail = getCursorOperatorDetail(err)?.toLowerCase() || '';
  const normalizedMessage =
    err instanceof Error
      ? err.message.trim().toLowerCase()
      : typeof err === 'string'
        ? err.trim().toLowerCase()
        : '';
  const combined = `${operatorDetail} ${normalizedMessage}`.trim();
  return /cursor cloud could not find that agent id|that cursor cloud job is no longer running|cursor agent .* was not found| not found\b/.test(
    combined,
  );
}

export function formatCursorOperationFailure(
  prefix: string,
  err: unknown,
): string {
  const operatorDetail = getCursorOperatorDetail(err);
  if (operatorDetail) {
    return `${normalizePrefix(prefix)}. ${operatorDetail}`;
  }

  return formatBackendOperationFailure({
    laneId: 'cursor',
    operation: prefix,
    err,
  });
}
