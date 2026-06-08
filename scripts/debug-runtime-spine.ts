import {
  buildAgentRuntimeSpineReport,
  formatAgentRuntimeSpineReport,
} from '../src/agent-runtime-spine.js';
import { initDatabase, listAgentRuntimeEvents } from '../src/db.js';

initDatabase();

const args = process.argv.slice(2);
const json = args.includes('--json');
const runIndex = args.indexOf('--run');
const eventIndex = args.indexOf('--events');
const runtimeRunId =
  runIndex >= 0 ? args[runIndex + 1] || null : eventIndex >= 0 ? args[eventIndex + 1] || null : null;
const generatedAt = new Date().toISOString();

if (eventIndex >= 0 && runtimeRunId) {
  const events = listAgentRuntimeEvents({ runtimeRunId, limit: 200 });
  const output = {
    generatedAt,
    runtimeRunId,
    events,
    nextAction: events.length
      ? 'Use event summaries with runtime checkpoints to inspect why the route was chosen.'
      : 'No runtime events were found for that run ID.',
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
          'Agent Runtime Spine Events',
          '',
          `Run: ${runtimeRunId}`,
          `Events: ${events.length}`,
          ...events.map((event) => `- ${event.eventKind}/${event.severity}: ${event.summary}`),
          '',
          `Next: ${output.nextAction}`,
        ].join('\n'),
  );
  process.exit(0);
}

const report = buildAgentRuntimeSpineReport({ runtimeRunId, generatedAt });
console.log(json ? JSON.stringify(report, null, 2) : formatAgentRuntimeSpineReport(report));
