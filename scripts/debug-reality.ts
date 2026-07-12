import { initDatabase } from '../src/db.js';
import {
  buildRealityGroundingReport,
  formatRealityGroundingReport,
} from '../src/reality-grounding.js';
import { resolveDebugExecutionPolicy } from '../src/debug-execution-policy.js';

initDatabase();

const args = process.argv.slice(2);
const json = args.includes('--json');
const { persist } = resolveDebugExecutionPolicy(args);
const subjectIndex = args.indexOf('--subject');
const subject = subjectIndex >= 0 ? args[subjectIndex + 1] || null : null;
const report = buildRealityGroundingReport({
  requestText: subject,
  channel: 'operator',
  persist,
});

console.log(
  json ? JSON.stringify(report, null, 2) : formatRealityGroundingReport(report),
);
