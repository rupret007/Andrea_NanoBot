import { initDatabase } from '../src/db.js';
import {
  buildProactiveOpportunityReport,
  formatProactiveOpportunityReport,
} from '../src/proactive-opportunities.js';
import { resolveDebugExecutionPolicy } from '../src/debug-execution-policy.js';

initDatabase();

const args = process.argv.slice(2);
const json = args.includes('--json');
const { persist } = resolveDebugExecutionPolicy(args);
const report = buildProactiveOpportunityReport({
  persist,
});

console.log(
  json
    ? JSON.stringify(report, null, 2)
    : formatProactiveOpportunityReport(report),
);
