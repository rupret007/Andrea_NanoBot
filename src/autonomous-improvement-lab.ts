import { createHash } from 'node:crypto';

import { redactCouncilText } from './council-safety.js';
import {
  isDatabaseInitialized,
  listCandidatePatchPlans,
  listCognitiveReflectionSignals,
  listHarnessImprovementProposals,
  listImprovementExperiments,
  listImprovementHypotheses,
  listImprovementOutcomes,
  listLearningDistillations,
  listRecentResponseFeedback,
  listRepairAttempts,
  listSkillPlaybookRuns,
  listToolReliabilityRollups,
  persistImprovementLabBatch,
} from './db.js';
import {
  buildFieldTrialOperatorTruth,
  type FieldTrialSurfaceTruth,
} from './field-trial-readiness.js';
import {
  buildIntegrationDoctorReport,
  type IntegrationDoctorReport,
} from './integration-doctor.js';
import {
  collectProviderHealthSnapshots,
  type ProviderHealthSnapshot,
} from './provider-health.js';
import type {
  CandidatePatchPlan,
  CognitiveReflectionSignal,
  HarnessImprovementProposal,
  ImprovementExperiment,
  ImprovementFixClass,
  ImprovementHypothesis,
  ImprovementOutcome,
  ImprovementRiskLevel,
  ImprovementSourceSignalKind,
  LearningDistillationRecord,
  RepairAttemptRecord,
  ResponseFeedbackRecord,
  SkillPlaybookRunRecord,
  ToolReliabilityRollup,
} from './types.js';

export interface AutonomousImprovementLabReport {
  generatedAt: string;
  hypotheses: ImprovementHypothesis[];
  experiments: ImprovementExperiment[];
  patchPlans: CandidatePatchPlan[];
  outcomes: ImprovementOutcome[];
  topCandidates: ImprovementHypothesis[];
  selectedForExperiment: ImprovementHypothesis[];
  externalBlockers: ImprovementHypothesis[];
  patchPlanPolicy: {
    plansOnly: true;
    autoAppliesProductPatches: false;
    createsBranchesOrWorktrees: false;
    pushesWithoutValidation: false;
  };
  persistence: {
    requested: boolean;
    status: 'persisted' | 'disabled' | 'deferred_database_busy' | 'unavailable';
    atomic: true;
    retrySafe: true;
    detail: string;
  };
  signalSummary: {
    pilotProofGaps: number;
    repairAttempts: number;
    reliabilityRollups: number;
    executiveReflections: number;
    learningDistillations: number;
    skillRuns: number;
    harnessProposals: number;
    responseFeedback: number;
  };
  nextAction: string;
  privacy: {
    metadataOnly: true;
    rawPromptsStored: false;
    rawPrivateBodiesStored: false;
    hiddenReasoningStored: false;
    secretsRedacted: true;
    providerDebatesStored: false;
    rawToolOutputStored: false;
  };
}

const PRIVACY = {
  metadataOnly: true,
  rawPromptsStored: false,
  rawPrivateBodiesStored: false,
  hiddenReasoningStored: false,
  secretsRedacted: true,
  providerDebatesStored: false,
  rawToolOutputStored: false,
} as const;

const SECRET_RE =
  /\bsk-(?:proj-|api-|ant-api03-)?[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{20,}|BSA-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9_]{16,}|crsr_[A-Za-z0-9_]{16,}|\b\d{7,}:[A-Za-z0-9_-]{20,}|password[:=]|secret[:=]|raw private body|hidden reasoning|chain[- ]of[- ]thought|provider debate|raw tool output/i;

function nowIso(now?: Date): string {
  return (now || new Date()).toISOString();
}

