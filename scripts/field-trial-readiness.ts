import { buildFieldTrialOperatorTruth } from '../src/field-trial-readiness.js';

function main(): void {
  const truth = buildFieldTrialOperatorTruth();
  console.log(JSON.stringify(truth));
}

main();
