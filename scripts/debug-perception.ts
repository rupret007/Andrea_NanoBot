import { initDatabase } from '../src/db.js';
import {
  buildRealityGroundingReport,
  formatActivePerceptionReport,
} from '../src/reality-grounding.js';
import { resolveDebugExecutionPolicy } from '../src/debug-execution-policy.js';

initDatabase();

const args = process.argv.slice(2);
const json = args.includes('--json');
const { persist } = resolveDebugExecutionPolicy(args);
const requestIndex = args.indexOf('--request');
const requestText =
  requestIndex >= 0
    ? args[requestIndex + 1] || null
    : 'operator perception check';
const report = buildRealityGroundingReport({
  requestText,
  channel: 'operator',
  persist,
});

console.log(
  json
    ? JSON.stringify(
        {
          generatedAt: report.generatedAt,
          snapshotId: report.snapshot.snapshotId,
          perceptionPlan: report.perceptionPlan,
          probes: report.perceptionProbes,
          proofClosureSteps: report.proofClosureSteps,
          privacy: report.privacy,
        },
        null,
        2,
      )
    : formatActivePerceptionReport(report),
);