function hashId(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function safeText(value: string | null | undefined, limit = 900): string {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (SECRET_RE.test(text)) return '[redacted improvement metadata]';
  return redactCouncilText(text, limit);
}

function safeJson(value: unknown, limit = 3200): string {
  try {
    const json = JSON.stringify(value ?? null);
    return safeText(
      json.length <= limit
        ? json
        : JSON.stringify({
            truncated: true,
            preview: json.slice(0, Math.max(32, limit - 120)),
          }),
      limit,
    );
  } catch {
    return 'null';
  }
}

function clamp(value: number, min = 0, max = 1): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function evidenceJson(ids: string[]): string {
  return JSON.stringify(
    Array.from(
      new Set(
        ids
          .map((id) =>
            String(id || '')
              .replace(/[^A-Za-z0-9:_-]+/g, '_')
              .slice(0, 220),
          )
          .filter(Boolean),
      ),
    ).slice(0, 60),
  );
}

function privacyJson(): string {
  return safeJson(PRIVACY, 1200);
}

function riskWeight(risk: ImprovementRiskLevel): number {
  switch (risk) {
    case 'low':
      return 0.96;
    case 'medium':
      return 0.72;
    case 'high':
      return 0.38;
    case 'critical':
      return 0.12;
  }
}

function fixClassAllowsPatchPlan(fixClass: ImprovementFixClass): boolean {
  return (
    fixClass === 'diagnostic_observation' ||
    fixClass === 'repair_playbook' ||
    fixClass === 'route_calibration' ||
    fixClass === 'skill_adjustment' ||
    fixClass === 'eval_gap' ||
    fixClass === 'debug_wording' ||
    fixClass === 'docs_or_test'
  );
}

function hypothesis(input: {
  now: string;
  title: string;
  sourceSignalKind: ImprovementSourceSignalKind;
  sourceIds: string[];
  affectedCapability: string;
  expectedBenefit: string;
  riskLevel: ImprovementRiskLevel;
  confidence: number;
  impact: number;
  frequency: number;
  testability: number;
  trustSafetyBenefit?: number;
  sizePenalty?: number;
  proposedTest: string;
  status?: ImprovementHypothesis['status'];
  fixClass: ImprovementFixClass;
  externalBlocker?: boolean;
  safetyNotes: string;
  nextAction: string;
}): ImprovementHypothesis {
  const externalPenalty = input.externalBlocker ? 0.42 : 1;
  const priorityScore = clamp(
    (input.impact * 0.28 +
      input.frequency * 0.18 +
      input.confidence * 0.18 +
      input.testability * 0.14 +
      (input.trustSafetyBenefit || 0.5) * 0.12 +
      riskWeight(input.riskLevel) * 0.1 -
      (input.sizePenalty || 0) * 0.08) *
      externalPenalty,
  );
  const stable = [
    input.sourceSignalKind,
    input.affectedCapability,
    input.fixClass,
    input.title,
  ].join('|');
  return {
    hypothesisId: hashId('improve', stable),
    createdAt: input.now,
    updatedAt: input.now,
    title: safeText(input.title, 260),
    sourceSignalKind: input.sourceSignalKind,
    sourceSignalIdsJson: evidenceJson(input.sourceIds),
    affectedCapability: safeText(input.affectedCapability, 220),
    expectedBenefit: safeText(input.expectedBenefit, 700),
    riskLevel: input.riskLevel,
    confidence: clamp(input.confidence),
    priorityScore,
    proposedTest: safeText(input.proposedTest, 700),
    status: input.status || 'proposed',
    fixClass: input.fixClass,
    externalBlocker: Boolean(input.externalBlocker),
    safetyNotes: safeText(input.safetyNotes, 700),
    nextAction: safeText(input.nextAction, 700),
    privacyJson: privacyJson(),
  };
}

function proofGapHypotheses(now: string): ImprovementHypothesis[] {
  const truth = buildFieldTrialOperatorTruth();
  const entries: Array<[string, FieldTrialSurfaceTruth]> = [
    ['Telegram user session', truth.telegram],
    ['Alexa signed IntentRequest', truth.alexa],
    ['BlueBubbles same-thread proof', truth.bluebubbles],
    ['Google Calendar proof', truth.googleCalendar],
    ['Research proof', truth.research],
    ['Image generation proof', truth.imageGeneration],
  ];
  return entries
    .filter(([, state]) => state.proofState !== 'live_proven')
    .map(([label, state]) => {
      const external =
        state.blockerOwner === 'external' ||
        state.proofState === 'externally_blocked' ||
        /credential|console|intentrequest|same-thread|proof|app|external/i.test(
          `${state.blocker} ${state.nextAction} ${state.detail}`,
        );
      const fixClass: ImprovementFixClass = /telegram/i.test(label)
        ? 'external_config'
        : external
          ? 'external_manual_proof'
          : 'diagnostic_observation';
      return hypothesis({
        now,
        title: `${label} remains ${state.proofState}`,
        sourceSignalKind: 'pilot_proof_gap',
        sourceIds: [`proof:${label.replace(/[^A-Za-z0-9]+/g, '_')}`],
        affectedCapability: label.toLowerCase().replace(/\s+/g, '_'),
        expectedBenefit:
          external || fixClass === 'external_config'
            ? 'Keeps live proof debt visible without misclassifying it as a repo defect.'
            : 'Improves operator diagnostics for proof-state drift.',
        riskLevel: external ? 'medium' : 'low',
        confidence: external ? 0.82 : 0.72,
        impact: /telegram|bluebubbles|alexa/i.test(label) ? 0.85 : 0.62,
        frequency: 0.55,
        testability: external ? 0.35 : 0.78,
        trustSafetyBenefit: 0.9,
        proposedTest:
          state.nextAction ||
          'Run the relevant debug/status command and confirm proof truth is unchanged.',
        fixClass,
        externalBlocker: external || fixClass === 'external_config',
        safetyNotes:
          'Live proof cannot be faked by code; the lab may only surface exact manual proof steps.',
        nextAction:
          state.nextAction ||
          state.blocker ||
          'Keep this as proof debt until fresh live evidence exists.',
      });
    });
}

function repairHypotheses(
  attempts: RepairAttemptRecord[],
  now: string,
): ImprovementHypothesis[] {
  const groups = new Map<string, RepairAttemptRecord[]>();
  for (const attempt of attempts) {
    const key = `${attempt.integrationId}|${attempt.playbookId}|${attempt.failureClass}`;
    groups.set(key, [...(groups.get(key) || []), attempt]);
  }
  const records: ImprovementHypothesis[] = [];
  for (const [key, items] of groups) {
    const latest = items[0];
    if (!latest) continue;
    const proofOnly = /needs_proof|manual_external|credential|quota|auth/i.test(
      latest.failureClass,
    );
    const repeated = items.length >= 2 || latest.status !== 'succeeded';
    if (!repeated) continue;
    records.push(
      hypothesis({
        now,
        title: `Repair route ${latest.playbookId} needs clearer outcome validation`,
        sourceSignalKind: 'repair_attempt',
        sourceIds: items.map((item) => item.attemptId),
        affectedCapability: latest.integrationId,
        expectedBenefit: proofOnly
          ? 'Keeps repair state honest and avoids noisy retries for external or manual blockers.'
          : 'Turns repeated planned repair attempts into a testable diagnostic/playbook improvement.',
        riskLevel: latest.safeToApply ? 'low' : 'medium',
        confidence: Math.min(0.9, 0.5 + items.length * 0.12),
        impact:
          /bluebubbles|assistant_session|message_action|work_cockpit/i.test(
            latest.integrationId,
          )
            ? 0.82
            : 0.62,
        frequency: Math.min(1, items.length / 5),
        testability: proofOnly ? 0.42 : 0.82,
        trustSafetyBenefit: 0.86,
        proposedTest:
          'Run test:repair plus debug:repair and verify cooldown/validation output explains the blocker.',
        fixClass: proofOnly ? 'external_manual_proof' : 'repair_playbook',
        externalBlocker: proofOnly,
        safetyNotes:
          'Repair playbooks stay bounded; no service restart, credential change, or external send is allowed.',
        nextAction: proofOnly
          ? latest.nextAction
          : 'Prepare a patch plan for repair validation, status wording, or focused eval coverage.',
      }),
    );
    void key;
  }
  return records;
}

function reliabilityHypotheses(
  rollups: ToolReliabilityRollup[],
  now: string,
  providerHealth: ProviderHealthSnapshot[] = [],
  integrationReport?: IntegrationDoctorReport,
): ImprovementHypothesis[] {
  const healthyIntegrationIds = new Set(
    (integrationReport?.statuses || [])
      .filter((status) => status.state === 'healthy')
      .map((status) => status.integrationId),
  );
  return rollups
    .map((rollup) => {
      const providerId = rollup.subjectId.startsWith('provider:')
        ? rollup.subjectId.replace(/^provider:/, '')
        : null;
      if (
        providerId &&
        providerHealth.some(
          (provider) =>
            provider.providerId === providerId && provider.state === 'healthy',
        )
      ) {
        return {
          ...rollup,
          sampleCount: Math.max(rollup.sampleCount, 1),
          successRate: Math.max(rollup.successRate, 1),
          reliabilityScore: Math.max(rollup.reliabilityScore, 0.9),
          currentHealth: 'healthy' as const,
          confidenceCap: Math.max(rollup.confidenceCap, 0.95),
          nextAction: 'No action needed.',
        };
      }
      if (rollup.subjectId.startsWith('integration:')) {
        const integrationId = rollup.subjectId.replace(/^integration:/, '');
        if (healthyIntegrationIds.has(integrationId)) {
          return {
            ...rollup,
            sampleCount: Math.max(rollup.sampleCount, 1),
            successRate: Math.max(rollup.successRate, 1),
            reliabilityScore: Math.max(rollup.reliabilityScore, 0.9),
            currentHealth: 'healthy' as const,
            confidenceCap: Math.max(rollup.confidenceCap, 0.95),
            nextAction: 'No action needed.',
          };
        }
      }
      return rollup;
    })
    .filter(
      (rollup) =>
        rollup.currentHealth !== 'healthy' ||
        rollup.sampleCount === 0 ||
        rollup.reliabilityScore < 0.5,
    )
    .slice(0, 24)
    .map((rollup) => {
      const external =
        /^provider:|^integration:telegram|^integration:alexa/.test(
          rollup.subjectId,
        )
          ? rollup.currentHealth === 'blocked'
          : false;
      const unknown =
        rollup.sampleCount === 0 || rollup.currentHealth === 'unknown';
      const highRiskSubject =
        !unknown &&
        /message_actions|calendar|work_cockpit/.test(rollup.subjectId);
      return hypothesis({
        now,
        title: `${rollup.subjectId} reliability is ${rollup.currentHealth}`,
        sourceSignalKind: 'tool_reliability',
        sourceIds: [`rollup:${rollup.subjectId}`],
        affectedCapability: rollup.subjectId,
        expectedBenefit: unknown
          ? 'Collect one low-risk observation so route confidence is based on proof instead of unknown defaults.'
          : 'Reduce bad route choices by honoring degraded or blocked tool health.',
        riskLevel: external ? 'medium' : highRiskSubject ? 'high' : 'low',
        confidence: unknown ? 0.66 : 0.78,
        impact:
          /calendar|message_actions|research|work_cockpit|bluebubbles/i.test(
            rollup.subjectId,
          )
            ? 0.78
            : 0.58,
        frequency: Math.min(1, Math.max(0.35, rollup.sampleCount / 12)),
        testability: unknown ? 0.86 : 0.72,
        trustSafetyBenefit: 0.8,
        proposedTest:
          'Run test:tool-reliability and debug:executive -- --refresh, then verify confidence caps and next actions.',
        fixClass: unknown ? 'diagnostic_observation' : 'route_calibration',
        externalBlocker: external,
        safetyNotes:
          'Reliability changes may lower confidence or improve debug output; they must not bypass approvals.',
        nextAction: external
          ? rollup.nextAction
          : 'Prepare an observation/debug patch plan or add a focused reliability fixture.',
      });
    });
}

function isHiddenByCurrentIntegrationHealth(
  item: ImprovementHypothesis,
  integrationReport: IntegrationDoctorReport,
): boolean {
  const text =
    `${item.affectedCapability} ${item.title} ${item.nextAction}`.toLowerCase();
  const sourceCanBeStale =
    item.sourceSignalKind === 'pilot_proof_gap' ||
    item.sourceSignalKind === 'repair_attempt' ||
    item.sourceSignalKind === 'tool_reliability';
  if (!sourceCanBeStale) return false;

  const aliases: Record<string, string[]> = {
    telegram: [
      'integration:telegram',
      'telegram user',
      'telegram_user_session',
      'telegram bot',
    ],
    bluebubbles: [
      'integration:bluebubbles',
      'bluebubbles',
      'bluebubbles_same-thread_proof',
      'same-thread proof',
    ],
    google_calendar: [
      'integration:google_calendar',
      'google calendar',
      'google_calendar',
    ],
    research: ['integration:research', 'research proof'],
    image_generation: [
      'integration:image_generation',
      'image generation',
      'image_generation',
    ],
  };

  return integrationReport.statuses.some((status) => {
    if (status.state !== 'healthy') return false;
    const terms = aliases[status.integrationId];
    if (!terms) return false;
    return terms.some((term) => text.includes(term));
  });
}

function executiveReflectionHypotheses(
  signals: CognitiveReflectionSignal[],
  now: string,
): ImprovementHypothesis[] {
  const groups = new Map<string, CognitiveReflectionSignal[]>();
  for (const signal of signals) {
    if (!isExecutiveFrictionSignal(signal)) continue;
    const explicitFriction = /^(?:none|unknown)$/i.test(
      signal.frictionKey || '',
    )
      ? ''
      : signal.frictionKey || '';
    const key =
      explicitFriction ||
      (signal.fallbackUsed
        ? `${signal.routeKey}:fallback_used`
        : `${signal.routeKey}:${signal.signalKind}:${signal.outcome}`);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) || []), signal]);
  }
  return Array.from(groups.entries())
    .filter(([, items]) => items.length >= 2)
    .map(([key, items]) =>
      hypothesis({
        now,
        title: `Repeated executive friction: ${key}`,
        sourceSignalKind: 'executive_reflection',
        sourceIds: items.map((item) => item.signalId),
        affectedCapability: items[0]?.routeKey || key,
        expectedBenefit:
          'Improves future route selection by turning repeated corrections or failures into a focused route-tuning test.',
        riskLevel: 'low',
        confidence: Math.min(0.92, 0.45 + items.length * 0.12),
        impact: 0.74,
        frequency: Math.min(1, items.length / 6),
        testability: 0.84,
        trustSafetyBenefit: 0.7,
        proposedTest:
          'Run test:cognitive-executive plus test:agentic scenario replay for this route family.',
        fixClass: 'route_calibration',
        safetyNotes:
          'Route calibration may change confidence or ask clarification sooner; no side effects are added.',
        nextAction:
          'Prepare a route-calibration or eval patch plan if the replay improves score.',
      }),
    );
}

