import {
  formatIntelligenceRegressionReport,
  runIntelligenceRegressionHarness,
} from '../src/intelligence-regression-harness.js';

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(name);
}

async function main(): Promise<void> {
  const baseline = hasFlag('--baseline');
  const noRecord = hasFlag('--no-record');
  const noReflect = hasFlag('--no-reflect');
  const report = await runIntelligenceRegressionHarness({
    mode: baseline ? 'baseline' : 'regression',
    recordToPlatform: !noRecord,
    reflectTurns: !noReflect,
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
