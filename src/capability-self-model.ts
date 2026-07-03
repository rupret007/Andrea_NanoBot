import {
  getAllTasks,
  isDatabaseInitialized,
  listActionPreflights,
  listCapabilityStates,
  listProofClosureSteps,
  listReliabilityObservations,
  listToolReliabilityRollups,
  upsertCapabilityState,
} from './db.js';
import { readEnvFile } from './env.js';
import {
  collectProviderHealthSnapshots,
  type ProviderHealthSnapshot,
} from './provider-health.js';
import {
  buildIntegrationDoctorReport,
  type IntegrationDoctorReport,
  type IntegrationStatus,
} from './integration-doctor.js';
import type { CapabilityStateRecord, ControlPlaneChannel } from './types.js';
import type { ScheduledTask } from './types.js';

// ---------------------------------------------------------------------------
// v32 Capability Self-Model
//
// Andrea's live model of what it can and cannot do right now, grounded in
// tool reliability rollups, proof closure records, and config presence.
// Config is checked by NAME ONLY — values are never read into this module's
// outputs. Missing config stays classified as external/config debt, never as
// a repo bug.
// ---------------------------------------------------------------------------

const PRIVACY_JSON = JSON.stringify({
  metadataOnly: true,
  rawPromptsStored: false,
  rawPrivateBodiesStored: false,
  hiddenReasoningStored: false,
  secretsRedacted: true,
  configCheckedByNameOnly: true,
});

interface CapabilityDefinition {
  capabilityId: string;
  displayName: string;
  focusTier: 'daily_core' | 'operator_support' | 'optional_surface';
  requiredConfig: string[];
  requiredConfigAnyOf?: string[][];
  reliabilitySubjectId?: string;
  proofNameHint?: RegExp;
  allowedChannels: ControlPlaneChannel[];
  approvalRequirement: CapabilityStateRecord['approvalRequirement'];
  fallbackCapabilityId?: string;
  autonomyLevel: number;
}

