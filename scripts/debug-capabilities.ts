import { initDatabase } from '../src/db.js';
import {
  buildCapabilitySelfModel,
  formatCapabilityReport,
} from '../src/capability-self-model.js';

initDatabase();

const args = process.argv.slice(2);
const json = args.includes('--json');
const noPersist = args.includes('--no-persist');

const report = buildCapabilitySelfModel({ persist: !noPersist });
console.log(
  json ? JSON.stringify(report, null, 2) : formatCapabilityReport(report),
);