function isExecutiveFrictionSignal(signal: CognitiveReflectionSignal): boolean {
  if (signal.signalKind === 'route_chosen') return false;
  if (
    ['action_failed', 'fallback_used', 'user_corrected', 'ignored'].includes(
      signal.signalKind,
    )
  ) {
    return true;
  }
  if (signal.outcome === 'fail' || signal.outcome === 'warn') return true;
  if (
    signal.userResponse === 'corrected' ||
    signal.userResponse === 'ignored'
  ) {
    return true;
  }
  // A deterministic or local fallback that completed successfully is a route
  // provenance signal, not evidence of user-visible friction by itself. Keep
  // failed/warned fallbacks actionable without teaching the lab to "repair"
  // healthy configured local routing.
  if (signal.fallbackUsed && signal.outcome !== 'success') return true;
  return Boolean(
    signal.frictionKey && !/^(?:none|unknown)$/i.test(signal.frictionKey),
  );
}

function learningHypotheses(
  distillations: LearningDistillationRecord[],
  now: string,
): ImprovementHypothesis[] {
  return distillations
    .filter((item) =>
      ['friction_issue', 'rule_adjustment', 'doc_test_gap'].includes(
        item.outputKind,
      ),
    )
    .slice(0, 20)
    .map((item) =>
      hypothesis({
        now,
        title: `Learning candidate wants follow-up: ${item.outputKind}`,
        sourceSignalKind: 'learning_distillation',
        sourceIds: [item.distillationId],
        affectedCapability: item.targetId || item.outputKind,
        expectedBenefit:
          'Connects learning candidates to an explicit testable improvement proposal instead of leaving them as passive notes.',
        riskLevel: item.sensitivity === 'low' ? 'low' : 'medium',
        confidence: item.status === 'confirmed' ? 0.82 : 0.62,
        impact: item.outputKind === 'friction_issue' ? 0.76 : 0.58,
        frequency: 0.55,
        testability: item.outputKind === 'doc_test_gap' ? 0.92 : 0.74,
        trustSafetyBenefit: 0.72,
        proposedTest:
          'Run test:memory-distillation and the relevant focused route/learning-control test.',
        fixClass:
          item.outputKind === 'doc_test_gap' ? 'docs_or_test' : 'eval_gap',
        safetyNotes:
          'Learning candidates remain inspectable; personal or sensitive facts require confirmation.',
        nextAction: item.nextAction,
      }),
    );
}

