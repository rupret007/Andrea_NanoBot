import {
  buildBlueBubblesHealthSnapshot,
  resolveBlueBubblesConfig,
} from './channels/bluebubbles.js';
import { readEnvFile } from './env.js';
import {
  assessAssistantHealthState,
  assessTelegramRoundtripState,
  readAlexaLastSignedRequestState,
  readHostControlSnapshot,
  reconcileWindowsHostState,
  type HostControlSnapshot,
  type WindowsHostReconciliation,
} from './host-control.js';
import { getMediaProviderStatus } from './media-generation.js';
import { describeOpenAiConfigBlocker, getOpenAiProviderStatus } from './openai-provider.js';
import { buildPilotReviewSnapshot } from './pilot-mode.js';
import { readProviderProofState } from './provider-proof-state.js';
import type { PilotJourneyEventRecord, PilotJourneyId } from './types.js';

export type FieldTrialProofState =
  | 'live_proven'
  | 'near_live_only'
  | 'externally_blocked'
  | 'degraded_but_usable'
  | 'not_intended_for_trial';

export type FieldTrialBlockerOwner = 'none' | 'repo_side' | 'external';

export interface FieldTrialSurfaceTruth {
  proofState: FieldTrialProofState;
  blocker: string;
  blockerOwner: FieldTrialBlockerOwner;
  nextAction: string;
  detail: string;
}

export interface FieldTrialJourneyTruthMap {
  ordinary_chat: FieldTrialSurfaceTruth;
  daily_guidance: FieldTrialSurfaceTruth;
  candace_followthrough: FieldTrialSurfaceTruth;
  mission_planning: FieldTrialSurfaceTruth;
  work_cockpit: FieldTrialSurfaceTruth;
  cross_channel_handoff: FieldTrialSurfaceTruth;
  alexa_orientation: FieldTrialSurfaceTruth;
}

export interface FieldTrialPilotIssueTruth {
  loggingEnabled: boolean;
  openCount: number;
  latestSummary: string;
}

export interface FieldTrialOperatorTruth {
  telegram: FieldTrialSurfaceTruth;
  alexa: FieldTrialSurfaceTruth;
  bluebubbles: FieldTrialSurfaceTruth;
  workCockpit: FieldTrialSurfaceTruth;
  lifeThreads: FieldTrialSurfaceTruth;
  communicationCompanion: FieldTrialSurfaceTruth;
  chiefOfStaffMissions: FieldTrialSurfaceTruth;
  knowledgeLibrary: FieldTrialSurfaceTruth;
  research: FieldTrialSurfaceTruth;
  imageGeneration: FieldTrialSurfaceTruth;
  hostHealth: FieldTrialSurfaceTruth;
  journeys: FieldTrialJourneyTruthMap;
  pilotIssues: FieldTrialPilotIssueTruth;
}

export interface BuildFieldTrialOperatorTruthOptions {
  projectRoot?: string;
  hostSnapshot?: HostControlSnapshot;
  windowsHost?: WindowsHostReconciliation | null;
  outwardResearchStatus?:
    | 'not_configured'
    | 'misconfigured_native_openai_endpoint'
    | 'missing_direct_provider_credentials'
    | 'quota_blocked'
    | 'degraded'
    | 'available';
}

interface PilotReviewSnapshotLike {
  loggingEnabled: boolean;
  recentEvents: PilotJourneyEventRecord[];
  openIssueCount: number;
  latestOpenIssue: { summaryText: string } | null;
}

function buildTruth(
  truth: Partial<FieldTrialSurfaceTruth> & Pick<FieldTrialSurfaceTruth, 'proofState'>,
): FieldTrialSurfaceTruth {
  return {
    blocker: '',
    blockerOwner: 'none',
    nextAction: '',
    detail: '',
    ...truth,
  };
}

function formatProofMoment(iso: string | null | undefined): string {
  if (!iso) return 'recently';
  return `on ${iso}`;
}

