import { initDatabase } from '../src/db.js';
import {
  buildAutonomousImprovementLabReport,
  formatAutonomousImprovementLabReport,
} from '../src/autonomous-improvement-lab.js';
import {
  buildShadowImprovementReport,
  formatShadowImprovementReport,
} from '../src/shadow-improvement-runner.js';

initDatabase();

const args = process.argv.slice(2);
const json = args.includes('--json');
const dryRun = args.includes('--dry-run');
const shadow = args.includes('--shadow');

if (shadow) {
  const report = buildShadowImprovementReport({ persist: !dryRun });
  console.log(
    json ? JSON.stringify(report, null, 2) : formatShadowImprovementReport(report),
  );
  process.exit(0);
}

const report = buildAutonomousImprovementLabReport({ persist: !dryRun });

console.log(
  json ? JSON.stringify(report, null, 2) : formatAutonomousImprovementLabReport(report),
);