const CAPABILITY_DEFINITIONS: CapabilityDefinition[] = [
  {
    capabilityId: 'messages.draft',
    displayName: 'Draft messages and replies',
    focusTier: 'daily_core',
    requiredConfig: [],
    allowedChannels: [
      'telegram',
      'bluebubbles',
      'alexa',
      'operator',
      'internal',
    ],
    approvalRequirement: 'none',
    autonomyLevel: 1,
  },
  {
    capabilityId: 'messages.send.telegram',
    displayName: 'Send Telegram messages (after approval)',
    focusTier: 'daily_core',
    requiredConfig: ['TELEGRAM_BOT_TOKEN'],
    reliabilitySubjectId: 'integration:telegram',
    proofNameHint: /telegram.*bot|bot.*telegram/i,
    allowedChannels: ['telegram'],
    approvalRequirement: 'explicit_approval',
    fallbackCapabilityId: 'messages.draft',
    autonomyLevel: 5,
  },
  {
    capabilityId: 'messages.send.bluebubbles',
    displayName: 'Send iMessage via BlueBubbles (after approval)',
    focusTier: 'daily_core',
    requiredConfig: ['BLUEBUBBLES_BASE_URL'],
    reliabilitySubjectId: 'integration:bluebubbles',
    proofNameHint: /bluebubbles|same.thread/i,
    allowedChannels: ['bluebubbles'],
    approvalRequirement: 'explicit_approval',
    fallbackCapabilityId: 'messages.draft',
    autonomyLevel: 5,
  },
  {
    capabilityId: 'telegram.user_session',
    displayName: 'Telegram user-session automation',
    focusTier: 'operator_support',
    requiredConfig: ['TELEGRAM_USER_API_ID', 'TELEGRAM_USER_API_HASH'],
    reliabilitySubjectId: 'integration:telegram',
    proofNameHint: /telegram.*user/i,
    allowedChannels: ['telegram', 'operator'],
    approvalRequirement: 'explicit_approval',
    fallbackCapabilityId: 'messages.send.telegram',
    autonomyLevel: 5,
  },
  {
    capabilityId: 'calendar.read',
    displayName: 'Read Google Calendar',
    focusTier: 'daily_core',
    requiredConfig: ['GOOGLE_CALENDAR_CLIENT_ID'],
    reliabilitySubjectId: 'integration:google_calendar',
    proofNameHint: /google calendar|calendar.*(read|write|create|auth)/i,
    allowedChannels: [
      'telegram',
      'alexa',
      'bluebubbles',
      'operator',
      'internal',
    ],
    approvalRequirement: 'none',
    autonomyLevel: 0,
  },
  {
    capabilityId: 'calendar.write',
    displayName: 'Create Google Calendar events (after approval)',
    focusTier: 'daily_core',
    requiredConfig: ['GOOGLE_CALENDAR_CLIENT_ID'],
    reliabilitySubjectId: 'integration:google_calendar',
    proofNameHint: /google calendar|calendar.*(read|write|create|auth)/i,
    allowedChannels: ['telegram', 'operator'],
    approvalRequirement: 'explicit_approval',
    fallbackCapabilityId: 'calendar.read',
    autonomyLevel: 5,
  },
  {
    capabilityId: 'voice.alexa',
    displayName: 'Alexa voice conversations',
    focusTier: 'optional_surface',
    requiredConfig: ['ALEXA_SKILL_ID'],
    reliabilitySubjectId: 'integration:alexa',
    proofNameHint: /alexa.*(intent|signed)/i,
    allowedChannels: ['alexa'],
    approvalRequirement: 'none',
    autonomyLevel: 0,
  },
  {
    capabilityId: 'research.web',
    displayName: 'Web research',
    focusTier: 'daily_core',
    requiredConfig: [],
    requiredConfigAnyOf: [['BRAVE_API_KEY', 'BRAVE_SEARCH_API_KEY']],
    reliabilitySubjectId: 'provider:brave_search',
    allowedChannels: [
      'telegram',
      'alexa',
      'bluebubbles',
      'operator',
      'internal',
    ],
    approvalRequirement: 'none',
    autonomyLevel: 0,
  },
  {
    capabilityId: 'reminders.internal',
    displayName: 'Internal reminders and follow-ups',
    focusTier: 'daily_core',
    requiredConfig: [],
    reliabilitySubjectId: 'tool:reminders',
    allowedChannels: [
      'telegram',
      'alexa',
      'bluebubbles',
      'operator',
      'internal',
    ],
    approvalRequirement: 'none',
    autonomyLevel: 3,
  },
  {
    capabilityId: 'repair.runtime',
    displayName: 'Self-healing repair playbooks',
    focusTier: 'operator_support',
    requiredConfig: [],
    allowedChannels: ['operator', 'internal'],
    approvalRequirement: 'operator_context',
    autonomyLevel: 6,
  },
  {
    capabilityId: 'patch.workbench',
    displayName: 'Approval-gated patch workbench',
    focusTier: 'operator_support',
    requiredConfig: [],
    allowedChannels: ['operator'],
    approvalRequirement: 'operator_context',
    autonomyLevel: 6,
  },
];

function nowIso(now?: string): string {
  return now ?? new Date().toISOString();
}

export interface CapabilitySelfModelReport {
  generatedAt: string;
  states: CapabilityStateRecord[];
  ready: number;
  blocked: number;
  needsSetup: number;
  dailyCore: {
    total: number;
    ready: number;
    needsAttention: number;
  };
  optionalSurfaces: {
    total: number;
    ready: number;
    needsAttention: number;
  };
  operatorSupport: {
    total: number;
    ready: number;
    needsAttention: number;
  };
}

function definitionForCapability(
  capabilityId: string,
): CapabilityDefinition | undefined {
  return CAPABILITY_DEFINITIONS.find(
    (definition) => definition.capabilityId === capabilityId,
  );
}

function focusTierForCapability(
  state: Pick<CapabilityStateRecord, 'capabilityId'>,
): CapabilityDefinition['focusTier'] {
  return definitionForCapability(state.capabilityId)?.focusTier ?? 'daily_core';
}

