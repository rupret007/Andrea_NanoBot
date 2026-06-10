import { initDatabase } from '../src/db.js';
import {
  buildMetacognitionDoctorReport,
  formatWorkingMemoryReport,
} from '../src/metacognition.js';

initDatabase();

const args = process.argv.slice(2);
const json = args.includes('--json');
const noPersist = args.includes('--no-persist');
const subjectIndex = args.indexOf('--subject');
const requestText = subjectIndex >= 0 ? args[subjectIndex + 1] || null : null;
const report = buildMetacognitionDoctorReport({
  requestText: requestText || undefined,
  persist: !noPersist,
});

console.log(json ? JSON.stringify(report, null, 2) : formatWorkingMemoryReport(report));
