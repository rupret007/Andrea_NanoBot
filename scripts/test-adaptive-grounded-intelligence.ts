import assert from 'node:assert/strict';

import {
  ADAPTIVE_GROUNDED_INTELLIGENCE_SCENARIOS,
  runAdaptiveGroundedIntelligenceEvaluation,
} from '../src/adaptive-grounded-intelligence-eval.js';

const report = runAdaptiveGroundedIntelligenceEvaluation();

console.log('Adaptive Grounded Intelligence and Safe Activation v1');
console.log(
  `Scenarios: ${report.scenarioCount} across ${report.categoryCount} categories; repeats=${report.repeats}`,
);
console.log(
  `Scores: frozen_pre_unified=${report.scores.frozenPreUnifiedBaseline} unified_shadow=${report.scores.unifiedShadow} learned_shadow=${report.scores.unifiedShadowWithAcceptedLearning} simulated_canary=${report.scores.simulatedAssistiveCanary}`,
);
console.log(
  `Learning-relevant improvement: +${report.scores.learningRelevantImprovementPoints} points`,
);
console.log(
  `Promotion precision: ${(report.promotionPrecision * 100).toFixed(2)}%`,
);
console.log(
  `Bounds: p95=${report.latencyP95Ms}ms context_max=${report.maxContextChars} chars metadata_max=${report.maxMetadataChars} chars`,
);
console.log(`Assistive readiness: ${report.readiness.status}`);
console.log(`Deterministic digests: ${report.deterministicDigests.join(', ')}`);
console.log('Weakest learned categories:');
for (const category of report.weakestCategories) {
  console.log(
    `  ${category.category}: ${category.unifiedShadowScore} -> ${category.learnedShadowScore} (${category.improvementPoints >= 0 ? '+' : ''}${category.improvementPoints})`,
  );
}
const failures = Object.entries(report.gates).filter(([, passed]) => !passed);
if (failures.length) {
  console.error(`Failed gates: ${failures.map(([name]) => name).join(', ')}`);
  const scenarioFailures = report.results.filter(
    (item) =>
      !item.expectedCandidateObserved ||
      !item.promotionCorrect ||
      !item.lifecycleVerified ||
      item.authorityViolations > 0 ||
      item.privacyRegressions > 0 ||
      item.unsupportedCompletionClaims > 0 ||
      item.syntheticProductionLeaks > 0 ||
      item.lostIntentOrTargetCount > 0 ||
      item.automaticOwnerReviewPromotions > 0 ||
      !item.boundsPassed,
  );
  console.error(JSON.stringify(scenarioFailures, null, 2));
}

assert.ok(
  ADAPTIVE_GROUNDED_INTELLIGENCE_SCENARIOS.length >= 60,
  'at least 60 frozen scenarios are required',
);
assert.ok(
  Object.values(report.gates).every(Boolean),
  `adaptive grounded intelligence gates failed: ${JSON.stringify(report.gates)}`,
);
assert.equal(
  report.readiness.status,
  'shadow_ready',
  'fixtures may establish shadow readiness but never owner canary approval',
);

console.log('test-adaptive-grounded-intelligence: all checks passed.');
