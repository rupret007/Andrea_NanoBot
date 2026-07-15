import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  evaluateNovelCapabilityCertification,
  REQUIRED_NOVEL_CAPABILITY_HELD_OUT_SCENARIOS,
  REQUIRED_NOVEL_CAPABILITY_PRIMARY_SCENARIOS,
  type NovelCapabilityCertificationEvidence,
  type NovelCapabilityScenarioId,
  type NovelCapabilityScenarioEvidence,
} from './lib/novel-capability-certification-gate.js';
import {
  createNovelCapabilityFixtureLab,
  type NovelCapabilityFixtureLab,
} from './fixtures/novel-capability/fixture-lab.js';
import {
  NovelCapabilityProductionCertificationAdapter,
  type ProductionCertificationRun,
} from './fixtures/novel-capability/production-certification-adapter.js';

const PROVIDER_ENVIRONMENT_PATTERN =
  /^(?:ANTHROPIC|AWS|AZURE|BEDROCK|BRAVE|CLAUDE|COHERE|DEEPSEEK|EXA|FIREWORKS|GEMINI|GOOGLE|GROQ|HUGGINGFACE|LMSTUDIO|MINIMAX|MISTRAL|OLLAMA|ONECLI|OPENAI|OPENROUTER|PERPLEXITY|REPLICATE|SERPER|TAVILY|TOGETHER|VERTEX_AI|VLLM|VOYAGE|XAI)_/;

function failedScenario<TId extends NovelCapabilityScenarioId>(
  id: TId,
  suite: 'primary' | 'held_out',
): NovelCapabilityScenarioEvidence<TId> {
  return {
    id,
    suite,
    status: 'fail',
    terminalState: 'observed',
    successClaimed: false,
    lastEffectSequence: null,
    transitions: [
      {
        from: null,
        to: 'observed',
        version: 1,
        sequence: 1,
        idempotencyKey: `integration-failed:${id}`,
        evidenceIds: ['production_certification_execution_failed'],
      },
    ],
    verificationReceipts: [],
    safety: { checked: 0, passed: 0 },
    counters: {
      falseSuccesses: 0,
      unauthorizedExternalEffects: 0,
      duplicateEffects: 0,
      providerCalls: 0,
      costUsd: 0,
      fabricatedOwnerApprovals: 0,
      ownerReviewedOutcomes: 0,
      privacyLeaks: 0,
      malformedStates: 0,
    },
  };
}

function defaultCleanup(): NovelCapabilityCertificationEvidence['cleanup'] {
  return {
    manifestCreatedBeforeSeeding: false,
    manifestRemoved: false,
    databaseRemoved: false,
    walRemoved: false,
    shmRemoved: false,
    fixtureRootRemoved: false,
    liveChildCount: 0,
    openLoopbackServerCount: 0,
    isolatedResidueCount: 1,
    productionResidueCount: 1,
    errors: ['fixture_lab_not_initialized'],
  };
}

function childNetworkDenialProven(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        "fetch('https://novel-capability-child.invalid').then(() => process.exit(9)).catch((error) => { process.exit(error?.code === 'ANDREA_DETERMINISTIC_NETWORK_DENIED' ? 0 : 8); });",
      ],
      { env: process.env, shell: false, stdio: 'ignore' },
    );
    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
  });
}

async function parentNetworkDenialProven(): Promise<boolean> {
  try {
    await fetch('https://novel-capability-parent.invalid');
    return false;
  } catch (error) {
    return (
      (error as NodeJS.ErrnoException).code ===
      'ANDREA_DETERMINISTIC_NETWORK_DENIED'
    );
  }
}

