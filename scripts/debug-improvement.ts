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

initDatabase();

const args = process.argv.slice(2);
const json = args.includes('--json');
const dryRun = args.includes('--dry-run');
const shadow = args.includes('--shadow');
const workbench = args.includes('--workbench') || args.includes('--patch-workbench');
const proof = args.includes('--proof') || args.includes('--proof-gauntlet');

if (shadow) {
  const report = buildShadowImprovementReport({ persist: !dryRun });
  const patchWorkbench = buildPatchWorkbenchReport({
    mode: 'dry_run',
    persist: !dryRun,
  });
  const proofGauntlet = buildLiveProofGauntletReport();
  console.log(
    json
      ? JSON.stringify({ ...report, patchWorkbench, proofGauntlet }, null, 2)
      : [
          formatShadowImprovementReport(report),
          '',
          formatPatchWorkbenchReport(patchWorkbench),
          '',
          formatLiveProofGauntletReport(proofGauntlet),
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
    persist: !dryRun,
  });
  console.log(
    json ? JSON.stringify(report, null, 2) : formatPatchWorkbenchReport(report),
  );
  process.exit(0);
}

if (proof) {
  const report = buildLiveProofGauntletReport();
  console.log(
    json ? JSON.stringify(report, null, 2) : formatLiveProofGauntletReport(report),
  );
  process.exit(0);
}

const report = buildAutonomousImprovementLabReport({ persist: !dryRun });
const proofGauntlet = buildLiveProofGauntletReport();

console.log(
  json
    ? JSON.stringify({ ...report, proofGauntlet }, null, 2)
    : [formatAutonomousImprovementLabReport(report), '', formatLiveProofGauntletReport(proofGauntlet)].join(
        '\n',
      ),
);
