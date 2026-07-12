import { createHash } from 'node:crypto';

import { buildAgentOSReport } from './agent-os.js';
import { redactCouncilText } from './council-safety.js';
import {
  buildCognitiveDoctorReport,
  type CognitiveDoctorReport,
} from './cognitive-kernel.js';
import {
  listWorldFacts,
  listWorldModelClaims,
  listWorldModelEvidenceRefs,
  listWorldModelOpenQuestions,
  listWorldModelRiskStates,
  listWorldModelSkillTrust,
  listWorldModelSnapshots,
  listWorldModelVerificationNeeds,
  upsertWorldModelClaim,
  upsertWorldModelEvidenceRef,
  upsertWorldModelOpenQuestion,
  upsertWorldModelRiskState,
  upsertWorldModelSkillTrust,
  upsertWorldModelSnapshot,
  upsertWorldModelVerificationNeed,
} from './db.js';
import {
  buildIntegrationDoctorReport,
  type IntegrationDoctorReport,
  type IntegrationStatus,
} from './integration-doctor.js';
import { buildLogicKernelReport } from './logic-kernel.js';
import {
  collectProviderHealthSnapshots,
  type ProviderHealthSnapshot,
} from './provider-health.js';
import { buildTruthEngineReport } from './truth-engine.js';
import type {
  AgentOSReport,
  LogicKernelReport,
  TruthEngineReport,
  WorldModelClaim,
  WorldModelDoctorReport,
  WorldModelDomain,
  WorldModelEvidenceRef,
  WorldModelFreshness,
  WorldModelFreshnessPolicy,
  WorldFactRecord,
  WorldModelOpenQuestion,
  WorldModelRiskState,
  WorldModelSkillTrustState,
  WorldModelSnapshot,
  WorldModelVerificationNeed,
} from './types.js';

