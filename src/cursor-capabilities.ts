import { CursorCloudApiError, type CursorCloudStatus } from './cursor-cloud.js';
import type { CursorDesktopStatus } from './cursor-desktop.js';
import type { CursorGatewayStatus } from './cursor-gateway.js';
import { formatUserFacingOperationFailure } from './user-facing-error.js';

export type CursorJobBackend = 'desktop' | 'cloud' | 'none';

export interface CursorCapabilitySummary {
  jobBackend: CursorJobBackend;
  canRunJobs: boolean;
  canListModels: boolean;
  cursorRoutingReady: boolean;
  nextStep: string | null;
}

function isDesktopJobBackendUsable(status: CursorDesktopStatus): boolean {
  return status.enabled && status.probeStatus !== 'failed';
}

function normalizePrefix(prefix: string): string {
  return prefix.trim().replace(/[. ]+$/, '');
}

function buildNextStep(
  desktopStatus: CursorDesktopStatus,
  cloudStatus: CursorCloudStatus,
  gatewayStatus: CursorGatewayStatus,
): string | null {
  if (desktopStatus.enabled && desktopStatus.probeStatus === 'failed') {
    return 'Fix the desktop bridge URL/token or bridge reachability before using Cursor job commands.';
  }

  if (desktopStatus.enabled) {
    return gatewayStatus.mode === 'configured'
      ? 'Desktop bridge job control is ready, and Cursor-backed runtime routing is configured.'
      : 'Desktop bridge job control is ready. Configure 9router only if you also want Cursor-backed runtime routing.';
  }

  if (cloudStatus.enabled) {
    return gatewayStatus.mode === 'configured'
      ? 'Cursor Cloud job control is ready, and Cursor-backed runtime routing is configured.'
      : 'Cursor Cloud job control is ready. Configure 9router only if you also want Cursor-backed runtime routing.';
  }

  return 'Configure either CURSOR_DESKTOP_BRIDGE_URL + CURSOR_DESKTOP_BRIDGE_TOKEN, or CURSOR_API_KEY, before using deeper Cursor job commands.';
}

export function summarizeCursorCapabilities(input: {
  desktopStatus: CursorDesktopStatus;
  cloudStatus: CursorCloudStatus;
  gatewayStatus: CursorGatewayStatus;
}): CursorCapabilitySummary {
  const { desktopStatus, cloudStatus, gatewayStatus } = input;
  const desktopUsable = isDesktopJobBackendUsable(desktopStatus);

  const jobBackend: CursorJobBackend = desktopUsable
    ? 'desktop'
    : cloudStatus.enabled
      ? 'cloud'
      : desktopStatus.enabled
        ? 'desktop'
        : 'none';

  return {
    jobBackend,
    canRunJobs:
      jobBackend === 'desktop'
        ? desktopUsable
        : jobBackend === 'cloud'
          ? cloudStatus.enabled
          : false,
    canListModels: cloudStatus.enabled,
    cursorRoutingReady: gatewayStatus.mode === 'configured',
    nextStep: buildNextStep(desktopStatus, cloudStatus, gatewayStatus),
  };
}

export function formatCursorCapabilitySummaryMessage(
  summary: CursorCapabilitySummary,
): string {
  const backendLabel =
    summary.jobBackend === 'desktop'
      ? 'desktop bridge'
      : summary.jobBackend === 'cloud'
        ? 'cloud agents'
        : 'not configured';

  const lines = [
    '*Cursor Capability Summary*',
    `- Job backend: ${backendLabel}`,
    `- Main-control job commands: ${summary.canRunJobs ? 'ready' : 'unavailable'}`,
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
  }

  if (!message) return null;

  if (/repository is required/i.test(message)) {
    return 'Cursor Cloud needs a repository for that job. Use `/cursor_create --repo <url> ...` or configure a default repository in Cursor settings.';
  }

  const safePatterns = [
    /^cursor is not configured\./i,
    /^cursor cloud is not configured\./i,
    /^cursor desktop bridge is not configured\./i,
    /^cursor model listing is only available through the cursor cloud api right now\./i,
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
