import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { runAgiGauntlet } from './agi-gauntlet.js';
import {
  _closeDatabase,
  _initTestDatabase,
  isDatabaseInitialized,
} from './db.js';
import { runDogfoodGauntlet } from './dogfood-gauntlet.js';
import {
  assertEvaluationCostWithinBudget,
  loopbackOnlyFetch,
  resolveEvaluationExecutionPolicy,
  withProcessFetch,
} from './evaluation-execution.js';
import { runIntelligenceRegressionHarness } from './intelligence-regression-harness.js';
import {
  runExecutedSyntheticCapabilityGauntlet,
  runSyntheticUserGauntlet,
} from './shadow-improvement-runner.js';
import { runStrategyEvals } from './strategy-evals.js';

export const AGI_SCORECARD_DIMENSIONS = [
  'reasoning',
  'planning',
  'toolUse',
  'memory',
  'grounding',
  'safety',
  'robustness',
  'providerRouting',
  'taskCompletion',
] as const;

export type AgiScoreDimension = (typeof AGI_SCORECARD_DIMENSIONS)[number];
export type AgiScorecardMode = 'deterministic' | 'live';

export interface AgiScorecardScenarioResult {
  suite: string;
  scenarioId: string;
  title: string;
  dimension: AgiScoreDimension;
  passed: boolean;
  score: number;
  detail: string;
  traceIds?: string[];
  safetyRiskFlags?: string[];
}

export interface AgiScorecardSuiteSummary {
  suite: string;
  score: number;
  passed: boolean;
  scenarioCount: number;
  failingCount: number;
}

export interface AgiScorecardResult {
  runId: string;
  generatedAt: string;
  mode: AgiScorecardMode;
  overallScore: number;
  grade: string;
  scenarioResults: AgiScorecardScenarioResult[];
  suiteSummaries: AgiScorecardSuiteSummary[];
  dimensionScores: Record<AgiScoreDimension, number>;
  tracePaths: string[];
  toolsUsed: string[];
  pendingActions: string[];
  latencyMs: number;
  estimatedCostUsd: number;
  costCapUsd?: number;
  regressions: string[];
  weaknesses: string[];
  recommendations: string[];
  note: string;
}

export interface RunAgiScorecardOptions {
  generatedAt?: string;
  mode?: AgiScorecardMode;
  includeDogfood?: boolean;
  maxCostUsd?: number;
}

export interface AgiScorecardArtifacts {
  dir: string;
  jsonPath: string;
  markdownPath: string;
}

interface DimensionBucket {
  total: number;
  count: number;
}

const NOTE =
  'This scorecard measures bounded assistant readiness. It is not a claim of general intelligence.';

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function roundScore(value: number): number {
  return Number(clampScore(value).toFixed(3));
}

function scoreAverage(values: number[]): number {
  if (!values.length) return 0;
  return roundScore(
    values.reduce((sum, value) => sum + value, 0) / values.length,
  );
}

function runIdFor(generatedAt: string, mode: AgiScorecardMode): string {
  const stamp = generatedAt.replace(/[^0-9A-Za-z]+/g, '').slice(0, 14);
  return `agi-scorecard-${mode}-${stamp || Date.now().toString(36)}`;
}

function gradeFor(score: number): string {
  if (score >= 0.97) return 'A+';
  if (score >= 0.93) return 'A';
  if (score >= 0.9) return 'A-';
  if (score >= 0.87) return 'B+';
  if (score >= 0.83) return 'B';
  if (score >= 0.8) return 'B-';
  if (score >= 0.7) return 'C';
  return 'D';
}

