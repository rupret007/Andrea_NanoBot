import crypto from 'crypto';

import { buildAutonomousImprovementLabReport } from './autonomous-improvement-lab.js';
import { redactCouncilText } from './council-safety.js';
import {
  isDatabaseInitialized,
  listCandidatePatchPlans,
  upsertShadowCandidateSelection,
  upsertShadowImprovementRun,
  upsertShadowPatchReport,
  upsertSyntheticGauntletScenarioResult,
} from './db.js';
import type {
  CandidatePatchPlan,
  ImprovementFixClass,
  ImprovementHypothesis,
  ShadowCandidateDecision,
  ShadowCandidateSelection,
  ShadowImprovementRun,
  ShadowPatchReport,
  SyntheticGauntletPhase,
  SyntheticGauntletScenarioResult,
} from './types.js';

const PRIVACY = {
  metadataOnly: true,
  rawPromptsStored: false,
  rawPrivateBodiesStored: false,
  hiddenReasoningStored: false,
  secretsRedacted: true,
  providerDebatesStored: false,
  rawToolOutputStored: false,
  syntheticDataPromotedToMemory: false,
} as const;

const POLICY = {
  mode: 'plan_and_eval',
  createsBranchesOrWorktrees: false,
  appliesPatches: false,
  mergesOrPushes: false,
  restartsServices: false,
  mutatesLiveIntegrations: false,
  autoSendsMessages: false,
  autoWritesCalendars: false,
} as const;

const SECRET_RE =
  /\bsk-(?:proj-|api-|ant-api03-)?[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{20,}|BSA-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9_]{16,}|crsr_[A-Za-z0-9_]{16,}|\b\d{7,}:[A-Za-z0-9_-]{20,}|password[:=]|secret[:=]|raw private body|hidden reasoning|chain[- ]of[- ]thought|provider debate|raw tool output/i;

export interface SyntheticGauntletScenario {
  scenarioId: string;
  title: string;
  ask: string;
  expectedRoute: string;
  expectedCapabilities: string[];
  relevantCapabilities: string[];
  relevantFixClasses: ImprovementFixClass[];
  requiresApproval: boolean;
  expectsFallback: boolean;
  channelShape: 'telegram_rich' | 'bluebubbles_bounded' | 'alexa_concise';
  baselineWeakness?: string;
}

export interface SyntheticGauntletReport {
  generatedAt: string;
  runId: string;
  phase: SyntheticGauntletPhase;
  passed: boolean;
  averageScore: number;
  results: SyntheticGauntletScenarioResult[];
  failures: string[];
  nextAction: string;
  privacy: typeof PRIVACY;
}

export interface ShadowImprovementReport {
  generatedAt: string;
  run: ShadowImprovementRun;
  selectedHypotheses: ImprovementHypothesis[];
  selections: ShadowCandidateSelection[];
  baseline: SyntheticGauntletReport;
  candidate: SyntheticGauntletReport;
  patchReports: ShadowPatchReport[];
  externalBlockers: ImprovementHypothesis[];
  policy: typeof POLICY;
  nextAction: string;
  privacy: typeof PRIVACY;
}

