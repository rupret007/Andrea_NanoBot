import '../src/channels/index.js';

import { initDatabase } from '../src/db.js';
import {
  formatDogfoodGauntletReport,
  runDogfoodGauntlet,
} from '../src/dogfood-gauntlet.js';
import { registerProductionRuntimeCapabilitySurfaces } from '../src/runtime-capability-production-surfaces.js';
import { runtimeCapabilityRegistry } from '../src/runtime-capability-registry.js';

registerProductionRuntimeCapabilitySurfaces(runtimeCapabilityRegistry);
initDatabase();

const args = process.argv.slice(2);
const json = args.includes('--json');
const persist = !args.includes('--no-persist');

const report = runDogfoodGauntlet({ persist });

console.log(
  json ? JSON.stringify(report, null, 2) : formatDogfoodGauntletReport(report),
);