function productionIsolationScan(): {
  fixtureImportCount: number;
  fixtureTokenMatchCount: number;
} {
  const sourceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'src',
  );
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile() && /\.(?:c|m)?(?:j|t)sx?$/.test(entry.name)) {
        files.push(candidate);
      }
    }
  };
  visit(sourceRoot);
  let fixtureImportCount = 0;
  let fixtureTokenMatchCount = 0;
  const tokens = [
    ...REQUIRED_NOVEL_CAPABILITY_PRIMARY_SCENARIOS,
    ...REQUIRED_NOVEL_CAPABILITY_HELD_OUT_SCENARIOS,
  ];
  for (const file of files) {
    const contents = fs.readFileSync(file, 'utf8');
    fixtureImportCount += (
      contents.match(
        /from\s+['"][^'"]*(?:fixtures\/novel-capability|novel-capability\/fixture)[^'"]*['"]/g,
      ) ?? []
    ).length;
    fixtureTokenMatchCount += tokens.filter((token) =>
      contents.includes(token),
    ).length;
  }
  return { fixtureImportCount, fixtureTokenMatchCount };
}

const hermeticParentProven =
  process.env.ANDREA_NOVEL_CAPABILITY_CERT_HERMETIC_PARENT === '1' &&
  process.env.ANDREA_TEST_NETWORK_GUARD_ACTIVE === '1';
const providerEnvironmentSuppressed = !Object.keys(process.env).some((key) =>
  PROVIDER_ENVIRONMENT_PATTERN.test(key),
);

let lab: NovelCapabilityFixtureLab | undefined;
let adapter: NovelCapabilityProductionCertificationAdapter | undefined;
let productionRun: ProductionCertificationRun | undefined;
let cleanup = defaultCleanup();
let fatalError: string | null = null;
let primaryPackDigest = '';
let heldOutPackDigest = '';
let publicOracleSeparated = false;
let benchmarkIsolationViolations = 1;
let parentNonLoopbackDenied = false;
let childNonLoopbackDenied = false;
let privacy: NovelCapabilityCertificationEvidence['privacy'] = {
  sentinelHashCount: 0,
  scannedSurfaceCount: 0,
  durableStateLeakCount: 0,
  logLeakCount: 0,
  reportLeakCount: 0,
  diagnosticLeakCount: 0,
};

try {
  lab = await createNovelCapabilityFixtureLab({ label: 'certification' });
  primaryPackDigest = lab.primaryPack.digest;
  heldOutPackDigest = lab.heldOutPack.digest;
  const isolation = lab.auditPublicOracleSeparation();
  publicOracleSeparated = isolation.passed;
  benchmarkIsolationViolations = isolation.violationCount;
  if (hermeticParentProven) {
    [parentNonLoopbackDenied, childNonLoopbackDenied] = await Promise.all([
      parentNetworkDenialProven(),
      childNetworkDenialProven(),
    ]);
  }
  adapter = new NovelCapabilityProductionCertificationAdapter(lab);
  productionRun = await adapter.runAll();
  adapter.close();

  const baseScan = lab.scanPrivateSentinels();
  const durableSurface = [
    lab.paths.databasePath,
    `${lab.paths.databasePath}-wal`,
    `${lab.paths.databasePath}-shm`,
  ]
    .filter((candidate) => fs.existsSync(candidate))
    .map((candidate) => fs.readFileSync(candidate).toString('latin1'))
    .join('\n');
  const reportSurface = JSON.stringify(
    productionRun.scenarios.map((scenario) => scenario.evidence),
  );
  const diagnosticSurface = JSON.stringify(
    productionRun.scenarios.flatMap((scenario) => scenario.diagnostics),
  );
  const durableScan = lab.scanPrivateSentinels([durableSurface]);
  const reportScan = lab.scanPrivateSentinels([reportSurface]);
  const diagnosticScan = lab.scanPrivateSentinels([diagnosticSurface]);
  const combinedScan = lab.scanPrivateSentinels([
    durableSurface,
    reportSurface,
    diagnosticSurface,
  ]);
  privacy = {
    sentinelHashCount: combinedScan.sentinelHashCount,
    scannedSurfaceCount: combinedScan.scannedSurfaceCount,
    durableStateLeakCount: durableScan.leakCount - baseScan.leakCount,
    logLeakCount: baseScan.leakCount,
    reportLeakCount: reportScan.leakCount - baseScan.leakCount,
    diagnosticLeakCount: diagnosticScan.leakCount - baseScan.leakCount,
  };
} catch (error) {
  fatalError = `production_certification_execution_failed:${
    error instanceof Error ? error.name : 'unknown_error'
  }`;
} finally {
  adapter?.close();
  if (lab) cleanup = await lab.dispose();
}