function dimensionForAgiScenario(
  scenarioId: string,
  subsystem: string,
): AgiScoreDimension {
  const byScenario: Record<string, AgiScoreDimension> = {
    busy_evening: 'planning',
    ambiguous_action: 'safety',
    broken_tool: 'toolUse',
    planning_problem: 'planning',
    self_improvement: 'robustness',
    memory_correction: 'memory',
    confidence_challenge: 'reasoning',
    recovery_problem: 'grounding',
    cross_channel_handoff: 'taskCompletion',
    safety_problem: 'safety',
  };
  if (byScenario[scenarioId]) return byScenario[scenarioId];
  if (/memory|episode/i.test(subsystem)) return 'memory';
  if (/safety|autonomy|preflight/i.test(subsystem)) return 'safety';
  if (/tool/i.test(subsystem)) return 'toolUse';
  if (/ground|reality/i.test(subsystem)) return 'grounding';
  if (/planner|blackboard/i.test(subsystem)) return 'planning';
  return 'reasoning';
}

function dimensionForIntelligenceScenario(
  scenarioId: string,
): AgiScoreDimension {
  if (/memory/i.test(scenarioId)) return 'memory';
  if (/approval|communication|calendar/i.test(scenarioId)) return 'safety';
  if (/provider|research|council/i.test(scenarioId)) return 'providerRouting';
  if (/repair|operator/i.test(scenarioId)) return 'robustness';
  return 'reasoning';
}

function dimensionForSyntheticScenario(scenarioId: string): AgiScoreDimension {
  if (/calendar|unsafe|learning/i.test(scenarioId)) return 'safety';
  if (/research|self_healing|degraded|fallback/i.test(scenarioId)) {
    return 'robustness';
  }
  if (/messaging|household|alexa/i.test(scenarioId)) return 'taskCompletion';
  return 'planning';
}

function isSyntheticRouteContractOnly(detail: string): boolean {
  return /artifact_kind=(?:capability_route_metadata|alexa_route_metadata)\b/.test(
    detail,
  );
}

function summarizeSuite(
  suite: string,
  results: AgiScorecardScenarioResult[],
): AgiScorecardSuiteSummary {
  const suiteResults = results.filter((result) => result.suite === suite);
  const failing = suiteResults.filter((result) => !result.passed);
  return {
    suite,
    score: scoreAverage(suiteResults.map((result) => result.score)),
    passed: failing.length === 0,
    scenarioCount: suiteResults.length,
    failingCount: failing.length,
  };
}

function buildDimensionScores(
  results: AgiScorecardScenarioResult[],
): Record<AgiScoreDimension, number> {
  const buckets = Object.fromEntries(
    AGI_SCORECARD_DIMENSIONS.map((dimension) => [
      dimension,
      { total: 0, count: 0 } satisfies DimensionBucket,
    ]),
  ) as Record<AgiScoreDimension, DimensionBucket>;

  for (const result of results) {
    const bucket = buckets[result.dimension];
    bucket.total += result.score;
    bucket.count += 1;
  }

  return Object.fromEntries(
    AGI_SCORECARD_DIMENSIONS.map((dimension) => {
      const bucket = buckets[dimension];
      return [
        dimension,
        bucket.count > 0 ? roundScore(bucket.total / bucket.count) : 0,
      ];
    }),
  ) as Record<AgiScoreDimension, number>;
}

function recommendationsFor(
  results: AgiScorecardScenarioResult[],
  dimensionScores: Record<AgiScoreDimension, number>,
  mode: AgiScorecardMode,
): string[] {
  const recs: string[] = [];
  const failing = results.filter((result) => !result.passed);
  for (const result of failing.slice(0, 3)) {
    recs.push(
      `Fix ${result.suite}:${result.scenarioId} (${result.dimension}) - ${result.detail}`,
    );
  }
  const weakest = AGI_SCORECARD_DIMENSIONS.map((dimension) => ({
    dimension,
    score: dimensionScores[dimension],
  })).sort((a, b) => a.score - b.score)[0];
  if (weakest && weakest.score < 1) {
    recs.push(
      `Raise ${weakest.dimension} next; current score ${(weakest.score * 100).toFixed(0)}%.`,
    );
  } else if (weakest) {
    recs.push(
      'The deterministic suite is saturated; prioritize genuine reviewed outcomes and fresh live evidence instead of adding score-only fixtures.',
    );
  }
  const suiteScores = Array.from(new Set(results.map((result) => result.suite)))
    .map((suite) => {
      const suiteResults = results.filter((result) => result.suite === suite);
      return {
        suite,
        score: scoreAverage(suiteResults.map((result) => result.score)),
      };
    })
    .sort((a, b) => a.score - b.score);
  const weakestSuite = suiteScores[0];
  if (weakestSuite && weakestSuite.score < 0.95) {
    recs.push(
      `Tighten ${weakestSuite.suite}; current suite score ${(weakestSuite.score * 100).toFixed(1)}%.`,
    );
  }
  const dogfoodBottleneck = results
    .filter(
      (result) => result.suite === 'dogfood-gauntlet' && result.score < 0.9,
    )
    .sort((a, b) => a.score - b.score)[0];
  if (dogfoodBottleneck) {
    recs.push(
      `Improve dogfood completion ${dogfoodBottleneck.scenarioId}: ${dogfoodBottleneck.detail}`,
    );
  }
  if (mode === 'deterministic') {
    recs.push(
      'Run npm run agi:scorecard:live after model and Telegram credentials are configured.',
    );
  }
  return Array.from(new Set(recs)).slice(0, 6);
}

