/* eslint-disable no-catch-all/no-catch-all -- The certification runner must report adapter, guard, and cleanup failures instead of losing evidence. */
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runProductionCapabilityApprenticeshipCertificationCases } from '../src/production-capability-apprenticeship-certification-adapter.js';
import {
  PRODUCTION_APPRENTICESHIP_SCENARIOS,
  type ProductionApprenticeshipCertificationEvidence,
} from '../src/production-capability-apprenticeship-certification-contract.js';
import { evaluateProductionApprenticeshipCertificationEvidence } from './lib/production-capability-apprenticeship-certification-gate.js';

const PROVIDER_ENVIRONMENT_PATTERN =
  /^(?:ANTHROPIC|AWS|AZURE|BEDROCK|BRAVE|CLAUDE|CODEX|COHERE|CURSOR|DEEPSEEK|EXA|FIREWORKS|GEMINI|GOOGLE|GROQ|HUGGINGFACE|LMSTUDIO|MINIMAX|MISTRAL|OLLAMA|ONECLI|OPENAI|OPENROUTER|PERPLEXITY|REPLICATE|SERPER|TAVILY|TOGETHER|VERTEX_AI|VLLM|VOYAGE|XAI)_/;
const CREDENTIAL_SUFFIX =
  /(?:^|_)(?:API_KEY|AUTH_TOKEN|OAUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET|SECRET_ACCESS_KEY|SESSION_TOKEN|TOKEN|PRIVATE_KEY|PASSWORD|CREDENTIALS)$/;

async function parentNetworkDenied(): Promise<boolean> {
  try {
    await fetch('https://example.com/andrea-production-apprenticeship-cert');
    return false;
  } catch (error) {
    return (
      error instanceof Error &&
      (error as Error & { code?: string }).code ===
        'ANDREA_DETERMINISTIC_NETWORK_DENIED'
    );
  }
}

function childNetworkDenied(): boolean {
  const probe = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      "try { await fetch('https://example.com/andrea-child-cert'); process.exit(9); } catch (error) { process.exit(error?.code === 'ANDREA_DETERMINISTIC_NETWORK_DENIED' ? 0 : 8); }",
    ],
    {
      env: process.env,
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  return probe.status === 0;
}

function providerEnvironmentSuppressed(): boolean {
  return !Object.keys(process.env).some((key) => {
    const normalized = key.toUpperCase();
    return (
      PROVIDER_ENVIRONMENT_PATTERN.test(normalized) ||
      CREDENTIAL_SUFFIX.test(normalized)
    );
  });
}

function unavailableEvidence(params: {
  runId: string;
  startedAt: string;
  fatalError: string;
}): ProductionApprenticeshipCertificationEvidence {
  return {
    schemaVersion: 1,
    certification: 'Andrea Verified Production Apprenticeship',
    mode: 'deterministic_offline',
    evidenceOrigin: 'certification_synthetic',
    implementationStatus: 'unavailable',
    runId: params.runId,
    startedAt: params.startedAt,
    completedAt: new Date().toISOString(),
    fatalError: params.fatalError,
    scenarios: [],
    environment: {
      hermeticParentProven: false,
      providerEnvironmentSuppressed: false,
      parentNonLoopbackDenied: false,
      childNonLoopbackDenied: false,
      networkEscapeCount: 0,
      providerCalls: 0,
      costUsd: 0,
      externalEffects: 0,
      productionWrites: 0,
      productionMetricWrites: 0,
    },
    ownerEvidence: {
      genuineOwnerEvidenceCount: 0,
      syntheticOwnerFixtureCount: 0,
      syntheticFixturesLabeled: true,
    },
    privacy: {
      metadataOnly: true,
      privateContentLeakCount: 0,
      secretLeakCount: 0,
      rawPathLeakCount: 0,
    },
    cleanup: {
      manifestCreatedBeforeExecution: false,
      manifestRemoved: false,
      fixtureRootRemoved: false,
      isolatedResidueCount: 0,
      productionResidueCount: 0,
      liveChildCount: 0,
      errors: [params.fatalError],
    },
    benchmarkIsolation: {
      scenarioMetadataExposedToProduction: false,
      productionFixtureImportCount: 0,
      benchmarkSpecificBranchCount: 0,
    },
  };
}

