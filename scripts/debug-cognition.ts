import {
  beginCognitiveKernelRun,
  buildCognitiveDoctorReport,
  buildCognitiveResumePlan,
  buildCognitiveTraceReport,
  formatCognitiveDoctorReport,
  formatCognitiveTraceReport,
  runCognitiveBenchmarkSuite,
} from '../src/cognitive-kernel.js';
import { initDatabase, listCognitiveTrajectoryScores } from '../src/db.js';
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
const trajectory = args.includes('--trajectory');
const executeDrillIndex = args.indexOf('--execute-drill');
const executeDrill =
  executeDrillIndex >= 0
    ? args[executeDrillIndex + 1] || 'research'
    : null;

const drillConfig: Record<
  string,
  {
    taskFamily: 'calendar' | 'research' | 'communication' | 'operator';
    selectedSkillId: string;
    selectedSkillPurpose: string;
    selectedSkillApprovalNeed: string;
    selectedSkillSideEffectRisk: string;
    selectedSkillEvidenceLevel: string;
    goal: string;
    channel: 'telegram' | 'bluebubbles' | 'system';
    requestRoute: string;
  }
> = {
  calendar: {
    taskFamily: 'calendar',
    selectedSkillId: 'calendar.read',
    selectedSkillPurpose:
      'Gather calendar read status/evidence without changing events.',
    selectedSkillApprovalNeed: 'none',
    selectedSkillSideEffectRisk: 'low',
    selectedSkillEvidenceLevel: 'partial',
    goal:
      'Run a calendar read-only executor drill: gather schedule evidence and explain blockers without writing calendar data.',
    channel: 'telegram',
    requestRoute: 'debug:cognition:execute-drill:calendar',
  },
  research: {
    taskFamily: 'research',
    selectedSkillId: 'research.live_status',
    selectedSkillPurpose:
      'Gather local-first research evidence and only use live public search when needed.',
    selectedSkillApprovalNeed: 'none',
    selectedSkillSideEffectRisk: 'low',
    selectedSkillEvidenceLevel: 'partial',
    goal:
      'Run a research read-only executor drill: gather public evidence metadata, skip blocked providers honestly, and explain the next repair action.',
    channel: 'system',
    requestRoute: 'debug:cognition:execute-drill:research',
  },
  bluebubbles: {
    taskFamily: 'communication',
    selectedSkillId: 'communication.reply_help',
    selectedSkillPurpose:
      'Gather BlueBubbles proof/thread metadata and stage any send-adjacent action for approval.',
    selectedSkillApprovalNeed: 'explicit',
    selectedSkillSideEffectRisk: 'high',
    selectedSkillEvidenceLevel: 'partial',
    goal:
      'Run a BlueBubbles bounded executor drill from sanitized metadata. Do not send messages; create an approval packet if a draft/send action appears.',
    channel: 'bluebubbles',
    requestRoute: 'debug:cognition:execute-drill:bluebubbles',
  },
  operator: {
    taskFamily: 'operator',
    selectedSkillId: 'operator.diagnostics',
    selectedSkillPurpose:
      'Gather operator diagnostics and stage repair actions without mutating services.',
    selectedSkillApprovalNeed: 'explicit',
    selectedSkillSideEffectRisk: 'high',
    selectedSkillEvidenceLevel: 'partial',
    goal:
      'Run an operator read-only executor drill: inspect safe status metadata and stage any repair as approval-only.',
    channel: 'system',
    requestRoute: 'debug:cognition:execute-drill:operator',
  },
};

async function main(): Promise<void> {
  if (runBenchmarks) {
    const report = runCognitiveBenchmarkSuite();
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.status === 'fail' ? 1 : 0);
  }

  if (trajectory) {
    const scores = listCognitiveTrajectoryScores({ limit: 20 });
    const latest = scores[0] || null;
    const report = {
      generatedAt: new Date().toISOString(),
      status:
        !latest || latest.status === 'fail'
          ? 'warn'
          : latest.status === 'pass'
            ? 'pass'
            : 'warn',
      total: scores.length,
      latest,
      averageScore:
        scores.length > 0
          ? Number(
              (
                scores.reduce((sum, score) => sum + score.overallScore, 0) /
                scores.length
              ).toFixed(3),
            )
          : 0,
      demotedAdapters: latest
        ? JSON.parse(latest.demotedAdaptersJson || '[]')
        : [],
      nextAction:
        latest?.nextAction ||
        'Run npm run debug:cognition -- --execute-drill research --json to seed a trajectory score.',
      privacy: {
        metadataOnly: true,
        rawPromptsStored: false,
        rawPrivateBodiesStored: false,
        hiddenReasoningStored: false,
        secretsRedacted: true,
      },
    };
    if (json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(
        [
          'Cognition Trajectory',
          '',
          `Status: ${report.status}`,
          `Scores: ${report.total}`,
          `Average: ${report.averageScore}`,
          `Latest: ${latest?.trajectoryId || 'none'}`,
          `Latest score: ${latest?.overallScore ?? 'none'}`,
          `Latest status: ${latest?.status || 'none'}`,
          `Demoted adapters: ${report.demotedAdapters.join(', ') || 'none'}`,
          `Next: ${report.nextAction}`,
          '',
          'Privacy: metadata-only; no raw prompts, private message bodies, hidden reasoning, or secrets are stored.',
        ].join('\n'),
      );
    }
    process.exit(0);
  }

  if (executeDrill) {
    const key = executeDrill.toLowerCase();
    const config = drillConfig[key] || drillConfig.research;
    const checkedAt = new Date().toISOString();
    const providerSnapshots = configOnly
      ? undefined
      : await collectProviderHealthSnapshotsWithLiveProbe(checkedAt);
    const run = beginCognitiveKernelRun({
      turnId: `debug-cognition-execute-${key}-${Date.now().toString(36)}`,
      groupFolder: 'main',
      providerHealthSnapshots: providerSnapshots,
      thinkingPreference: key === 'research' || key === 'operator' ? 'deep' : null,
      thinkingTrigger: `execute-drill:${key}`,
      ...config,
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
            drill: key,
            runId: run.run.runId,
            runStatus: run.run.status,
            loopStatus: report.loopStatus,
            loopRoundCount: report.loopRoundCount,
            executionStatus: report.executionStatus,
            executedStepCount: report.executedStepCount,
            evidenceArtifacts: report.evidenceArtifactCount,
            stepVerifications: report.replayPacket.stepVerifications.length,
            approvalPackets: report.approvalPacketCount,
            trajectoryScore: report.trajectoryScore,
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
            loopStatus: report.loopStatus,
            loopRoundCount: report.loopRoundCount,
            evidenceArtifacts: report.evidenceArtifactCount,
            approvalPackets: report.approvalPacketCount,
            trajectoryScore: report.trajectoryScore,
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
