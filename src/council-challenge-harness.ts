import {
  emitAndreaPlatformCouncilChallenge,
  emitAndreaPlatformDiagnosis,
  emitAndreaPlatformRepairPlan,
  type AndreaPlatformProviderCouncilResult,
  type PlatformTaskFamily,
} from './andrea-platform-bridge.js';
import {
  runObservableProviderCouncil,
  type ObservableProviderCouncilInput,
  type ProviderCouncilRunnerDeps,
} from './provider-council-runner.js';

export type CouncilChallengeTier = 'small' | 'medium' | 'large' | 'xl';
export type CouncilChallengeRunTier = CouncilChallengeTier | 'ladder';
export type CouncilChallengeStatus = 'pass' | 'warn' | 'fail' | 'degraded';

export interface CouncilChallengeScenario {
  scenarioId: string;
  tier: CouncilChallengeTier;
  taskFamily: PlatformTaskFamily;
  prompt: string;
  expectedCouncilMode:
    | 'single_model'
    | 'dual_review'
    | 'max_iq_council'
    | 'repair_council';
  requiredRoles: string[];
  requiredEvidence: 'strong' | 'partial' | 'weak' | 'unknown';
  forbiddenLeakageTerms: string[];
  successRubric: string[];
  providerBudget: 'low' | 'medium' | 'high';
  sideEffectPolicy: 'none' | 'read_only' | 'approval_required';
  repairPolicy: 'none' | 'one_approval';
}

export interface CouncilChallengeResult {
  scenarioId: string;
  tier: CouncilChallengeTier;
  status: CouncilChallengeStatus;
  score: number;
  criticalFailures: string[];
  rolesObserved: string[];
  missingRoles: string[];
  evidenceLevel: 'strong' | 'partial' | 'weak' | 'unknown';
  providerFailures: string[];
  latencyMs: number;
  estimatedCostTier: 'low' | 'medium' | 'high' | 'unknown';
  traceGradeId?: string;
  councilRunId?: string;
  eventIds: string[];
  issueId?: string;
  repairPlanId?: string;
}

export interface CouncilChallengeHarnessReport {
  runId: string;
  tier: CouncilChallengeRunTier;
  status: CouncilChallengeStatus;
  totalScore: number;
  criticalFailureCount: number;
  scenarioCount: number;
  scenarios: CouncilChallengeScenario[];
  results: CouncilChallengeResult[];
  platformReportId?: string;
}

export interface CouncilChallengeHarnessDeps {
  runCouncil?: (
    input: ObservableProviderCouncilInput,
    deps?: ProviderCouncilRunnerDeps,
  ) => Promise<AndreaPlatformProviderCouncilResult | null>;
  emitChallenge?: typeof emitAndreaPlatformCouncilChallenge;
  emitDiagnosis?: typeof emitAndreaPlatformDiagnosis;
  emitRepairPlan?: typeof emitAndreaPlatformRepairPlan;
  now?: () => number;
  councilDeps?: ProviderCouncilRunnerDeps;
}