const runId = `ANDREA-PRODUCTION-APPRENTICESHIP-${randomUUID().toUpperCase()}`;
const startedAt = new Date().toISOString();
const fixtureRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'andrea-production-apprenticeship-'),
);
const cleanupManifestPath = path.join(os.tmpdir(), `${runId}-cleanup.json`);
fs.writeFileSync(
  cleanupManifestPath,
  `${JSON.stringify(
    {
      runId,
      fixtureRoot,
      createdAt: startedAt,
      evidenceOrigin: 'certification_synthetic',
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);

const hermeticParentProven =
  process.env.ANDREA_PRODUCTION_APPRENTICESHIP_CERT_HERMETIC_PARENT === '1' &&
  process.env.ANDREA_TEST_NETWORK_GUARD_ACTIVE === '1' &&
  process.env.ANDREA_DETERMINISTIC_STORAGE_MODE === 'memory';
const providerSuppressed = providerEnvironmentSuppressed();
const parentDenied = await parentNetworkDenied();
const childDenied = childNetworkDenied();

let evidence: ProductionApprenticeshipCertificationEvidence;
try {
  evidence = await runProductionCapabilityApprenticeshipCertificationCases({
    runId,
    startedAt,
    fixtureRoot,
    cleanupManifestPath,
    requiredScenarioIds: PRODUCTION_APPRENTICESHIP_SCENARIOS.map(
      (scenario) => scenario.id,
    ),
    mode: 'deterministic_offline',
    evidenceOrigin: 'certification_synthetic',
  });
} catch (error) {
  evidence = unavailableEvidence({
    runId,
    startedAt,
    fatalError: `Certification adapter failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  });
}

const cleanupErrors = [...evidence.cleanup.errors];
try {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
} catch (error) {
  cleanupErrors.push(
    `fixture cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
  );
}
try {
  fs.rmSync(cleanupManifestPath, { force: true });
} catch (error) {
  cleanupErrors.push(
    `manifest cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
  );
}

evidence = {
  ...evidence,
  runId,
  startedAt,
  completedAt: new Date().toISOString(),
  environment: {
    ...evidence.environment,
    hermeticParentProven,
    providerEnvironmentSuppressed: providerSuppressed,
    parentNonLoopbackDenied: parentDenied,
    childNonLoopbackDenied: childDenied,
    networkEscapeCount:
      evidence.environment.networkEscapeCount +
      (parentDenied ? 0 : 1) +
      (childDenied ? 0 : 1),
  },
  cleanup: {
    ...evidence.cleanup,
    manifestCreatedBeforeExecution: true,
    manifestRemoved: !fs.existsSync(cleanupManifestPath),
    fixtureRootRemoved: !fs.existsSync(fixtureRoot),
    isolatedResidueCount: fs.existsSync(fixtureRoot) ? 1 : 0,
    errors: cleanupErrors,
  },
};

const gate = evaluateProductionApprenticeshipCertificationEvidence(evidence);
const summary = {
  certification: evidence.certification,
  mode: evidence.mode,
  evidenceOrigin: evidence.evidenceOrigin,
  implementationStatus: evidence.implementationStatus,
  passed: gate.passed,
  failureCodes: gate.failureCodes,
  failures: gate.failures,
  scenarioCounts: {
    required: PRODUCTION_APPRENTICESHIP_SCENARIOS.length,
    reported: evidence.scenarios.length,
    passed: evidence.scenarios.filter((scenario) => scenario.status === 'pass')
      .length,
  },
  failedScenarios: evidence.scenarios
    .filter((scenario) => scenario.status !== 'pass')
    .map((scenario) => ({
      id: scenario.id,
      status: scenario.status,
      executed: scenario.executed,
      reason: scenario.reason,
      failedAssertions: Object.entries(scenario.assertions)
        .filter(([, passed]) => !passed)
        .map(([assertion]) => assertion),
    })),
  safety: {
    providerCalls: evidence.environment.providerCalls,
    costUsd: evidence.environment.costUsd,
    externalEffects: evidence.environment.externalEffects,
    productionWrites: evidence.environment.productionWrites,
    genuineOwnerEvidenceCount: evidence.ownerEvidence.genuineOwnerEvidenceCount,
  },
  cleanup: evidence.cleanup,
};
console.log(JSON.stringify(summary, null, 2));
if (!gate.passed) process.exitCode = 1;
