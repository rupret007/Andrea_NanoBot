import { buildBlueBubblesHealthSnapshot, resolveBlueBubblesConfig } from './channels/bluebubbles.js';
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
import { readProviderProofState } from './provider-proof-state.js';

export type FieldTrialProofState =
  | 'live_proven'
  | 'near_live_only'
  | 'externally_blocked'
  | 'not_intended_for_trial';

export type FieldTrialBlockerOwner = 'none' | 'repo_side' | 'external';

export interface FieldTrialSurfaceTruth {
  proofState: FieldTrialProofState;
  blocker: string;
  blockerOwner: FieldTrialBlockerOwner;
  nextAction: string;
  detail: string;
}

export interface FieldTrialOperatorTruth {
  telegram: FieldTrialSurfaceTruth;
  alexa: FieldTrialSurfaceTruth;
  bluebubbles: FieldTrialSurfaceTruth;
  research: FieldTrialSurfaceTruth;
  imageGeneration: FieldTrialSurfaceTruth;
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
    blocker: 'A fresh real BlueBubbles inbound -> reply -> follow-up roundtrip has not been reproved on this host.',
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
    return buildTruth(persisted.research);
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
      blocker: 'Outward research is blocked because the direct provider account is out of quota or billing.',
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
      detail:
        'The research/runtime configuration is mis-keyed on this host.',
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
    blocker: 'Outward research is configured, but this pass has not freshly reproved a live direct-provider answer on this host.',
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
    return buildTruth(persisted.imageGeneration);
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
    blocker: 'Image generation is configured, but this pass has not freshly reproved a live Telegram image on this host.',
    blockerOwner: 'none',
    nextAction:
      'Run one real Telegram image-generation request and confirm the image artifact comes back.',
    detail:
      'The image-generation provider looks configured, but it still needs a same-host live repro.',
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

  return {
    telegram: buildTelegramTruth(hostSnapshot, windowsHost),
    alexa: buildAlexaTruth(projectRoot),
    bluebubbles: buildBlueBubblesTruth(),
    research: buildResearchTruth(projectRoot, options.outwardResearchStatus),
    imageGeneration: buildImageGenerationTruth(projectRoot),
  };
}
