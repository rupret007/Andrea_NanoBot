import {
  beginCognitiveKernelRun,
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
const taskDrill = args.includes('--task-drill');
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

  if (taskDrill) {
    const checkedAt = new Date().toISOString();
    const providerSnapshots = configOnly
      ? undefined
      : await collectProviderHealthSnapshotsWithLiveProbe(checkedAt);
    const run = beginCognitiveKernelRun({
      turnId: `debug-cognition-task-drill-${Date.now().toString(36)}`,
      channel: 'system',
      groupFolder: 'main',
      taskFamily: 'research',
      goal:
        'Run a safe cognition task drill: gather read-only status evidence, skip blocked providers honestly, and explain the next repair action.',
      requestRoute: 'debug:cognition:task-drill',
      selectedSkillId: 'research.live_status',
      selectedSkillPurpose:
        'Run a non-mutating task drill through the cognitive executor.',
      selectedSkillApprovalNeed: 'none',
      selectedSkillSideEffectRisk: 'low',
      selectedSkillEvidenceLevel: 'partial',
      providerHealthSnapshots: providerSnapshots,
      thinkingPreference: 'deep',
      thinkingTrigger: 'task-drill',
    });
    const report = buildCognitiveTraceReport({
      runId: run.run.runId,
      generatedAt: checkedAt,
    });
    if (json) {
      console.log(
        JSON.stringify(
          {
            status: report.ok ? 'pass' : 'warn',
            runId: run.run.runId,
            executionStatus: report.executionStatus,
            executedStepCount: report.executedStepCount,
            planRevisionCount: report.planRevisionCount,
            toolResults: report.replayPacket.toolResults.length,
            policyDecisions: report.replayPacket.policyDecisions.length,
            providerCooldowns: report.activeCooldownProviderIds,
            nextAction: report.nextAction,
            privacy: report.replayPacket.privacy,
          },
          null,
          2,
        ),
      );
    } else {
      console.log(formatCognitiveTraceReport(report));
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
