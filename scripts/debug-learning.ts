import { initDatabase } from '../src/db.js';
import {
  buildLearningDistillationReport,
  formatLearningDistillationReport,
} from '../src/memory-distillation.js';
import {
  buildAutonomousImprovementLabReport,
  formatAutonomousImprovementLabReport,
} from '../src/autonomous-improvement-lab.js';

initDatabase();

const args = process.argv.slice(2);
const json = args.includes('--json');
const groupIndex = args.indexOf('--group');
const groupFolder = groupIndex >= 0 ? args[groupIndex + 1] || null : null;
const report = buildLearningDistillationReport({ groupFolder });
const improvement = buildAutonomousImprovementLabReport();

console.log(
  json
    ? JSON.stringify({ learning: report, improvement }, null, 2)
    : `${formatLearningDistillationReport(report)}\n\n${formatAutonomousImprovementLabReport(improvement)}`,
);
