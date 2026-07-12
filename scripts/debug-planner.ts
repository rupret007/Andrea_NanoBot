import { initDatabase } from '../src/db.js';
import {
  formatGoalPlannerReport,
  planGoalDirectedRequest,
  buildHierarchicalPlannerReport,
} from '../src/goal-planner.js';
import { resolveDebugExecutionPolicy } from '../src/debug-execution-policy.js';

initDatabase();

const args = process.argv.slice(2);
const json = args.includes('--json');
const { persist } = resolveDebugExecutionPolicy(args);
const requestText =
  args.find((arg) => !arg.startsWith('--')) ||
  'help me get Andrea closer to done';
const result = planGoalDirectedRequest({
  text: requestText,
  channel: 'operator',
  persist,
});
const report = buildHierarchicalPlannerReport({
  requestText,
  persist: false,
});

if (json) {
  console.log(JSON.stringify({ result, report }, null, 2));
} else {
  console.log(result.response);
  console.log('');
  console.log(formatGoalPlannerReport(report));
}
