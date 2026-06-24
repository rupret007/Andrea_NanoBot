import { initDatabase } from '../src/db.js';
import {
  buildPersonalContextGraph,
  formatPersonalContextGraphHealth,
} from '../src/personal-context-graph.js';

initDatabase();

const args = process.argv.slice(2);
const json = args.includes('--json');
const groupIndex = args.indexOf('--group');
const groupFolder = groupIndex >= 0 ? args[groupIndex + 1] || 'main' : 'main';

const report = buildPersonalContextGraph({
  groupFolder,
  now: new Date(),
});

console.log(
  json
    ? JSON.stringify(report, null, 2)
    : formatPersonalContextGraphHealth(report),
);