const CHALLENGE_SCENARIOS: CouncilChallengeScenario[] = [
  {
    scenarioId: 'small.observable_single_model',
    tier: 'small',
    taskFamily: 'assistant',
    prompt:
      'Run a small observable council check: classify the task, keep it cheap, and produce a safe next step.',
    expectedCouncilMode: 'single_model',
    requiredRoles: ['openai_cloud'],
    requiredEvidence: 'partial',
    forbiddenLeakageTerms: ['api key', 'token=', 'password='],
    successRubric: [
      'uses cheap route',
      'records observable events',
      'does not leak secrets',
    ],
    providerBudget: 'low',
    sideEffectPolicy: 'read_only',
    repairPolicy: 'one_approval',
  },
  {
    scenarioId: 'medium.live_evidence_dual_review',
    tier: 'medium',
    taskFamily: 'research',
    prompt:
      'Use live public evidence to compare two safe approaches for improving Andrea provider council observability.',
    expectedCouncilMode: 'dual_review',
    requiredRoles: [
      'brave_search',
      'openai_cloud',
      'minimax_cloud',
      'gemini_cloud',
    ],
    requiredEvidence: 'strong',
    forbiddenLeakageTerms: ['sk-', 'AIza', 'BSA-', 'password='],
    successRubric: [
      'Brave gathers live evidence',
      'MiniMax critiques planner assumptions',
      'Gemini verifies before arbitration',
    ],
    providerBudget: 'medium',
    sideEffectPolicy: 'read_only',
    repairPolicy: 'one_approval',
  },
  {
    scenarioId: 'large.max_iq_architecture_review',
    tier: 'large',
    taskFamily: 'operator',
    prompt:
      'Stress-test Andrea Max-IQ council by reviewing the self-repair approval loop for missing evidence, policy gates, and dashboard observability.',
    expectedCouncilMode: 'max_iq_council',
    requiredRoles: [
      'brave_search',
      'openai_cloud',
      'minimax_cloud',
      'gemini_cloud',
    ],
    requiredEvidence: 'strong',
    forbiddenLeakageTerms: ['api key', 'token=', 'secret=', 'password='],
    successRubric: [
      'planner, critic, verifier, evidence scout all participate',
      'platform arbitration stays final',
      'high-impact claims are evidence aware',
    ],
    providerBudget: 'high',
    sideEffectPolicy: 'read_only',
    repairPolicy: 'one_approval',
  },
  {
    scenarioId: 'xl.repair_approval_autopilot_drill',
    tier: 'xl',
    taskFamily: 'operator',
    prompt:
      'Run an XL synthetic repair approval drill: diagnose a failed council challenge, require one scoped approval, and do not mutate code before approval.',
    expectedCouncilMode: 'repair_council',
    requiredRoles: ['openai_cloud', 'minimax_cloud', 'gemini_cloud'],
    requiredEvidence: 'partial',
    forbiddenLeakageTerms: ['api key', 'token=', 'password='],
    successRubric: [
      'repair path requires approval',
      'local fallback is not silent',
      'verification/landing gates are named',
    ],
    providerBudget: 'high',
    sideEffectPolicy: 'approval_required',
    repairPolicy: 'one_approval',
  },
  {
    scenarioId: 'xl.communication_calendar_continuity',
    tier: 'xl',
    taskFamily: 'communication',
    prompt:
      'Review a multi-turn assistant scenario covering BlueBubbles continuity, calendar certainty, and self-improvement status without sending messages.',
    expectedCouncilMode: 'max_iq_council',
    requiredRoles: [
      'brave_search',
      'openai_cloud',
      'minimax_cloud',
      'gemini_cloud',
    ],
    requiredEvidence: 'partial',
    forbiddenLeakageTerms: ['raw message', 'password=', 'token='],
    successRubric: [
      'communication sends remain approval-gated',
      'calendar claims stay narrow',
      'BlueBubbles proof gaps stay honest',
    ],
    providerBudget: 'high',
    sideEffectPolicy: 'approval_required',
    repairPolicy: 'one_approval',
  },
];

function scenarioSet(
  tier: CouncilChallengeRunTier,
): CouncilChallengeScenario[] {
  if (tier === 'ladder') return CHALLENGE_SCENARIOS;
  return CHALLENGE_SCENARIOS.filter((scenario) => scenario.tier === tier);
}

