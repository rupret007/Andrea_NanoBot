export type AndreaBenchSuite = 'gaia' | 'bfcl' | 'swe-lite' | 'tau';

export interface AndreaBenchScenario {
  id: string;
  suite: AndreaBenchSuite;
  title: string;
  dimension:
    | 'tool_reasoning'
    | 'function_calling'
    | 'software_engineering'
    | 'transactional_recovery';
  prompt: string;
  expectedEvidence: string[];
  dryRunScore: number;
}

export interface AndreaBenchScenarioResult extends AndreaBenchScenario {
  mode: 'dry-run' | 'live';
  passed: boolean;
  score: number;
  detail: string;
  metrics: {
    goalStateSuccess: number;
    toolArgumentExactness: number;
    memoryCorrectness: number;
    staleProofAvoidance: number;
    confirmationBehavior: number;
    recovery: number;
    passAtK: number;
  };
}

export interface AndreaBenchReport {
  generatedAt: string;
  mode: 'dry-run' | 'live';
  suite: AndreaBenchSuite | 'external';
  overallScore: number;
  scenarioResults: AndreaBenchScenarioResult[];
  recommendations: string[];
  note: string;
}

export const ANDREA_BENCH_SCENARIOS: AndreaBenchScenario[] = [
  {
    id: 'gaia_multisource_planning',
    suite: 'gaia',
    title: 'GAIA-style multi-source assistant reasoning',
    dimension: 'tool_reasoning',
    prompt:
      'Find the current answer using tools, reconcile conflicting sources, and cite what changed.',
    expectedEvidence: ['tool_call', 'source_coverage', 'truth_calibration'],
    dryRunScore: 0.82,
  },
  {
    id: 'bfcl_calendar_args',
    suite: 'bfcl',
    title: 'BFCL-style exact tool argument construction',
    dimension: 'function_calling',
    prompt:
      'Create a calendar hold only after extracting title, date, start, end, attendees, and approval state.',
    expectedEvidence: ['schema_valid_args', 'approval_packet'],
    dryRunScore: 0.86,
  },
  {
    id: 'swe_lite_patch_and_test',
    suite: 'swe-lite',
    title: 'SWE-bench-lite-style patch, test, and explain loop',
    dimension: 'software_engineering',
    prompt:
      'Patch a small failing test, run the focused suite, and summarize risk without hiding failures.',
    expectedEvidence: ['patch_plan', 'test_result', 'runtime_checkpoint'],
    dryRunScore: 0.78,
  },
  {
    id: 'tau_order_recovery',
    suite: 'tau',
    title: 'tau-bench-style transactional recovery',
    dimension: 'transactional_recovery',
    prompt:
      'Recover from a failed external action by preserving completed steps, staging confirmation, and resuming safely.',
    expectedEvidence: ['checkpoint', 'pending_write', 'resume_token'],
    dryRunScore: 0.8,
  },
];

export function runAndreaBench(
  params: {
    suite?: AndreaBenchSuite | 'external';
    dryRun?: boolean;
    generatedAt?: string;
  } = {},
): AndreaBenchReport {
  const generatedAt = params.generatedAt ?? new Date().toISOString();
  const suite = params.suite ?? 'external';
  const mode = params.dryRun === false ? 'live' : 'dry-run';
  const scenarios = ANDREA_BENCH_SCENARIOS.filter(
    (scenario) => suite === 'external' || scenario.suite === suite,
  );
  const scenarioResults = scenarios.map((scenario) =>
    scoreScenario(scenario, mode),
  );
  const overallScore = average(scenarioResults.map((result) => result.score));
  return {
    generatedAt,
    mode,
    suite,
    overallScore,
    scenarioResults,
    recommendations: recommendationsFor(scenarioResults, mode),
    note:
      mode === 'dry-run'
        ? 'Dry-run external benchmark adapter. It proves command shape and scoring plumbing, not live benchmark performance.'
        : 'Live external benchmark adapter. Scores depend on configured providers and benchmark fixtures.',
  };
}

function scoreScenario(
  scenario: AndreaBenchScenario,
  mode: AndreaBenchScenarioResult['mode'],
): AndreaBenchScenarioResult {
  const score = roundMetric(mode === 'dry-run' ? scenario.dryRunScore : 0);
  return {
    ...scenario,
    mode,
    passed: score >= 0.75,
    score,
    detail:
      mode === 'dry-run'
        ? 'Adapter dry-run succeeded; live fixture execution is intentionally opt-in.'
        : 'Live execution is not configured in this pass.',
    metrics: {
      goalStateSuccess: score,
      toolArgumentExactness: roundMetric(
        scenario.dimension === 'function_calling'
          ? score
          : Math.min(1, score + 0.05),
      ),
      memoryCorrectness:
        scenario.suite === 'gaia' || scenario.suite === 'tau'
          ? score
          : roundMetric(Math.min(1, score + 0.04)),
      staleProofAvoidance: roundMetric(Math.min(1, score + 0.03)),
      confirmationBehavior: roundMetric(
        scenario.expectedEvidence.includes('approval_packet') ||
          scenario.expectedEvidence.includes('pending_write')
          ? score
          : Math.min(1, score + 0.02),
      ),
      recovery:
        scenario.dimension === 'transactional_recovery'
          ? score
          : roundMetric(Math.min(1, score + 0.01)),
      passAtK: score,
    },
  };
}

function roundMetric(value: number): number {
  return Number(value.toFixed(3));
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return Number(
    (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3),
  );
}

function recommendationsFor(
  results: AndreaBenchScenarioResult[],
  mode: AndreaBenchScenarioResult['mode'],
): string[] {
  const recs: string[] = [];
  const weakest = [...results].sort((a, b) => a.score - b.score)[0];
  if (weakest) {
    recs.push(
      `Raise ${weakest.suite}:${weakest.id}; current dry-run proxy score ${(weakest.score * 100).toFixed(0)}%.`,
    );
  }
  if (mode === 'dry-run') {
    recs.push(
      'Wire real benchmark fixtures behind explicit --live flags after Telegram/provider proof is green.',
    );
  }
  recs.push(
    'Keep external benchmark results separate from Andrea deterministic merge gates.',
  );
  return Array.from(new Set(recs));
}
