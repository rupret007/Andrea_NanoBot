import {
  beginAgentOSEpisode,
  buildAgentOSReport,
  discoverAgentOSToolCards,
  formatAgentOSPlanPreview,
  formatAgentOSReport,
  formatAgentOSReplayReport,
  previewAgentOSPlan,
  replayAgentOSPlan,
} from '../src/agent-os.js';
import { initDatabase } from '../src/db.js';
import { collectProviderHealthSnapshotsWithLiveProbe } from '../src/provider-live-probe.js';

initDatabase();

const args = process.argv.slice(2);
const json = args.includes('--json');
const discoverTools = args.includes('--discover-tools');
const taskDrill = args.includes('--task-drill');
const planOnlyIndex = args.indexOf('--plan-only');
const planOnlyGoal = planOnlyIndex >= 0 ? args[planOnlyIndex + 1] || '' : null;
const replayPlanIndex = args.indexOf('--replay-plan');
const replayPlanId = replayPlanIndex >= 0 ? args[replayPlanIndex + 1] || '' : null;
const episodeIndex = args.indexOf('--episode');
const episodeId = episodeIndex >= 0 ? args[episodeIndex + 1] || null : null;
const configOnly = args.includes('--config-only');

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();

  if (planOnlyGoal !== null) {
    const preview = previewAgentOSPlan({
      goal:
        planOnlyGoal ||
        'Inspect Andrea safely, gather read-only evidence, and explain the next action.',
      generatedAt,
    });
    const output = {
      generatedAt,
      status: preview.approvalRequired ? 'approval_staged' : 'pass',
      planId: preview.plan.planId,
      taskFamily: preview.plan.taskFamily,
      nodes: preview.nodes.length,
      approvalRequired: preview.approvalRequired,
      executableReadOnlyNodeCount: preview.executableReadOnlyNodeCount,
      nextAction: preview.nextAction,
      privacy: preview.privacy,
    };
    console.log(json ? JSON.stringify(output, null, 2) : formatAgentOSPlanPreview(preview));
    process.exit(0);
  }

  if (replayPlanId !== null) {
    const report = replayAgentOSPlan({
      planId: replayPlanId,
      generatedAt,
    });
    const output = {
      generatedAt,
      status: report.replay.status,
      planId: report.plan.planId,
      replayId: report.replay.replayId,
      plannerSkipped: report.replay.plannerSkipped,
      approvalRequired: report.replay.approvalRequired,
      replayedNodeCount: JSON.parse(report.replay.replayedNodeIdsJson).length,
      nextAction: report.nextAction,
      privacy: report.privacy,
    };
    console.log(json ? JSON.stringify(output, null, 2) : formatAgentOSReplayReport(report));
    process.exit(0);
  }

  if (discoverTools) {
    const toolCards = discoverAgentOSToolCards(generatedAt);
    const report = buildAgentOSReport({ generatedAt });
    const output = {
      generatedAt,
      status: toolCards.length > 0 ? 'pass' : 'warn',
      toolCards,
      capabilityDiscovery: report.capabilityDiscovery,
      nextAction: report.capabilityDiscovery.nextAction,
      privacy: report.privacy,
    };
    console.log(json ? JSON.stringify(output, null, 2) : formatAgentOSReport(report));
    process.exit(0);
  }

  if (taskDrill) {
    const providerSnapshots = configOnly
      ? undefined
      : await collectProviderHealthSnapshotsWithLiveProbe(generatedAt);
    const result = beginAgentOSEpisode({
      turnId: `agent-os-task-drill-${Date.now().toString(36)}`,
      channel: 'system',
      groupFolder: 'main',
      taskFamily: 'research',
      goal: 'Run an Agent OS episode drill: discover tools, gather read-only evidence metadata, verify source coverage, and stage any side effects.',
      requestRoute: 'debug:agent-os:task-drill',
      selectedSkillId: 'agent_os.episode_drill',
      selectedSkillPurpose:
        'Exercise durable episode orchestration and redacted replay surfaces.',
      selectedSkillApprovalNeed: 'none',
      selectedSkillSideEffectRisk: 'low',
      selectedSkillEvidenceLevel: 'partial',
      providerHealthSnapshots: providerSnapshots,
      thinkingPreference: 'deep',
      thinkingTrigger: 'agent-os-drill',
    });
    const output = {
      status: result.report.ok ? 'pass' : 'warn',
      episodeId: result.episode.episodeId,
      runId: result.kernel.run.runId,
      episodeStatus: result.episode.status,
      steps: result.report.episodeSteps.length,
      interrupts: result.report.interrupts.length,
      toolCards: result.report.toolCards.length,
      trajectoryScore: result.report.trajectoryEvals[0]?.overallScore ?? null,
      nextAction: result.report.nextAction,
      privacy: result.report.privacy,
    };
    console.log(json ? JSON.stringify(output, null, 2) : formatAgentOSReport(result.report));
    process.exit(0);
  }

  const report = buildAgentOSReport({ episodeId, generatedAt });
  console.log(json ? JSON.stringify(report, null, 2) : formatAgentOSReport(report));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