const scenarioMap = new Map(
  productionRun?.scenarios.map((scenario) => [
    scenario.scenario.certificationScenarioId,
    scenario.evidence,
  ]) ?? [],
);
const primaryScenarios = REQUIRED_NOVEL_CAPABILITY_PRIMARY_SCENARIOS.map(
  (id) =>
    (scenarioMap.get(id) ??
      failedScenario(id, 'primary')) as NovelCapabilityScenarioEvidence<
      (typeof REQUIRED_NOVEL_CAPABILITY_PRIMARY_SCENARIOS)[number]
    >,
);
const heldOutScenarios = REQUIRED_NOVEL_CAPABILITY_HELD_OUT_SCENARIOS.map(
  (id) =>
    (scenarioMap.get(id) ??
      failedScenario(id, 'held_out')) as NovelCapabilityScenarioEvidence<
      (typeof REQUIRED_NOVEL_CAPABILITY_HELD_OUT_SCENARIOS)[number]
    >,
);
let isolationScan = { fixtureImportCount: 1, fixtureTokenMatchCount: 1 };
try {
  isolationScan = productionIsolationScan();
} catch {
  fatalError ??= 'production_isolation_scan_failed';
}
const highestSyntheticState = productionRun?.scenarios.some((scenario) =>
  scenario.evidence.transitions.some(
    (transition) => transition.to === 'sandbox_verified',
  ),
)
  ? 'sandbox_verified'
  : 'candidate';
const productionActivated =
  productionRun?.scenarios.some(
    (scenario) =>
      scenario.record.state === 'active' ||
      scenario.record.state === 'monitoring' ||
      scenario.evidence.transitions.some(
        (transition) =>
          transition.to === 'active' || transition.to === 'monitoring',
      ),
  ) ?? false;
const productionPromoted =
  productionRun?.scenarios.some((scenario) => {
    let outcomeCount = 0;
    try {
      const outcomes = JSON.parse(scenario.record.outcomeIdsJson) as unknown;
      outcomeCount = Array.isArray(outcomes) ? outcomes.length : 1;
    } catch {
      outcomeCount = 1;
    }
    return (
      scenario.record.evidenceOrigin === 'live' ||
      outcomeCount > 0 ||
      scenario.record.state === 'canary_ready' ||
      scenario.record.state === 'active' ||
      scenario.record.state === 'monitoring'
    );
  }) ?? false;

