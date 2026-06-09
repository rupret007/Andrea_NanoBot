import { initDatabase } from '../src/db.js';
import {
  buildRealityGroundingReport,
  formatProofGuidedReport,
} from '../src/reality-grounding.js';

initDatabase();

const args = process.argv.slice(2);
const json = args.includes('--json');
const noPersist = args.includes('--no-persist');
const report = buildRealityGroundingReport({
  requestText: 'guided proof closure',
  channel: 'operator',
  persist: !noPersist,
});

console.log(
  json
    ? JSON.stringify(
        {
          generatedAt: report.generatedAt,
          proofDebt: report.proofDebt,
          proofClosureSteps: report.proofClosureSteps,
          nextAction: report.nextAction,
          privacy: report.privacy,
        },
        null,
        2,
      )
    : formatProofGuidedReport(report),
);
