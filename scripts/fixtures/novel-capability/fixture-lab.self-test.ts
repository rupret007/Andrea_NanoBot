import '../../test-network-guard.mjs';

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

import {
  REQUIRED_NOVEL_CAPABILITY_HELD_OUT_SCENARIOS,
  REQUIRED_NOVEL_CAPABILITY_PRIMARY_SCENARIOS,
} from '../../lib/novel-capability-certification-gate.js';
import {
  createNovelCapabilityFixtureLab,
  type FixtureProcessResult,
} from './fixture-lab.js';
import {
  decodeNovelCapabilityCliOperationId,
  encodeNovelCapabilityCliOperationId,
  NOVEL_CAPABILITY_CLI_OPERATION_ID_PREFIX,
} from './pack-support.js';
import type { NovelCapabilityPublicResource } from './types.js';

function nodeProcess(
  arguments_: readonly string[],
): Promise<FixtureProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...arguments_], {
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => {
      resolve({ exitCode, signal, stdout, stderr });
    });
  });
}

function requireResource(
  resources: readonly NovelCapabilityPublicResource[],
  kind: NovelCapabilityPublicResource['kind'],
  titleIncludes = '',
): NovelCapabilityPublicResource {
  const resource = resources.find(
    (candidate) =>
      candidate.kind === kind &&
      candidate.title.toLowerCase().includes(titleIncludes.toLowerCase()),
  );
  assert.ok(resource, `Missing fixture resource ${kind}:${titleIncludes}.`);
  return resource;
}

function assertExactInventory(
  actual: readonly string[],
  expected: readonly string[],
): void {
  assert.equal(actual.length, expected.length);
  assert.deepEqual([...actual].sort(), [...expected].sort());
  assert.equal(new Set(actual).size, actual.length);
}

const operationIdentity = encodeNovelCapabilityCliOperationId({
  command: 'inspect-safe',
  flag: '--summarize-safe',
});
assert.deepEqual(decodeNovelCapabilityCliOperationId(operationIdentity), {
  command: 'inspect-safe',
  flag: '--summarize-safe',
});
assert.throws(
  () =>
    encodeNovelCapabilityCliOperationId({
      command: 'inspect;read-secret',
      flag: '--summarize-safe',
    }),
  /unsafe operation token/,
);
const extraFieldIdentity = `${NOVEL_CAPABILITY_CLI_OPERATION_ID_PREFIX}${Buffer.from(
  JSON.stringify({
    schemaVersion: 1,
    command: 'inspect-safe',
    flag: '--summarize-safe',
    oracle: 'forbidden',
  }),
).toString('base64url')}`;
assert.throws(
  () => decodeNovelCapabilityCliOperationId(extraFieldIdentity),
  /invalid schema/,
);

const externalDenial = await nodeProcess([
  '-e',
  "fetch('https://novel-capability-fixture.invalid').then(() => process.exit(9)).catch((error) => { if (error?.code !== 'ANDREA_DETERMINISTIC_NETWORK_DENIED') process.exit(8); });",
]);
assert.equal(externalDenial.exitCode, 0, externalDenial.stderr);

