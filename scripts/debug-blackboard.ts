import { initDatabase } from '../src/db.js';
import {
  buildCognitiveBlackboard,
  formatBlackboardReport,
} from '../src/cognitive-blackboard.js';

initDatabase();

const args = process.argv.slice(2);
const json = args.includes('--json');
const noPersist = args.includes('--no-persist');
const subjectIndex = args.indexOf('--subject');
const requestText = subjectIndex >= 0 ? args[subjectIndex + 1] || null : null;

const record = buildCognitiveBlackboard({
  requestText: requestText || undefined,
  persist: !noPersist,
});

console.log(
  json ? JSON.stringify(record, null, 2) : formatBlackboardReport(record),
);