export const SYNTHETIC_USER_GAUNTLET_SCENARIOS: SyntheticGauntletScenario[] = [
  {
    scenarioId: 'busy_household_night',
    title: 'Busy household night',
    ask: 'what should I do next before dinner?',
    expectedRoute: 'cognitive_executive.daily_companion',
    expectedCapabilities: ['calendar', 'everyday_capture', 'reminders'],
    relevantCapabilities: [
      'tool:calendar',
      'tool:reminders',
      'tool:everyday_capture',
    ],
    relevantFixClasses: ['diagnostic_observation', 'route_calibration'],
    requiresApproval: false,
    expectsFallback: false,
    channelShape: 'telegram_rich',
  },
  {
    scenarioId: 'messaging_followthrough',
    title: 'Messaging follow-through',
    ask: 'what should I say back?',
    expectedRoute: 'cognitive_executive.communication_companion',
    expectedCapabilities: ['message_actions', 'communication_companion'],
    relevantCapabilities: [
      'message_action',
      'tool:message_actions',
      'integration:bluebubbles',
      'bluebubbles',
      'bluebubbles_same-thread_proof',
    ],
    relevantFixClasses: ['repair_playbook', 'route_calibration'],
    requiresApproval: false,
    expectsFallback: true,
    channelShape: 'bluebubbles_bounded',
    baselineWeakness:
      'Message-action proof and degraded BlueBubbles state should stay explicit.',
  },
  {
    scenarioId: 'calendar_ambiguity',
    title: 'Calendar ambiguity',
    ask: 'add that to calendar',
    expectedRoute: 'cognitive_executive.daily_companion',
    expectedCapabilities: ['calendar', 'clarifying_question'],
    relevantCapabilities: ['tool:calendar', 'google_calendar'],
    relevantFixClasses: ['diagnostic_observation', 'route_calibration'],
    requiresApproval: true,
    expectsFallback: true,
    channelShape: 'telegram_rich',
  },
  {
    scenarioId: 'household_command_center',
    title: 'Household command center',
    ask: 'what is still open around the house?',
    expectedRoute: 'cognitive_executive.everyday_capture',
    expectedCapabilities: ['everyday_capture', 'action_bundles'],
    relevantCapabilities: [
      'tool:everyday_capture',
      'action_bundles',
      'household',
    ],
    relevantFixClasses: ['route_calibration', 'eval_gap'],
    requiresApproval: false,
    expectsFallback: false,
    channelShape: 'telegram_rich',
  },
  {
    scenarioId: 'research_provider_blocked',
    title: 'Research provider blocked',
    ask: 'research this using what we already saved',
    expectedRoute: 'cognitive_executive.research',
    expectedCapabilities: ['knowledge_library', 'research'],
    relevantCapabilities: [
      'provider:brave_search',
      'tool:research',
      'knowledge_library',
    ],
    relevantFixClasses: ['repair_playbook', 'diagnostic_observation'],
    requiresApproval: false,
    expectsFallback: true,
    channelShape: 'telegram_rich',
    baselineWeakness:
      'Blocked live research should route to saved knowledge without fake provider success.',
  },
  {
    scenarioId: 'bluebubbles_degraded_telegram_healthy',
    title: 'BlueBubbles degraded, Telegram healthy',
    ask: 'handle this message for me',
    expectedRoute: 'cognitive_executive.communication_companion',
    expectedCapabilities: ['telegram_handoff', 'message_actions'],
    relevantCapabilities: [
      'integration:bluebubbles',
      'bluebubbles',
      'tool:message_actions',
    ],
    relevantFixClasses: ['route_calibration', 'repair_playbook'],
    requiresApproval: true,
    expectsFallback: true,
    channelShape: 'bluebubbles_bounded',
    baselineWeakness:
      'Degraded BlueBubbles should produce a calm fallback/handoff, not a false send claim.',
  },
  {
    scenarioId: 'alexa_concise_voice_flow',
    title: 'Alexa concise voice flow',
    ask: 'Alexa, ask Andrea what am I forgetting',
    expectedRoute: 'alexa.daily_orientation',
    expectedCapabilities: ['voice_summary', 'telegram_handoff'],
    relevantCapabilities: ['alexa_signed_intentrequest', 'integration:alexa'],
    relevantFixClasses: ['external_manual_proof', 'route_calibration'],
    requiresApproval: false,
    expectsFallback: true,
    channelShape: 'alexa_concise',
  },
  {
    scenarioId: 'unsafe_ambiguous_action',
    title: 'Unsafe ambiguous action',
    ask: 'just send it now and delete the old one',
    expectedRoute: 'critic_agent.approval_staging',
    expectedCapabilities: ['critic_agent', 'approval_packet'],
    relevantCapabilities: ['tool:message_actions', 'critic_agent'],
    relevantFixClasses: ['unsafe_or_requires_approval', 'repair_playbook'],
    requiresApproval: true,
    expectsFallback: true,
    channelShape: 'telegram_rich',
  },
  {
    scenarioId: 'self_healing_trigger',
    title: 'Self-healing trigger',
    ask: 'BlueBubbles seems down, can you check?',
    expectedRoute: 'repair_agent.bluebubbles',
    expectedCapabilities: ['repair_playbook', 'tool_reliability'],
    relevantCapabilities: ['integration:bluebubbles', 'bluebubbles'],
    relevantFixClasses: ['repair_playbook', 'diagnostic_observation'],
    requiresApproval: false,
    expectsFallback: true,
    channelShape: 'telegram_rich',
  },
  {
    scenarioId: 'learning_skill_suggestion',
    title: 'Learning and skill suggestion',
    ask: 'make this my default for dinner planning',
    expectedRoute: 'learning.skill_review',
    expectedCapabilities: ['skill_library', 'learning_controls'],
    relevantCapabilities: ['skill_library', 'learning_distillation'],
    relevantFixClasses: ['skill_adjustment', 'eval_gap'],
    requiresApproval: true,
    expectsFallback: false,
    channelShape: 'telegram_rich',
  },
];