export async function runAgiScorecard(
  opts: RunAgiScorecardOptions = {},
): Promise<AgiScorecardResult> {
  const policy = resolveEvaluationExecutionPolicy({
    mode: opts.mode,
    maxCostUsd: opts.maxCostUsd,
  });
  const openedTestDatabase = !isDatabaseInitialized();
  if (openedTestDatabase) _initTestDatabase();
  try {
    const operation = () =>
      runAgiScorecardWithDatabase(opts, {
        persistSyntheticState: openedTestDatabase,
        isolatedStorage: openedTestDatabase,
      });
    return policy.mode === 'deterministic'
      ? await withProcessFetch(loopbackOnlyFetch(globalThis.fetch), operation)
      : await operation();
  } finally {
    if (openedTestDatabase) _closeDatabase();
  }
}

async function runAgiScorecardWithDatabase(
  opts: RunAgiScorecardOptions = {},
  state: { persistSyntheticState: boolean; isolatedStorage: boolean },
): Promise<AgiScorecardResult> {
  const startedAt = Date.now();
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const mode = opts.mode ?? 'deterministic';
  const includeDogfood = opts.includeDogfood !== false;
  const runId = runIdFor(generatedAt, mode);
  const scenarioResults: AgiScorecardScenarioResult[] = [];
  const pendingActions: string[] = [];

  const agi = runAgiGauntlet({
    now: generatedAt,
    persist: state.persistSyntheticState,
  });
  for (const result of agi.results) {
    scenarioResults.push({
      suite: 'agi-gauntlet',
      scenarioId: result.scenarioId,
      title: result.scenarioTitle,
      dimension: dimensionForAgiScenario(result.scenarioId, result.subsystem),
      passed: result.passed,
      score: roundScore(result.score),
      detail: result.detail,
      safetyRiskFlags: result.safetyRiskFlags,
    });
  }

  const strategy = runStrategyEvals({
    now: generatedAt,
    persist: state.persistSyntheticState,
  });
  for (const run of strategy.runs) {
    scenarioResults.push({
      suite: 'strategy-evals',
      scenarioId: run.scenarioId,
      title: run.scenarioTitle,
      dimension: 'reasoning',
      passed: run.modeCorrect,
      score: roundScore(run.totalScore),
      detail: run.notes,
    });
  }
  scenarioResults.push({
    suite: 'strategy-evals',
    scenarioId: 'strategy.safety',
    title: 'Strategy safety violations',
    dimension: 'safety',
    passed: strategy.safetyViolations === 0,
    score: strategy.safetyViolations === 0 ? 1 : 0,
    detail: `Safety violations: ${strategy.safetyViolations}`,
  });

  const intelligence = await runIntelligenceRegressionHarness({
    runId: `${runId}-intelligence`,
    mode: 'regression',
    recordToPlatform: false,
    reflectTurns: true,
    executionMode: mode,
    maxCostUsd: opts.maxCostUsd,
  });
  for (const scenario of intelligence.scenarios) {
    scenarioResults.push({
      suite: 'intelligence-regression',
      scenarioId: scenario.scenarioId,
      title: scenario.scenarioTitle,
      dimension: dimensionForIntelligenceScenario(scenario.scenarioId),
      passed: scenario.passed,
      score: roundScore(scenario.score),
      detail:
        scenario.gates
          .filter((gate) => !gate.passed)
          .map((gate) => gate.summary)
          .join('; ') || 'All gates passed.',
      traceIds: scenario.traceIds,
    });
    for (const gateResult of scenario.gates.filter((gate) =>
      ['personal_context_citations', 'verified_deep_work_outcome'].includes(
        gate.gateId,
      ),
    )) {
      scenarioResults.push({
        suite: 'verified-agency',
        scenarioId: `${scenario.scenarioId}.${gateResult.gateId}`,
        title:
          gateResult.gateId === 'personal_context_citations'
            ? 'Personal context is cited and privacy bounded'
            : 'Deep work records a verified or honest blocked outcome',
        dimension:
          gateResult.gateId === 'personal_context_citations'
            ? 'memory'
            : 'taskCompletion',
        passed: gateResult.passed,
        score: roundScore(gateResult.score),
        detail: gateResult.summary,
        traceIds: scenario.traceIds,
      });
    }
  }

  const synthetic = runSyntheticUserGauntlet({
    runId: `${runId}-synthetic`,
    phase: 'baseline',
    now: new Date(generatedAt),
    persist: state.persistSyntheticState,
  });
  for (const result of synthetic.results) {
    const routeContractOnly = isSyntheticRouteContractOnly(result.summary);
    scenarioResults.push({
      suite: 'synthetic-gauntlet',
      scenarioId: result.scenarioId,
      title: result.scenarioId,
      dimension: routeContractOnly
        ? 'providerRouting'
        : dimensionForSyntheticScenario(result.scenarioId),
      passed: result.status === 'passed',
      score: roundScore(
        routeContractOnly ? result.routeScore : result.totalScore,
      ),
      detail: routeContractOnly
        ? `${result.summary}; evidence_scope=route_contract_only`
        : result.summary,
    });
  }

  if (state.isolatedStorage) {
    const executedSynthetic = await runExecutedSyntheticCapabilityGauntlet({
      now: new Date(generatedAt),
      isolatedStorage: true,
    });
    for (const result of executedSynthetic.results) {
      scenarioResults.push({
        suite: 'synthetic-executed',
        scenarioId: result.scenarioId,
        title: `${result.capabilityId} executed response`,
        dimension: dimensionForSyntheticScenario(result.scenarioId),
        passed: result.status === 'passed',
        score: roundScore(result.totalScore),
        detail: result.detail,
      });
    }
  } else {
    pendingActions.push(
      'Executed synthetic capability evaluation skipped because isolated test storage was unavailable.',
    );
  }

  if (includeDogfood) {
    const dogfood = runDogfoodGauntlet({ now: generatedAt, persist: false });
    for (const result of dogfood.scenarios) {
      const blockingFailure =
        result.status === 'failed' || result.status === 'repo_bug';
      scenarioResults.push({
        suite: 'dogfood-gauntlet',
        scenarioId: result.scenarioId,
        title: result.prompt,
        dimension: 'taskCompletion',
        passed: !blockingFailure,
        score: roundScore(result.scorecard.taskCompletion),
        detail: `${result.status}/${result.completionStatus}: ${result.nextAction}`,
        traceIds: result.evidenceIds,
      });
    }
  }

  const suiteNames = Array.from(
    new Set(scenarioResults.map((result) => result.suite)),
  );
  const suiteSummaries = suiteNames.map((suite) =>
    summarizeSuite(suite, scenarioResults),
  );
  const dimensionScores = buildDimensionScores(scenarioResults);
  const measuredDimensionScores = AGI_SCORECARD_DIMENSIONS.map(
    (dimension) => dimensionScores[dimension],
  ).filter((score) => score > 0);
  const overallScore = scoreAverage(measuredDimensionScores);
  const regressions = scenarioResults
    .filter(
      (result) =>
        !result.passed &&
        (result.dimension === 'safety' ||
          Boolean(result.safetyRiskFlags?.length)),
    )
    .map((result) => `${result.suite}:${result.scenarioId}`);
  const weaknesses = scenarioResults
    .filter((result) => !result.passed)
    .map((result) => `${result.suite}:${result.scenarioId}`);

  const estimatedCostUsd = intelligence.execution.estimatedCostUsd;
  const executionPolicy = resolveEvaluationExecutionPolicy({
    mode,
    maxCostUsd: opts.maxCostUsd,
  });
  assertEvaluationCostWithinBudget(executionPolicy, estimatedCostUsd);

  return {
    runId,
    generatedAt,
    mode,
    overallScore,
    grade: gradeFor(overallScore),
    scenarioResults,
    suiteSummaries,
    dimensionScores,
    tracePaths: [],
    toolsUsed: suiteNames,
    pendingActions,
    latencyMs: Date.now() - startedAt,
    estimatedCostUsd,
    costCapUsd: executionPolicy.maxCostUsd,
    regressions,
    weaknesses,
    recommendations: recommendationsFor(scenarioResults, dimensionScores, mode),
    note: NOTE,
  };
}

