import {
  buildAgiLabReadinessReport,
  formatAgiLabReadinessReport,
} from '../src/agi-lab-readiness.js';
import { initDatabase } from '../src/db.js';

const args = process.argv.slice(2);
const json = args.includes('--json');
const fullRegression = args.includes('--full-regression');
const failOnHold = args.includes('--fail-on-hold');
const failOnBlock = args.includes('--fail-on-block');
const groupIndex = args.indexOf('--group');
const groupFolder = groupIndex >= 0 ? args[groupIndex + 1] || 'main' : 'main';

initDatabase();

const report = await buildAgiLabReadinessReport({
  groupFolder,
  fullRegression,
});

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(formatAgiLabReadinessReport(report));
  console.log(
    `Regression mode: ${
      fullRegression
        ? 'full intelligence harness'
        : 'local safety summary (add --full-regression for the full harness)'
    }.`,
  );
}

if (failOnHold && report.decision !== 'advance') {
  process.exitCode = 1;
} else if (failOnBlock && report.decision === 'block') {
  process.exitCode = 1;
}