function needsAttention(state: CapabilityStateRecord): boolean {
  return state.proofStatus !== 'live_proven';
}

function summarizeFocusTier(
  states: CapabilityStateRecord[],
  focusTier: CapabilityDefinition['focusTier'],
): CapabilitySelfModelReport['dailyCore'] {
  const scoped = states.filter(
    (state) => focusTierForCapability(state) === focusTier,
  );
  return {
    total: scoped.length,
    ready: scoped.filter((state) => state.proofStatus === 'live_proven').length,
    needsAttention: scoped.filter(needsAttention).length,
  };
}

export function getDailyCoreCapabilityStates(
  report: CapabilitySelfModelReport,
): CapabilityStateRecord[] {
  return report.states.filter(
    (state) => focusTierForCapability(state) === 'daily_core',
  );
}

export function getDailyCoreAttentionStates(
  report: CapabilitySelfModelReport,
): CapabilityStateRecord[] {
  return getDailyCoreCapabilityStates(report).filter(needsAttention);
}

function sortCapabilityStatesForDisplay(
  states: CapabilityStateRecord[],
): CapabilityStateRecord[] {
  const tierRank: Record<CapabilityDefinition['focusTier'], number> = {
    daily_core: 0,
    operator_support: 1,
    optional_surface: 2,
  };
  return [...states].sort((a, b) => {
    const tierDelta =
      tierRank[focusTierForCapability(a)] - tierRank[focusTierForCapability(b)];
    if (tierDelta !== 0) return tierDelta;
    const attentionDelta =
      Number(needsAttention(b)) - Number(needsAttention(a));
    if (attentionDelta !== 0) return attentionDelta;
    return a.capabilityId.localeCompare(b.capabilityId);
  });
}

function focusLabelForCapability(state: CapabilityStateRecord): string {
  const focusTier = focusTierForCapability(state);
  if (focusTier === 'daily_core') return 'CORE';
  if (focusTier === 'operator_support') return 'OPERATOR';
  return 'OPTIONAL';
}

function isReminderTask(task: ScheduledTask): boolean {
  return /\breminder\b/i.test(task.prompt || '');
}

function summarizeReminderTaskEvidence(
  tasks: ScheduledTask[],
  generatedAt: string,
): { hasEvidence: boolean; lastEvidenceAt: string | null } {
  const nowMs = Date.parse(generatedAt);
  const recentWindowMs = 30 * 24 * 60 * 60 * 1000;
  const reminderTasks = tasks.filter(isReminderTask);
  const active = reminderTasks.find((task) => task.status === 'active');
  if (active) {
    return {
      hasEvidence: true,
      lastEvidenceAt: active.created_at || active.next_run || null,
    };
  }
  const recentCompleted = reminderTasks.find((task) => {
    if (task.status !== 'completed') return false;
    const evidenceAt = Date.parse(task.last_run || task.created_at || '');
    return Number.isFinite(evidenceAt) && nowMs - evidenceAt <= recentWindowMs;
  });
  return {
    hasEvidence: Boolean(recentCompleted),
    lastEvidenceAt:
      recentCompleted?.last_run || recentCompleted?.created_at || null,
  };
}