function scoreScenario(
  scenario: CouncilChallengeScenario,
  council: AndreaPlatformProviderCouncilResult | null,
  latencyMs: number,
): CouncilChallengeResult {
  const observed = new Set(council?.observedMemberIds || []);
  const missingRoles = scenario.requiredRoles.filter(
    (role) => !observed.has(role),
  );
  const providerFailures = [
    ...(council?.providerFailures || []),
    ...(council?.riskFlags || []).filter((flag) =>
      flag.includes('unavailable'),
    ),
  ];
  const criticalFailures: string[] = [];
  if (!council?.councilRunId) criticalFailures.push('council_run_missing');
  if (council?.mode && council.mode !== scenario.expectedCouncilMode) {
    criticalFailures.push('wrong_council_mode');
  }
  if (missingRoles.length > 0) criticalFailures.push('required_role_missing');
  if (providerFailures.length > 0) criticalFailures.push('provider_degraded');
  const evidenceIds = council?.evidenceIds || [];
  const evidenceLevel =
    evidenceIds.length > 0 && scenario.requiredRoles.includes('brave_search')
      ? 'strong'
      : evidenceIds.length > 0
        ? 'partial'
        : scenario.requiredEvidence === 'unknown'
          ? 'unknown'
          : 'weak';
  if (scenario.requiredEvidence === 'strong' && evidenceLevel !== 'strong') {
    criticalFailures.push('strong_evidence_missing');
  }
  let score = 1;
  score -= missingRoles.length * 0.18;
  score -= providerFailures.length * 0.16;
  if (!council?.councilRunId) score -= 0.35;
  if (council?.mode !== scenario.expectedCouncilMode) score -= 0.22;
  if (scenario.requiredEvidence === 'strong' && evidenceLevel !== 'strong') {
    score -= 0.2;
  }
  score = Math.max(0, Math.min(1, Number(score.toFixed(3))));
  const status: CouncilChallengeStatus =
    criticalFailures.length > 0
      ? providerFailures.length > 0 && missingRoles.length === 0
        ? 'degraded'
        : 'fail'
      : score >= 0.9
        ? 'pass'
        : 'warn';
  return {
    scenarioId: scenario.scenarioId,
    tier: scenario.tier,
    status,
    score,
    criticalFailures: Array.from(new Set(criticalFailures)),
    rolesObserved: Array.from(observed),
    missingRoles,
    evidenceLevel,
    providerFailures: Array.from(new Set(providerFailures)),
    latencyMs,
    estimatedCostTier: council?.estimatedCostTier || scenario.providerBudget,
    councilRunId: council?.councilRunId,
    eventIds: council?.eventIds || [],
  };
}

async function createRepairPlanForFailure(
  scenario: CouncilChallengeScenario,
  result: CouncilChallengeResult,
  deps: Required<
    Pick<CouncilChallengeHarnessDeps, 'emitDiagnosis' | 'emitRepairPlan'>
  >,
): Promise<CouncilChallengeResult> {
  if (scenario.repairPolicy !== 'one_approval') return result;
  if (result.status === 'pass' || result.status === 'warn') return result;
  const diagnosis = await deps.emitDiagnosis({
    goal: `Council challenge ${scenario.scenarioId} failed: ${result.criticalFailures.join(', ') || result.status}.`,
    correlationId: result.councilRunId || scenario.scenarioId,
    taskFamily: 'operator',
    channel: 'system',
    includePlatformSignals: true,
    signals: [
      {
        signalKind: 'council_challenge_failure',
        severity: result.status,
        scenarioId: scenario.scenarioId,
        missingRoles: result.missingRoles,
        providerFailures: result.providerFailures,
      },
    ],
    metadata: {
      council_challenge_scenario_id: scenario.scenarioId,
      council_challenge_tier: scenario.tier,
    },
  });
  const repair = await deps.emitRepairPlan({
    goal: `Repair council challenge failure ${scenario.scenarioId}.`,
    diagnosisId: diagnosis?.diagnosisId || null,
    correlationId: result.councilRunId || scenario.scenarioId,
    title: `Repair failed council challenge ${scenario.scenarioId}`,
    workerId: 'cursor_cloud',
    cloudWorkerId: 'cursor_cloud',
    affectedRepos: ['Andrea_NanoBot', 'andrea_platform'],
    affectedServices: ['andrea_nanobot', 'andrea_platform'],
    testsRequired: [
      'npm run test:council:ladder',
      'npm run test:intelligence',
      'python -m pytest src',
    ],
    restartRequired: false,
    deployAllowed: false,
    metadata: {
      source: 'council_challenge_harness',
      one_approval_required_for_mutation: 'true',
      local_fallback_requires_explicit_approval: 'true',
      scenario_id: scenario.scenarioId,
      tier: scenario.tier,
    },
  });
  return {
    ...result,
    repairPlanId: repair?.repairPlanId,
  };
}

