import {
  formatIntelligenceRegressionReport,
  runIntelligenceRegressionHarness,
} from '../src/intelligence-regression-harness.js';

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(name);
}

function readScenarioIds(): string[] {
  return process.argv
    .slice(2)
    .filter((arg) => arg.startsWith('--scenario='))
    .flatMap((arg) =>
      arg
        .slice('--scenario='.length)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    );
}

function readNumberFlag(name: string, fallback: number): number {
  const prefix = `${name}=`;
  const raw = process.argv
    .slice(2)
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function main(): Promise<void> {
  process.env.PROVIDER_REQUEST_TIMEOUT_MS ||=
    process.env.INTELLIGENCE_REGRESSION_PROVIDER_TIMEOUT_MS || '5000';
  const baseline = hasFlag('--baseline');
  const noRecord = hasFlag('--no-record');
  const noReflect = hasFlag('--no-reflect');
  const quiet = hasFlag('--quiet');
  const scenarioIds = readScenarioIds();
  const scenarioTimeoutMs = readNumberFlag('--scenario-timeout-ms', 15_000);
  const report = await runIntelligenceRegressionHarness({
    mode: baseline ? 'baseline' : 'regression',
    recordToPlatform: !noRecord,
    reflectTurns: !noReflect,
    scenarioIds,
    scenarioTimeoutMs,
    onProgress: quiet
      ? undefined
      : (event) => {
          const status = event.status ? ` ${event.status}` : '';
          const score =
            typeof event.score === 'number'
              ? ` score=${event.score.toFixed(3)}`
              : '';
          console.error(
            `[intelligence-regression] ${event.phase} ${event.index}/${event.total} ${event.scenarioId}${status}${score}`,
          );
        },
  });
  console.log(formatIntelligenceRegressionReport(report));
  if (!baseline && report.criticalFailureCount > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
