import {
  buildSupervisorDoctorReport,
  formatSupervisorDoctorReport,
} from '../src/supervisor-kernel.js';
import {
  initDatabase,
  listSupervisorBlackboardPatches,
  listSupervisorBlackboards,
} from '../src/db.js';

initDatabase();

const args = process.argv.slice(2);
const json = args.includes('--json');
const runIndex = args.indexOf('--run');
const blackboardIndex = args.indexOf('--blackboard');
const runtimeIndex = args.indexOf('--runtime');
const supervisorRunId = runIndex >= 0 ? args[runIndex + 1] || null : null;
const runtimeRunId = runtimeIndex >= 0 ? args[runtimeIndex + 1] || null : null;
const blackboardId = blackboardIndex >= 0 ? args[blackboardIndex + 1] || null : null;
const generatedAt = new Date().toISOString();

if (blackboardId) {
  const blackboard = listSupervisorBlackboards({ limit: 500 }).find(
    (item) => item.blackboardId === blackboardId,
  ) || null;
  const patches = listSupervisorBlackboardPatches({ blackboardId, limit: 200 });
  const output = {
    generatedAt,
    blackboard,
    patches,
    nextAction: blackboard
      ? blackboard.nextAction
      : 'No supervisor blackboard was found for that ID.',
    privacy: {
      metadataOnly: true,
      rawPromptsStored: false,
      rawPrivateBodiesStored: false,
      hiddenReasoningStored: false,
      rawToolOutputStored: false,
      secretsRedacted: true,
    },
  };
  console.log(
    json
      ? JSON.stringify(output, null, 2)
      : [
          'Supervisor Blackboard',
          '',
          `Blackboard: ${blackboardId}`,
          `Status: ${blackboard?.status || 'none'}`,
          `Patches: ${patches.length}`,
          `Rejected: ${patches.filter((patch) => patch.rejected).length}`,
          `Next: ${output.nextAction}`,
        ].join('\n'),
  );
  process.exit(0);
}

const report = buildSupervisorDoctorReport({
  supervisorRunId,
  runtimeRunId,
  generatedAt,
});

console.log(json ? JSON.stringify(report, null, 2) : formatSupervisorDoctorReport(report));
