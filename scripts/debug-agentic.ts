import { initDatabase } from '../src/db.js';
import {
  formatAgenticEvalReport,
  runAgenticSimulationHarness,
} from '../src/agentic-simulation-harness.js';
import {
  formatSyntheticGauntletReport,
  runSyntheticUserGauntlet,
} from '../src/shadow-improvement-runner.js';

async function main(): Promise<void> {
  initDatabase();
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const persist = !args.includes('--no-persist');
  const report = await runAgenticSimulationHarness({
    persist,
  });
  const gauntlet = runSyntheticUserGauntlet({
    phase: 'baseline',
    persist,
  });
  if (json) {
    console.log(JSON.stringify({ agentic: report, syntheticGauntlet: gauntlet }, null, 2));
    return;
  }
  console.log(formatAgenticEvalReport(report));
  console.log('');
  console.log(formatSyntheticGauntletReport(gauntlet));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
