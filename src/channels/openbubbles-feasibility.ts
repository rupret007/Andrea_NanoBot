import fs from 'fs';
import path from 'path';

export type OpenBubblesFeasibilityCriterionStatus =
  | 'pass'
  | 'blocked'
  | 'unproven';

export interface OpenBubblesFeasibilityCriterion {
  id:
    | 'windows_surface'
    | 'inbound_observation'
    | 'outbound_reply'
    | 'mac_offline_runtime'
    | 'no_ui_scraping';
  status: OpenBubblesFeasibilityCriterionStatus;
  detail: string;
  nextAction?: string;
}

export interface OpenBubblesFeasibilityReport {
  providerName: 'openbubbles';
  checkedAt: string;
  detectedInstallPaths: string[];
  supportedWindowsSurfaceDetected: boolean;
  verdict:
    | 'ready_for_provider'
    | 'partially_ready_but_not_shippable'
    | 'blocked_for_now';
  summary: string;
  criteria: OpenBubblesFeasibilityCriterion[];
  officialReferences: string[];
}

function normalizePath(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? path.normalize(trimmed) : null;
}

export function getOpenBubblesOfficialReferences(): string[] {
  return [
    'https://openbubbles.app/',
    'https://openbubbles.app/quickstart.html',
    'https://openbubbles.app/docs/faq.html',
    'https://openbubbles.app/docs/renewal.html',
    'https://openbubbles.app/extensions/extension-service.html',
  ];
}

export function getDefaultOpenBubblesProbePaths(): string[] {
  const localAppData = normalizePath(process.env.LOCALAPPDATA);
  const programFiles = normalizePath(process.env.ProgramFiles);
  const programFilesX86 = normalizePath(process.env['ProgramFiles(x86)']);

  return [
    localAppData ? path.join(localAppData, 'Programs', 'OpenBubbles') : null,
    localAppData ? path.join(localAppData, 'OpenBubbles') : null,
    programFiles ? path.join(programFiles, 'OpenBubbles') : null,
    programFilesX86 ? path.join(programFilesX86, 'OpenBubbles') : null,
  ].filter((value): value is string => Boolean(value));
}

export function detectOpenBubblesInstallPaths(
  candidatePaths = getDefaultOpenBubblesProbePaths(),
): string[] {
  return candidatePaths.filter((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
}

export function buildOpenBubblesFeasibilityReport(params?: {
  nowIso?: string;
  detectedInstallPaths?: string[];
  supportedWindowsSurfaceDetected?: boolean;
  inboundObservationSupported?: boolean;
  outboundReplySupported?: boolean;
  macOfflineRuntimeSupported?: boolean;
  noUiScrapingRequired?: boolean;
}): OpenBubblesFeasibilityReport {
  const detectedInstallPaths =
    params?.detectedInstallPaths || detectOpenBubblesInstallPaths();
  const supportedWindowsSurfaceDetected =
    params?.supportedWindowsSurfaceDetected || false;
  const inboundObservationSupported =
    params?.inboundObservationSupported || false;
  const outboundReplySupported = params?.outboundReplySupported || false;
  const macOfflineRuntimeSupported = params?.macOfflineRuntimeSupported ?? true;
  const noUiScrapingRequired = params?.noUiScrapingRequired ?? true;
  const criteria: OpenBubblesFeasibilityCriterion[] = [
    {
      id: 'windows_surface',
      status: supportedWindowsSurfaceDetected
        ? 'pass'
        : detectedInstallPaths.length > 0
          ? 'unproven'
          : 'blocked',
      detail: supportedWindowsSurfaceDetected
        ? 'Andrea has a supported Windows-native surface available to attach to for OpenBubbles feasibility work.'
        : detectedInstallPaths.length > 0
          ? 'OpenBubbles app files were detected on this PC, but Andrea still does not have a documented Windows-native webhook or API surface to attach to.'
          : 'No local OpenBubbles install was detected on this PC, and Andrea does not have a documented Windows-native webhook or API surface to attach to yet.',
      nextAction:
        'Confirm whether OpenBubbles exposes a supported Windows runtime API or webhook surface for inbound observation and outbound reply before wiring it into Andrea.',
    },
    {
      id: 'inbound_observation',
      status: inboundObservationSupported
        ? 'pass'
        : supportedWindowsSurfaceDetected
          ? 'unproven'
          : 'blocked',
      detail: inboundObservationSupported
        ? 'Andrea can prove direct inbound 1:1 observation from the supported OpenBubbles Windows surface.'
        : 'Andrea cannot yet prove direct inbound 1:1 observation from a supported OpenBubbles Windows surface.',
      nextAction:
        'Do not migrate the Messages bridge until a supported Windows observation path is verified without UI scraping.',
    },
    {
      id: 'outbound_reply',
      status: outboundReplySupported
        ? 'pass'
        : supportedWindowsSurfaceDetected
          ? 'unproven'
          : 'blocked',
      detail: outboundReplySupported
        ? 'Andrea can prove programmatic outbound reply through the supported OpenBubbles Windows surface.'
        : 'Andrea cannot yet prove programmatic outbound reply through a supported OpenBubbles Windows surface.',
      nextAction:
        'Do not migrate the Messages bridge until a stable supported reply path is verified without UI scraping.',
    },
    {
      id: 'mac_offline_runtime',
      status: macOfflineRuntimeSupported ? 'pass' : 'blocked',
      detail: macOfflineRuntimeSupported
        ? 'Official OpenBubbles docs say normal use can continue with the Mac offline after activation or renewal, which matches the PC-first product goal.'
        : 'The current OpenBubbles path does not yet satisfy the Mac-offline runtime requirement for Andrea.',
    },
    {
      id: 'no_ui_scraping',
      status: noUiScrapingRequired ? 'pass' : 'blocked',
      detail: noUiScrapingRequired
        ? 'Andrea intentionally rejects Windows UI scraping as the primary Messages bridge, so the feasibility gate stays aligned with the supported-surface requirement.'
        : 'The current OpenBubbles path would require UI scraping, which Andrea does not allow for the primary Messages bridge.',
    },
  ];

  const allCriteriaPass = criteria.every(
    (criterion) => criterion.status === 'pass',
  );
  const verdict =
    supportedWindowsSurfaceDetected && allCriteriaPass
      ? 'ready_for_provider'
      : detectedInstallPaths.length > 0 || supportedWindowsSurfaceDetected
        ? 'partially_ready_but_not_shippable'
        : 'blocked_for_now';

  const summary =
    verdict === 'ready_for_provider'
      ? 'OpenBubbles is ready to become an Andrea Messages bridge provider on this PC.'
      : verdict === 'partially_ready_but_not_shippable'
        ? 'OpenBubbles may satisfy the Mac-offline goal, but Andrea still lacks a supported Windows observation/reply surface, so it stays a future provider track while Telegram remains the dependable main path.'
        : 'OpenBubbles is blocked for now on this PC. Telegram remains the dependable main path while Messages stays a best-effort bridge.';

  return {
    providerName: 'openbubbles',
    checkedAt: params?.nowIso || new Date().toISOString(),
    detectedInstallPaths,
    supportedWindowsSurfaceDetected,
    verdict,
    summary,
    criteria,
    officialReferences: getOpenBubblesOfficialReferences(),
  };
}