const lab = await createNovelCapabilityFixtureLab({
  label: 'self-test',
  seed: 'andrea-novel-capability-fixture-self-test-v1',
});
let cleanup: Awaited<ReturnType<typeof lab.dispose>> | null = null;
try {
  assert.deepEqual(lab.manifestLifecycle(), [
    { sequence: 1, event: 'manifest_created' },
    { sequence: 2, event: 'fixture_seeded' },
  ]);
  assertExactInventory(
    lab.primaryPack.scenarios.map((scenario) =>
      String(scenario.certificationScenarioId),
    ),
    REQUIRED_NOVEL_CAPABILITY_PRIMARY_SCENARIOS,
  );
  assertExactInventory(
    lab.heldOutPack.scenarios.map((scenario) =>
      String(scenario.certificationScenarioId),
    ),
    REQUIRED_NOVEL_CAPABILITY_HELD_OUT_SCENARIOS,
  );
  assert.match(lab.primaryPack.digest, /^sha256:[a-f0-9]{64}$/);
  assert.match(lab.heldOutPack.digest, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(lab.primaryPack.digest, lab.heldOutPack.digest);

  const separation = lab.auditPublicOracleSeparation();
  assert.deepEqual(separation, {
    passed: true,
    violationCount: 0,
    publicTaskCount: 25,
  });

  const resources = lab.listPublicResources();
  const cli = requireResource(resources, 'local_cli', 'unfamiliar');
  const staleCli = requireResource(resources, 'local_cli', 'drifted');
  const api = requireResource(resources, 'api_schema');
  const calendar = requireResource(resources, 'calendar');
  const manual = requireResource(resources, 'document', 'bounded review');
  const repository = requireResource(resources, 'repository');

  const cliHelp = await lab.runCli(cli.resourceId, ['--help']);
  assert.equal(cliHelp.exitCode, 0, cliHelp.stderr);
  assert.match(cliHelp.stdout, /Commands:/);
  assert.match(cliHelp.stdout, /DESTRUCTIVE:/);
  assert.doesNotMatch(cliHelp.stdout, /fixture-private-/);

  const cliDescription = await lab.runCli(cli.resourceId, ['--describe-json']);
  assert.equal(cliDescription.exitCode, 0, cliDescription.stderr);
  const described = JSON.parse(cliDescription.stdout) as {
    commands: Array<{
      name: string;
      requiredFlag: string;
      authority: string;
    }>;
  };
  const readCommand = described.commands.find(
    (command) => command.authority === 'read_only',
  );
  assert.ok(readCommand);
  const cliRead = await lab.runCli(cli.resourceId, [
    readCommand.name,
    readCommand.requiredFlag,
  ]);
  assert.equal(cliRead.exitCode, 0, cliRead.stderr);
  const cliResult = JSON.parse(cliRead.stdout) as Record<string, unknown>;
  assert.equal(cliResult.rows, 5);
  assert.ok(
    Object.values(cliResult).some(
      (value) => typeof value === 'number' && value > 5,
    ),
  );
  await assert.rejects(
    () => lab.runCli(staleCli.resourceId, ['--help']),
    /version-stale/,
  );

  const schema = JSON.parse(lab.readResourceText(api.resourceId)) as {
    paths: Record<
      string,
      {
        get?: { security?: unknown };
        post?: unknown;
      }
    >;
  };
  const readablePath = Object.entries(schema.paths).find(
    ([, contract]) => contract.get && !contract.get.security,
  )?.[0];
  const protectedPath = Object.entries(schema.paths).find(
    ([, contract]) => contract.get?.security,
  )?.[0];
  const mutationPath = Object.entries(schema.paths).find(
    ([, contract]) => contract.post,
  )?.[0];
  assert.ok(readablePath);
  assert.ok(protectedPath);
  assert.ok(mutationPath);
  const apiRead = await lab.requestApi(api.resourceId, 'GET', readablePath);
  assert.equal(apiRead.status, 200);
  assert.match(apiRead.bodyFingerprint, /^sha256:[a-f0-9]{64}$/);
  const protectedRead = await lab.requestApi(
    api.resourceId,
    'GET',
    protectedPath,
  );
  assert.equal(protectedRead.status, 401);

  const procedure = lab.readResourceText(manual.resourceId);
  assert.match(procedure, /Duration minutes: 30/);
  assert.equal(
    lab.verifyManualProcedure({
      durationMinutes: 30,
      mode: 'proposal_only',
      freshApprovalRequired: true,
    }).verified,
    true,
  );

  const calendarEvents = lab.readCalendar(calendar.resourceId);
  assert.equal(calendarEvents.length, 2);
  assert.ok(
    calendarEvents.every(
      (event) => !Object.prototype.hasOwnProperty.call(event, 'privateNote'),
    ),
  );
  const proposal = lab.proposeCalendarSlot(calendar.resourceId);
  assert.match(proposal.proposalFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(lab.verifyCalendarProposal(proposal).verified, true);
  assert.equal(
    lab.verifyCalendarProposal(
      { ...proposal, proposalFingerprint: `sha256:${'0'.repeat(64)}` },
      'the next open afternoon',
    ).verified,
    false,
  );
  const morningProposal = lab.proposeCalendarSlot(
    calendar.resourceId,
    'tomorrow morning',
  );
  assert.match(morningProposal.start, /^2031-04-15T(?:09|10|11):/);
  assert.equal(
    lab.verifyCalendarProposal(morningProposal, 'tomorrow morning').verified,
    true,
  );

  assert.match(
    lab.readRepositoryFile(repository.resourceId, 'README.md'),
    /Disposable Adapter Fixture/,
  );
  const initialVerification = await lab.runRepositoryVerifier(
    repository.resourceId,
  );
  assert.equal(initialVerification.passed, false);
  assert.equal(initialVerification.exitCode, 1);
  assert.equal(lab.repositoryHeadUnchanged(), true);

  const firstWorker = lab.spawnWorker();
  firstWorker.send('ping');
  const ping = await firstWorker.nextMessage();
  assert.equal(ping.type, 'result');
  assert.equal(ping.payload?.ready, true);
  assert.equal(ping.payload?.productionIntegration, false);
  firstWorker.send('checkpoint_candidate', {
    taskId: lab.primaryPack.scenarios[0]!.publicView.taskId,
  });
  const checkpoint = await firstWorker.nextMessage();
  assert.equal(checkpoint.type, 'result');
  assert.equal(checkpoint.payload?.phase, 'candidate_designed');
  assert.equal(checkpoint.payload?.verified, false);
  assert.equal(checkpoint.payload?.effectCount, 0);
  firstWorker.send('exit');
  assert.equal((await firstWorker.nextMessage()).type, 'result');
  assert.equal((await firstWorker.waitForExit()).code, 0);

  const resumedWorker = lab.spawnWorker();
  resumedWorker.send('inspect');
  const inspected = await resumedWorker.nextMessage();
  assert.equal(inspected.type, 'result');
  assert.equal(inspected.payload?.phase, 'candidate_designed');
  assert.equal(inspected.payload?.verified, false);
  resumedWorker.send('exit');
  assert.equal((await resumedWorker.nextMessage()).type, 'result');
  assert.equal((await resumedWorker.waitForExit()).code, 0);

  assert.deepEqual(lab.effectMarkers(), {
    apiMutation: false,
    calendarMutation: false,
    cliDestructive: false,
  });
  assert.equal(lab.readEffectLedger().length, 0);
  const requestLedger = lab.readRequestLedger();
  assert.ok(requestLedger.length >= 12);
  assert.ok(
    requestLedger.every(
      (record, index) =>
        record.sequence === index + 1 &&
        /^sha256:[a-f0-9]{64}$/.test(record.targetFingerprint) &&
        /^sha256:[a-f0-9]{64}$/.test(record.inputFingerprint),
    ),
  );
  const privacy = lab.scanPrivateSentinels([
    cliHelp.stdout,
    cliDescription.stdout,
    cliRead.stdout,
    JSON.stringify(apiRead.body),
    JSON.stringify(protectedRead.body),
    procedure,
    JSON.stringify(calendarEvents),
    firstWorker.stdout(),
    firstWorker.stderr(),
    resumedWorker.stdout(),
    resumedWorker.stderr(),
  ]);
  assert.equal(privacy.sentinelHashCount, 2);
  assert.equal(privacy.leakCount, 0);
} finally {
  cleanup = await lab.dispose();
}

assert.ok(cleanup);
assert.equal(cleanup.manifestCreatedBeforeSeeding, true);
assert.equal(cleanup.manifestRemoved, true);
assert.equal(cleanup.databaseRemoved, true);
assert.equal(cleanup.walRemoved, true);
assert.equal(cleanup.shmRemoved, true);
assert.equal(cleanup.fixtureRootRemoved, true);
assert.equal(cleanup.liveChildCount, 0);
assert.equal(cleanup.openLoopbackServerCount, 0);
assert.equal(cleanup.isolatedResidueCount, 0);
assert.equal(cleanup.productionResidueCount, 0);
assert.deepEqual(cleanup.errors, []);

const isolationViolationLab = await createNovelCapabilityFixtureLab({
  label: 'isolation-violation-self-test',
  seed: 'andrea-novel-capability-isolation-violation-v1',
});
isolationViolationLab.observeDatabaseIsolation(
  false,
  isolationViolationLab.paths.databasePath,
);
const isolationViolationCleanup = await isolationViolationLab.dispose();
assert.equal(isolationViolationCleanup.productionResidueCount, 1);
assert.equal(isolationViolationCleanup.fixtureRootRemoved, true);
assert.equal(isolationViolationCleanup.manifestRemoved, true);

console.log(
  JSON.stringify({
    fixture: 'novel-capability',
    status: 'passed',
    primaryScenarios: 10,
    heldOutScenarios: 15,
    externalNetworkDenied: true,
    loopbackApiAllowed: true,
    cleanupVerified: true,
    productionIntegrationClaimed: false,
  }),
);