function describeRecentJourney(
  label: string,
  event: PilotJourneyEventRecord,
  proofLabel: 'live-proven' | 'degraded but usable',
): string {
  return `${label} was ${proofLabel} ${formatProofMoment(
    event.completedAt || event.startedAt,
  )}. ${event.summaryText}`;
}

function formatBlockerClass(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback;
  return value.replace(/_/g, ' ');
}

function isLiveProvenPilotOutcome(
  outcome: PilotJourneyEventRecord['outcome'],
): boolean {
  return outcome === 'success';
}

function getRecentJourneyEvent(
  review: PilotReviewSnapshotLike,
  predicate: (event: PilotJourneyEventRecord) => boolean,
): PilotJourneyEventRecord | null {
  return review.recentEvents.find(predicate) || null;
}

function getJourneyEventById(
  review: PilotReviewSnapshotLike,
  journeyId: PilotJourneyId,
): PilotJourneyEventRecord | null {
  return getRecentJourneyEvent(review, (event) => event.journeyId === journeyId);
}

function buildJourneyTruthFromEvent(params: {
  label: string;
  event: PilotJourneyEventRecord | null;
  nearLiveDetail: string;
  nearLiveNextAction: string;
  externalBlocker?: string;
  externalNextAction?: string;
}): FieldTrialSurfaceTruth {
  if (!params.event) {
    return buildTruth({
      proofState: 'near_live_only',
      detail: params.nearLiveDetail,
      nextAction: params.nearLiveNextAction,
    });
  }

  if (isLiveProvenPilotOutcome(params.event.outcome)) {
    return buildTruth({
      proofState: 'live_proven',
      detail: describeRecentJourney(params.label, params.event, 'live-proven'),
    });
  }

  if (params.event.outcome === 'degraded_usable') {
    return buildTruth({
      proofState: 'degraded_but_usable',
      blocker: formatBlockerClass(
        params.event.blockerClass,
        `${params.label} stayed usable, but only through a bounded fallback path on this host.`,
      ),
      blockerOwner:
        params.event.blockerOwner === 'none'
          ? 'repo_side'
          : params.event.blockerOwner,
      nextAction: params.nearLiveNextAction,
      detail: describeRecentJourney(params.label, params.event, 'degraded but usable'),
    });
  }

  if (params.event.outcome === 'externally_blocked') {
    return buildTruth({
      proofState: 'externally_blocked',
      blocker:
        params.externalBlocker ||
        formatBlockerClass(
          params.event.blockerClass,
          `${params.label} is blocked by an external dependency on this host.`,
        ),
      blockerOwner:
        params.event.blockerOwner === 'none'
          ? 'external'
          : params.event.blockerOwner,
      nextAction: params.externalNextAction || params.nearLiveNextAction,
      detail:
        params.event.summaryText ||
        `${params.label} hit an external blocker on this host.`,
    });
  }

  if (params.event.outcome === 'internal_failure') {
    return buildTruth({
      proofState: 'near_live_only',
      blocker: `${params.label} hit a repo-side failure during the most recent proof run.`,
      blockerOwner: 'repo_side',
      nextAction: params.nearLiveNextAction,
      detail:
        params.event.summaryText ||
        `${params.label} needs one clean rerun after the last internal failure.`,
    });
  }

  return buildTruth({
    proofState: 'near_live_only',
    detail: params.nearLiveDetail,
    nextAction: params.nearLiveNextAction,
  });
}