export function buildCapabilitySelfModel(
  params: {
    now?: string;
    persist?: boolean;
    env?: Record<string, string | undefined>;
    envFileValues?: Record<string, string | undefined>;
    providerHealthSnapshots?: ProviderHealthSnapshot[];
    integrationReport?: IntegrationDoctorReport;
  } = {},
): CapabilitySelfModelReport {
  const generatedAt = nowIso(params.now);
  const dbReady = isDatabaseInitialized();
  const rollups = dbReady ? listToolReliabilityRollups({ limit: 100 }) : [];
  const proofSteps = dbReady ? listProofClosureSteps({ limit: 100 }) : [];
  const scheduledTasks = dbReady ? getAllTasks() : [];
  const requiredConfigNames = Array.from(
    new Set(
      CAPABILITY_DEFINITIONS.flatMap((item) => [
        ...item.requiredConfig,
        ...(item.requiredConfigAnyOf ?? []).flat(),
      ]),
    ),
  );
  const env = params.env ?? process.env;
  const envFileValues =
    params.envFileValues ?? readEnvFile(requiredConfigNames);
  const providerHealth =
    params.providerHealthSnapshots ??
    collectProviderHealthSnapshots(generatedAt);
  const integrationReport =
    params.integrationReport ||
    buildIntegrationDoctorReport({ now: new Date(generatedAt) });
  const states: CapabilityStateRecord[] = [];

  for (const definition of CAPABILITY_DEFINITIONS) {
    const hasConfig = (name: string) =>
      Boolean(env[name] || envFileValues[name]);
    const missingRequiredConfig = definition.requiredConfig.filter(
      (name) => !env[name] && !envFileValues[name],
    );
    const missingAlternativeConfig = (definition.requiredConfigAnyOf ?? [])
      .filter((group) => !group.some(hasConfig))
      .map((group) => group.join('|'));
    const missingConfig = [
      ...missingRequiredConfig,
      ...missingAlternativeConfig,
    ];
    const rollup = definition.reliabilitySubjectId
      ? rollups.find(
          (entry) => entry.subjectId === definition.reliabilitySubjectId,
        )
      : undefined;
    const proofStep = definition.proofNameHint
      ? proofSteps.find((step) =>
          definition.proofNameHint!.test(step.proofName),
        )
      : undefined;
    const provider = definition.reliabilitySubjectId?.startsWith('provider:')
      ? providerHealth.find(
          (item) =>
            item.providerId ===
            definition.reliabilitySubjectId!.replace(/^provider:/, ''),
        )
      : undefined;
    const integration = definition.reliabilitySubjectId?.startsWith(
      'integration:',
    )
      ? integrationReport.statuses.find(
          (item) =>
            item.integrationId ===
            definition.reliabilitySubjectId!.replace(/^integration:/, ''),
        )
      : undefined;

    let proofStatus: CapabilityStateRecord['proofStatus'] = 'unproven';
    let currentBlocker: string | null = null;
    if (missingConfig.length) {
      proofStatus = 'missing_config';
      currentBlocker = `Missing config (external/config debt, not a repo bug): ${missingConfig.join(', ')}`;
    } else if (proofStep?.status === 'complete') {
      proofStatus = 'live_proven';
    } else if (integration) {
      const integrationProof =
        capabilityProofStatusFromIntegration(integration);
      proofStatus = integrationProof.proofStatus;
      currentBlocker = integrationProof.currentBlocker;
    } else if (proofStep) {
      switch (proofStep.status) {
        case 'stale_proof':
          proofStatus = 'stale';
          currentBlocker = proofStep.exactNextStep;
          break;
        case 'manual_action':
          proofStatus = 'manual_proof_required';
          currentBlocker = proofStep.exactNextStep;
          break;
        case 'externally_blocked':
          proofStatus = 'externally_blocked';
          currentBlocker = proofStep.exactNextStep;
          break;
        case 'missing_config':
          proofStatus = 'missing_config';
          currentBlocker = proofStep.exactNextStep;
          break;
        default:
          proofStatus = 'unproven';
          currentBlocker = proofStep.exactNextStep;
      }
    } else if (
      rollup &&
      !(
        definition.capabilityId === 'reminders.internal' &&
        rollup.currentHealth === 'unknown'
      )
    ) {
      if (provider) {
        proofStatus =
          provider.state === 'healthy'
            ? 'live_proven'
            : provider.state === 'externally_blocked' ||
                provider.state === 'not_configured'
              ? 'externally_blocked'
              : 'stale';
        if (provider.state !== 'healthy') {
          currentBlocker = provider.nextAction || provider.blocker || null;
        }
      } else {
        proofStatus =
          rollup.currentHealth === 'healthy'
            ? 'live_proven'
            : rollup.currentHealth === 'blocked'
              ? 'externally_blocked'
              : 'stale';
        if (rollup.currentHealth !== 'healthy') {
          currentBlocker = rollup.nextAction;
        }
      }
    } else if (!definition.requiredConfig.length) {
      // Pure-internal capabilities are proven by construction.
      proofStatus = 'live_proven';
    }

    const reminderEvidence =
      definition.capabilityId === 'reminders.internal'
        ? summarizeReminderTaskEvidence(scheduledTasks, generatedAt)
        : null;
    if (reminderEvidence?.hasEvidence) {
      proofStatus = 'live_proven';
      currentBlocker = null;
    }

    const observations =
      dbReady && definition.reliabilitySubjectId
        ? listReliabilityObservations({
            subjectId: definition.reliabilitySubjectId,
            limit: 30,
          })
        : [];
    const lastSuccess = observations.find(
      (observation) => observation.outcome === 'success',
    );
    const lastFailure = observations.find(
      (observation) =>
        observation.outcome === 'failed' || observation.outcome === 'blocked',
    );

    const reliabilityScoreBase =
      provider?.state === 'healthy'
        ? Math.max(rollup?.reliabilityScore ?? 0, 0.9)
        : (rollup?.reliabilityScore ??
          (proofStatus === 'live_proven' ? 0.9 : 0.4));
    const reliabilityScore =
      proofStatus === 'live_proven'
        ? Math.max(reliabilityScoreBase, 0.9)
        : proofStatus === 'missing_config'
          ? Math.min(reliabilityScoreBase, 0.05)
          : proofStatus === 'externally_blocked'
            ? Math.min(reliabilityScoreBase, 0.22)
            : reliabilityScoreBase;
    const enabled =
      proofStatus !== 'missing_config' && proofStatus !== 'externally_blocked';
    const confidence = Math.max(
      0.05,
      Math.min(
        0.98,
        reliabilityScore *
          (proofStatus === 'live_proven'
            ? 1
            : proofStatus === 'stale'
              ? 0.7
              : 0.45),
      ),
    );

    const state: CapabilityStateRecord = {
      capabilityId: definition.capabilityId,
      updatedAt: generatedAt,
      displayName: definition.displayName,
      enabled,
      proofStatus,
      lastSuccessAt:
        lastSuccess?.observedAt ?? reminderEvidence?.lastEvidenceAt ?? null,
      lastFailureAt: lastFailure?.observedAt ?? null,
      reliabilityScore,
      requiredConfig:
        [
          ...definition.requiredConfig,
          ...(definition.requiredConfigAnyOf ?? []).map((group) =>
            group.join('|'),
          ),
        ].join(',') || 'none',
      currentBlocker,
      allowedChannels: definition.allowedChannels.join(','),
      approvalRequirement: definition.approvalRequirement,
      fallbackCapabilityId: definition.fallbackCapabilityId ?? null,
      confidence,
      autonomyLevel: definition.autonomyLevel,
      privacyJson: PRIVACY_JSON,
    };
    states.push(state);
    if (params.persist !== false && dbReady) {
      upsertCapabilityState(state);
    }
  }

  const dailyCore = summarizeFocusTier(states, 'daily_core');
  const optionalSurfaces = summarizeFocusTier(states, 'optional_surface');
  const operatorSupport = summarizeFocusTier(states, 'operator_support');
  return {
    generatedAt,
    states,
    ready: states.filter((state) => state.proofStatus === 'live_proven').length,
    blocked: states.filter(
      (state) =>
        state.proofStatus === 'externally_blocked' ||
        state.proofStatus === 'missing_config',
    ).length,
    needsSetup: states.filter((state) => state.proofStatus === 'missing_config')
      .length,
    dailyCore,
    optionalSurfaces,
    operatorSupport,
  };
}