const evidence: NovelCapabilityCertificationEvidence = {
  schemaVersion: 1,
  certification: 'Andrea Novel Capability Mastery',
  mode: 'deterministic_offline',
  runId: `novel-capability-${Date.now().toString(36)}`,
  fatalError,
  primaryScenarios,
  heldOutScenarios,
  aggregate: productionRun
    ? {
        falseSuccesses: productionRun.falseSuccesses,
        unauthorizedExternalEffects: productionRun.unauthorizedExternalEffects,
        duplicateEffects: productionRun.duplicateEffects,
        providerCalls: productionRun.providerCalls,
        costUsd: productionRun.costUsd,
        fabricatedOwnerApprovals: productionRun.fabricatedOwnerApprovals,
        ownerReviewedOutcomes: productionRun.ownerReviewedOutcomes,
        malformedStates: productionRun.malformedStates,
      }
    : {
        falseSuccesses: 0,
        unauthorizedExternalEffects: 0,
        duplicateEffects: 0,
        providerCalls: 0,
        costUsd: 0,
        fabricatedOwnerApprovals: 0,
        ownerReviewedOutcomes: 0,
        malformedStates: 0,
      },
  network: {
    hermeticParentProven,
    providerEnvironmentSuppressed,
    parentNonLoopbackDenied,
    childNonLoopbackDenied,
    escapeCount:
      Number(!parentNonLoopbackDenied) + Number(!childNonLoopbackDenied),
  },
  restart: productionRun?.restart ?? {
    attempted: false,
    phaseBeforeRestart: 'observed',
    phaseAfterRestart: 'observed',
    verifiedBeforeRestart: false,
    completedAfterResume: false,
    verificationAfterResume: false,
    duplicateEffects: 0,
  },
  reuse: productionRun?.reuse ?? {
    adapterRestarted: false,
    workerProcessObservedContract: false,
    canonicalContractRehydrated: false,
    baselineOperationDiscoveryCalls: 0,
    reusedOperationDiscoveryCalls: 0,
    sameCapabilityIdentity: false,
    compatibleVersion: false,
    fullDiscoveryRepeated: false,
    baselineCorrectness: 0,
    reusedCorrectness: 0,
    baselineSafetyRate: 0,
    reusedSafetyRate: 0,
    baselineDiscoveryCalls: 0,
    reusedDiscoveryCalls: 0,
    baselineDiscoverySteps: 0,
    reusedDiscoverySteps: 0,
    baselineTotalCalls: 0,
    reusedTotalCalls: 0,
  },
  staleVersion: productionRun?.staleVersion ?? {
    detectedBeforeInvocation: false,
    staleInvocationCount: 0,
    priorProvenancePreserved: false,
    resolution: 'paused',
  },
  syntheticPromotion: {
    highestState: highestSyntheticState,
    productionActivated,
    productionPromoted,
  },
  privacy,
  cleanup,
  benchmarkIsolation: {
    publicOracleSeparated,
    scenarioMetadataExposedToRuntime:
      !productionRun || productionRun.runtimeMetadataLeakCount !== 0,
    productionFixtureImportCount: isolationScan.fixtureImportCount,
    productionFixtureTokenMatchCount: isolationScan.fixtureTokenMatchCount,
    leakageCount:
      benchmarkIsolationViolations +
      isolationScan.fixtureImportCount +
      isolationScan.fixtureTokenMatchCount,
    metamorphicVariantsPassed:
      Boolean(productionRun) &&
      heldOutScenarios.every((scenario) => scenario.status === 'pass'),
    primaryPackDigest,
    heldOutPackDigest,
  },
};

const gate = evaluateNovelCapabilityCertification(evidence);
console.log(
  JSON.stringify(
    {
      certification: evidence.certification,
      mode: evidence.mode,
      integrationStatus: fatalError ?? 'production_evidence_observed',
      passed: gate.passed,
      failureCodes: gate.failureCodes,
      failures: gate.failures,
      scenarioCounts: {
        primary: primaryScenarios.length,
        heldOut: heldOutScenarios.length,
        passed: [...primaryScenarios, ...heldOutScenarios].filter(
          (scenario) => scenario.status === 'pass',
        ).length,
      },
      safety: {
        providerCalls: evidence.aggregate.providerCalls,
        costUsd: evidence.aggregate.costUsd,
        unauthorizedExternalEffects:
          evidence.aggregate.unauthorizedExternalEffects,
        syntheticPromotion: evidence.syntheticPromotion,
      },
      network: evidence.network,
      reuse: evidence.reuse,
      cleanup: evidence.cleanup,
      benchmarkIsolation: evidence.benchmarkIsolation,
    },
    null,
    2,
  ),
);
process.exitCode = gate.passed ? 0 : 1;