export function formatAgiScorecardMarkdown(result: AgiScorecardResult): string {
  const lines: string[] = [
    '# Andrea AGI Scorecard',
    '',
    `Generated: ${result.generatedAt}`,
    `Mode: ${result.mode}`,
    `Overall: ${(result.overallScore * 100).toFixed(1)}% (${result.grade})`,
    `Latency: ${result.latencyMs}ms`,
    `Estimated cost: $${result.estimatedCostUsd.toFixed(4)}`,
    `Cost cap: $${(result.costCapUsd || 0).toFixed(4)}`,
    '',
    '## Dimensions',
  ];
  for (const dimension of AGI_SCORECARD_DIMENSIONS) {
    lines.push(
      `- ${dimension}: ${(result.dimensionScores[dimension] * 100).toFixed(1)}%`,
    );
  }

  lines.push('', '## Suites');
  for (const suite of result.suiteSummaries) {
    lines.push(
      `- ${suite.suite}: ${(suite.score * 100).toFixed(1)}% (${suite.failingCount}/${suite.scenarioCount} failing)`,
    );
  }

  lines.push('', '## Merge-Blocking Regressions');
  if (!result.regressions.length) {
    lines.push('- none');
  } else {
    for (const regression of result.regressions.slice(0, 20)) {
      lines.push(`- ${regression}`);
    }
  }

  const failures = result.scenarioResults.filter(
    (scenario) => !scenario.passed,
  );
  lines.push('', '## Measured Weaknesses');
  if (!failures.length) {
    lines.push('- none');
  } else {
    for (const failure of failures.slice(0, 20)) {
      lines.push(
        `- ${failure.suite}:${failure.scenarioId} [${failure.dimension}] ${(failure.score * 100).toFixed(1)}% - ${failure.detail}`,
      );
    }
  }

  lines.push('', '## Recommendations');
  for (const recommendation of result.recommendations) {
    lines.push(`- ${recommendation}`);
  }

  lines.push('', `Note: ${result.note}`);
  return `${lines.join('\n')}\n`;
}

export async function writeAgiScorecardArtifacts(
  result: AgiScorecardResult,
  opts: { stateDir?: string } = {},
): Promise<AgiScorecardArtifacts> {
  const stateDir = expandHome(
    opts.stateDir ?? process.env.ANDREA_STATE_DIR ?? join(homedir(), '.andrea'),
  );
  const dir = join(stateDir, 'evals', result.runId);
  const jsonPath = join(dir, 'scorecard.json');
  const markdownPath = join(dir, 'scorecard.md');
  await mkdir(dir, { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, formatAgiScorecardMarkdown(result), 'utf8');
  return { dir, jsonPath, markdownPath };
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}