function buildHostHealthTruth(
  hostSnapshot: HostControlSnapshot,
  windowsHost: WindowsHostReconciliation | null,
): FieldTrialSurfaceTruth {
  const serviceState =
    windowsHost?.serviceState ||
    hostSnapshot.hostState?.phase ||
    'stopped';
  const dependencyState =
    windowsHost?.dependencyState || hostSnapshot.hostState?.dependencyState || 'unknown';
  const dependencyError =
    windowsHost?.dependencyError || hostSnapshot.hostState?.dependencyError || '';

  if (serviceState === 'running_ready') {
    return buildTruth({
      proofState: 'live_proven',
      detail:
        dependencyState === 'degraded' && dependencyError
          ? `Host-control is healthy and ready on this machine. Dependency state is degraded: ${dependencyError}`
          : 'Host-control, watchdog, and readiness are healthy on this machine.',
    });
  }

  if (serviceState === 'starting') {
    return buildTruth({
      proofState: 'near_live_only',
      blocker: 'Andrea is still starting on this machine.',
      nextAction: 'Wait for the host to reach running_ready, then rerun services:status.',
      detail: 'The host is starting and not ready to claim a full pilot proof yet.',
    });
  }

  return buildTruth({
    proofState: 'externally_blocked',
    blocker:
      windowsHost?.launcherError ||
      hostSnapshot.hostState?.lastError ||
      'Andrea is not currently healthy on this machine.',
    blockerOwner: 'repo_side',
    nextAction:
      'Repair the host-control path on this machine, then rerun services:status, setup verify, and debug:status.',
    detail: `Host state is ${serviceState}.`,
  });
}

function buildTelegramTruth(
  hostSnapshot: HostControlSnapshot,
  windowsHost: WindowsHostReconciliation | null,
): FieldTrialSurfaceTruth {
  const assistantHealth = assessAssistantHealthState({
    assistantHealthState: hostSnapshot.assistantHealthState,
    hostState: hostSnapshot.hostState,
    readyState: hostSnapshot.readyState,
    processRunning: windowsHost?.processRunning,
    runtimePid: windowsHost?.runtimePid,
  });
  const roundtrip = assessTelegramRoundtripState({
    assistantHealthState: hostSnapshot.assistantHealthState,
    telegramRoundtripState: hostSnapshot.telegramRoundtripState,
    hostState: hostSnapshot.hostState,
    readyState: hostSnapshot.readyState,
  });
  const transport = hostSnapshot.telegramTransportState;

  if (transport?.status === 'ready' && roundtrip.status === 'healthy') {
    return buildTruth({
      proofState: 'live_proven',
      detail: roundtrip.detail || 'Telegram transport and roundtrip proof are healthy on this host.',
    });
  }

  if (transport?.status === 'blocked') {
    return buildTruth({
      proofState: 'externally_blocked',
      blocker:
        transport.detail ||
        'Telegram is blocked by another consumer or an active webhook on this token.',
      blockerOwner: 'external',
      nextAction:
        'Clear the external Telegram consumer or rotate the bot token, then rerun npm run telegram:user:smoke.',
      detail:
        transport.detail ||
        'Telegram transport is blocked, so this host cannot claim a live Telegram roundtrip right now.',
    });
  }

  if (roundtrip.status === 'unconfigured') {
    return buildTruth({
      proofState: 'externally_blocked',
      blocker: roundtrip.detail,
      blockerOwner: 'external',
      nextAction:
        'Configure the Telegram user-session probe on this host and rerun npm run telegram:user:smoke.',
      detail:
        'Telegram bot routing can still run, but the live proof path is not fully configured on this host.',
    });
  }

  if (roundtrip.status === 'pending') {
    return buildTruth({
      proofState: 'near_live_only',
      blocker: roundtrip.detail,
      blockerOwner: 'none',
      nextAction:
        'Wait for the first post-startup Telegram roundtrip or rerun npm run telegram:user:smoke.',
      detail:
        'Telegram routing is up, but the latest live-proof marker is still pending after startup.',
    });
  }

  return buildTruth({
    proofState: assistantHealth.status === 'healthy' ? 'near_live_only' : 'externally_blocked',
    blocker:
      roundtrip.detail ||
      transport?.detail ||
      assistantHealth.detail ||
      'Telegram live proof is not currently healthy on this host.',
    blockerOwner: assistantHealth.status === 'healthy' ? 'none' : 'external',
    nextAction:
      assistantHealth.status === 'healthy'
        ? 'Rerun npm run telegram:user:smoke to refresh the Telegram live-proof marker.'
        : 'Repair the Telegram transport or roundtrip path on this host, then rerun npm run telegram:user:smoke.',
    detail:
      roundtrip.detail ||
      transport?.detail ||
      'Telegram live proof needs another same-host confirmation.',
  });
}

