import { initDatabase } from '../src/db.js';
import {
  buildLiveProofGauntletReport,
  formatLiveProofGauntletReport,
} from '../src/live-proof-gauntlet.js';
import {
  buildRealityGroundingReport,
  formatRealityGroundingReport,
} from '../src/reality-grounding.js';

initDatabase();

const args = process.argv.slice(2);
const json = args.includes('--json');
const report = buildLiveProofGauntletReport();
const reality = buildRealityGroundingReport({
  proofReport: report,
  requestText: 'proof gauntlet reality explanation',
  channel: 'operator',
  persist: false,
});

console.log(
  json
    ? JSON.stringify({ ...report, reality }, null, 2)
    : [
        formatLiveProofGauntletReport(report),
        '',
        '*Reality / Truth Maintenance*',
        formatRealityGroundingReport(reality),
      ].join('\n'),
);
