import '../src/channels/index.js';

import { initDatabase } from '../src/db.js';
import {
  buildCapabilitySelfModel,
  formatCapabilityReport,
} from '../src/capability-self-model.js';
import { resolveDebugExecutionPolicy } from '../src/debug-execution-policy.js';
import { registerProductionRuntimeCapabilitySurfaces } from '../src/runtime-capability-production-surfaces.js';
import { runtimeCapabilityRegistry } from '../src/runtime-capability-registry.js';

registerProductionRuntimeCapabilitySurfaces(runtimeCapabilityRegistry);
initDatabase();

const args = process.argv.slice(2);
const json = args.includes('--json');
const { persist } = resolveDebugExecutionPolicy(args);

const report = buildCapabilitySelfModel({ persist });
console.log(
  json ? JSON.stringify(report, null, 2) : formatCapabilityReport(report),
);
