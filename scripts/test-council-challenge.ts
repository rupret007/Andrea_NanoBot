import {
  runCouncilChallengeHarness,
  type CouncilChallengeRunTier,
} from '../src/council-challenge-harness.js';

function parseArgs(): {
  tier: CouncilChallengeRunTier;
  recordToPlatform: boolean;
  createRepairPlans: boolean;
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
  };
}

const options = parseArgs();
const report = await runCouncilChallengeHarness(options);

console.log(
  JSON.stringify(
    {
      runId: report.runId,
      tier: report.tier,
      status: report.status,
      totalScore: report.totalScore,
      criticalFailureCount: report.criticalFailureCount,
      scenarioCount: report.scenarioCount,
      results: report.results.map((result) => ({
        scenarioId: result.scenarioId,
        status: result.status,
        score: result.score,
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

if (report.status === 'fail') {
  process.exitCode = 1;
}