export interface BuildWorldModelInput {
  generatedAt?: string;
  subject?: string | null;
  verifySafe?: boolean;
  providers?: ProviderHealthSnapshot[];
  integrationReport?: IntegrationDoctorReport;
  logicReport?: LogicKernelReport;
  truthReport?: TruthEngineReport;
  agentOSReport?: AgentOSReport;
  cognitiveReport?: CognitiveDoctorReport;
  persist?: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function hashId(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function safeJson(value: unknown, limit = 12000): string {
  try {
    const json = JSON.stringify(value ?? null);
    return redactCouncilText(
      json.length <= limit
        ? json
        : JSON.stringify({
            truncated: true,
            summary: json.slice(0, Math.max(0, limit - 80)),
          }),
      limit,
    );
  } catch {
    return 'null';
  }
}

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function privacyJson(): string {
  return safeJson({
    metadataOnly: true,
    rawPromptsStored: false,
    rawPrivateBodiesStored: false,
    hiddenReasoningStored: false,
    rawToolOutputStored: false,
    secretsRedacted: true,
  });
}

function privacyReport(): WorldModelDoctorReport['privacy'] {
  return {
    metadataOnly: true,
    rawPromptsStored: false,
    rawPrivateBodiesStored: false,
    hiddenReasoningStored: false,
    secretsRedacted: true,
  };
}

const DEFAULT_FRESHNESS_POLICIES: WorldModelFreshnessPolicy[] = [
  {
    policyId: 'world:freshness:providers',
    domain: 'providers',
    freshForHours: 1,
    staleAfterHours: 6,
    expiresAfterHours: 24,
    manualProofRequired: false,
    nextAction:
      'Run provider diagnostics before trusting degraded model participation.',
  },
  {
    policyId: 'world:freshness:integrations',
    domain: 'bluebubbles',
    freshForHours: 12,
    staleAfterHours: 48,
    expiresAfterHours: 168,
    manualProofRequired: true,
    nextAction:
      'Complete the same-thread proof when BlueBubbles proof is stale.',
  },
  {
    policyId: 'world:freshness:calendar',
    domain: 'google_calendar',
    freshForHours: 2,
    staleAfterHours: 12,
    expiresAfterHours: 48,
    manualProofRequired: false,
    nextAction:
      'Use a fresh read window before high-certainty calendar answers.',
  },
  {
    policyId: 'world:freshness:skills',
    domain: 'skills',
    freshForHours: 168,
    staleAfterHours: 720,
    expiresAfterHours: 2160,
    manualProofRequired: false,
    nextAction: 'Keep promoted skills tied to recent successful trajectories.',
  },
];

function freshnessFromAge(
  iso: string | null | undefined,
  now: string,
): WorldModelFreshness {
  if (!iso) return 'unknown';
  const thenMs = Date.parse(iso);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(thenMs) || !Number.isFinite(nowMs)) return 'unknown';
  const hours = Math.max(0, (nowMs - thenMs) / (60 * 60 * 1000));
  if (hours <= 24) return 'fresh';
  if (hours <= 168) return 'recent';
  if (hours <= 720) return 'stale';
  return 'expired';
}

function domainForIntegration(id: string): WorldModelDomain {
  const normalized = id.toLowerCase();
  if (
    normalized.includes('openai') ||
    normalized.includes('minimax') ||
    normalized.includes('gemini') ||
    normalized.includes('anthropic') ||
    normalized.includes('claude') ||
    normalized.includes('brave')
  ) {
    return 'providers';
  }
  if (normalized.includes('calendar')) return 'google_calendar';
  if (normalized.includes('telegram')) return 'telegram';
  if (normalized.includes('bluebubbles')) return 'bluebubbles';
  if (normalized.includes('alexa')) return 'alexa';
  if (normalized.includes('research')) return 'research';
  if (normalized.includes('image')) return 'image_generation';
  return 'agent_os';
}

function evidenceRef(input: {
  snapshotId: string;
  now: string;
  domain: WorldModelDomain;
  sourceKind: WorldModelEvidenceRef['sourceKind'];
  sourceId: string;
  freshness: WorldModelFreshness;
  trust: WorldModelEvidenceRef['trust'];
  summary: string;
}): WorldModelEvidenceRef {
  return {
    evidenceRefId: hashId(
      'world:evidence',
      `${input.snapshotId}|${input.domain}|${input.sourceKind}|${input.sourceId}`,
    ),
    snapshotId: input.snapshotId,
    createdAt: input.now,
    domain: input.domain,
    sourceKind: input.sourceKind,
    sourceId: redactCouncilText(input.sourceId, 320),
    freshness: input.freshness,
    trust: input.trust,
    summary: redactCouncilText(input.summary, 640),
    privacyJson: privacyJson(),
  };
}

function verificationNeed(input: {
  snapshotId: string;
  now: string;
  domain: WorldModelDomain;
  status: WorldModelVerificationNeed['status'];
  actionKind: WorldModelVerificationNeed['actionKind'];
  safeToRunAutomatically: boolean;
  command: string;
  blockerClass: string;
  evidenceRefIds: string[];
  summary: string;
  nextAction: string;
}): WorldModelVerificationNeed {
  return {
    needId: hashId(
      'world:need',
      [
        input.snapshotId,
        input.domain,
        input.blockerClass,
        input.command,
        input.summary,
        input.nextAction,
      ].join('|'),
    ),
    snapshotId: input.snapshotId,
    createdAt: input.now,
    updatedAt: input.now,
    domain: input.domain,
    status: input.status,
    actionKind: input.actionKind,
    safeToRunAutomatically: input.safeToRunAutomatically,
    command: redactCouncilText(input.command, 640),
    blockerClass: redactCouncilText(input.blockerClass, 160),
    evidenceRefIdsJson: safeJson(input.evidenceRefIds, 2400),
    summary: redactCouncilText(input.summary, 900),
    nextAction: redactCouncilText(input.nextAction, 900),
    privacyJson: privacyJson(),
  };
}

function claim(input: {
  snapshotId: string;
  now: string;
  domain: WorldModelDomain;
  subject: string;
  claimKind: WorldModelClaim['claimKind'];
  status: WorldModelClaim['status'];
  confidence: number;
  evidenceRefIds: string[];
  verificationNeedIds?: string[];
  summary: string;
  nextAction: string;
}): WorldModelClaim {
  return {
    claimId: hashId(
      'world:claim',
      `${input.snapshotId}|${input.domain}|${input.claimKind}|${input.subject}`,
    ),
    snapshotId: input.snapshotId,
    createdAt: input.now,
    updatedAt: input.now,
    domain: input.domain,
    subject: redactCouncilText(input.subject, 320),
    claimKind: input.claimKind,
    status: input.status,
    confidence: Number(clamp01(input.confidence).toFixed(3)),
    evidenceRefIdsJson: safeJson(input.evidenceRefIds, 3200),
    verificationNeedIdsJson: safeJson(input.verificationNeedIds || [], 2400),
    summary: redactCouncilText(input.summary, 900),
    nextAction: redactCouncilText(input.nextAction, 900),
    privacyJson: privacyJson(),
  };
}

function riskState(input: {
  snapshotId: string;
  now: string;
  domain: WorldModelDomain;
  severity: WorldModelRiskState['severity'];
  riskClass: WorldModelRiskState['riskClass'];
  summary: string;
  nextAction: string;
}): WorldModelRiskState {
  return {
    riskId: hashId(
      'world:risk',
      `${input.snapshotId}|${input.domain}|${input.riskClass}|${input.summary}`,
    ),
    snapshotId: input.snapshotId,
    createdAt: input.now,
    domain: input.domain,
    severity: input.severity,
    status: 'open',
    riskClass: input.riskClass,
    summary: redactCouncilText(input.summary, 900),
    nextAction: redactCouncilText(input.nextAction, 900),
    privacyJson: privacyJson(),
  };
}

function openQuestion(input: {
  snapshotId: string;
  now: string;
  domain: WorldModelDomain;
  question: string;
  requiredEvidence: string[];
  nextAction: string;
}): WorldModelOpenQuestion {
  return {
    questionId: hashId(
      'world:question',
      `${input.snapshotId}|${input.domain}|${input.question}`,
    ),
    snapshotId: input.snapshotId,
    createdAt: input.now,
    domain: input.domain,
    status: 'open',
    question: redactCouncilText(input.question, 900),
    requiredEvidenceJson: safeJson(input.requiredEvidence, 2400),
    nextAction: redactCouncilText(input.nextAction, 900),
    privacyJson: privacyJson(),
  };
}

function providerEvidence(
  snapshotId: string,
  now: string,
  providers: ProviderHealthSnapshot[],
): {
  evidenceRefs: WorldModelEvidenceRef[];
  claims: WorldModelClaim[];
  needs: WorldModelVerificationNeed[];
  risks: WorldModelRiskState[];
} {
  const evidenceRefs = providers.map((provider) =>
    evidenceRef({
      snapshotId,
      now,
      domain: 'providers',
      sourceKind: 'provider_health',
      sourceId: provider.providerId,
      freshness: freshnessFromAge(provider.lastCheckedAt, now),
      trust:
        provider.state === 'healthy'
          ? 'high'
          : provider.state === 'externally_blocked'
            ? 'blocked'
            : 'medium',
      summary:
        provider.state === 'healthy'
          ? `${provider.providerId} is healthy for ${provider.kind}.`
          : `${provider.providerId} is ${provider.state}; ${provider.blocker || provider.nextAction || 'diagnostics required'}.`,
    }),
  );
  const blocked = providers.filter(
    (provider) =>
      provider.state === 'externally_blocked' ||
      provider.state === 'not_configured' ||
      provider.state === 'degraded',
  );
  const needs = blocked.map((provider) =>
    verificationNeed({
      snapshotId,
      now,
      domain: 'providers',
      status:
        provider.failureClass === 'quota_or_rate_limit' ||
        provider.failureClass === 'manual_external'
          ? 'manual_proof'
          : 'runnable_read_only',
      actionKind:
        provider.failureClass === 'quota_or_rate_limit' ||
        provider.failureClass === 'manual_external'
          ? 'manual_proof'
          : 'read_only_check',
      safeToRunAutomatically:
        provider.failureClass !== 'quota_or_rate_limit' &&
        provider.failureClass !== 'manual_external',
      command: 'npm run debug:providers',
      blockerClass: provider.failureClass,
      evidenceRefIds: evidenceRefs
        .filter((ref) => ref.sourceId === provider.providerId)
        .map((ref) => ref.evidenceRefId),
      summary: `${provider.providerId} needs fresh provider verification or external recovery.`,
      nextAction:
        provider.nextAction ||
        'Run provider diagnostics and keep degraded participation visible.',
    }),
  );
  const claims = [
    claim({
      snapshotId,
      now,
      domain: 'providers',
      subject: 'provider health',
      claimKind: 'provider_state',
      status: blocked.length ? 'proof_debt' : 'current',
      confidence: blocked.length ? 0.58 : 0.9,
      evidenceRefIds: evidenceRefs.map((ref) => ref.evidenceRefId),
      verificationNeedIds: needs.map((need) => need.needId),
      summary: blocked.length
        ? `${blocked.length} provider(s) are degraded or externally blocked; model participation must be reported honestly.`
        : 'Configured provider health is current enough for routing.',
      nextAction: blocked.length
        ? 'Skip known-blocked optional providers and rerun provider diagnostics before claiming full council participation.'
        : 'Use healthy providers and keep provider evidence IDs attached to answers.',
    }),
  ];
  const risks = blocked.map((provider) =>
    riskState({
      snapshotId,
      now,
      domain: 'providers',
      severity: provider.state === 'externally_blocked' ? 'medium' : 'low',
      riskClass: 'provider_blocked',
      summary: `${provider.providerId} is ${provider.state}.`,
      nextAction: provider.nextAction || 'Keep degraded participation visible.',
    }),
  );
  return { evidenceRefs, claims, needs, risks };
}

function integrationNeedStatus(
  status: IntegrationStatus,
): Pick<
  WorldModelVerificationNeed,
  'status' | 'actionKind' | 'safeToRunAutomatically'
> {
  if (status.state === 'healthy') {
    return {
      status: 'resolved',
      actionKind: 'read_only_check',
      safeToRunAutomatically: true,
    };
  }
  if (
    status.repairability === 'proof_drill' ||
    status.state === 'needs_proof'
  ) {
    return {
      status: 'manual_proof',
      actionKind: 'manual_proof',
      safeToRunAutomatically: false,
    };
  }
  if (
    status.repairability === 'status_only' ||
    status.repairability === 'guided_manual' ||
    status.repairability === 'repo_fix_available'
  ) {
    return {
      status: 'runnable_read_only',
      actionKind: 'read_only_check',
      safeToRunAutomatically: true,
    };
  }
  return {
    status: 'manual_proof',
    actionKind: 'manual_proof',
    safeToRunAutomatically: false,
  };
}

function integrationCommand(status: IntegrationStatus): string {
  if (status.integrationId === 'bluebubbles') {
    return 'npm run debug:bluebubbles -- --live';
  }
  if (status.integrationId === 'google_calendar') {
    return 'npm run debug:google-calendar';
  }
  if (status.integrationId === 'research') {
    return 'npm run debug:research-mode -- --live';
  }
  if (status.integrationId === 'telegram') {
    return 'npm run telegram:user:smoke';
  }
  if (status.integrationId === 'alexa') {
    return 'npm run debug:alexa-conversation -- --review';
  }
  return 'npm run integrations:status -- --json';
}

function integrationEvidence(
  snapshotId: string,
  now: string,
  report: IntegrationDoctorReport,
): {
  evidenceRefs: WorldModelEvidenceRef[];
  claims: WorldModelClaim[];
  needs: WorldModelVerificationNeed[];
  questions: WorldModelOpenQuestion[];
  risks: WorldModelRiskState[];
} {
  const evidenceRefs = report.statuses.map((status) =>
    evidenceRef({
      snapshotId,
      now,
      domain: domainForIntegration(status.integrationId),
      sourceKind: 'integration_status',
      sourceId: status.integrationId,
      freshness: freshnessFromAge(
        status.lastHealthyAt || report.generatedAt,
        now,
      ),
      trust:
        status.state === 'healthy'
          ? 'high'
          : status.state === 'externally_blocked'
            ? 'blocked'
            : 'medium',
      summary: `${status.label}: ${status.state}; proof=${status.proofState}; next=${status.nextAction}`,
    }),
  );
  const unresolved = report.statuses.filter(
    (status) => status.state !== 'healthy',
  );
  const needs = unresolved.map((status) => {
    const policy = integrationNeedStatus(status);
    const domain = domainForIntegration(status.integrationId);
    return verificationNeed({
      snapshotId,
      now,
      domain,
      status: policy.status,
      actionKind: policy.actionKind,
      safeToRunAutomatically: policy.safeToRunAutomatically,
      command: integrationCommand(status),
      blockerClass: status.state,
      evidenceRefIds: evidenceRefs
        .filter((ref) => ref.sourceId === status.integrationId)
        .map((ref) => ref.evidenceRefId),
      summary: `${status.label} is ${status.state}; ${status.detail || status.lastFailure || 'fresh proof is not complete'}.`,
      nextAction: status.nextAction,
    });
  });
  const claims = report.statuses.map((status) => {
    const domain = domainForIntegration(status.integrationId);
    const matchedNeeds = needs.filter((need) => need.domain === domain);
    return claim({
      snapshotId,
      now,
      domain,
      subject: status.label,
      claimKind: 'integration_state',
      status: status.state === 'healthy' ? 'current' : 'proof_debt',
      confidence: status.state === 'healthy' ? 0.88 : 0.52,
      evidenceRefIds: evidenceRefs
        .filter((ref) => ref.sourceId === status.integrationId)
        .map((ref) => ref.evidenceRefId),
      verificationNeedIds: matchedNeeds.map((need) => need.needId),
      summary:
        status.state === 'healthy'
          ? `${status.label} is healthy/live enough for current routing.`
          : `${status.label} needs verification before Andrea should claim live proof.`,
      nextAction: status.nextAction,
    });
  });
  const questions = unresolved
    .filter((status) => status.state === 'needs_proof')
    .map((status) =>
      openQuestion({
        snapshotId,
        now,
        domain: domainForIntegration(status.integrationId),
        question: `What fresh proof should close ${status.label}?`,
        requiredEvidence: [status.integrationId, status.proofState],
        nextAction: status.nextAction,
      }),
    );
  const risks = unresolved.map((status) =>
    riskState({
      snapshotId,
      now,
      domain: domainForIntegration(status.integrationId),
      severity:
        status.state === 'externally_blocked' ||
        status.state === 'manual_action_required'
          ? 'medium'
          : 'low',
      riskClass: 'integration_proof_debt',
      summary: `${status.label} is ${status.state}; proof=${status.proofState}.`,
      nextAction: status.nextAction,
    }),
  );
  return { evidenceRefs, claims, needs, questions, risks };
}

function reportEvidence(input: {
  snapshotId: string;
  now: string;
  logicReport: LogicKernelReport;
  truthReport: TruthEngineReport;
  agentOSReport: AgentOSReport;
  cognitiveReport: CognitiveDoctorReport;
}): {
  evidenceRefs: WorldModelEvidenceRef[];
  claims: WorldModelClaim[];
  needs: WorldModelVerificationNeed[];
  questions: WorldModelOpenQuestion[];
  risks: WorldModelRiskState[];
} {
  const refs: WorldModelEvidenceRef[] = [];
  const addRef = (ref: WorldModelEvidenceRef) => refs.push(ref);
  if (input.logicReport.beliefState) {
    addRef(
      evidenceRef({
        snapshotId: input.snapshotId,
        now: input.now,
        domain: 'logic',
        sourceKind: 'logic_claim',
        sourceId: input.logicReport.beliefState.beliefStateId,
        freshness: freshnessFromAge(
          input.logicReport.beliefState.updatedAt,
          input.now,
        ),
        trust: input.logicReport.ok ? 'high' : 'medium',
        summary: input.logicReport.summary,
      }),
    );
  }
  if (input.truthReport.latestAudit) {
    addRef(
      evidenceRef({
        snapshotId: input.snapshotId,
        now: input.now,
        domain: 'truth',
        sourceKind: 'truth_audit',
        sourceId: input.truthReport.latestAudit.auditId,
        freshness: freshnessFromAge(
          input.truthReport.latestAudit.updatedAt,
          input.now,
        ),
        trust: input.truthReport.ok ? 'high' : 'medium',
        summary: input.truthReport.latestAudit.verdictSummary,
      }),
    );
  }
  if (input.agentOSReport.latestEpisode) {
    addRef(
      evidenceRef({
        snapshotId: input.snapshotId,
        now: input.now,
        domain: 'agent_os',
        sourceKind: 'agent_os_episode',
        sourceId: input.agentOSReport.latestEpisode.episodeId,
        freshness: freshnessFromAge(
          input.agentOSReport.latestEpisode.updatedAt,
          input.now,
        ),
        trust: input.agentOSReport.ok ? 'high' : 'medium',
        summary: input.agentOSReport.summary,
      }),
    );
  }
  if (input.cognitiveReport.activeRun) {
    addRef(
      evidenceRef({
        snapshotId: input.snapshotId,
        now: input.now,
        domain: 'cognition',
        sourceKind: 'cognitive_trace',
        sourceId: input.cognitiveReport.activeRun.runId,
        freshness: freshnessFromAge(
          input.cognitiveReport.activeRun.updatedAt,
          input.now,
        ),
        trust: input.cognitiveReport.ok ? 'high' : 'medium',
        summary: input.cognitiveReport.summary,
      }),
    );
  }
  const logicRefIds = refs
    .filter((ref) => ref.domain === 'logic')
    .map((ref) => ref.evidenceRefId);
  const truthRefIds = refs
    .filter((ref) => ref.domain === 'truth')
    .map((ref) => ref.evidenceRefId);
  const agentRefIds = refs
    .filter((ref) => ref.domain === 'agent_os')
    .map((ref) => ref.evidenceRefId);
  const cognitiveRefIds = refs
    .filter((ref) => ref.domain === 'cognition')
    .map((ref) => ref.evidenceRefId);
  const needs: WorldModelVerificationNeed[] = [];
  if (
    !input.truthReport.ok ||
    input.truthReport.latestAudit?.status === 'warn'
  ) {
    needs.push(
      verificationNeed({
        snapshotId: input.snapshotId,
        now: input.now,
        domain: 'truth',
        status: 'runnable_read_only',
        actionKind: 'read_only_check',
        safeToRunAutomatically: true,
        command: 'npm run debug:truth -- --json',
        blockerClass: 'truth_calibration_warn',
        evidenceRefIds: truthRefIds,
        summary:
          'Latest answer audit needs truth-calibration review before high-certainty claims.',
        nextAction: input.truthReport.nextAction,
      }),
    );
  }
  if (!input.logicReport.ok || input.logicReport.contradictions.length > 0) {
    needs.push(
      verificationNeed({
        snapshotId: input.snapshotId,
        now: input.now,
        domain: 'logic',
        status: 'runnable_read_only',
        actionKind: 'read_only_check',
        safeToRunAutomatically: true,
        command: 'npm run debug:logic -- --reconcile --json',
        blockerClass: 'logic_conflict_or_uncertainty',
        evidenceRefIds: logicRefIds,
        summary:
          'Logic metadata has uncertainty or contradictions that should be reconciled.',
        nextAction: input.logicReport.selectedNextAction,
      }),
    );
  }
  const claims = [
    claim({
      snapshotId: input.snapshotId,
      now: input.now,
      domain: 'logic',
      subject: input.logicReport.subject,
      claimKind: 'belief_state',
      status: input.logicReport.ok ? 'current' : 'conflicted',
      confidence: input.logicReport.confidence,
      evidenceRefIds: logicRefIds,
      verificationNeedIds: needs
        .filter((need) => need.domain === 'logic')
        .map((need) => need.needId),
      summary: input.logicReport.summary,
      nextAction: input.logicReport.selectedNextAction,
    }),
    claim({
      snapshotId: input.snapshotId,
      now: input.now,
      domain: 'truth',
      subject: input.truthReport.latestAudit?.subject || 'latest answer audit',
      claimKind: 'current_truth',
      status: input.truthReport.ok ? 'current' : 'stale',
      confidence: input.truthReport.latestAudit?.confidence ?? 0.5,
      evidenceRefIds: truthRefIds,
      verificationNeedIds: needs
        .filter((need) => need.domain === 'truth')
        .map((need) => need.needId),
      summary:
        input.truthReport.latestAudit?.verdictSummary ||
        'No truth audit exists yet; run an answer audit before making high-certainty claims.',
      nextAction: input.truthReport.nextAction,
    }),
    claim({
      snapshotId: input.snapshotId,
      now: input.now,
      domain: 'agent_os',
      subject: 'agent os episode state',
      claimKind: 'next_action',
      status: input.agentOSReport.ok ? 'current' : 'proof_debt',
      confidence: input.agentOSReport.ok ? 0.8 : 0.55,
      evidenceRefIds: agentRefIds,
      summary: input.agentOSReport.summary,
      nextAction: input.agentOSReport.nextAction,
    }),
    claim({
      snapshotId: input.snapshotId,
      now: input.now,
      domain: 'cognition',
      subject: 'cognitive kernel workbench',
      claimKind: 'next_action',
      status: input.cognitiveReport.ok ? 'current' : 'proof_debt',
      confidence: input.cognitiveReport.ok ? 0.8 : 0.55,
      evidenceRefIds: cognitiveRefIds,
      summary: input.cognitiveReport.summary,
      nextAction: input.cognitiveReport.summary,
    }),
  ];
  const questions = input.logicReport.missingPremises
    .slice(0, 5)
    .map((premise) =>
      openQuestion({
        snapshotId: input.snapshotId,
        now: input.now,
        domain: 'logic',
        question: premise.question,
        requiredEvidence: parseJsonArray(premise.requiredEvidenceJson),
        nextAction: premise.nextAction,
      }),
    );
  const risks: WorldModelRiskState[] = [
    ...input.logicReport.contradictions.slice(0, 5).map((contradiction) =>
      riskState({
        snapshotId: input.snapshotId,
        now: input.now,
        domain: 'logic',
        severity: contradiction.severity,
        riskClass: 'memory_conflict',
        summary: contradiction.summary,
        nextAction: contradiction.nextAction,
      }),
    ),
    ...input.truthReport.claims
      .filter((truthClaim) => truthClaim.supportGrade === 'unsupported')
      .slice(0, 5)
      .map((truthClaim) =>
        riskState({
          snapshotId: input.snapshotId,
          now: input.now,
          domain: 'truth',
          severity: 'medium',
          riskClass: 'unsupported_claim',
          summary: truthClaim.claimText,
          nextAction: input.truthReport.nextAction,
        }),
      ),
  ];
  return { evidenceRefs: refs, claims, needs, questions, risks };
}

function skillTrustEvidence(input: {
  snapshotId: string;
  now: string;
  agentOSReport: AgentOSReport;
}): WorldModelSkillTrustState[] {
  const proposals = input.agentOSReport.skillProposals.slice(0, 20);
  if (proposals.length === 0) {
    return [
      {
        skillTrustId: hashId('world:skill', `${input.snapshotId}|skills:none`),
        snapshotId: input.snapshotId,
        createdAt: input.now,
        skillId: 'world.skill_registry.empty',
        taskFamily: 'unknown',
        status: 'needs_proof',
        confidence: 0.35,
        outcomeScore: 0,
        sourceIdsJson: safeJson([]),
        summary: 'No Agent OS skill proposals are available to trust yet.',
        nextAction:
          'Run task drills or real successful episodes before promoting skills.',
        privacyJson: privacyJson(),
      },
    ];
  }
  return proposals.map((proposal) => {
    const status: WorldModelSkillTrustState['status'] =
      proposal.status === 'accepted' && proposal.outcomeScore >= 0.85
        ? 'trusted'
        : proposal.status === 'quarantined'
          ? 'quarantined'
          : proposal.outcomeScore >= 0.7
            ? 'probation'
            : 'needs_proof';
    return {
      skillTrustId: hashId(
        'world:skill',
        `${input.snapshotId}|${proposal.proposalId}`,
      ),
      snapshotId: input.snapshotId,
      createdAt: input.now,
      skillId: proposal.proposalId,
      taskFamily: proposal.taskFamily,
      status,
      confidence: clamp01(proposal.outcomeScore),
      outcomeScore: proposal.outcomeScore,
      sourceIdsJson: proposal.sourceEpisodeIdsJson,
      summary: proposal.skillSummary,
      nextAction:
        status === 'trusted'
          ? 'Use this skill for similar tasks while continuing outcome monitoring.'
          : status === 'quarantined'
            ? 'Do not use this skill until failures are repaired.'
            : 'Collect one more verified outcome before promoting this skill.',
      privacyJson: privacyJson(),
    };
  });
}

function reportStatus(input: {
  claims: WorldModelClaim[];
  needs: WorldModelVerificationNeed[];
  risks: WorldModelRiskState[];
  logicReport: LogicKernelReport;
}): {
  status: WorldModelSnapshot['status'];
  confidence: number;
  summary: string;
  nextAction: string;
} {
  const manual = input.needs.filter((need) => need.status === 'manual_proof');
  const runnable = input.needs.filter(
    (need) => need.status === 'runnable_read_only',
  );
  const severeRisk = input.risks.some(
    (risk) => risk.severity === 'high' || risk.severity === 'critical',
  );
  const conflicted = input.claims.some(
    (claimItem) => claimItem.status === 'conflicted',
  );
  const status: WorldModelSnapshot['status'] =
    conflicted || severeRisk
      ? 'conflicted'
      : manual.length || runnable.length
        ? 'needs_verification'
        : input.risks.length
          ? 'degraded'
          : 'stable';
  const confidence = clamp01(
    input.logicReport.confidence -
      manual.length * 0.045 -
      runnable.length * 0.025 -
      input.risks.length * 0.015,
  );
  const nextAction =
    manual[0]?.nextAction ||
    runnable[0]?.nextAction ||
    input.logicReport.selectedNextAction ||
    'Use the current world snapshot, cite evidence IDs, and keep verifying stale proof paths.';
  const summary =
    status === 'stable'
      ? 'World Model is stable: current evidence is sufficient for ordinary answers.'
      : status === 'conflicted'
        ? 'World Model has live conflicts or high-risk proof gaps that must be named before confident answers.'
        : `World Model has ${manual.length + runnable.length} verification need(s) and ${input.risks.length} risk signal(s).`;
  return {
    status,
    confidence: Number(confidence.toFixed(3)),
    summary,
    nextAction,
  };
}

function persistReport(report: WorldModelDoctorReport): void {
  upsertWorldModelSnapshot(report.snapshot);
  for (const evidence of report.evidenceRefs)
    upsertWorldModelEvidenceRef(evidence);
  for (const claimItem of report.claims) upsertWorldModelClaim(claimItem);
  for (const need of report.verificationNeeds)
    upsertWorldModelVerificationNeed(need);
  for (const question of report.openQuestions)
    upsertWorldModelOpenQuestion(question);
  for (const risk of report.riskStates) upsertWorldModelRiskState(risk);
  for (const skill of report.skillTrust) upsertWorldModelSkillTrust(skill);
}

export function buildWorldModelReport(
  input: BuildWorldModelInput = {},
): WorldModelDoctorReport {
  const generatedAt = input.generatedAt || nowIso();
  const subject = input.subject || null;
  const providers =
    input.providers || collectProviderHealthSnapshots(generatedAt);
  const integrationReport =
    input.integrationReport ||
    buildIntegrationDoctorReport({
      now: new Date(generatedAt),
      providers,
    });
  const agentOSReport =
    input.agentOSReport || buildAgentOSReport({ generatedAt });
  const logicReport =
    input.logicReport ||
    buildLogicKernelReport({
      subject,
      episodeId: agentOSReport.latestEpisode?.episodeId,
      generatedAt,
    });
  const truthReport =
    input.truthReport || buildTruthEngineReport({ subject, generatedAt });
  const cognitiveReport =
    input.cognitiveReport || buildCognitiveDoctorReport(generatedAt, providers);
  const seed = [
    generatedAt,
    subject || 'default',
    logicReport.beliefState?.beliefStateId || '',
    truthReport.latestAudit?.auditId || '',
    agentOSReport.latestEpisode?.episodeId || '',
    cognitiveReport.activeRun?.runId || '',
    providers
      .map((provider) => `${provider.providerId}:${provider.state}`)
      .join('|'),
    integrationReport.statuses
      .map((status) => `${status.integrationId}:${status.state}`)
      .join('|'),
  ].join('|');
  const snapshotId = hashId('world:snapshot', seed);

  const providerLayer = providerEvidence(snapshotId, generatedAt, providers);
  const integrationLayer = integrationEvidence(
    snapshotId,
    generatedAt,
    integrationReport,
  );
  const reportLayer = reportEvidence({
    snapshotId,
    now: generatedAt,
    logicReport,
    truthReport,
    agentOSReport,
    cognitiveReport,
  });
  const skillTrust = skillTrustEvidence({
    snapshotId,
    now: generatedAt,
    agentOSReport,
  });
  const evidenceRefs = [
    ...providerLayer.evidenceRefs,
    ...integrationLayer.evidenceRefs,
    ...reportLayer.evidenceRefs,
  ];
  const verificationNeeds = [
    ...providerLayer.needs,
    ...integrationLayer.needs.filter((need) => need.status !== 'resolved'),
    ...reportLayer.needs,
  ];
  const claims = [
    ...providerLayer.claims,
    ...integrationLayer.claims,
    ...reportLayer.claims,
    claim({
      snapshotId,
      now: generatedAt,
      domain: 'skills',
      subject: 'skill trust lifecycle',
      claimKind: 'skill_state',
      status: skillTrust.some((skill) => skill.status === 'trusted')
        ? 'current'
        : 'proof_debt',
      confidence: skillTrust.some((skill) => skill.status === 'trusted')
        ? 0.78
        : 0.44,
      evidenceRefIds: [],
      summary: skillTrust.some((skill) => skill.status === 'trusted')
        ? 'At least one skill has verified trust metadata.'
        : 'Skills need more verified outcomes before automatic promotion.',
      nextAction: 'Use skill trust states when choosing future task routes.',
    }),
  ];
  const openQuestions = [
    ...integrationLayer.questions,
    ...reportLayer.questions,
  ];
  const riskStates = [
    ...providerLayer.risks,
    ...integrationLayer.risks,
    ...reportLayer.risks,
  ];
  const status = reportStatus({
    claims,
    needs: verificationNeeds,
    risks: riskStates,
    logicReport,
  });
  const snapshot: WorldModelSnapshot = {
    snapshotId,
    createdAt: generatedAt,
    updatedAt: generatedAt,
    status: status.status,
    confidence: status.confidence,
    logicBeliefStateId: logicReport.beliefState?.beliefStateId || null,
    truthAuditId: truthReport.latestAudit?.auditId || null,
    agentOSEpisodeId: agentOSReport.latestEpisode?.episodeId || null,
    cognitiveRunId: cognitiveReport.activeRun?.runId || null,
    freshnessPolicyJson: safeJson(DEFAULT_FRESHNESS_POLICIES, 4800),
    claimIdsJson: safeJson(
      claims.map((item) => item.claimId),
      3200,
    ),
    evidenceRefIdsJson: safeJson(
      evidenceRefs.map((item) => item.evidenceRefId),
      3200,
    ),
    verificationNeedIdsJson: safeJson(
      verificationNeeds.map((item) => item.needId),
      3200,
    ),
    openQuestionIdsJson: safeJson(
      openQuestions.map((item) => item.questionId),
      2400,
    ),
    riskStateIdsJson: safeJson(
      riskStates.map((item) => item.riskId),
      2400,
    ),
    skillTrustIdsJson: safeJson(
      skillTrust.map((item) => item.skillTrustId),
      2400,
    ),
    summary: status.summary,
    bestNextAction: status.nextAction,
    privacyJson: privacyJson(),
  };
  const freshness: Record<WorldModelFreshness, number> = {
    fresh: 0,
    recent: 0,
    stale: 0,
    expired: 0,
    unknown: 0,
  };
  for (const evidence of evidenceRefs) freshness[evidence.freshness] += 1;
  const learnedFacts: WorldFactRecord[] = listWorldFacts({
    statuses: ['confirmed', 'suggested', 'pending_confirmation', 'stale'],
    limit: 80,
  });
  const report: WorldModelDoctorReport = {
    generatedAt,
    ok: status.status === 'stable' || status.status === 'degraded',
    snapshot,
    claims,
    learnedFacts,
    evidenceRefs,
    verificationNeeds,
    openQuestions,
    riskStates,
    skillTrust,
    freshness,
    proofDebt: {
      total: verificationNeeds.length,
      runnableReadOnly: verificationNeeds.filter(
        (need) => need.status === 'runnable_read_only',
      ).length,
      manualProof: verificationNeeds.filter(
        (need) => need.status === 'manual_proof',
      ).length,
      approvalRequired: verificationNeeds.filter(
        (need) => need.status === 'approval_required',
      ).length,
    },
    safeVerificationRan: input.verifySafe === true,
    nextAction: status.nextAction,
    privacy: privacyReport(),
  };
  if (input.persist !== false) persistReport(report);
  return report;
}

export function buildWorldModelStoredReport(
  input: { generatedAt?: string; snapshotId?: string | null } = {},
): WorldModelDoctorReport {
  const generatedAt = input.generatedAt || nowIso();
  const snapshot =
    (input.snapshotId
      ? listWorldModelSnapshots({ limit: 100 }).find(
          (item) => item.snapshotId === input.snapshotId,
        )
      : null) || listWorldModelSnapshots({ limit: 1 })[0];
  if (!snapshot) {
    return buildWorldModelReport({ generatedAt });
  }
  const evidenceRefs = listWorldModelEvidenceRefs({
    snapshotId: snapshot.snapshotId,
    limit: 500,
  });
  const claims = listWorldModelClaims({
    snapshotId: snapshot.snapshotId,
    limit: 500,
  });
  const verificationNeeds = listWorldModelVerificationNeeds({
    snapshotId: snapshot.snapshotId,
    limit: 500,
  });
  const openQuestions = listWorldModelOpenQuestions({
    snapshotId: snapshot.snapshotId,
    limit: 200,
  });
  const riskStates = listWorldModelRiskStates({
    snapshotId: snapshot.snapshotId,
    limit: 200,
  });
  const skillTrust = listWorldModelSkillTrust({
    snapshotId: snapshot.snapshotId,
    limit: 200,
  });
  const learnedFacts = listWorldFacts({
    statuses: ['confirmed', 'suggested', 'pending_confirmation', 'stale'],
    limit: 80,
  });
  const freshness: Record<WorldModelFreshness, number> = {
    fresh: 0,
    recent: 0,
    stale: 0,
    expired: 0,
    unknown: 0,
  };
  for (const evidence of evidenceRefs) freshness[evidence.freshness] += 1;
  return {
    generatedAt,
    ok: snapshot.status === 'stable' || snapshot.status === 'degraded',
    snapshot,
    claims,
    learnedFacts,
    evidenceRefs,
    verificationNeeds,
    openQuestions,
    riskStates,
    skillTrust,
    freshness,
    proofDebt: {
      total: verificationNeeds.length,
      runnableReadOnly: verificationNeeds.filter(
        (need) => need.status === 'runnable_read_only',
      ).length,
      manualProof: verificationNeeds.filter(
        (need) => need.status === 'manual_proof',
      ).length,
      approvalRequired: verificationNeeds.filter(
        (need) => need.status === 'approval_required',
      ).length,
    },
    safeVerificationRan: false,
    nextAction: snapshot.bestNextAction,
    privacy: privacyReport(),
  };
}

export function formatWorldModelReport(report: WorldModelDoctorReport): string {
  const topNeeds = report.verificationNeeds.slice(0, 6);
  const topClaims = report.claims.slice(0, 6);
  const topFacts = report.learnedFacts.slice(0, 6);
  const factCounts = report.learnedFacts.reduce(
    (counts, fact) => {
      counts[fact.status] += 1;
      return counts;
    },
    {
      suggested: 0,
      pending_confirmation: 0,
      confirmed: 0,
      stale: 0,
      rejected: 0,
      forgotten: 0,
    } satisfies Record<WorldFactRecord['status'], number>,
  );
  const skillCounts = report.skillTrust.reduce(
    (counts, skill) => {
      counts[skill.status] += 1;
      return counts;
    },
    {
      trusted: 0,
      probation: 0,
      quarantined: 0,
      needs_proof: 0,
    } satisfies Record<WorldModelSkillTrustState['status'], number>,
  );
  return redactCouncilText(
    [
      'World Model',
      '',
      `Status: ${report.snapshot.status}`,
      `Confidence: ${report.snapshot.confidence.toFixed(2)}`,
      `Evidence refs: ${report.evidenceRefs.length} (fresh=${report.freshness.fresh}, recent=${report.freshness.recent}, stale=${report.freshness.stale}, expired=${report.freshness.expired}, unknown=${report.freshness.unknown})`,
      `Proof debt: total=${report.proofDebt.total}, read-only=${report.proofDebt.runnableReadOnly}, manual=${report.proofDebt.manualProof}, approval=${report.proofDebt.approvalRequired}`,
      `Skill trust: trusted=${skillCounts.trusted}, probation=${skillCounts.probation}, quarantined=${skillCounts.quarantined}, needs_proof=${skillCounts.needs_proof}`,
      `Learned facts: confirmed=${factCounts.confirmed}, pending=${factCounts.pending_confirmation}, suggested=${factCounts.suggested}, stale=${factCounts.stale}`,
      `Safe verification ran: ${report.safeVerificationRan ? 'yes' : 'no'}`,
      `Next: ${report.nextAction}`,
      '',
      'Current Claims',
      ...topClaims.map(
        (item) =>
          `- ${item.domain}: ${item.status} (${item.confidence.toFixed(2)}) ${item.summary}`,
      ),
      '',
      'Learned Facts',
      ...(topFacts.length
        ? topFacts.map(
            (fact) =>
              `- ${fact.factType}: ${fact.status} (${fact.confidence.toFixed(2)}) ${fact.summary}`,
          )
        : ['- none yet']),
      '',
      'Verification Needs',
      ...(topNeeds.length
        ? topNeeds.map(
            (need) =>
              `- ${need.domain}: ${need.status}; ${need.nextAction} (${need.command})`,
          )
        : ['- none']),
      '',
      'Privacy: metadata-only; no raw prompts, private message bodies, hidden reasoning, raw tool output, or secrets are stored.',
    ].join('\n'),
    7000,
  );
}

export function buildWorldModelStatusText(): string {
  return formatWorldModelReport(buildWorldModelReport());
}

export function isWorldModelNaturalRequest(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return (
    normalized === 'what changed?' ||
    normalized === 'what changed' ||
    normalized === 'what is stale?' ||
    normalized === 'what is stale' ||
    normalized === "what's stale?" ||
    normalized === "what's stale" ||
    normalized === 'what do you know for sure?' ||
    normalized === 'what do you know for sure' ||
    normalized === 'what should you verify next?' ||
    normalized === 'what should you verify next' ||
    normalized === 'what is most useful now?' ||
    normalized === 'what is most useful now'
  );
}
