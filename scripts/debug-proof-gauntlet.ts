import { initDatabase } from '../src/db.js';
import {
  buildLiveProofGauntletReport,
  formatLiveProofGauntletReport,
} from '../src/live-proof-gauntlet.js';

initDatabase();

const args = process.argv.slice(2);
const json = args.includes('--json');
const report = buildLiveProofGauntletReport();

console.log(json ? JSON.stringify(report, null, 2) : formatLiveProofGauntletReport(report));
