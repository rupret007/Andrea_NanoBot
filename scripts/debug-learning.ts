import { initDatabase } from '../src/db.js';
import {
  buildLearningDistillationReport,
  formatLearningDistillationReport,
} from '../src/memory-distillation.js';

initDatabase();

const args = process.argv.slice(2);
const json = args.includes('--json');
const groupIndex = args.indexOf('--group');
const groupFolder = groupIndex >= 0 ? args[groupIndex + 1] || null : null;
const report = buildLearningDistillationReport({ groupFolder });

console.log(
  json ? JSON.stringify(report, null, 2) : formatLearningDistillationReport(report),
);
