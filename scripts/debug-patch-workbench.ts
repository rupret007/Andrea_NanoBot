import { initDatabase } from '../src/db.js';
import {
  buildPatchWorkbenchReport,
  formatPatchWorkbenchReport,
  type PatchWorkbenchMode,
} from '../src/patch-workbench.js';

initDatabase();

const args = process.argv.slice(2);
const json = args.includes('--json');
const noPersist = args.includes('--no-persist') || args.includes('--dry-run');
const mode: PatchWorkbenchMode = args.includes('--apply-low-risk')
  ? 'apply_low_risk'
  : args.includes('--prepare-workspace')
    ? 'prepare_workspace'
    : 'dry_run';

const report = buildPatchWorkbenchReport({
  mode,
  persist: !noPersist,
});

console.log(json ? JSON.stringify(report, null, 2) : formatPatchWorkbenchReport(report));