function buildAlexaTruth(projectRoot: string): FieldTrialSurfaceTruth {
  const env = readEnvFile(['ALEXA_SKILL_ID']);
  const configured = Boolean(process.env.ALEXA_SKILL_ID || env.ALEXA_SKILL_ID);
  if (!configured) {
    return buildTruth({
      proofState: 'not_intended_for_trial',
      detail: 'Alexa is not configured on this host.',
    });
  }

  const lastSignedRequest = readAlexaLastSignedRequestState(projectRoot);
  if (lastSignedRequest?.requestType) {
    return buildTruth({
      proofState: 'live_proven',
      detail: `A signed Alexa ${lastSignedRequest.requestType} was recorded on this host.`,
    });
  }

  return buildTruth({
    proofState: 'near_live_only',
    blocker: 'No fresh signed Alexa IntentRequest is recorded on this host.',
    blockerOwner: 'external',
    nextAction:
      'Perform one real signed Alexa voice or authenticated simulator turn and confirm services:status records an IntentRequest.',
    detail:
      'Alexa listener, ingress, and account-link health can still be green even when no fresh signed live turn has been recorded on this host.',
  });
}

function buildBlueBubblesTruth(): FieldTrialSurfaceTruth {
  const config = resolveBlueBubblesConfig();
  const snapshot = buildBlueBubblesHealthSnapshot(config);

  if (
    !config.enabled &&
    !config.baseUrl &&
    !config.password &&
    !config.allowedChatGuid
  ) {
    return buildTruth({
      proofState: 'externally_blocked',
      blocker: 'BlueBubbles Server/webhook is not installed or configured on this host.',
      blockerOwner: 'external',
      nextAction:
        'Reconnect the Mac-side BlueBubbles server/webhook and set the BLUEBUBBLES_* values on this Windows host.',
      detail:
        'Repo-side BlueBubbles harnesses can still pass here, but this PC does not currently have a live BlueBubbles server/webhook connection.',
    });
  }

  if (!config.enabled) {
    return buildTruth({
      proofState: 'externally_blocked',
      blocker: 'BlueBubbles is disabled on this host.',
      blockerOwner: 'external',
      nextAction:
        'Enable BLUEBUBBLES_ENABLED and point this host at the reachable BlueBubbles server/webhook.',
      detail:
        'BlueBubbles code is present, but the channel is intentionally disabled on this machine.',
    });
  }

  if (!snapshot.configured) {
    return buildTruth({
      proofState: 'externally_blocked',
      blocker:
        snapshot.detail ||
        'BlueBubbles is enabled but still missing the live server or linked-chat configuration.',
      blockerOwner: 'external',
      nextAction:
        'Finish the BLUEBUBBLES_* connection values and linked chat GUID for this host.',
      detail:
        'The BlueBubbles channel is enabled in code, but this host is not yet configured for a live linked conversation.',
    });
  }

  if (!config.sendEnabled) {
    return buildTruth({
      proofState: 'externally_blocked',
      blocker: 'BlueBubbles outbound reply-back is still disabled on this host.',
      blockerOwner: 'external',
      nextAction:
        'Enable BLUEBUBBLES_SEND_ENABLED and repro one real inbound -> reply -> follow-up flow.',
      detail:
        'Inbound webhook handling is configured, but this host cannot yet prove a full live reply-back flow.',
    });
  }

  return buildTruth({
    proofState: 'near_live_only',
    blocker:
      'A fresh real BlueBubbles inbound -> reply -> follow-up roundtrip has not been reproved on this host.',
    blockerOwner: 'external',
    nextAction:
      'Send one real BlueBubbles message through the reachable server/webhook and confirm Andrea replies in the same linked conversation.',
    detail:
      'BlueBubbles configuration is present, but this pass still needs a same-host live roundtrip before the surface can be called fully live-proven.',
  });
}