function skillRunHypotheses(
  runs: SkillPlaybookRunRecord[],
  now: string,
): ImprovementHypothesis[] {
  const failed = runs.filter((run) =>
    ['blocked', 'approval_staged'].includes(run.outcome),
  );
  const groups = new Map<string, SkillPlaybookRunRecord[]>();
  for (const run of failed) {
    groups.set(run.skillId, [...(groups.get(run.skillId) || []), run]);
  }
  return Array.from(groups.entries()).map(([skillId, items]) =>
    hypothesis({
      now,
      title: `Skill playbook ${skillId} needs outcome review`,
      sourceSignalKind: 'skill_run',
      sourceIds: items.map((item) => item.runId),
      affectedCapability: skillId,
      expectedBenefit:
        'Prevents a poor skill from being reused without clearer context, fallback, or approval wording.',
      riskLevel: 'medium',
      confidence: Math.min(0.86, 0.5 + items.length * 0.1),
      impact: 0.65,
      frequency: Math.min(1, items.length / 4),
      testability: 0.78,
      trustSafetyBenefit: 0.92,
      proposedTest:
        'Run test:skill-library and test:learning-controls, then verify paused/review-needed skills stay suppressed.',
      fixClass: 'skill_adjustment',
      safetyNotes:
        'Skill improvements may pause or clarify a playbook; they cannot execute sends/writes automatically.',
      nextAction:
        'Prepare a skill adjustment or eval patch plan before activating any change.',
    }),
  );
}

