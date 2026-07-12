import { initDatabase } from '../src/db.js';
import {
  buildCognitiveBlackboard,
  formatBlackboardReport,
} from '../src/cognitive-blackboard.js';
import { resolveDebugExecutionPolicy } from '../src/debug-execution-policy.js';

initDatabase();

const args = process.argv.slice(2);
const json = args.includes('--json');
const { persist } = resolveDebugExecutionPolicy(args);
const subjectIndex = args.indexOf('--subject');
const requestText = subjectIndex >= 0 ? args[subjectIndex + 1] || null : null;

const record = buildCognitiveBlackboard({
  requestText: requestText || undefined,
  persist,
});

console.log(
  json ? JSON.stringify(record, null, 2) : formatBlackboardReport(record),
);
