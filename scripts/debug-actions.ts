import { initDatabase } from '../src/db.js';
import {
  buildActionLifecycleReport,
  formatActionLifecycleReport,
  syncActionIntentsFromSources,
} from '../src/action-lifecycle.js';

initDatabase();

const args = process.argv.slice(2);
const json = args.includes('--json');
const sync = args.includes('--sync');

if (sync) {
  const result = syncActionIntentsFromSources({});
  console.log(
    `Synced ${result.synced} intent(s): ${JSON.stringify(result.bySource)}`,
  );
}

const report = buildActionLifecycleReport();
console.log(
  json ? JSON.stringify(report, null, 2) : formatActionLifecycleReport(report),
);