function capabilityProofStatusFromIntegration(integration: IntegrationStatus): {
  proofStatus: CapabilityStateRecord['proofStatus'];
  currentBlocker: string | null;
} {
  if (integration.state === 'healthy') {
    return { proofStatus: 'live_proven', currentBlocker: null };
  }
  if (
    integration.state === 'externally_blocked' ||
    integration.state === 'needs_auth' ||
    integration.state === 'manual_action_required'
  ) {
    return {
      proofStatus: 'externally_blocked',
      currentBlocker:
        integration.nextAction || integration.lastFailure || integration.detail,
    };
  }
  if (integration.state === 'near_live_only') {
    return {
      proofStatus: 'manual_proof_required',
      currentBlocker:
        integration.nextAction || integration.lastFailure || integration.detail,
    };
  }
  if (
    integration.state === 'degraded_but_usable' ||
    integration.state === 'needs_proof' ||
    integration.state === 'repo_fix_available'
  ) {
    return {
      proofStatus: 'stale',
      currentBlocker:
        integration.nextAction || integration.lastFailure || integration.detail,
    };
  }
  return {
    proofStatus: 'unproven',
    currentBlocker:
      integration.nextAction || integration.lastFailure || integration.detail,
  };
}

export function getStoredCapabilityStates(): CapabilityStateRecord[] {
  if (!isDatabaseInitialized()) return [];
  return listCapabilityStates({ limit: 50 });
}

