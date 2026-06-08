import { initDatabase } from '../src/db.js';
import {
  buildAutonomousImprovementLabReport,
  formatAutonomousImprovementLabReport,
} from '../src/autonomous-improvement-lab.js';

initDatabase();

const args = process.argv.slice(2);
const json = args.includes('--json');
const dryRun = args.includes('--dry-run');
const report = buildAutonomousImprovementLabReport({ persist: !dryRun });

console.log(
  json ? JSON.stringify(report, null, 2) : formatAutonomousImprovementLabReport(report),
);
