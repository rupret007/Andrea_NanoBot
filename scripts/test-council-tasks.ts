import {
  buildCouncilTaskEaseReport,
  formatCouncilTaskEaseReport,
} from '../src/council-task-drills.js';
import { initDatabase } from '../src/db.js';

initDatabase();

const json = process.argv.includes('--json');
const report = buildCouncilTaskEaseReport({ recordOutcomeSignal: true });

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(formatCouncilTaskEaseReport(report));
}

if (report.status === 'fail') {
  process.exitCode = 1;
}
