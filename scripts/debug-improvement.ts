import { initDatabase } from '../src/db.js';
import {
  buildAutonomousImprovementLabReport,
  formatAutonomousImprovementLabReport,
} from '../src/autonomous-improvement-lab.js';
import {
  buildShadowImprovementReport,
  formatShadowImprovementReport,
} from '../src/shadow-improvement-runner.js';
import {
  buildPatchWorkbenchReport,
  formatPatchWorkbenchReport,
} from '../src/patch-workbench.js';
import {
  buildLiveProofGauntletReport,
  formatLiveProofGauntletReport,
} from '../src/live-proof-gauntlet.js';
import {
  buildRealityGroundingReport,
  formatRealityGroundingReport,
} from '../src/reality-grounding.js';
import {
  buildHierarchicalPlannerReport,
  formatGoalPlannerReport,
} from '../src/goal-planner.js';
import { resolveDebugExecutionPolicy } from '../src/debug-execution-policy.js';

initDatabase();

const args = process.argv.slice(2);
const json = args.includes('--json');
const executionPolicy = resolveDebugExecutionPolicy(args);
const { persist } = executionPolicy;
const shadow = args.includes('--shadow');
const workbench =
  args.includes('--workbench') || args.includes('--patch-workbench');
const proof = args.includes('--proof') || args.includes('--proof-gauntlet');

if (shadow) {
  const report = buildShadowImprovementReport({ persist });
  const patchWorkbench = buildPatchWorkbenchReport({
    mode: 'dry_run',
    persist,
  });
  const proofGauntlet = buildLiveProofGauntletReport();
  const reality = buildRealityGroundingReport({
    proofReport: proofGauntlet,
    requestText: 'shadow improvement reality gaps',
    channel: 'operator',
    persist: false,
  });
  const planner = buildHierarchicalPlannerReport({
    requestText: 'help me get Andrea closer to done',
    persist: false,
  });
  console.log(
    json
      ? JSON.stringify(
          { ...report, patchWorkbench, proofGauntlet, reality, planner },
          null,
          2,
        )
      : [
          formatShadowImprovementReport(report),
          '',
          formatPatchWorkbenchReport(patchWorkbench),
          '',
          formatLiveProofGauntletReport(proofGauntlet),
          '',
          formatRealityGroundingReport(reality),
          '',
          formatGoalPlannerReport(planner),
        ].join('\n'),
  );
  process.exit(0);
}

if (workbench) {
  const report = buildPatchWorkbenchReport({
    mode: args.includes('--apply-low-risk')
      ? 'apply_low_risk'
      : args.includes('--prepare-workspace')
        ? 'prepare_workspace'
        : 'dry_run',
    persist,
  });
  console.log(
    json ? JSON.stringify(report, null, 2) : formatPatchWorkbenchReport(report),
  );
  process.exit(0);
}

if (proof) {
  const report = buildLiveProofGauntletReport();
  console.log(
    json
      ? JSON.stringify(report, null, 2)
      : formatLiveProofGauntletReport(report),
  );
  process.exit(0);
}

const report = buildAutonomousImprovementLabReport({ persist });
const proofGauntlet = buildLiveProofGauntletReport();
const reality = buildRealityGroundingReport({
  proofReport: proofGauntlet,
  requestText: 'improvement lab reality gaps',
  channel: 'operator',
  persist: false,
});
const planner = buildHierarchicalPlannerReport({
  requestText: 'help me get Andrea closer to done',
  persist: false,
});

console.log(
  json
    ? JSON.stringify({ ...report, proofGauntlet, reality, planner }, null, 2)
    : [
        formatAutonomousImprovementLabReport(report),
        '',
        formatLiveProofGauntletReport(proofGauntlet),
        '',
        formatRealityGroundingReport(reality),
        '',
        formatGoalPlannerReport(planner),
      ].join('\n'),
);