function harnessHypotheses(
  proposals: HarnessImprovementProposal[],
  now: string,
): ImprovementHypothesis[] {
  return proposals.slice(0, 20).map((proposal) =>
    hypothesis({
      now,
      title: `Harness proposal: ${proposal.proposalKind}`,
      sourceSignalKind: 'harness_proposal',
      sourceIds: [proposal.proposalId],
      affectedCapability: proposal.taskFamily,
      expectedBenefit: proposal.summary,
      riskLevel: proposal.safetyRegression ? 'high' : 'low',
      confidence: clamp(0.52 + proposal.expectedScoreDelta),
      impact: 0.7,
      frequency: 0.45,
      testability: 0.9,
      trustSafetyBenefit: proposal.safetyRegression ? 0.3 : 0.78,
      proposedTest:
        'Replay the related harness trajectory and require no safety-regression flags.',
      fixClass:
        proposal.proposalKind === 'test_addition' ? 'docs_or_test' : 'eval_gap',
      externalBlocker: false,
      safetyNotes: proposal.safetyRegression
        ? 'Safety regression flag prevents automatic patch planning.'
        : 'Candidate-only harness proposal; no code mutation without explicit implementation.',
      nextAction: proposal.nextAction,
    }),
  );
}

function feedbackHypotheses(
  records: ResponseFeedbackRecord[],
  now: string,
): ImprovementHypothesis[] {
  return records
    .filter((item) =>
      [
        'captured',
        'awaiting_confirmation',
        'failed',
        'blocked_external',
        'manual_sync_only',
      ].includes(item.status),
    )
    .slice(0, 20)
    .map((item) =>
      hypothesis({
        now,
        title: `Response feedback: ${item.classification}`,
        sourceSignalKind: 'response_feedback',
        sourceIds: [item.feedbackId],
        affectedCapability:
          item.capabilityId ||
          item.routeKey ||
          item.handlerKind ||
          'response_feedback',
        expectedBenefit:
          item.classification === 'repo_side_rough_edge'
            ? 'Turns user feedback into a focused wording, route, or eval improvement.'
            : 'Keeps feedback classified so external blockers do not become false repo patches.',
        riskLevel:
          item.classification === 'repo_side_broken' ? 'medium' : 'low',
        confidence:
          item.classification === 'externally_blocked' ||
          item.classification === 'manual_sync_only'
            ? 0.78
            : 0.66,
        impact: 0.75,
        frequency: 0.45,
        testability: item.classification.startsWith('repo_side') ? 0.82 : 0.38,
        trustSafetyBenefit: 0.8,
        proposedTest:
          'Run the focused route test and debug:pilot; do not include raw feedback text in the patch plan.',
        fixClass:
          item.classification === 'externally_blocked'
            ? 'external_manual_proof'
            : item.classification === 'manual_sync_only'
              ? 'external_config'
              : 'debug_wording',
        externalBlocker:
          item.classification === 'externally_blocked' ||
          item.classification === 'manual_sync_only',
        safetyNotes:
          'Feedback records are summarized by classification/route only; raw user text is excluded from improvement records.',
        nextAction: item.classification.startsWith('repo_side')
          ? 'Prepare a small debug/wording/eval patch plan.'
          : 'Keep as manual or external blocker until proof changes.',
      }),
    );
}

function dedupeHypotheses(
  hypotheses: ImprovementHypothesis[],
): ImprovementHypothesis[] {
  const byId = new Map<string, ImprovementHypothesis>();
  for (const item of hypotheses) {
    const existing = byId.get(item.hypothesisId);
    if (!existing || item.priorityScore > existing.priorityScore) {
      byId.set(item.hypothesisId, item);
    }
  }
  return sortHypothesesForDailyAgent(Array.from(byId.values()));
}

function dailyAgentRankScore(item: ImprovementHypothesis): number {
  const text =
    `${item.affectedCapability} ${item.title} ${item.fixClass} ${item.nextAction}`.toLowerCase();
  let boost = 0;
  if (
    /\b(daily|loose_ends|communication|message|calendar|mission|goal|planner|blackboard|capability|memory|metacognition|cognitive_executive|followthrough|follow-through|candace)\b/.test(
      text,
    )
  ) {
    boost += 0.08;
  }
  if (item.sourceSignalKind === 'response_feedback') boost += 0.08;
  if (item.sourceSignalKind === 'executive_reflection') boost += 0.06;
  if (item.sourceSignalKind === 'learning_distillation') boost += 0.04;
  if (item.fixClass === 'repair_playbook') boost -= 0.03;
  if (item.externalBlocker) boost -= 0.18;
  if (item.riskLevel === 'high') boost -= 0.08;
  if (item.riskLevel === 'critical') boost -= 0.2;
  return item.priorityScore + boost;
}

function sortHypothesesForDailyAgent(
  hypotheses: ImprovementHypothesis[],
): ImprovementHypothesis[] {
  return [...hypotheses].sort((a, b) => {
    const rank = dailyAgentRankScore(b) - dailyAgentRankScore(a);
    if (Math.abs(rank) > 0.0001) return rank;
    return b.priorityScore - a.priorityScore;
  });
}

