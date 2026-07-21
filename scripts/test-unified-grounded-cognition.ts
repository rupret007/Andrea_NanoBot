import assert from 'node:assert/strict';

import {
  runUnifiedCognitionEvaluation,
  UNIFIED_COGNITION_SCENARIOS,
} from '../src/unified-grounded-cognition-eval.js';

const report = runUnifiedCognitionEvaluation();

console.log(
  JSON.stringify(
    {
      baseline: report.baseline,
      scenarioCount: report.scenarioCount,
      baselineScore: report.baselineScore,
      candidateScore: report.candidateScore,
      improvementPoints: report.improvementPoints,
      p95LatencyMs: report.p95LatencyMs,
      maxContextChars: report.maxContextChars,
      maxMetadataChars: report.maxMetadataChars,
      comparisonModes: report.comparisonModes,
      weakestCategories: report.weakestCategories,
      categoryScores: report.categoryScores,
    },
    null,
    2,
  ),
);

const failures = report.results.filter(
  (result) =>
    result.actualPosture !== result.expectedPosture ||
    result.authorityViolation ||
    result.privacyViolation ||
    result.unsupportedCompletion ||
    result.clauseOrTargetLoss ||
    result.syntheticLearningLeak ||
    result.staleApprovalReuse ||
    result.terminalGoalResurrection ||
    result.providerGoalConflation,
);
if (failures.length > 0) {
  console.error('Scenario failures:');
  console.error(JSON.stringify(failures, null, 2));
}

assert.ok(
  UNIFIED_COGNITION_SCENARIOS.length >= 60,
  'at least 60 frozen scenarios are required',
);
assert.ok(
  Object.values(report.gates).every(Boolean),
  `acceptance gates failed: ${JSON.stringify(report.gates)}`,
);

console.log('');
console.log('test-unified-grounded-cognition: all checks passed.');
