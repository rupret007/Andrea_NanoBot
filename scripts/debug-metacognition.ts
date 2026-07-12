import { initDatabase } from '../src/db.js';
import {
  buildMetacognitionDoctorReport,
  formatMetacognitionReport,
} from '../src/metacognition.js';
import { resolveDebugExecutionPolicy } from '../src/debug-execution-policy.js';

initDatabase();

const args = process.argv.slice(2);
const json = args.includes('--json');
const { persist } = resolveDebugExecutionPolicy(args);
const latestOnly = args.includes('--latest');
const subjectIndex = args.indexOf('--subject');
const requestText = subjectIndex >= 0 ? args[subjectIndex + 1] || null : null;
const report = buildMetacognitionDoctorReport({
  requestText:
    requestText ||
    (latestOnly
      ? undefined
      : 'What is the current system reasoning, evidence, and proof status?'),
  persist,
});

console.log(
  json ? JSON.stringify(report, null, 2) : formatMetacognitionReport(report),
);