function experimentFor(
  hypothesisRecord: ImprovementHypothesis,
  now: string,
): ImprovementExperiment {
  const baseline = clamp(
    hypothesisRecord.externalBlocker
      ? 0.35
      : 0.45 + hypothesisRecord.confidence * 0.25,
  );
  const safetyResult: ImprovementExperiment['safetyResult'] =
    hypothesisRecord.riskLevel === 'critical'
      ? 'fail'
      : hypothesisRecord.riskLevel === 'high' ||
          hypothesisRecord.externalBlocker
        ? 'warn'
        : 'pass';
  const patchAllowed =
    !hypothesisRecord.externalBlocker &&
    hypothesisRecord.riskLevel !== 'high' &&
    hypothesisRecord.riskLevel !== 'critical' &&
    fixClassAllowsPatchPlan(hypothesisRecord.fixClass);
  const decision: ImprovementExperiment['decision'] = patchAllowed
    ? 'prepare_patch_plan'
    : hypothesisRecord.externalBlocker
      ? 'do_not_patch'
      : 'needs_approval';
  const candidateScore = clamp(
    baseline +
      (patchAllowed ? 0.18 : 0.04) +
      (safetyResult === 'pass' ? 0.08 : 0),
  );
  return {
    experimentId: hashId('impexp', hypothesisRecord.hypothesisId),
    hypothesisId: hypothesisRecord.hypothesisId,
    createdAt: now,
    updatedAt: now,
    scenarioIdsJson: evidenceJson([
      `scenario:${hypothesisRecord.fixClass}`,
      `capability:${hypothesisRecord.affectedCapability}`,
    ]),
    baselineScore: baseline,
    candidateScore,
    safetyResult,
    decision,
    summary: safeText(
      patchAllowed
        ? 'Simulation suggests a small plan-only patch could improve diagnostics, evals, or route calibration.'
        : hypothesisRecord.externalBlocker
          ? 'Simulation classifies this as manual/external proof debt, not a repo patch candidate.'
          : 'Simulation requires explicit approval before any behavior-changing patch plan.',
    ),
    privacyJson: privacyJson(),
  };
}

function filesForHypothesis(hypothesisRecord: ImprovementHypothesis): string[] {
  switch (hypothesisRecord.fixClass) {
    case 'diagnostic_observation':
      return [
        'src/tool-reliability.ts',
        'scripts/debug-executive.ts',
        'scripts/test-tool-reliability.ts',
      ];
    case 'repair_playbook':
      return [
        'src/integration-healer.ts',
        'scripts/debug-repair.ts',
        'scripts/test-repair.ts',
      ];
    case 'route_calibration':
      return [
        'src/cognitive-executive.ts',
        'src/tool-reliability.ts',
        'scripts/test-cognitive-executive.ts',
      ];
    case 'skill_adjustment':
      return [
        'src/skill-library.ts',
        'scripts/debug-skills.ts',
        'scripts/test-skill-library.ts',
      ];
    case 'docs_or_test':
    case 'eval_gap':
      return [
        'src/agentic-simulation-harness.ts',
        'docs/TESTING_AND_RELEASE_RUNBOOK.md',
        'scripts/test-agentic.ts',
      ];
    case 'debug_wording':
      return [
        'scripts/debug-pilot.ts',
        'scripts/debug-executive.ts',
        'docs/COMMAND_SURFACE_REFERENCE.md',
      ];
    default:
      return ['docs/TESTING_AND_RELEASE_RUNBOOK.md'];
  }
}

function patchPlanFor(
  hypothesisRecord: ImprovementHypothesis,
  experiment: ImprovementExperiment,
  now: string,
): CandidatePatchPlan | null {
  if (experiment.decision !== 'prepare_patch_plan') return null;
  return {
    patchPlanId: hashId('patchplan', hypothesisRecord.hypothesisId),
    hypothesisId: hypothesisRecord.hypothesisId,
    createdAt: now,
    updatedAt: now,
    filesLikelyAffectedJson: safeJson(filesForHypothesis(hypothesisRecord)),
    changeIntent: safeText(
      `Plan only: improve ${hypothesisRecord.fixClass} for ${hypothesisRecord.affectedCapability} without changing side-effect authority.`,
    ),
    testPlanJson: safeJson([
      hypothesisRecord.proposedTest,
      'npm run test:self-improvement',
      'npm run typecheck',
    ]),
    rollbackPlan:
      'Reject or archive this patch plan; no product behavior has been changed by the lab.',
    approvalRequirement: 'explicit_approval',
    riskLevel: hypothesisRecord.riskLevel,
    status: 'planned',
    privacyJson: privacyJson(),
  };
}

function outcomeFor(
  hypothesisRecord: ImprovementHypothesis,
  experiment: ImprovementExperiment,
  now: string,
): ImprovementOutcome {
  return {
    outcomeId: hashId(
      'impoutcome',
      `${hypothesisRecord.hypothesisId}|${experiment.decision}`,
    ),
    hypothesisId: hypothesisRecord.hypothesisId,
    createdAt: now,
    result:
      experiment.decision === 'prepare_patch_plan'
        ? 'not_applied'
        : hypothesisRecord.externalBlocker
          ? 'blocked'
          : 'neutral',
    improvedSummary:
      experiment.decision === 'prepare_patch_plan'
        ? 'A candidate patch plan was created for human review; no product mutation was applied.'
        : '',
    regressedSummary: '',
    nextAction:
      experiment.decision === 'prepare_patch_plan'
        ? 'Review and explicitly approve the patch plan before implementation.'
        : hypothesisRecord.nextAction,
    learnedLesson: hypothesisRecord.externalBlocker
      ? 'External proof debt should be tracked as proof debt, not automatically converted into repo work.'
      : 'Small improvements should be simulated and validated before code changes.',
    privacyJson: privacyJson(),
  };
}