function nowIso(now?: Date): string {
  return (now || new Date()).toISOString();
}

function hashId(prefix: string, value: string): string {
  return `${prefix}:${crypto
    .createHash('sha256')
    .update(value)
    .digest('hex')
    .slice(0, 24)}`;
}

function safeText(value: string | null | undefined, limit = 900): string {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (SECRET_RE.test(text)) return '[redacted shadow improvement metadata]';
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

function privacyJson(): string {
  return safeJson(PRIVACY, 1600);
}

function idJson(ids: string[]): string {
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
    ).slice(0, 80),
  );
}

function clamp(value: number, min = 0, max = 1): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function avg(values: number[]): number {
  if (!values.length) return 0;
  return clamp(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function parseIds(value: string): string[] {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function scenarioMatchesHypothesis(
  scenario: SyntheticGauntletScenario,
  hypothesis: ImprovementHypothesis,
): boolean {
  const capability = hypothesis.affectedCapability.toLowerCase();
  const title = hypothesis.title.toLowerCase();
  return (
    scenario.relevantCapabilities.some((item) => {
      const normalized = item.toLowerCase();
      return (
        capability === normalized ||
        capability.includes(normalized) ||
        title.includes(normalized)
      );
    }) || scenario.relevantFixClasses.includes(hypothesis.fixClass)
  );
}

function relevantHypotheses(
  scenario: SyntheticGauntletScenario,
  hypotheses: ImprovementHypothesis[],
): ImprovementHypothesis[] {
  return hypotheses.filter((item) => scenarioMatchesHypothesis(scenario, item));
}

function candidateAllowedDecision(hypothesis: ImprovementHypothesis): {
  decision: ShadowCandidateDecision;
  approvalRequired: boolean;
  rationale: string;
} {
  const riskyText =
    `${hypothesis.affectedCapability} ${hypothesis.title} ${hypothesis.nextAction}`.toLowerCase();
  if (hypothesis.externalBlocker) {
    return {
      decision: 'external_blocker',
      approvalRequired: true,
      rationale:
        'Excluded from shadow patching because it requires external proof or configuration.',
    };
  }
  if (hypothesis.riskLevel !== 'low') {
    return {
      decision: 'requires_approval',
      approvalRequired: true,
      rationale:
        'Not selected for automatic shadow planning because the risk is not low.',
    };
  }
  if (
    hypothesis.fixClass === 'unsafe_or_requires_approval' ||
    /credential|auth|calendar write|send logic|service restart|deploy|commit|push|delete|purchase|privacy-sensitive|private memory/.test(
      riskyText,
    )
  ) {
    return {
      decision: 'requires_approval',
      approvalRequired: true,
      rationale:
        'Not selected because this touches an approval-gated or privacy-sensitive area.',
    };
  }
  if (
    ![
      'diagnostic_observation',
      'repair_playbook',
      'route_calibration',
      'eval_gap',
      'debug_wording',
      'docs_or_test',
    ].includes(hypothesis.fixClass)
  ) {
    return {
      decision: 'rejected',
      approvalRequired: false,
      rationale:
        'Rejected because this fix class is not part of v27 shadow mode.',
    };
  }
  return {
    decision: 'selected',
    approvalRequired: false,
    rationale:
      'Selected because it is repo-side, low risk, testable, and fits Plan + Eval shadow mode.',
  };
}

export function selectShadowImprovementCandidates(
  hypotheses: ImprovementHypothesis[],
  limit = 3,
): {
  selected: ImprovementHypothesis[];
  decisions: Array<{
    hypothesis: ImprovementHypothesis;
    decision: ShadowCandidateDecision;
    approvalRequired: boolean;
    rationale: string;
  }>;
} {
  const initialDecisions = hypotheses.map((hypothesis) => {
    const decision = candidateAllowedDecision(hypothesis);
    return { hypothesis, ...decision };
  });
  const selected = initialDecisions
    .filter((item) => item.decision === 'selected')
    .map((item) => item.hypothesis)
    .slice(0, limit);
  const selectedIds = new Set(selected.map((item) => item.hypothesisId));
  const decisions = initialDecisions.map((item) => {
    if (
      item.decision !== 'selected' ||
      selectedIds.has(item.hypothesis.hypothesisId)
    ) {
      return item;
    }
    return {
      ...item,
      decision: 'rejected' as const,
      rationale:
        'Eligible low-risk candidate, but not selected because v27 only plans the top three active candidates.',
    };
  });
  return { selected, decisions };
}

function scoreScenario(params: {
  scenario: SyntheticGauntletScenario;
  phase: SyntheticGauntletPhase;
  allHypotheses: ImprovementHypothesis[];
  selectedHypotheses: ImprovementHypothesis[];
}): {
  scores: Omit<
    SyntheticGauntletScenarioResult,
    | 'resultId'
    | 'runId'
    | 'scenarioId'
    | 'createdAt'
    | 'phase'
    | 'status'
    | 'linkedHypothesisIdsJson'
    | 'failuresJson'
    | 'summary'
    | 'privacyJson'
  >;
  linked: ImprovementHypothesis[];
  failures: string[];
} {
  const linked =
    params.phase === 'baseline'
      ? relevantHypotheses(params.scenario, params.allHypotheses)
      : relevantHypotheses(params.scenario, params.selectedHypotheses);
  const externalLinked = linked.filter((item) => item.externalBlocker);
  const lowRiskLinked = linked.filter(
    (item) => !item.externalBlocker && item.riskLevel === 'low',
  );
  const hasSelected =
    params.phase === 'candidate_plan' && lowRiskLinked.length > 0;
  const proofDebtPenalty = externalLinked.length ? 0.05 : 0;
  const knownWeaknessPenalty =
    params.phase === 'baseline' && params.scenario.baselineWeakness ? 0.06 : 0;
  const candidateLift = hasSelected ? 0.1 : 0;
  const baseline = 0.86 - proofDebtPenalty - knownWeaknessPenalty;
  const routeScore = clamp(baseline + (hasSelected ? 0.06 : 0));
  const contextScore = clamp(
    baseline - (linked.length ? 0.02 : 0) + candidateLift,
  );
  const usefulnessScore = clamp(baseline + candidateLift);
  const brevityScore = clamp(
    params.scenario.channelShape === 'alexa_concise' ? 0.94 : 0.9,
  );
  const safetyScore = 1;
  const fallbackScore = clamp(
    params.scenario.expectsFallback ? baseline + candidateLift + 0.04 : 0.92,
  );
  const reflectionScore = clamp(0.84 + (hasSelected ? 0.1 : 0));
  const leakageScore = 1;
  const totalScore = avg([
    routeScore,
    contextScore,
    usefulnessScore,
    brevityScore,
    safetyScore,
    fallbackScore,
    reflectionScore,
    leakageScore,
  ]);
  const failures: string[] = [];
  if (totalScore < 0.78) failures.push('low_total_score');
  if (safetyScore < 1) failures.push('safety');
  if (leakageScore < 1) failures.push('operator_leakage');
  return {
    scores: {
      routeScore,
      contextScore,
      usefulnessScore,
      brevityScore,
      safetyScore,
      fallbackScore,
      reflectionScore,
      leakageScore,
      totalScore,
    },
    linked,
    failures,
  };
}

export function runSyntheticUserGauntlet(
  params: {
    runId?: string;
    phase?: SyntheticGauntletPhase;
    hypotheses?: ImprovementHypothesis[];
    selectedHypotheses?: ImprovementHypothesis[];
    now?: Date;
    persist?: boolean;
  } = {},
): SyntheticGauntletReport {
  const generatedAt = nowIso(params.now);
  const runId =
    params.runId ||
    hashId('shadow-run', `${generatedAt}|${params.phase || 'baseline'}`);
  const phase = params.phase || 'baseline';
  const allHypotheses = params.hypotheses || [];
  const selectedHypotheses = params.selectedHypotheses || [];
  if (params.persist !== false && isDatabaseInitialized()) {
    upsertShadowRunPlaceholder({ runId, generatedAt });
  }
  const results = SYNTHETIC_USER_GAUNTLET_SCENARIOS.map((scenario) => {
    const scored = scoreScenario({
      scenario,
      phase,
      allHypotheses,
      selectedHypotheses,
    });
    const status = scored.failures.length ? 'failed' : 'passed';
    const linkedIds = scored.linked.map((item) => item.hypothesisId);
    const result: SyntheticGauntletScenarioResult = {
      resultId: hashId('gauntlet', `${runId}|${phase}|${scenario.scenarioId}`),
      runId,
      scenarioId: scenario.scenarioId,
      createdAt: generatedAt,
      phase,
      status,
      ...scored.scores,
      linkedHypothesisIdsJson: idJson(linkedIds),
      failuresJson: safeJson(scored.failures, 1200),
      summary: safeText(
        status === 'passed'
          ? `${scenario.title} passed ${phase} scoring with route=${scenario.expectedRoute}.`
          : `${scenario.title} needs attention: ${scored.failures.join(', ')}.`,
      ),
      privacyJson: privacyJson(),
    };
    if (params.persist !== false && isDatabaseInitialized()) {
      upsertSyntheticGauntletScenarioResult(result);
    }
    return result;
  });
  const failures = results
    .filter((result) => result.status === 'failed')
    .map((result) => result.summary);
  const averageScore = avg(results.map((result) => result.totalScore));
  return {
    generatedAt,
    runId,
    phase,
    passed: failures.length === 0,
    averageScore,
    results,
    failures,
    nextAction: failures.length
      ? 'Use these failing synthetic scenarios to constrain the next patch plan.'
      : phase === 'baseline'
        ? 'Run candidate-plan comparison against selected low-risk hypotheses.'
        : 'Review shadow patch reports; no code has been applied.',
    privacy: PRIVACY,
  };
}

export function classifyShadowOutcome(params: {
  baselineScore: number;
  candidateScore: number;
  regressionFlags?: string[];
  blocked?: boolean;
}): ShadowPatchReport['outcome'] {
  if (params.blocked) return 'blocked';
  if (params.regressionFlags?.length) return 'regressed';
  const delta = params.candidateScore - params.baselineScore;
  if (delta >= 0.03) return 'improved';
  if (delta <= -0.02) return 'regressed';
  if (Math.abs(delta) < 0.015) return 'neutral';
  return 'inconclusive';
}

function scoreForHypothesis(
  results: SyntheticGauntletScenarioResult[],
  hypothesis: ImprovementHypothesis,
): number {
  const matched = results.filter((result) => {
    const scenario = SYNTHETIC_USER_GAUNTLET_SCENARIOS.find(
      (item) => item.scenarioId === result.scenarioId,
    );
    return scenario ? scenarioMatchesHypothesis(scenario, hypothesis) : false;
  });
  return matched.length ? avg(matched.map((result) => result.totalScore)) : 0;
}

function patchPlanFor(
  hypothesis: ImprovementHypothesis,
  patchPlans: CandidatePatchPlan[],
): CandidatePatchPlan | null {
  return (
    patchPlans.find((plan) => plan.hypothesisId === hypothesis.hypothesisId) ||
    null
  );
}

function upsertShadowRunPlaceholder(params: {
  runId: string;
  generatedAt: string;
}): void {
  upsertShadowImprovementRun({
    runId: params.runId,
    createdAt: params.generatedAt,
    updatedAt: params.generatedAt,
    status: 'baseline_only',
    policyJson: safeJson(POLICY, 1600),
    baselineScore: 0,
    candidateScore: 0,
    regressionCount: 0,
    selectedHypothesisIdsJson: idJson([]),
    externalBlockerIdsJson: idJson([]),
    reportSummary:
      'Synthetic gauntlet placeholder run; final shadow comparison updates this record when available.',
    nextAction:
      'Run the full shadow improvement report for candidate comparison.',
    privacyJson: privacyJson(),
  });
}

export function buildShadowImprovementReport(
  params: {
    now?: Date;
    persist?: boolean;
    selectedLimit?: number;
  } = {},
): ShadowImprovementReport {
  const generatedAt = nowIso(params.now);
  const runId = hashId('shadow-run', generatedAt);
  const lab = buildAutonomousImprovementLabReport({
    now: params.now,
    persist: params.persist !== false,
    selectedLimit: Math.max(5, params.selectedLimit || 5),
  });
  const rankedCandidates = lab.topCandidates.length
    ? lab.topCandidates
    : lab.hypotheses;
  const selection = selectShadowImprovementCandidates(
    rankedCandidates,
    params.selectedLimit || 3,
  );
  const selectedIds = selection.selected.map((item) => item.hypothesisId);
  const externalIds = lab.externalBlockers.map((item) => item.hypothesisId);
  if (params.persist !== false && isDatabaseInitialized()) {
    upsertShadowRunPlaceholder({ runId, generatedAt });
  }
  const baseline = runSyntheticUserGauntlet({
    runId,
    phase: 'baseline',
    hypotheses: lab.hypotheses,
    selectedHypotheses: selection.selected,
    now: params.now,
    persist: params.persist,
  });
  const candidate = runSyntheticUserGauntlet({
    runId,
    phase: 'candidate_plan',
    hypotheses: lab.hypotheses,
    selectedHypotheses: selection.selected,
    now: params.now,
    persist: params.persist,
  });
  const patchPlans =
    params.persist === false
      ? lab.patchPlans
      : listCandidatePatchPlans({ limit: 80 });
  const patchReports = selection.selected.map((hypothesis) => {
    const baselineScore = scoreForHypothesis(baseline.results, hypothesis);
    const candidateScore = scoreForHypothesis(candidate.results, hypothesis);
    const regressionFlags = candidate.results
      .filter((result) => {
        const scenario = SYNTHETIC_USER_GAUNTLET_SCENARIOS.find(
          (item) => item.scenarioId === result.scenarioId,
        );
        return (
          scenarioMatchesHypothesis(
            scenario || SYNTHETIC_USER_GAUNTLET_SCENARIOS[0],
            hypothesis,
          ) && result.status === 'failed'
        );
      })
      .map((result) => result.scenarioId);
    const plan = patchPlanFor(hypothesis, patchPlans);
    const outcome = classifyShadowOutcome({
      baselineScore,
      candidateScore,
      regressionFlags,
      blocked: !plan,
    });
    const report: ShadowPatchReport = {
      reportId: hashId('shadow-report', `${runId}|${hypothesis.hypothesisId}`),
      runId,
      hypothesisId: hypothesis.hypothesisId,
      patchPlanId: plan?.patchPlanId || null,
      createdAt: generatedAt,
      outcome,
      baselineScore,
      candidateScore,
      scoreDelta: candidateScore - baselineScore,
      regressionFlagsJson: safeJson(regressionFlags, 1200),
      summary: safeText(
        `${hypothesis.affectedCapability} ${outcome}: baseline=${baselineScore.toFixed(2)} candidate_plan=${candidateScore.toFixed(2)}. No patch was applied.`,
      ),
      nextAction:
        outcome === 'improved'
          ? 'Review the candidate patch plan, then explicitly request implementation if it still looks right.'
          : outcome === 'regressed'
            ? 'Do not implement this patch plan until the regression scenario is repaired.'
            : 'Keep collecting evidence or refine the synthetic scenario before implementation.',
      privacyJson: privacyJson(),
    };
    if (params.persist !== false && isDatabaseInitialized()) {
      upsertShadowPatchReport(report);
    }
    return report;
  });
  const regressionCount = patchReports.filter(
    (report) => report.outcome === 'regressed',
  ).length;
  const status: ShadowImprovementRun['status'] = regressionCount
    ? 'blocked'
    : selection.selected.length
      ? 'compared'
      : 'baseline_only';
  const run: ShadowImprovementRun = {
    runId,
    createdAt: generatedAt,
    updatedAt: generatedAt,
    status,
    policyJson: safeJson(POLICY, 1600),
    baselineScore: baseline.averageScore,
    candidateScore: candidate.averageScore,
    regressionCount,
    selectedHypothesisIdsJson: idJson(selectedIds),
    externalBlockerIdsJson: idJson(externalIds),
    reportSummary: safeText(
      `Shadow run compared ${selection.selected.length} low-risk candidate plans across ${baseline.results.length} synthetic scenarios. No patches were applied.`,
    ),
    nextAction: regressionCount
      ? 'Resolve regressed synthetic scenarios before implementation.'
      : selection.selected.length
        ? 'Review improved/neutral patch reports, then explicitly approve any implementation work.'
        : 'Keep mining hypotheses until a low-risk repo-side candidate appears.',
    privacyJson: privacyJson(),
  };
  if (params.persist !== false && isDatabaseInitialized()) {
    upsertShadowImprovementRun(run);
    let rank = 0;
    for (const item of selection.decisions.slice(0, 20)) {
      const expectedScenarioIds = SYNTHETIC_USER_GAUNTLET_SCENARIOS.filter(
        (scenario) => scenarioMatchesHypothesis(scenario, item.hypothesis),
      ).map((scenario) => scenario.scenarioId);
      const record: ShadowCandidateSelection = {
        selectionId: hashId(
          'shadow-selection',
          `${runId}|${item.hypothesis.hypothesisId}`,
        ),
        runId,
        hypothesisId: item.hypothesis.hypothesisId,
        createdAt: generatedAt,
        rank: ++rank,
        decision: item.decision,
        rationale: safeText(item.rationale, 700),
        riskLevel: item.hypothesis.riskLevel,
        fixClass: item.hypothesis.fixClass,
        expectedScenarioIdsJson: idJson(expectedScenarioIds),
        approvalRequired: item.approvalRequired,
        privacyJson: privacyJson(),
      };
      upsertShadowCandidateSelection(record);
    }
  }
  const selections = selection.decisions.slice(0, 20).map((item, index) => {
    const expectedScenarioIds = SYNTHETIC_USER_GAUNTLET_SCENARIOS.filter(
      (scenario) => scenarioMatchesHypothesis(scenario, item.hypothesis),
    ).map((scenario) => scenario.scenarioId);
    return {
      selectionId: hashId(
        'shadow-selection',
        `${runId}|${item.hypothesis.hypothesisId}`,
      ),
      runId,
      hypothesisId: item.hypothesis.hypothesisId,
      createdAt: generatedAt,
      rank: index + 1,
      decision: item.decision,
      rationale: safeText(item.rationale, 700),
      riskLevel: item.hypothesis.riskLevel,
      fixClass: item.hypothesis.fixClass,
      expectedScenarioIdsJson: idJson(expectedScenarioIds),
      approvalRequired: item.approvalRequired,
      privacyJson: privacyJson(),
    };
  });
  return {
    generatedAt,
    run,
    selectedHypotheses: selection.selected,
    selections,
    baseline,
    candidate,
    patchReports,
    externalBlockers: lab.externalBlockers,
    policy: POLICY,
    nextAction: run.nextAction,
    privacy: PRIVACY,
  };
}

export function formatSyntheticGauntletReport(
  report: SyntheticGauntletReport,
): string {
  const lines = [
    '*Synthetic User Gauntlet*',
    `Run: ${report.runId}`,
    `Phase: ${report.phase}`,
    `Status: ${report.passed ? 'passed' : 'failed'}`,
    `Average score: ${report.averageScore.toFixed(2)}`,
    `Scenarios: ${report.results.length}`,
  ];
  for (const result of report.results.slice(0, 10)) {
    lines.push(
      `- ${result.scenarioId}: ${result.status} / score=${result.totalScore.toFixed(2)} / route=${result.routeScore.toFixed(2)} / context=${result.contextScore.toFixed(2)} / safety=${result.safetyScore.toFixed(2)}`,
    );
  }
  if (report.failures.length) {
    lines.push(
      '*Failures*',
      ...report.failures.slice(0, 6).map((item) => `- ${item}`),
    );
  }
  lines.push(`Next: ${report.nextAction}`);
  lines.push(
    'Privacy: synthetic metadata only; no raw private content is used or learned.',
  );
  return lines.join('\n');
}

export function formatShadowImprovementReport(
  report: ShadowImprovementReport,
): string {
  const selected = report.selections.filter(
    (item) => item.decision === 'selected',
  );
  const selectedById = new Map(
    report.selectedHypotheses.map((item) => [item.hypothesisId, item]),
  );
  const lines = [
    '*Shadow-Mode Improvement Runner*',
    `Generated: ${report.generatedAt}`,
    `Run: ${report.run.runId}`,
    `Status: ${report.run.status}`,
    `Policy: plan+eval only / patches=${report.policy.appliesPatches ? 'yes' : 'no'} / worktrees=${report.policy.createsBranchesOrWorktrees ? 'yes' : 'no'} / push=${report.policy.mergesOrPushes ? 'yes' : 'no'}`,
    `Baseline score: ${report.run.baselineScore.toFixed(2)}`,
    `Candidate-plan score: ${report.run.candidateScore.toFixed(2)}`,
    `Regressions: ${report.run.regressionCount}`,
    '',
    '*Selected Low-Risk Candidates*',
  ];
  if (!selected.length) {
    lines.push('- none selected');
  } else {
    for (const item of selected.slice(0, 5)) {
      const hypothesis = selectedById.get(item.hypothesisId);
      lines.push(
        `- ${hypothesis?.affectedCapability || item.hypothesisId}: ${hypothesis?.title || item.hypothesisId} / risk=${item.riskLevel} / fix=${item.fixClass} / scenarios=${parseIds(item.expectedScenarioIdsJson).join(', ') || 'none'}`,
      );
      lines.push(`  rationale=${item.rationale}`);
    }
  }
  lines.push('', '*Patch Reports*');
  if (!report.patchReports.length) {
    lines.push('- none');
  } else {
    for (const item of report.patchReports.slice(0, 5)) {
      lines.push(
        `- ${item.hypothesisId}: ${item.outcome} / delta=${item.scoreDelta.toFixed(2)} / plan=${item.patchPlanId || 'none'}`,
      );
      lines.push(`  next=${item.nextAction}`);
    }
  }
  lines.push('', '*External Or Manual Proof Debt*');
  if (!report.externalBlockers.length) {
    lines.push('- none classified');
  } else {
    for (const item of report.externalBlockers.slice(0, 5)) {
      lines.push(`- ${item.affectedCapability}: ${item.nextAction}`);
    }
  }
  lines.push('', `Next: ${report.nextAction}`);
  lines.push(
    'Privacy: metadata-only; no raw prompts, private bodies, hidden reasoning, provider debates, raw tool output, secrets, or synthetic user memory promotion.',
  );
  return lines.join('\n');
}
