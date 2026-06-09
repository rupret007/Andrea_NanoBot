import { initDatabase } from '../src/db.js';
import {
  buildHierarchicalPlannerReport,
  formatGoalPlannerReport,
} from '../src/goal-planner.js';

initDatabase();

const args = process.argv.slice(2);
const json = args.includes('--json');
const requestArgIndex = args.findIndex((arg) => arg === '--request');
const requestText =
  requestArgIndex >= 0 ? args.slice(requestArgIndex + 1).join(' ') : undefined;
const report = buildHierarchicalPlannerReport({
  requestText,
  persist: !args.includes('--no-persist'),
});

console.log(json ? JSON.stringify(report, null, 2) : formatGoalPlannerReport(report));
