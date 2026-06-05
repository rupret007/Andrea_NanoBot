import {
  buildCognitiveDoctorReport,
  buildCognitiveResumePlan,
  buildCognitiveTraceReport,
  formatCognitiveDoctorReport,
  formatCognitiveTraceReport,
  runCognitiveBenchmarkSuite,
} from '../src/cognitive-kernel.js';
import { initDatabase } from '../src/db.js';
import {
  collectProviderHealthSnapshotsWithLiveProbe,
} from '../src/provider-live-probe.js';

initDatabase();

const args = process.argv.slice(2);
const json = args.includes('--json');
const runBenchmarks = args.includes('--benchmarks');
const resume = args.includes('--resume');
const trace = args.includes('--trace');
const configOnly = args.includes('--config-only');

async function main(): Promise<void> {
  if (runBenchmarks) {
    const report = runCognitiveBenchmarkSuite();
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.status === 'fail' ? 1 : 0);
  }

  if (resume) {
    const plan = buildCognitiveResumePlan();
    if (json) {
      console.log(JSON.stringify(plan, null, 2));
    } else {
      console.log(
        [
          'Cognition Resume',
          '',
          `Found: ${plan.found}`,
          `Run: ${plan.run?.runId || 'none'}`,
          `Goal: ${plan.goal?.goalId || 'none'}`,
          `Checkpoint: ${plan.checkpoint?.checkpointKind || 'none'}`,
          `Status: ${plan.checkpoint?.status || 'none'}`,
          `Blackboard entries: ${plan.blackboardEntries.length}`,
          `Subgoals: ${plan.subgoalCount}`,
          `Next: ${plan.nextAction}`,
          '',
          'Privacy: metadata-only; no raw prompts, private message bodies, hidden reasoning, or secrets are stored.',
        ].join('\n'),
      );
    }
    process.exit(0);
  }

  if (trace) {
    const runId = args
      .find((arg) => arg.startsWith('--run-id='))
      ?.split('=')
      .slice(1)
      .join('=') || null;
    const report = buildCognitiveTraceReport({ runId });
    if (json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatCognitiveTraceReport(report));
    }
    process.exit(report.ok ? 0 : 0);
  }

  const checkedAt = new Date().toISOString();
  const providerSnapshots = configOnly
    ? undefined
    : await collectProviderHealthSnapshotsWithLiveProbe(checkedAt);
  const report = buildCognitiveDoctorReport(checkedAt, providerSnapshots);

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatCognitiveDoctorReport(report));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
