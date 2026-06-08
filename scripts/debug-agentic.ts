import { initDatabase } from '../src/db.js';
import {
  formatAgenticEvalReport,
  runAgenticSimulationHarness,
} from '../src/agentic-simulation-harness.js';

async function main(): Promise<void> {
  initDatabase();
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const report = await runAgenticSimulationHarness({
    persist: !args.includes('--no-persist'),
  });
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(formatAgenticEvalReport(report));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