export function formatCapabilityReport(
  report: CapabilitySelfModelReport = buildCapabilitySelfModel({
    persist: false,
  }),
): string {
  const lines: string[] = ['*Capability Self-Model*'];
  lines.push(
    `Capabilities: ${report.states.length} (ready ${report.ready}, blocked/missing-config ${report.blocked})`,
  );
  lines.push(
    `Daily core: ${report.dailyCore.ready}/${report.dailyCore.total} ready (${report.dailyCore.needsAttention} need attention)`,
  );
  lines.push(
    `Optional surfaces: ${report.optionalSurfaces.ready}/${report.optionalSurfaces.total} ready (${report.optionalSurfaces.needsAttention} need attention)`,
  );
  lines.push(
    `Operator support: ${report.operatorSupport.ready}/${report.operatorSupport.total} ready (${report.operatorSupport.needsAttention} need attention)`,
  );
  for (const state of sortCapabilityStatesForDisplay(report.states)) {
    const flag =
      state.proofStatus === 'live_proven'
        ? 'OK'
        : state.proofStatus === 'missing_config'
          ? 'SETUP'
          : state.proofStatus.toUpperCase();
    lines.push(
      `- [${flag}/${focusLabelForCapability(state)}] ${state.displayName} — reliability ${state.reliabilityScore.toFixed(2)}, approval: ${state.approvalRequirement}, autonomy L${state.autonomyLevel}${state.currentBlocker ? ` — blocker: ${state.currentBlocker}` : ''}`,
    );
  }
  return lines.join('\n');
}

