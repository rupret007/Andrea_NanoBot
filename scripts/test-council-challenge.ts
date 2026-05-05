import {
  runCouncilChallengeHarness,
  type CouncilChallengeRunTier,
} from '../src/council-challenge-harness.js';
import {
  DEFAULT_COUNCIL_CHALLENGE_BASELINE,
  type CouncilChallengeBaseline,
} from '../src/agent-source-intelligence.js';
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(): {
  tier: CouncilChallengeRunTier;
  recordToPlatform: boolean;
  createRepairPlans: boolean;
  baseline: boolean;
  compare: boolean;
  failOnRegression: boolean;
} {
  const args = new Set(process.argv.slice(2));
  const tierArg = process.argv
    .slice(2)
    .find((arg) => arg.startsWith('--tier='))
    ?.split('=')[1];
  const positionalTier = process.argv
    .slice(2)
    .find((arg) => ['small', 'medium', 'large', 'xl', 'ladder'].includes(arg));
  const tier = (tierArg ||
    positionalTier ||
    'ladder') as CouncilChallengeRunTier;
  return {
    tier,
    recordToPlatform: !args.has('--no-record'),
    createRepairPlans: !args.has('--no-repair-plan'),
    baseline: args.has('--baseline'),
    compare: args.has('--compare'),
    failOnRegression: args.has('--fail-on-regression'),
  };
}

const options = parseArgs();
const baselinePath = path.join(
  process.cwd(),
  'state',
  'council-challenge-baseline.json',
);

function readBaseline(): CouncilChallengeBaseline {
  if (!fs.existsSync(baselinePath)) return DEFAULT_COUNCIL_CHALLENGE_BASELINE;
  try {
    const parsed = JSON.parse(
      fs.readFileSync(baselinePath, 'utf-8'),
    ) as Partial<CouncilChallengeBaseline>;
    return {
      totalScore:
        typeof parsed.totalScore === 'number'
          ? parsed.totalScore
          : DEFAULT_COUNCIL_CHALLENGE_BASELINE.totalScore,
      criticalFailureCount:
        typeof parsed.criticalFailureCount === 'number'
          ? parsed.criticalFailureCount
          : DEFAULT_COUNCIL_CHALLENGE_BASELINE.criticalFailureCount,
      criticalScenarioIds: Array.isArray(parsed.criticalScenarioIds)
        ? parsed.criticalScenarioIds.filter(
            (item): item is string => typeof item === 'string',
          )
        : [],
      scenarioCount:
        typeof parsed.scenarioCount === 'number'
          ? parsed.scenarioCount
          : undefined,
      recordedAt:
        typeof parsed.recordedAt === 'string' ? parsed.recordedAt : undefined,
    };
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (_err) {
    return DEFAULT_COUNCIL_CHALLENGE_BASELINE;
  }
}

function writeBaseline(
  report: Awaited<ReturnType<typeof runCouncilChallengeHarness>>,
) {
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  const baseline: CouncilChallengeBaseline = {
    totalScore: report.totalScore,
    criticalFailureCount: report.criticalFailureCount,
    criticalScenarioIds: report.results
      .filter((result) => result.criticalFailures.length > 0)
      .map((result) => result.scenarioId),
    scenarioCount: report.scenarioCount,
    recordedAt: new Date().toISOString(),
  };
  fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));
}

const baseline = options.compare ? readBaseline() : null;
const report = await runCouncilChallengeHarness({
  tier: options.tier,
  recordToPlatform: options.recordToPlatform,
  createRepairPlans: options.createRepairPlans,
  baseline,
  compareToBaseline: options.compare,
  baselineMode: options.baseline,
});

if (options.baseline) {
  writeBaseline(report);
}

console.log(
  JSON.stringify(
    {
      runId: report.runId,
      tier: report.tier,
      status: report.status,
      totalScore: report.totalScore,
      criticalFailureCount: report.criticalFailureCount,
      scenarioCount: report.scenarioCount,
      advancement: report.advancement,
      results: report.results.map((result) => ({
        scenarioId: result.scenarioId,
        status: result.status,
        score: result.score,
        intelligenceAdvancementScore: result.intelligenceAdvancementScore,
        advancementStatus: result.advancementStatus,
        sourcePatternIds: result.sourcePatternIds,
        criticalFailures: result.criticalFailures,
        rolesObserved: result.rolesObserved,
        missingRoles: result.missingRoles,
        providerFailures: result.providerFailures,
        councilRunId: result.councilRunId,
        repairPlanId: result.repairPlanId,
      })),
    },
    null,
    2,
  ),
);

if (
  report.status === 'fail' ||
  (options.failOnRegression && report.advancement?.status === 'regressed')
) {
  process.exitCode = 1;
}