function buildResearchTruth(
  projectRoot: string,
  outwardResearchStatus?: BuildFieldTrialOperatorTruthOptions['outwardResearchStatus'],
): FieldTrialSurfaceTruth {
  const persisted = readProviderProofState(projectRoot);
  if (persisted?.research) {
    return buildTruth({
      ...persisted.research,
      blockerOwner:
        persisted.research.proofState === 'externally_blocked'
          ? 'external'
          : persisted.research.proofState === 'degraded_but_usable'
            ? 'repo_side'
            : 'none',
    });
  }

  if (outwardResearchStatus === 'available') {
    return buildTruth({
      proofState: 'live_proven',
      detail: 'Outward research is currently usable and was validated on this host.',
    });
  }

  if (outwardResearchStatus === 'quota_blocked') {
    return buildTruth({
      proofState: 'externally_blocked',
      blocker:
        'Outward research is blocked because the direct provider account is out of quota or billing.',
      blockerOwner: 'external',
      nextAction:
        'Restore provider quota or billing for the direct outward research account, then rerun setup -- --step verify.',
      detail:
        'The outward research path is configured but blocked by provider quota or billing.',
    });
  }

  if (outwardResearchStatus === 'misconfigured_native_openai_endpoint') {
    return buildTruth({
      proofState: 'externally_blocked',
      blocker:
        'Outward research is blocked because OPENAI_BASE_URL points at native OpenAI instead of the Anthropic-compatible core runtime path.',
      blockerOwner: 'external',
      nextAction:
        'Point the core runtime back at an Anthropic-compatible gateway and keep direct provider keys separate for outward research.',
      detail: 'The research/runtime configuration is mis-keyed on this host.',
    });
  }

  if (outwardResearchStatus === 'degraded') {
    return buildTruth({
      proofState: 'externally_blocked',
      blocker:
        'Outward research is configured but the live provider probe is currently degraded on this host.',
      blockerOwner: 'external',
      nextAction:
        'Repair the direct provider path or gateway health, then rerun setup -- --step verify.',
      detail:
        'The outward research path exists, but the live provider probe is not healthy right now.',
    });
  }

  const providerStatus = getOpenAiProviderStatus();
  if (!providerStatus.configured) {
    return buildTruth({
      proofState: 'externally_blocked',
      blocker: `Outward research is blocked because ${describeOpenAiConfigBlocker(providerStatus.missing)}`,
      blockerOwner: 'external',
      nextAction:
        'Add a working OPENAI_API_KEY with quota and billing for outward research on this host.',
      detail:
        'The direct outward research path is not configured on this host, even though the local runtime backend may still be healthy.',
    });
  }

  return buildTruth({
    proofState: 'near_live_only',
    blocker:
      'Outward research is configured, but this pass has not freshly reproved a live direct-provider answer on this host.',
    blockerOwner: 'none',
    nextAction:
      'Run one real outward research question on this host and confirm a provider-backed answer succeeds.',
    detail:
      'The direct outward research path looks configured, but it still needs a same-host live repro.',
  });
}

function buildImageGenerationTruth(projectRoot: string): FieldTrialSurfaceTruth {
  const persisted = readProviderProofState(projectRoot);
  if (persisted?.imageGeneration) {
    return buildTruth({
      ...persisted.imageGeneration,
      blockerOwner:
        persisted.imageGeneration.proofState === 'externally_blocked'
          ? 'external'
          : persisted.imageGeneration.proofState === 'degraded_but_usable'
            ? 'repo_side'
            : 'none',
    });
  }

  const providerStatus = getMediaProviderStatus();
  if (!providerStatus.configured) {
    return buildTruth({
      proofState: 'externally_blocked',
      blocker: `Image generation is blocked because ${describeOpenAiConfigBlocker(providerStatus.missing)}`,
      blockerOwner: 'external',
      nextAction:
        'Add a working OPENAI_API_KEY with image-generation access and billing on this host.',
      detail:
        'The Telegram image-generation handoff is implemented, but the live provider is not configured on this host.',
    });
  }

  return buildTruth({
    proofState: 'near_live_only',
    blocker:
      'Image generation is configured, but this pass has not freshly reproved a live Telegram image on this host.',
    blockerOwner: 'none',
    nextAction:
      'Run one real Telegram image-generation request and confirm the image artifact comes back.',
    detail:
      'The image-generation provider looks configured, but it still needs a same-host live repro.',
  });
}

