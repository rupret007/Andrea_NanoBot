/* eslint-disable no-catch-all/no-catch-all -- This CLI boundary reports guarded preparation failures without creating partial live evidence. */
import { buildHermeticTestEnv } from '../src/hermetic-test-env.js';

const environment = buildHermeticTestEnv(process.env, {
  // This explicit operator command writes only synthetic preproduction
  // evidence to the canonical local ledger. It never creates live evidence.
  isolateStorage: false,
});
for (const key of Object.keys(process.env)) {
  if (!(key in environment)) delete process.env[key];
}
Object.assign(process.env, environment, {
  ANDREA_NOVEL_CAPABILITY_CERT_HERMETIC_PARENT: '1',
});

await import(new URL('./test-network-guard.mjs', import.meta.url).href);

function parseArgs(args: string[]): { groupFolder: string; json: boolean } {
  let groupFolder = 'main';
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--group') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--group requires one registered group folder.');
      }
      groupFolder = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { groupFolder, json };
}

try {
  const options = parseArgs(process.argv.slice(2));
  const [{ initDatabase }, { prepareReleaseReadinessCandidate }] =
    await Promise.all([
      import('../src/db.js'),
      import('../src/release-readiness-candidate-preparation.js'),
    ]);
  initDatabase();
  const prepared = await prepareReleaseReadinessCandidate({
    groupFolder: options.groupFolder,
  });
  const report = {
    acquisitionId: prepared.acquisition.acquisitionId,
    state: prepared.acquisition.state,
    evidenceOrigin: prepared.acquisition.evidenceOrigin,
    candidateFingerprint: prepared.contract.candidateFingerprint,
    contractVersion: prepared.contract.contractVersion,
    taskFamily: prepared.contract.taskFamily,
    readOnly: prepared.contract.steps.every((step) => step.readOnly),
    dataEgressClass: prepared.contract.dataEgressClass,
    allowedActions: prepared.contract.allowedActions,
    prohibitedActions: prepared.contract.prohibitedActions,
    healthObservationId: prepared.healthObservation?.observationId || null,
    healthObservedAt: prepared.healthObservation?.observedAt || null,
    suggestedHealthExpiry: prepared.suggestedHealthExpiry,
    nextSafeAction: prepared.acquisition.nextSafeAction,
    liveCanaryCreated: false,
    ownerReviewRecorded: false,
    capabilityActivated: false,
  };
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('Andrea Release-Readiness candidate prepared');
    console.log(`Acquisition: ${report.acquisitionId}`);
    console.log(`State: ${report.state} (${report.evidenceOrigin})`);
    console.log(`Candidate: ${report.candidateFingerprint}`);
    console.log(
      `Health: ${report.healthObservationId || 'not recorded'}${
        report.suggestedHealthExpiry
          ? ` (use no later than ${report.suggestedHealthExpiry})`
          : ''
      }`,
    );
    console.log(`Next: ${report.nextSafeAction}`);
    console.log(
      'No canary approval, owner verdict, activation, external effect, provider call, or live evidence was created.',
    );
  }
} catch (error) {
  console.error(
    `Release-readiness candidate preparation failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}
