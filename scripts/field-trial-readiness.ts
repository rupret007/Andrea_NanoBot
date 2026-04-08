import { initDatabase } from '../src/db.js';
import { buildFieldTrialOperatorTruth } from '../src/field-trial-readiness.js';

function main(): void {
  initDatabase();
  const truth = buildFieldTrialOperatorTruth();
  console.log(JSON.stringify(truth));
}

main();
