import { initDatabase } from '../src/db.js';
import {
  applyEpisodeRetention,
  buildEpisodeMemoryReport,
  formatEpisodeMemoryReport,
} from '../src/cognitive-episodes.js';

initDatabase();

const args = process.argv.slice(2);
const json = args.includes('--json');

if (args.includes('--apply-retention')) {
  const pruned = applyEpisodeRetention();
  console.log(`Retention applied: ${pruned} episode(s) pruned.`);
}

const report = buildEpisodeMemoryReport();
console.log(
  json ? JSON.stringify(report, null, 2) : formatEpisodeMemoryReport(report),
);
