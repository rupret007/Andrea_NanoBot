import {
  buildAgencyConvergenceDoctorReport,
  formatAgencyConvergenceDoctorReport,
  runAgencyConvergenceLoop,
} from '../src/agency-convergence-loop.js';
import { initDatabase } from '../src/db.js';

initDatabase();

const args = process.argv.slice(2);
const json = args.includes('--json');
const execute = args.includes('--execute');
const agendaOnly = args.includes('--agenda');
const resumeOnly = args.includes('--resume');
const runIndex = args.indexOf('--run');
const intentIndex = args.indexOf('--intent');
const modeIndex = args.indexOf('--mode');
const convergenceRunId = runIndex >= 0 ? args[runIndex + 1] || null : null;
const intentText = intentIndex >= 0 ? args[intentIndex + 1] || '' : '';
const mode =
  modeIndex >= 0
    ? (args[modeIndex + 1] as 'off' | 'shadow' | 'assistive' | undefined)
    : undefined;

const report = execute
  ? await runAgencyConvergenceLoop({
      intentText,
      mode,
    })
  : buildAgencyConvergenceDoctorReport({
      convergenceRunId,
    });

if (agendaOnly) {
  const output = {
    generatedAt: report.generatedAt,
    latestRun: report.latestRun,
    agendas: report.agendas,
    decisions: report.decisions,
    providerPlans: report.providerPlans,
    actionQueue: report.sessionGraph.cockpit.actionQueue,
    nextAction: report.nextAction,
    privacy: report.privacy,
  };
  console.log(
    json
      ? JSON.stringify(output, null, 2)
      : [
          'Agency Convergence Agenda',
          '',
          `Run: ${report.latestRun?.convergenceRunId || 'none'}`,
          ...report.agendas.map(
            (agenda) =>
              `- ${agenda.policyClass}/${agenda.status}: ${agenda.nextAction}`,
          ),
          '',
          `Next: ${report.nextAction}`,
        ].join('\n'),
  );
  process.exit(0);
}

if (resumeOnly) {
  const output = {
    generatedAt: report.generatedAt,
    latestRun: report.latestRun,
    resumePlans: report.resumePlans,
    nextAction: report.resumePlans[0]?.nextAction || report.nextAction,
    privacy: report.privacy,
  };
  console.log(
    json
      ? JSON.stringify(output, null, 2)
      : [
          'Agency Convergence Resume',
          '',
          `Run: ${report.latestRun?.convergenceRunId || 'none'}`,
          ...report.resumePlans.map(
            (plan) =>
              `- ${plan.status}: ${plan.summary} Next: ${plan.nextAction}`,
          ),
          '',
          `Next: ${output.nextAction}`,
        ].join('\n'),
  );
  process.exit(0);
}

console.log(
  json
    ? JSON.stringify(report, null, 2)
    : formatAgencyConvergenceDoctorReport(report),
);