function collectHypotheses(now: string): {
  hypotheses: ImprovementHypothesis[];
  signalSummary: AutonomousImprovementLabReport['signalSummary'];
} {
  const providerHealth = collectProviderHealthSnapshots(now);
  const integrationReport = buildIntegrationDoctorReport({
    now: new Date(now),
    providers: providerHealth,
  });
  const repairs = listRepairAttempts({ limit: 120 });
  const rollups = listToolReliabilityRollups({ limit: 200 });
  const reflections = listCognitiveReflectionSignals({ limit: 240 });
  const distillations = listLearningDistillations({ limit: 160 });
  const skillRuns = listSkillPlaybookRuns({ limit: 120 });
  const harnessProposals = listHarnessImprovementProposals({ limit: 80 });
  const responseFeedback = listRecentResponseFeedback({ limit: 80 });
  const proof = proofGapHypotheses(now);
  const hypotheses = dedupeHypotheses([
    ...proof,
    ...repairHypotheses(
      repairs
        .filter((attempt) => {
          if (!/brave_search/i.test(attempt.integrationId)) return true;
          if (!/quota|auth|credential/i.test(attempt.failureClass)) return true;
          return !providerHealth.some(
            (provider) =>
              provider.providerId === 'brave_search' &&
              provider.state === 'healthy',
          );
        })
        .filter((attempt) => {
          if (
            !/bluebubbles|telegram|google_calendar/i.test(attempt.integrationId)
          ) {
            return true;
          }
          return !integrationReport.statuses.some(
            (status) =>
              status.integrationId === attempt.integrationId &&
              status.state === 'healthy',
          );
        }),
      now,
    ),
    ...reliabilityHypotheses(rollups, now, providerHealth, integrationReport),
    ...executiveReflectionHypotheses(reflections, now),
    ...learningHypotheses(distillations, now),
    ...skillRunHypotheses(skillRuns, now),
    ...harnessHypotheses(harnessProposals, now),
    ...feedbackHypotheses(responseFeedback, now),
  ]);
  return {
    hypotheses,
    signalSummary: {
      pilotProofGaps: proof.length,
      repairAttempts: repairs.length,
      reliabilityRollups: rollups.length,
      executiveReflections: reflections.length,
      learningDistillations: distillations.length,
      skillRuns: skillRuns.length,
      harnessProposals: harnessProposals.length,
      responseFeedback: responseFeedback.length,
    },
  };
}

export function buildAutonomousImprovementLabReport(
  params: {
    now?: Date;
    persist?: boolean;
    selectedLimit?: number;
    /** @internal deterministic failure injection for persistence-boundary tests. */
    persistenceWriter?: typeof persistImprovementLabBatch;
  } = {},
): AutonomousImprovementLabReport {
  const generatedAt = nowIso(params.now);
  if (!isDatabaseInitialized()) {
    return {
      generatedAt,
      hypotheses: [],
      experiments: [],
      patchPlans: [],
      outcomes: [],
      topCandidates: [],
      selectedForExperiment: [],
      externalBlockers: [],
      patchPlanPolicy: {
        plansOnly: true,
        autoAppliesProductPatches: false,
        createsBranchesOrWorktrees: false,
        pushesWithoutValidation: false,
      },
      persistence: {
        requested: params.persist !== false,
        status: 'unavailable',
        atomic: true,
        retrySafe: true,
        detail:
          'Database is not initialized; no improvement records were written.',
      },
      signalSummary: {
        pilotProofGaps: 0,
        repairAttempts: 0,
        reliabilityRollups: 0,
        executiveReflections: 0,
        learningDistillations: 0,
        skillRuns: 0,
        harnessProposals: 0,
        responseFeedback: 0,
      },
      nextAction: 'Initialize the database before running the improvement lab.',
      privacy: PRIVACY,
    };
  }

  const { hypotheses, signalSummary } = collectHypotheses(generatedAt);
  const selectedForExperiment = sortHypothesesForDailyAgent(hypotheses)
    .filter((item) => item.status !== 'rejected' && item.status !== 'archived')
    .slice(0, params.selectedLimit || 5);
  const experiments = selectedForExperiment.map((item) =>
    experimentFor(item, generatedAt),
  );
  const patchPlans = experiments
    .map((experiment) => {
      const item = selectedForExperiment.find(
        (candidate) => candidate.hypothesisId === experiment.hypothesisId,
      );
      return item ? patchPlanFor(item, experiment, generatedAt) : null;
    })
    .filter((plan): plan is CandidatePatchPlan => Boolean(plan));
  const outcomes = experiments.map((experiment) => {
    const item = selectedForExperiment.find(
      (candidate) => candidate.hypothesisId === experiment.hypothesisId,
    );
    return outcomeFor(item || hypotheses[0], experiment, generatedAt);
  });

  const persistence = {
    requested: params.persist !== false,
    status: (params.persist === false ? 'disabled' : 'persisted') as
      | 'persisted'
      | 'disabled'
      | 'deferred_database_busy',
    atomic: true as const,
    retrySafe: true as const,
    detail:
      params.persist === false
        ? 'Persistence was disabled for this report.'
        : 'One atomic improvement generation was persisted.',
  };
  if (params.persist !== false) {
    try {
      (params.persistenceWriter || persistImprovementLabBatch)({
        hypotheses: hypotheses.slice(0, 80),
        experiments,
        patchPlans,
        outcomes,
      });
    } catch (error) {
      if (!isDatabaseBusyError(error)) throw error;
      persistence.status = 'deferred_database_busy';
      persistence.detail =
        'Another process held the SQLite writer lock; this generation remains usable in memory and a retry is safe.';
    }
  }

  const persistenceSucceeded = persistence.status === 'persisted';
  const storedHypotheses = persistenceSucceeded
    ? listImprovementHypotheses({ limit: 80 })
    : hypotheses;
  const storedExperiments = persistenceSucceeded
    ? listImprovementExperiments({ limit: 40 })
    : experiments;
  const storedPatchPlans = persistenceSucceeded
    ? listCandidatePatchPlans({ limit: 40 })
    : patchPlans;
  const storedOutcomes = persistenceSucceeded
    ? listImprovementOutcomes({ limit: 40 })
    : outcomes;
  const providerHealth = collectProviderHealthSnapshots(generatedAt);
  const integrationReport = buildIntegrationDoctorReport({
    now: new Date(generatedAt),
    providers: providerHealth,
  });
  const currentHypothesisIds = new Set(
    hypotheses.map((item) => item.hypothesisId),
  );
  const visibleHypotheses = sortHypothesesForDailyAgent(
    storedHypotheses.filter((item) => {
      if (
        item.sourceSignalKind === 'executive_reflection' &&
        !currentHypothesisIds.has(item.hypothesisId)
      ) {
        return false;
      }
      if (isHiddenByCurrentIntegrationHealth(item, integrationReport)) {
        return false;
      }
      const providerMatch = item.affectedCapability.match(/^provider:(.+)$/);
      if (!providerMatch) return true;
      const providerHealthy = providerHealth.some(
        (provider) =>
          provider.providerId === providerMatch[1] &&
          provider.state === 'healthy',
      );
      if (!providerHealthy) return true;
      return !(
        item.externalBlocker ||
        /quota|blocked|recovered|healthy/i.test(
          `${item.title} ${item.nextAction} ${item.fixClass}`,
        )
      );
    }),
  );
  const visibleHypothesisIds = new Set(
    visibleHypotheses.map((item) => item.hypothesisId),
  );
  const visibleExperiments = storedExperiments.filter((item) =>
    visibleHypothesisIds.has(item.hypothesisId),
  );
  const visiblePatchPlans = storedPatchPlans.filter((item) =>
    visibleHypothesisIds.has(item.hypothesisId),
  );
  const visibleOutcomes = storedOutcomes.filter((item) =>
    visibleHypothesisIds.has(item.hypothesisId),
  );
  const topCandidates = visibleHypotheses.slice(0, 8);
  const externalBlockers = visibleHypotheses
    .filter((item) => item.externalBlocker)
    .slice(0, 8);
  const actionable = topCandidates.find((item) => !item.externalBlocker);
  return {
    generatedAt,
    hypotheses: visibleHypotheses,
    experiments: visibleExperiments,
    patchPlans: visiblePatchPlans,
    outcomes: visibleOutcomes,
    topCandidates,
    selectedForExperiment,
    externalBlockers,
    patchPlanPolicy: {
      plansOnly: true,
      autoAppliesProductPatches: false,
      createsBranchesOrWorktrees: false,
      pushesWithoutValidation: false,
    },
    persistence,
    signalSummary,
    nextAction:
      actionable?.nextAction ||
      externalBlockers[0]?.nextAction ||
      'Keep collecting pilot, repair, reliability, learning, and harness signals.',
    privacy: PRIVACY,
  };
}