function buildJourneyTruths(
  review: PilotReviewSnapshotLike,
  telegramTruth: FieldTrialSurfaceTruth,
  alexaTruth: FieldTrialSurfaceTruth,
): FieldTrialJourneyTruthMap {
  return {
    ordinary_chat: buildJourneyTruthFromEvent({
      label: 'Ordinary chat',
      event: getJourneyEventById(review, 'ordinary_chat'),
      nearLiveDetail:
        telegramTruth.proofState === 'live_proven'
          ? 'Telegram is healthy, but ordinary chat needs one fresh same-host proof turn.'
          : 'Ordinary chat is waiting on the Telegram live surface.',
      nearLiveNextAction: 'Send `hi` or `what\'s up` in Telegram on this host.',
    }),
    daily_guidance: buildJourneyTruthFromEvent({
      label: 'Daily guidance',
      event: getJourneyEventById(review, 'daily_guidance'),
      nearLiveDetail:
        'Daily guidance is ready, but it still needs one fresh `what am I forgetting` or `what should I remember tonight` proof turn.',
      nearLiveNextAction:
        'Run `what am I forgetting` or `what should I remember tonight` in Telegram on this host.',
    }),
    candace_followthrough: buildJourneyTruthFromEvent({
      label: 'Candace follow-through',
      event: getJourneyEventById(review, 'candace_followthrough'),
      nearLiveDetail:
        'Candace follow-through is ready, but it still needs one fresh same-host proof chain.',
      nearLiveNextAction:
        'Run `what\'s still open with Candace`, `what should I say back`, and `save that for later` in Telegram on this host.',
    }),
    mission_planning: buildJourneyTruthFromEvent({
      label: 'Mission planning',
      event: getJourneyEventById(review, 'mission_planning'),
      nearLiveDetail:
        'Mission planning is ready, but it still needs one fresh same-host proof chain.',
      nearLiveNextAction:
        'Run `help me plan tonight`, `what\'s the next step`, and `what\'s blocking this` in Telegram on this host.',
    }),
    work_cockpit: buildJourneyTruthFromEvent({
      label: 'Work cockpit',
      event: getJourneyEventById(review, 'work_cockpit'),
      nearLiveDetail:
        'The `/cursor` work cockpit is ready, but it still needs one fresh same-host dashboard and continuation proof.',
      nearLiveNextAction:
        'Run `/cursor`, `Current Work`, and one reply-linked continuation on this host.',
    }),
    cross_channel_handoff: buildJourneyTruthFromEvent({
      label: 'Cross-channel handoff',
      event: getJourneyEventById(review, 'cross_channel_handoff'),
      nearLiveDetail:
        'Cross-channel save and handoff flows are ready, but they still need one fresh same-host proof turn.',
      nearLiveNextAction:
        'Run `send me the full version` or `save that for later` from a flagship Telegram journey on this host.',
    }),
    alexa_orientation:
      alexaTruth.proofState === 'live_proven'
        ? alexaTruth
        : buildTruth({
            proofState: alexaTruth.proofState,
            blocker: alexaTruth.blocker,
            blockerOwner: alexaTruth.blockerOwner,
            nextAction: alexaTruth.nextAction,
            detail:
              alexaTruth.proofState === 'near_live_only'
                ? 'Alexa orientation stays near-live until one fresh signed turn is recorded on this host.'
                : alexaTruth.detail,
          }),
  };
}

function buildSurfaceTruthFromPilotEvidence(params: {
  label: string;
  review: PilotReviewSnapshotLike;
  predicate: (event: PilotJourneyEventRecord) => boolean;
  nearLiveDetail: string;
  nearLiveNextAction: string;
}): FieldTrialSurfaceTruth {
  return buildJourneyTruthFromEvent({
    label: params.label,
    event: getRecentJourneyEvent(params.review, params.predicate),
    nearLiveDetail: params.nearLiveDetail,
    nearLiveNextAction: params.nearLiveNextAction,
  });
}