export function isCapabilityNaturalRequest(text: string): boolean {
  return /\b(what can you (actually |really )?do( today)?|can you (send|text|use|write|read) (texts?|messages?|my calendar|imessage)|what('?| i)s broken|what needs (setup|set up|fixing)|why didn'?t you (do|send|create)|what should we fix next)\b/i.test(
    text || '',
  );
}

export function formatCapabilityNaturalResponse(text: string): string {
  const report = buildCapabilitySelfModel({ persist: false });
  const ask = text || '';

  if (/\bcan you (send|text)\b/i.test(ask)) {
    const bluebubbles = report.states.find(
      (state) => state.capabilityId === 'messages.send.bluebubbles',
    );
    const telegram = report.states.find(
      (state) => state.capabilityId === 'messages.send.telegram',
    );
    const lines = ['Here is where message sending stands:'];
    for (const state of [bluebubbles, telegram]) {
      if (!state) continue;
      if (state.proofStatus === 'live_proven') {
        lines.push(
          `- ${state.displayName}: ready. I always draft first and send only with your approval.`,
        );
      } else {
        lines.push(
          `- ${state.displayName}: not fully proven right now (${state.proofStatus.replace(/_/g, ' ')})${state.currentBlocker ? ` — ${state.currentBlocker}` : ''}. I can still draft, and we can queue the send for when it is verified.`,
        );
      }
    }
    return lines.join('\n');
  }

  if (
    /\bwhat('?| i)s broken|what needs (setup|set up|fixing)|what should we fix next\b/i.test(
      ask,
    )
  ) {
    const coreAttention = getDailyCoreAttentionStates(report);
    const optionalAttention = report.states.filter(
      (state) =>
        focusTierForCapability(state) === 'optional_surface' &&
        needsAttention(state),
    );
    const operatorAttention = report.states.filter(
      (state) =>
        focusTierForCapability(state) === 'operator_support' &&
        needsAttention(state),
    );
    if (
      !coreAttention.length &&
      !optionalAttention.length &&
      !operatorAttention.length
    ) {
      return 'Nothing is broken right now — all tracked capabilities have live proof.';
    }
    const lines = [
      coreAttention.length
        ? `${coreAttention.length} core daily-agent capabilit${coreAttention.length === 1 ? 'y' : 'ies'} need attention:`
        : 'Core daily-agent capabilities are ready.',
    ];
    for (const state of coreAttention.slice(0, 6)) {
      lines.push(
        `- ${state.displayName}: ${state.proofStatus.replace(/_/g, ' ')}${state.currentBlocker ? ` — ${state.currentBlocker}` : ''}`,
      );
    }
    if (optionalAttention.length) {
      lines.push('Optional/manual surfaces not in the core loop:');
      for (const state of optionalAttention.slice(0, 3)) {
        lines.push(
          `- ${state.displayName}: ${state.proofStatus.replace(/_/g, ' ')}${state.currentBlocker ? ` — ${state.currentBlocker}` : ''}`,
        );
      }
    }
    if (operatorAttention.length) {
      lines.push('Operator support that may need attention:');
      for (const state of operatorAttention.slice(0, 3)) {
        lines.push(
          `- ${state.displayName}: ${state.proofStatus.replace(/_/g, ' ')}${state.currentBlocker ? ` — ${state.currentBlocker}` : ''}`,
        );
      }
    }
    return lines.join('\n');
  }

  if (/\bwhy didn'?t you\b/i.test(ask)) {
    const preflights = isDatabaseInitialized()
      ? listActionPreflights({ limit: 5 })
      : [];
    const blockedPreflight = preflights.find(
      (preflight) => preflight.verdict !== 'proceed',
    );
    if (blockedPreflight) {
      return `The last time I held back: ${blockedPreflight.actionSummary} — verdict was "${blockedPreflight.verdict}" because ${blockedPreflight.blockerSummary}${blockedPreflight.fallbackSuggestion ? ` Safer option: ${blockedPreflight.fallbackSuggestion}` : ''}`;
    }
    return 'I do not have a recent record of holding back an action. If you tell me which action you mean, I can check the lifecycle ledger.';
  }

  const readyCore = getDailyCoreCapabilityStates(report).filter(
    (state) => state.proofStatus === 'live_proven',
  );
  const lines = [
    `What I can do right now through the daily core (${report.dailyCore.ready}/${report.dailyCore.total} ready):`,
  ];
  for (const state of readyCore) {
    lines.push(`- ${state.displayName}`);
  }
  const coreNeedsWork = getDailyCoreAttentionStates(report);
  if (coreNeedsWork.length) {
    lines.push('Daily core needs setup or fresh proof:');
    for (const state of coreNeedsWork) {
      lines.push(
        `- ${state.displayName} (${state.proofStatus.replace(/_/g, ' ')})`,
      );
    }
  }
  const optionalNeedsWork = report.states.filter(
    (state) =>
      focusTierForCapability(state) === 'optional_surface' &&
      needsAttention(state),
  );
  if (optionalNeedsWork.length) {
    lines.push('Optional/manual surfaces can wait:');
    for (const state of optionalNeedsWork) {
      lines.push(
        `- ${state.displayName} (${state.proofStatus.replace(/_/g, ' ')})`,
      );
    }
  }
  lines.push(
    'Anything external — sending, calendar writes, purchases — always waits for your explicit approval.',
  );
  return lines.join('\n');
}