export async function runCouncilChallengeHarness(
  options: {
    tier: CouncilChallengeRunTier;
    recordToPlatform?: boolean;
    createRepairPlans?: boolean;
    runId?: string;
  },
  deps: CouncilChallengeHarnessDeps = {},
): Promise<CouncilChallengeHarnessReport> {
  const runCouncil = deps.runCouncil || runObservableProviderCouncil;
  const emitChallenge =
    deps.emitChallenge || emitAndreaPlatformCouncilChallenge;
  const emitDiagnosis = deps.emitDiagnosis || emitAndreaPlatformDiagnosis;
  const emitRepairPlan = deps.emitRepairPlan || emitAndreaPlatformRepairPlan;
  const now = deps.now || (() => Date.now());
  const scenarios = scenarioSet(options.tier);
  const runId =
    options.runId ||
    `council-challenge-${options.tier}-${new Date().toISOString()}`;
  const results: CouncilChallengeResult[] = [];

  for (const scenario of scenarios) {
    const started = now();
    const council = await runCouncil(
      {
        goal: scenario.prompt,
        taskFamily: scenario.taskFamily,
        channel: 'system',
        correlationId: `${runId}:${scenario.scenarioId}`,
        requestedMode: scenario.expectedCouncilMode,
        riskLevel:
          scenario.sideEffectPolicy === 'approval_required' ? 'high' : 'medium',
        requiredEvidence: scenario.requiredEvidence,
        allowedSideEffects: scenario.sideEffectPolicy,
        rawContentPolicy: 'sanitized_snippets',
        metadata: {
          challenge_run_id: runId,
          challenge_scenario_id: scenario.scenarioId,
          challenge_tier: scenario.tier,
          mostly_live: 'true',
        },
      },
      deps.councilDeps,
    );
    let result = scoreScenario(scenario, council, Math.max(0, now() - started));
    if (options.createRepairPlans !== false) {
      result = await createRepairPlanForFailure(scenario, result, {
        emitDiagnosis,
        emitRepairPlan,
      });
    }
    results.push(result);
  }

  const criticalFailureCount = results.reduce(
    (count, result) => count + result.criticalFailures.length,
    0,
  );
  const totalScore =
    results.length > 0
      ? Number(
          (
            results.reduce((sum, result) => sum + result.score, 0) /
            results.length
          ).toFixed(3),
        )
      : 0;
  const status: CouncilChallengeStatus =
    criticalFailureCount > 0
      ? results.some((result) => result.status === 'fail')
        ? 'fail'
        : 'degraded'
      : totalScore >= 0.9
        ? 'pass'
        : 'warn';
  const report: CouncilChallengeHarnessReport = {
    runId,
    tier: options.tier,
    status,
    totalScore,
    criticalFailureCount,
    scenarioCount: scenarios.length,
    scenarios,
    results,
  };

  if (options.recordToPlatform !== false) {
    const platform = await emitChallenge({
      runId,
      tier: options.tier,
      mode: 'mostly_live',
      status,
      totalScore,
      criticalFailureCount,
      providerHealth: {},
      scenarios: scenarios.map((scenario) => ({ ...scenario })),
      results: results.map((result) => ({ ...result })),
      metadata: {
        scenario_count: String(scenarios.length),
        one_approval_required_for_mutation: 'true',
      },
    });
    report.platformReportId = platform?.runId;
  }

  return report;
}

export function listCouncilChallengeScenarios(
  tier: CouncilChallengeRunTier = 'ladder',
): CouncilChallengeScenario[] {
  return scenarioSet(tier);
}
