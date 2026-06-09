import { initDatabase } from '../src/db.js';
import {
  buildProactiveOpportunityReport,
  formatProactiveOpportunityReport,
} from '../src/proactive-opportunities.js';

initDatabase();

const args = process.argv.slice(2);
const json = args.includes('--json');
const report = buildProactiveOpportunityReport({
  persist: !args.includes('--no-persist'),
});

console.log(
  json ? JSON.stringify(report, null, 2) : formatProactiveOpportunityReport(report),
);
