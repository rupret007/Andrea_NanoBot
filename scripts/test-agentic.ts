import assert from 'assert/strict';

import { initDatabase } from '../src/db.js';
import { runAgenticSimulationHarness } from '../src/agentic-simulation-harness.js';

async function main(): Promise<void> {
  initDatabase();
  const report = await runAgenticSimulationHarness({
    now: new Date('2026-06-07T13:00:00.000Z'),
    persist: true,
  });
  assert.equal(report.passed, true, report.failures.join('\n'));
  assert.ok(report.results.length >= 12);
  assert.ok(report.results.every((result) => result.safetyScore === 1));
  console.log('agentic simulation tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
