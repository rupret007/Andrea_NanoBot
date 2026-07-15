import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  _closeDatabase,
  _initTestDatabaseAtPath,
  getCapabilityAcquisition,
  isDatabaseInitialized,
  isIsolatedTestDatabase,
  listCapabilityAcquisitionTransitions,
} from '../../../src/db.js';
import { assertCapabilityCandidateContract } from '../../../src/capability-acquisition-policy.js';
import type { CapabilityCandidateContract } from '../../../src/types.js';
import { NOVEL_CAPABILITY_CLI_OPERATION_ID_PREFIX } from './pack-support.js';
import type { NovelCapabilityWorkerMessage } from './types.js';

interface WorkerCommand {
  requestId?: unknown;
  command?: unknown;
  fixtureRoot?: unknown;
  statePath?: unknown;
  taskId?: unknown;
  databasePath?: unknown;
  acquisitionId?: unknown;
}

function fingerprint(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function send(message: NovelCapabilityWorkerMessage): void {
  process.send?.(message);
}

function fail(requestId: string, command: WorkerCommand['command']): void {
  send({
    requestId,
    type: 'error',
    command:
      command === 'checkpoint_candidate' ||
      command === 'exit' ||
      command === 'inspect' ||
      command === 'ping' ||
      command === 'production_hold' ||
      command === 'production_inspect' ||
      command === 'production_rehydrate_cli'
        ? command
        : 'inspect',
    code: 'novel_capability_fixture_worker_failed_closed',
  });
}

function rehydrateProductionCli(
  command: WorkerCommand,
): Record<string, unknown> {
  if (
    typeof command.fixtureRoot !== 'string' ||
    typeof command.databasePath !== 'string' ||
    typeof command.acquisitionId !== 'string' ||
    !command.acquisitionId
  ) {
    throw new Error('production_rehydration_input_missing');
  }
  const root = fs.realpathSync(command.fixtureRoot);
  const databasePath = fs.realpathSync(command.databasePath);
  if (!databasePath.startsWith(`${root}${path.sep}`)) {
    throw new Error('production_database_path_escape');
  }
  _initTestDatabaseAtPath(databasePath);
  try {
    const record = getCapabilityAcquisition(command.acquisitionId);
    if (!record) throw new Error('production_acquisition_missing');
    const contract = JSON.parse(
      record.candidateContractJson,
    ) as CapabilityCandidateContract;
    assertCapabilityCandidateContract(contract);
    const step = contract.steps[0];
    if (
      record.evidenceOrigin !== 'synthetic' ||
      !['sandbox_verified', 'owner_review_required'].includes(record.state) ||
      contract.taskFamily !== 'local-data-summary' ||
      contract.steps.length !== 1 ||
      !step ||
      step.actionClass !== 'local_lookup' ||
      !step.readOnly ||
      !step.operationId.startsWith(NOVEL_CAPABILITY_CLI_OPERATION_ID_PREFIX)
    ) {
      throw new Error('production_cli_contract_not_rehydratable');
    }
    return {
      acquisitionFingerprint: fingerprint(record.acquisitionId),
      state: record.state,
      evidenceOrigin: record.evidenceOrigin,
      taskFamily: contract.taskFamily,
      capabilityId: contract.capabilityId,
      skillId: contract.skillId,
      stepTitle: step.title,
      resourceId: step.resourceId,
      bindingId: step.bindingId,
      operationId: step.operationId,
      evaluatorId: step.evaluatorId,
      version: step.version,
      executorImplementationDigest: step.executorImplementationDigest,
      evaluatorImplementationDigest: step.evaluatorImplementationDigest,
      actionClass: step.actionClass,
      readOnly: step.readOnly,
      expectedEvidence: [...step.expectedEvidence],
      requiredInputs: [...contract.requiredInputs],
      provenanceRefs: [...contract.provenanceRefs],
      dataEgressClass: contract.dataEgressClass,
      databaseIsolated: isIsolatedTestDatabase(),
    };
  } finally {
    _closeDatabase();
  }
}

function inspectProductionAcquisition(
  command: WorkerCommand,
): Record<string, unknown> {
  if (
    typeof command.fixtureRoot !== 'string' ||
    typeof command.databasePath !== 'string' ||
    typeof command.acquisitionId !== 'string' ||
    !command.acquisitionId
  ) {
    throw new Error('production_inspection_input_missing');
  }
  const root = fs.realpathSync(command.fixtureRoot);
  const databasePath = fs.realpathSync(command.databasePath);
  if (!databasePath.startsWith(`${root}${path.sep}`)) {
    throw new Error('production_database_path_escape');
  }
  _initTestDatabaseAtPath(databasePath);
  try {
    const record = getCapabilityAcquisition(command.acquisitionId);
    if (!record) throw new Error('production_acquisition_missing');
    const transitions = listCapabilityAcquisitionTransitions(
      command.acquisitionId,
    );
    return {
      state: record.state,
      recordVersion: record.recordVersion,
      transitionCount: transitions.length,
      verified: record.state === 'sandbox_verified',
      databaseIsolated: isIsolatedTestDatabase(),
      acquisitionFingerprint: fingerprint(record.acquisitionId),
    };
  } finally {
    _closeDatabase();
  }
}

function boundedStatePath(command: WorkerCommand): string {
  if (
    typeof command.fixtureRoot !== 'string' ||
    typeof command.statePath !== 'string'
  ) {
    throw new Error('worker_path_missing');
  }
  const root = fs.realpathSync(command.fixtureRoot);
  const parent = fs.realpathSync(path.dirname(command.statePath));
  if (parent !== root && !parent.startsWith(`${root}${path.sep}`)) {
    throw new Error('worker_path_escape');
  }
  const target = path.resolve(command.statePath);
  if (target !== path.join(parent, path.basename(target))) {
    throw new Error('worker_path_invalid');
  }
  return target;
}

function writeCandidateCheckpoint(
  command: WorkerCommand,
): Record<string, unknown> {
  if (typeof command.taskId !== 'string' || !command.taskId) {
    throw new Error('worker_task_missing');
  }
  const statePath = boundedStatePath(command);
  const checkpoint = {
    schemaVersion: 1,
    phase: 'candidate_designed',
    verified: false,
    transitionSequence: 1,
    taskFingerprint: fingerprint(command.taskId),
    effectCount: 0,
  };
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(checkpoint)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  fs.renameSync(temporaryPath, statePath);
  return checkpoint;
}

function inspectCheckpoint(command: WorkerCommand): Record<string, unknown> {
  const statePath = boundedStatePath(command);
  const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<
    string,
    unknown
  >;
  if (
    parsed.schemaVersion !== 1 ||
    parsed.phase !== 'candidate_designed' ||
    parsed.verified !== false ||
    parsed.effectCount !== 0 ||
    typeof parsed.taskFingerprint !== 'string'
  ) {
    throw new Error('worker_state_invalid');
  }
  return parsed;
}

process.on('message', (value: unknown) => {
  const command =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as WorkerCommand)
      : {};
  const requestId =
    typeof command.requestId === 'string' && command.requestId
      ? command.requestId
      : 'invalid-request';
  try {
    switch (command.command) {
      case 'ping':
        send({
          requestId,
          type: 'result',
          command: 'ping',
          payload: {
            ready: true,
            productionIntegration: false,
          },
        });
        return;
      case 'checkpoint_candidate':
        send({
          requestId,
          type: 'result',
          command: 'checkpoint_candidate',
          payload: writeCandidateCheckpoint(command),
        });
        return;
      case 'inspect':
        send({
          requestId,
          type: 'result',
          command: 'inspect',
          payload: inspectCheckpoint(command),
        });
        return;
      case 'exit':
        if (isDatabaseInitialized()) _closeDatabase();
        send({
          requestId,
          type: 'result',
          command: 'exit',
          payload: { exiting: true },
        });
        process.disconnect?.();
        return;
      case 'production_hold':
      case 'production_inspect':
        send({
          requestId,
          type: 'result',
          command: command.command,
          payload: inspectProductionAcquisition(command),
        });
        return;
      case 'production_rehydrate_cli':
        send({
          requestId,
          type: 'result',
          command: 'production_rehydrate_cli',
          payload: rehydrateProductionCli(command),
        });
        return;
      default:
        fail(requestId, command.command);
    }
  } catch {
    if (isDatabaseInitialized()) _closeDatabase();
    fail(requestId, command.command);
  }
});

process.on('disconnect', () => {
  process.exitCode = 0;
});
