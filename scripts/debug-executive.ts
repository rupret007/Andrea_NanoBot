import { initDatabase } from '../src/db.js';
import {
  buildStoredCognitiveExecutiveReport,
  formatCognitiveExecutiveReport,
} from '../src/cognitive-executive.js';
import {
  buildToolReliabilityDoctorReport,
  formatToolReliabilityReport,
  refreshToolReliabilityFromCurrentTruth,
} from '../src/tool-reliability.js';

async function main(): Promise<void> {
  initDatabase();
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const refresh = args.includes('--refresh');
  if (refresh) {
    await refreshToolReliabilityFromCurrentTruth();
  }
  const executive = buildStoredCognitiveExecutiveReport();
  const reliability = buildToolReliabilityDoctorReport();
  if (json) {
    console.log(JSON.stringify({ executive, reliability }, null, 2));
    return;
  }
  console.log(formatCognitiveExecutiveReport(executive));
  console.log('');
  console.log(formatToolReliabilityReport(reliability));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
