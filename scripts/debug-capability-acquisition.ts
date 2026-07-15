import { initDatabase } from '../src/db.js';
import {
  buildCapabilityAcquisitionReport,
  formatCapabilityAcquisitionReport,
} from '../src/verified-capability-acquisition.js';

const args = process.argv.slice(2);
const json = args.includes('--json');
const groupIndex = args.indexOf('--group');
const groupFolder = groupIndex >= 0 ? args[groupIndex + 1] || 'main' : 'main';

initDatabase();

const report = buildCapabilityAcquisitionReport({ groupFolder });
console.log(
  json
    ? JSON.stringify(report, null, 2)
    : formatCapabilityAcquisitionReport(report),
);
