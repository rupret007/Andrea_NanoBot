import fs from 'node:fs';
import path from 'node:path';

import { _initTestDatabase, initDatabase } from '../src/db.js';
import {
  buildIntelligenceProgressReport,
  formatIntelligenceProgressReport,
  makeIntelligenceProgressBaseline,
  type IntelligenceProgressBaseline,
} from '../src/intelligence-progress.js';
import { buildAgiLeapReadinessReport } from '../src/agi-leap-readiness.js';
import { buildCapabilitySelfModel } from '../src/capability-self-model.js';
import { buildLiveProofGauntletReport } from '../src/live-proof-gauntlet.js';
import { buildCognitiveDoctorReport } from '../src/cognitive-kernel.js';
import { runAgiGauntlet } from '../src/agi-gauntlet.js';
import {
  runIntelligenceRegressionHarness,
  type IntelligenceRegressionHarnessReport,
} from '../src/intelligence-regression-harness.js';

const args = process.argv.slice(2);
const json = args.includes('--json');
const saveBaseline = args.includes('--baseline');
const compare = args.includes('--compare');
const fullRegression = args.includes('--full-regression');
const groupIndex = args.indexOf('--group');
const groupFolder = groupIndex >= 0 ? args[groupIndex + 1] || 'main' : 'main';
const baselinePath = path.join(
  process.cwd(),
  'store',
  'intelligence-progress-baseline.json',
);

function readBaseline(): IntelligenceProgressBaseline | null {
  if (!fs.existsSync(baselinePath)) return null;
  try {
    return JSON.parse(
      fs.readFileSync(baselinePath, 'utf-8'),
    ) as IntelligenceProgressBaseline;
  } catch {
    return null;
  }
}

function writeBaseline(baseline: IntelligenceProgressBaseline): void {
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));
}

const now = new Date();
const generatedAt = now.toISOString();

// Read current live readiness first. No synthetic writes or live actions occur.
initDatabase();
const dailyAgentReport = buildAgiLeapReadinessReport({
  groupFolder,
  now,
});
const capabilityReport = buildCapabilitySelfModel({
  persist: false,
});
const proofReport = buildLiveProofGauntletReport({ now });
const cognition = buildCognitiveDoctorReport();
const cognitionTraceHealth =
  cognition.privacy.rawPrivateBodiesStored ||
  cognition.privacy.hiddenReasoningStored
    ? 0
    : 1;

// Run synthetic/eval harnesses against an isolated in-memory database.
_initTestDatabase();
const agiReport = runAgiGauntlet({
  now: generatedAt,
  persist: true,
});
const intelligenceRegressionReport: IntelligenceRegressionHarnessReport =
  fullRegression
    ? await runIntelligenceRegressionHarness({
        runId: `intel-progress-${now.getTime().toString(36)}`,
        recordToPlatform: false,
        reflectTurns: false,
      })
    : summarizeAgiSafetyAsRegressionReport(agiReport);

const baseline = compare ? readBaseline() : null;
const report = buildIntelligenceProgressReport(
  {
    generatedAt,
    groupFolder,
    agiReport,
    dailyAgentReport,
    intelligenceRegressionReport,
    capabilityReport,
    proofReport,
    cognitionTraceHealth,
  },
  baseline,
);

if (saveBaseline) {
  writeBaseline(makeIntelligenceProgressBaseline(report));
}

if (json) {
  console.log(
    JSON.stringify(
      {
        ...report,
        regressionMode: fullRegression ? 'full' : 'local_safety_summary',
        baselineSaved: saveBaseline,
        baselinePath: saveBaseline ? baselinePath : undefined,
      },
      null,
      2,
    ),
  );
} else {
  console.log(formatIntelligenceProgressReport(report));
  console.log(
    `Regression mode: ${
      fullRegression
        ? 'full intelligence harness'
        : 'local safety summary (add --full-regression for the full harness)'
    }.`,
  );
  if (saveBaseline) {
    console.log(`Saved redacted baseline: ${baselinePath}`);
  } else if (compare && !baseline) {
    console.log('No baseline found. Run with --baseline to create one.');
  }
}

if (report.promotionDecision === 'block') {
  process.exitCode = 1;
}

function summarizeAgiSafetyAsRegressionReport(
  agiReport: ReturnType<typeof runAgiGauntlet>,
): IntelligenceRegressionHarnessReport {
  const safetyScenarioIds = new Set([
    'ambiguous_action',
    'broken_tool',
    'recovery_problem',
    'safety_problem',
    'optional_surface_boundary',
  ]);
  const safetyScenarios = agiReport.results.filter((result) =>
    safetyScenarioIds.has(result.scenarioId),
  );
  const failed = safetyScenarios.filter(
    (result) => !result.passed || result.safetyRiskFlags.length > 0,
  );
  const criticalScore =
    safetyScenarios.length === 0
      ? 1
      : (safetyScenarios.length - failed.length) / safetyScenarios.length;
  return {
    runId: `intel-progress-local-${agiReport.runId}`,
    mode: 'regression',
    status: failed.length > 0 ? 'fail' : 'pass',
    totalScore: agiReport.totalScore,
    criticalScore,
    scenarioCount: agiReport.results.length,
    criticalFailureCount: failed.length,
    scenarios: [],
  };
}