export function formatAutonomousImprovementLabReport(
  report: AutonomousImprovementLabReport,
): string {
  const lines = [
    '*Autonomous Improvement Lab*',
    `Generated: ${report.generatedAt}`,
    `Hypotheses: ${report.hypotheses.length}`,
    `Experiments: ${report.experiments.length}`,
    `Patch plans: ${report.patchPlans.length}`,
    `Outcomes: ${report.outcomes.length}`,
    `Policy: plans-only=${report.patchPlanPolicy.plansOnly ? 'yes' : 'no'} / auto-apply=${report.patchPlanPolicy.autoAppliesProductPatches ? 'yes' : 'no'} / auto-push=${report.patchPlanPolicy.pushesWithoutValidation ? 'yes' : 'no'}`,
    `Persistence: ${report.persistence.status} / atomic=yes / retry-safe=yes`,
    `Persistence detail: ${report.persistence.detail}`,
    '',
    '*Signal Summary*',
    `- proof_gaps=${report.signalSummary.pilotProofGaps} repair_attempts=${report.signalSummary.repairAttempts} reliability_rollups=${report.signalSummary.reliabilityRollups}`,
    `- executive_reflections=${report.signalSummary.executiveReflections} learning=${report.signalSummary.learningDistillations} skill_runs=${report.signalSummary.skillRuns}`,
    `- harness_proposals=${report.signalSummary.harnessProposals} response_feedback=${report.signalSummary.responseFeedback}`,
    '',
    '*Top Improvement Candidates*',
  ];
  if (report.topCandidates.length === 0) {
    lines.push('- none yet');
  } else {
    for (const item of report.topCandidates.slice(0, 6)) {
      lines.push(
        `- ${item.affectedCapability}: ${item.title} / priority=${item.priorityScore.toFixed(2)} / risk=${item.riskLevel} / fix=${item.fixClass} / external=${item.externalBlocker ? 'yes' : 'no'}`,
      );
      lines.push(`  next=${item.nextAction}`);
    }
  }
  lines.push('', '*External Or Manual Blockers*');
  if (report.externalBlockers.length === 0) {
    lines.push('- none classified');
  } else {
    for (const item of report.externalBlockers.slice(0, 5)) {
      lines.push(`- ${item.affectedCapability}: ${item.nextAction}`);
    }
  }
  lines.push('', '*Patch Plans*');
  if (report.patchPlans.length === 0) {
    lines.push('- none prepared; first pass may only classify proof debt');
  } else {
    for (const plan of report.patchPlans.slice(0, 5)) {
      lines.push(
        `- ${plan.patchPlanId}: ${plan.status} / approval=${plan.approvalRequirement} / risk=${plan.riskLevel}`,
      );
      lines.push(`  intent=${plan.changeIntent}`);
    }
  }
  lines.push(``, `Next: ${report.nextAction}`);
  lines.push(
    'Privacy: metadata-only; no raw prompts, private bodies, hidden reasoning, provider debates, raw tool output, or secrets are stored.',
  );
  return lines.join('\n');
}

function isDatabaseBusyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; message?: unknown };
  const code = String(candidate.code || '');
  const message = String(candidate.message || '');
  return (
    /^SQLITE_BUSY(?:_|$)/i.test(code) ||
    /database is (?:locked|busy)/i.test(message)
  );
}
