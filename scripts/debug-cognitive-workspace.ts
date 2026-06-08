import {
  buildCognitiveWorkspaceReport,
  buildStoredCognitiveWorkspaceReport,
  formatCognitiveWorkspaceReport,
} from '../src/cognitive-workspace.js';
import { initDatabase } from '../src/db.js';

initDatabase();

const args = process.argv.slice(2);
const json = args.includes('--json');
const optimize = args.includes('--optimize');
const execute = args.includes('--execute');
const stored = args.includes('--stored');
const packetIndex = args.indexOf('--packet');
const intentIndex = args.indexOf('--intent');
const packetId = packetIndex >= 0 ? args[packetIndex + 1] || null : null;
const intentText = intentIndex >= 0 ? args[intentIndex + 1] || '' : '';
const generatedAt = new Date().toISOString();

const report =
  stored && !packetId
    ? buildStoredCognitiveWorkspaceReport({ generatedAt })
    : await buildCognitiveWorkspaceReport({
        generatedAt,
        packetId,
        optimize,
        executeAgencyLoop: execute,
        intentText,
      });

if (optimize) {
  const output = {
    generatedAt,
    packet: report.packet?.packetId || null,
    selectedProgram: report.packet?.selectedProgramId || null,
    scorecards: report.optimizationScorecards,
    proposals: report.improvementProposals,
    nextAction: report.nextAction,
    privacy: report.privacy,
  };
  console.log(json ? JSON.stringify(output, null, 2) : formatCognitiveWorkspaceReport(report));
  process.exit(0);
}

console.log(json ? JSON.stringify(report, null, 2) : formatCognitiveWorkspaceReport(report));