export function buildFieldTrialOperatorTruth(
  options: BuildFieldTrialOperatorTruthOptions = {},
): FieldTrialOperatorTruth {
  const projectRoot = options.projectRoot || process.cwd();
  const hostSnapshot = options.hostSnapshot || readHostControlSnapshot(projectRoot);
  const windowsHost =
    options.windowsHost === undefined
      ? process.platform === 'win32'
        ? reconcileWindowsHostState({ projectRoot })
        : null
      : options.windowsHost;
  const review = buildPilotReviewSnapshot();

  const telegram = buildTelegramTruth(hostSnapshot, windowsHost);
  const alexa = buildAlexaTruth(projectRoot);
  const bluebubbles = buildBlueBubblesTruth();
  const research = buildResearchTruth(projectRoot, options.outwardResearchStatus);
  const imageGeneration = buildImageGenerationTruth(projectRoot);
  const hostHealth = buildHostHealthTruth(hostSnapshot, windowsHost);
  const journeys = buildJourneyTruths(review, telegram, alexa);

  const workCockpit = buildSurfaceTruthFromPilotEvidence({
    label: 'Work cockpit',
    review,
    predicate: (event) => event.journeyId === 'work_cockpit',
    nearLiveDetail:
      'The work cockpit is ready, but it still needs one fresh `/cursor` and `Current Work` proof chain on this host.',
    nearLiveNextAction:
      'Run `/cursor`, `Current Work`, and one reply-linked continuation on this host.',
  });
  const lifeThreads = buildSurfaceTruthFromPilotEvidence({
    label: 'Life threads',
    review,
    predicate: (event) =>
      event.threadSaved === true ||
      event.routeKey?.startsWith('threads.') === true ||
      event.systemsInvolved.includes('life_threads'),
    nearLiveDetail:
      'Life-thread tracking is ready, but it still needs one fresh same-host save or thread-control proof turn.',
    nearLiveNextAction:
      'Run `save that for later` or another explicit thread-control turn on this host.',
  });
  const communicationCompanion = buildSurfaceTruthFromPilotEvidence({
    label: 'Communication companion',
    review,
    predicate: (event) =>
      event.journeyId === 'candace_followthrough' ||
      event.systemsInvolved.includes('communication_companion'),
    nearLiveDetail:
      'Communication companion flows are ready, but they still need one fresh same-host proof turn.',
    nearLiveNextAction:
      'Run `what\'s still open with Candace` or `what should I say back` on this host.',
  });
  const chiefOfStaffMissions = buildSurfaceTruthFromPilotEvidence({
    label: 'Chief-of-staff and missions',
    review,
    predicate: (event) =>
      event.journeyId === 'mission_planning' ||
      event.systemsInvolved.includes('missions') ||
      event.systemsInvolved.includes('chief_of_staff'),
    nearLiveDetail:
      'Chief-of-staff and mission flows are ready, but they still need one fresh same-host proof chain.',
    nearLiveNextAction:
      'Run `help me plan tonight`, `what\'s the next step`, and `what\'s blocking this` on this host.',
  });
  const knowledgeLibrary = buildSurfaceTruthFromPilotEvidence({
    label: 'Knowledge library',
    review,
    predicate: (event) =>
      event.librarySaved === true ||
      event.systemsInvolved.includes('knowledge_library') ||
      event.routeKey?.startsWith('knowledge.') === true,
    nearLiveDetail:
      'Knowledge-library flows are ready, but they still need one fresh same-host proof save or source-grounded answer.',
    nearLiveNextAction:
      'Run one `use only my saved material` or `save this to my library` proof turn on this host.',
  });

  return {
    telegram,
    alexa,
    bluebubbles,
    workCockpit,
    lifeThreads,
    communicationCompanion,
    chiefOfStaffMissions,
    knowledgeLibrary,
    research,
    imageGeneration,
    hostHealth,
    journeys,
    pilotIssues: {
      loggingEnabled: review.loggingEnabled,
      openCount: review.openIssueCount,
      latestSummary: review.latestOpenIssue?.summaryText || '',
    },
  };
}
