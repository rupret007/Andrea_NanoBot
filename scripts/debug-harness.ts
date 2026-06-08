import {
  buildHarnessLabReport,
  formatHarnessLabReport,
  runHarnessLab,
  runRhoHarnessReplay,
} from '../src/harness-lab.js';
import { initDatabase } from '../src/db.js';

initDatabase();

const args = process.argv.slice(2);
const json = args.includes('--json');
const rho = args.includes('--rho');
const stored = args.includes('--stored');
const generatedAt = new Date().toISOString();

const report = rho
  ? runRhoHarnessReplay({ generatedAt })
  : stored
    ? buildHarnessLabReport({ generatedAt, ensureSeeded: false })
    : runHarnessLab({ generatedAt });

const output = {
  generatedAt,
  status: report.ok ? 'pass' : 'warn',
  trajectories: report.trajectories.length,
  scorecards: report.scorecards.length,
  averageScore: report.averageScore,
  proposals: report.proposals.length,
  failingTaskFamilies: report.failingTaskFamilies,
  nextAction: report.nextAction,
  privacy: report.privacy,
};

console.log(json ? JSON.stringify(output, null, 2) : formatHarnessLabReport(report));
