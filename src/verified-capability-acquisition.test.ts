import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  _closeDatabase,
  _initTestDatabase,
  getCapabilityAcquisition,
  getDurableWorkCheckpoint,
  getDurableWorkUnit,
  listCapabilityAcquisitionTransitions,
  listDurableEffectReceipts,
} from './db.js';
import type { CapabilityResourceDescriptor } from './types.js';
import { applySkillControl } from './skill-library.js';
import { capabilityBindingImplementationDigest } from './capability-execution-guard.js';
import { isLegalCapabilityAcquisitionTransition } from './capability-acquisition-policy.js';
import { _setDurableContinuityTestHook } from './durable-work-continuity.js';
import {
  activateVerifiedCapability,
  buildCapabilityAcquisitionReport,
  CAPABILITY_SANDBOX_MARKER,
  capabilitySandboxTargetScopeHash,
  createHermeticCertificationBindingRegistry,
  capabilityMetadataJson,
  compileCapabilityCandidate,
  executeActiveCapability,
  markCapabilityExternallyBlocked,
  observeCapabilityGap,
  prepareCapabilitySandbox,
  prepareCapabilityExecutionScope,
  recordCapabilityCandidateNegativeEvaluation,
  recordCapabilityCanaryOutcome,
  recordCapabilityHeldOutEvidence,
  recordCapabilityResourceDiscovery,
  runCapabilitySandbox,
  scopeCapabilityAcquisition,
  type CapabilityEvaluatorBinding,
  type CapabilityExecutorBinding,
  type VerifiedCapabilityBindingRegistry,
} from './verified-capability-acquisition.js';

const NOW = new Date('2026-07-14T12:00:00.000Z');

type CombinedTestBinding = CapabilityExecutorBinding &
  Pick<
    CapabilityEvaluatorBinding,
    'evaluatorId' | 'evaluatorImplementationDigest' | 'verify'
  >;

function executorDigest(bindingId: string, version: string): string {
  return capabilityBindingImplementationDigest({
    kind: 'executor',
    implementationId: bindingId,
    version,
  });
}

function evaluatorDigest(evaluatorId: string, version: string): string {
  return capabilityBindingImplementationDigest({
    kind: 'evaluator',
    implementationId: evaluatorId,
    version,
  });
}

function testRegistry(
  bindings: CombinedTestBinding[],
): VerifiedCapabilityBindingRegistry {
  return createHermeticCertificationBindingRegistry({
    executors: bindings.map(
      ({
        evaluatorId: _evaluatorId,
        evaluatorImplementationDigest: _evaluatorImplementationDigest,
        verify: _verify,
        ...executor
      }) => executor,
    ),
    evaluators: bindings.map((binding) => ({
      evaluatorId: binding.evaluatorId,
      operationId: binding.operationId,
      resourceId: binding.resourceId,
      version: binding.version,
      evaluatorImplementationDigest: binding.evaluatorImplementationDigest,
      verify: binding.verify,
    })),
  });
}

function resource(
  version = 'sha256:resource-v1',
  inputKey = 'key',
): CapabilityResourceDescriptor {
  return {
    resourceId: 'fixture.lookup',
    kind: 'local_script',
    displayName: 'Fixture lookup',
    taskFamilies: ['fixture_lookup'],
    capabilityIds: ['fixture.lookup'],
    supportedPostconditions: ['the fixture value is returned and verified'],
    requiredInputs: [inputKey],
    available: true,
    healthState: 'healthy',
    verificationStrength: 1,
    reliabilityScore: 0.98,
    authorityRequirement: 'none',
    riskLevel: 'low',
    dataEgressClass: 'local_only',
    reversible: true,
    expectedCostBand: 'zero',
    expectedLatencyBand: 'instant',
    version,
    sourceRefs: ['fixture:lookup-contract'],
    maintenanceBurden: 'low',
    bindingRefs: [
      {
        bindingId: 'binding.fixture.lookup',
        operationId: 'lookup',
        evaluatorId: 'verify.fixture.lookup',
        executorImplementationDigest: executorDigest(
          'binding.fixture.lookup',
          version,
        ),
        evaluatorImplementationDigest: evaluatorDigest(
          'verify.fixture.lookup',
          version,
        ),
        actionClass: 'local_lookup',
        version,
        readOnly: true,
      },
    ],
  };
}

function observed() {
  return observeCapabilityGap({
    metadataClassification: 'derived_metadata',
    groupFolder: 'main',
    targetOutcome: 'Look up and verify a novel fixture value',
    postconditions: ['the fixture value is returned and verified'],
    taskFamily: 'fixture_lookup',
    gapKind: 'tool_usage_gap',
    provenanceRefs: ['owner-request:fixture'],
    evidenceOrigin: 'synthetic',
    environmentFingerprint: 'sha256:environment-v1',
    now: NOW,
  });
}

function designed(inputKey = 'key') {
  const initial = observed();
  scopeCapabilityAcquisition({
    acquisitionId: initial.acquisitionId,
    knownPrerequisites: ['fixture key'],
    missingPrerequisites: [],
    confidence: 0.8,
    now: NOW,
  });
  recordCapabilityResourceDiscovery({
    acquisitionId: initial.acquisitionId,
    candidates: [resource('sha256:resource-v1', inputKey)],
    selected: [resource('sha256:resource-v1', inputKey)],
    rejectedReasons: {},
    now: NOW,
  });
  return compileCapabilityCandidate({
    acquisitionId: initial.acquisitionId,
    selectedResources: [resource('sha256:resource-v1', inputKey)],
    triggerSemantics: ['verify a fixture lookup'],
    requiredInputs: [inputKey],
    expectedOutput: 'A verified fixture result with evidence.',
    deterministicScenarioIds: ['fixture-primary'],
    heldOutScenarioIds: ['fixture-heldout'],
    now: NOW,
  });
}

function preparedVerifiedSandbox(options?: {
  inputKey?: string;
  inputValue?: string;
}) {
  const inputKey = options?.inputKey || 'key';
  const inputValue = options?.inputValue || 'alpha';
  const candidate = designed(inputKey);
  prepareCapabilitySandbox({
    acquisitionId: candidate.record.acquisitionId,
    now: NOW,
  });
  const calls: string[] = [];
  let observedValue = '';
  const registry = testRegistry([
    {
      bindingId: 'binding.fixture.lookup',
      operationId: 'lookup',
      evaluatorId: 'verify.fixture.lookup',
      resourceId: 'fixture.lookup',
      version: 'sha256:resource-v1',
      executorImplementationDigest: executorDigest(
        'binding.fixture.lookup',
        'sha256:resource-v1',
      ),
      evaluatorImplementationDigest: evaluatorDigest(
        'verify.fixture.lookup',
        'sha256:resource-v1',
      ),
      actionClass: 'local_lookup',
      effectClass: 'read_only',
      networkAccess: 'none',
      execute: async ({ values, idempotencyKey }) => {
        calls.push(idempotencyKey);
        observedValue = `value:${String(values[inputKey])}`;
        return {
          result: { value: observedValue },
          evidenceRefs: ['fixture:actual-read'],
          effectClass: 'read_only',
          effectStatus: 'certain',
          preStateFingerprint: '1'.repeat(64),
          postStateFingerprint: '2'.repeat(64),
          providerCalls: 0,
          costUsd: 0,
        };
      },
      verify: async ({ result, requiredPostconditions }) => ({
        verified:
          typeof (result.result as { value?: unknown } | null)?.value ===
            'string' || observedValue.startsWith('value:'),
        evidenceRefs: ['fixture:actual-verifier'],
        verifiedPostconditions: requiredPostconditions,
        postconditionFingerprint: '3'.repeat(64),
        reason: 'Observed the exact fixture value.',
      }),
      cleanup: async () => true,
    },
  ]);
  const scope = prepareCapabilityExecutionScope({
    acquisitionId: candidate.record.acquisitionId,
    ownerId: 'fixture-owner',
    chatId: 'fixture-chat',
    groupId: 'main',
    channel: 'certification',
    targetScopeKey: 'fixture-target',
    now: NOW,
  });
  return {
    candidate,
    calls,
    registry,
    scope,
    values: { [inputKey]: inputValue },
    currentResources: [resource('sha256:resource-v1', inputKey)],
  };
}

async function verifiedSandbox(options?: {
  inputKey?: string;
  inputValue?: string;
}) {
  const prepared = preparedVerifiedSandbox(options);
  const record = await runCapabilitySandbox({
    acquisitionId: prepared.candidate.record.acquisitionId,
    values: prepared.values,
    registry: prepared.registry,
    currentResources: prepared.currentResources,
    scope: prepared.scope,
    networkPolicy: 'none',
    now: NOW,
  });
  const receipts = listDurableEffectReceipts({
    workId: prepared.scope.workId,
    checkpointId: prepared.scope.checkpointId,
  });
  return { record, receipts, ...prepared };
}

beforeEach(() => {
  vi.stubEnv('ANDREA_NOVEL_CAPABILITY_CERT_HERMETIC_PARENT', '1');
  _initTestDatabase();
});
afterEach(() => {
  _setDurableContinuityTestHook(null);
  _closeDatabase();
  vi.unstubAllEnvs();
});

describe('verified capability acquisition', () => {
  it('persists one atomic canonical genesis and idempotent scoped transition', () => {
    const initial = observed();
    const repeatedObservation = observed();
    expect(repeatedObservation.acquisitionId).toBe(initial.acquisitionId);
    expect(initial.state).toBe('observed');
    const genesis = listCapabilityAcquisitionTransitions(initial.acquisitionId);
    expect(genesis).toHaveLength(1);
    expect(genesis[0]).toMatchObject({
      fromState: 'observed',
      toState: 'observed',
      expectedVersion: 0,
      resultingVersion: 1,
    });
    const scoped = scopeCapabilityAcquisition({
      acquisitionId: initial.acquisitionId,
      knownPrerequisites: ['fixture key'],
      missingPrerequisites: [],
      confidence: 0.8,
      now: NOW,
    });
    const replayed = scopeCapabilityAcquisition({
      acquisitionId: initial.acquisitionId,
      knownPrerequisites: ['fixture key'],
      missingPrerequisites: [],
      confidence: 0.8,
      now: NOW,
    });
    expect(scoped.recordVersion).toBe(2);
    expect(replayed.recordVersion).toBe(2);
    expect(
      listCapabilityAcquisitionTransitions(initial.acquisitionId),
    ).toHaveLength(2);
  });

  it('keeps illegal transition edges out of the public acquisition API', () => {
    expect(isLegalCapabilityAcquisitionTransition('observed', 'active')).toBe(
      false,
    );
  });

  it('rejects a same-ID resource whose selected binding or version was swapped', () => {
    const initial = observed();
    scopeCapabilityAcquisition({
      acquisitionId: initial.acquisitionId,
      knownPrerequisites: ['fixture key'],
      missingPrerequisites: [],
      confidence: 0.8,
      now: NOW,
    });
    recordCapabilityResourceDiscovery({
      acquisitionId: initial.acquisitionId,
      candidates: [resource()],
      selected: [resource()],
      rejectedReasons: {},
      now: NOW,
    });

    expect(() =>
      compileCapabilityCandidate({
        acquisitionId: initial.acquisitionId,
        selectedResources: [resource('sha256:swapped-version')],
        triggerSemantics: ['verify a fixture lookup'],
        requiredInputs: ['key'],
        expectedOutput: 'A verified fixture result with evidence.',
        now: NOW,
      }),
    ).toThrow(/exactly match the broker-selected descriptor/i);
  });

  it('makes candidate compilation and sandbox preparation exact-retry idempotent', () => {
    const first = designed();
    const retried = compileCapabilityCandidate({
      acquisitionId: first.record.acquisitionId,
      selectedResources: [resource()],
      triggerSemantics: ['verify a fixture lookup'],
      requiredInputs: ['key'],
      expectedOutput: 'A verified fixture result with evidence.',
      deterministicScenarioIds: ['fixture-primary'],
      heldOutScenarioIds: ['fixture-heldout'],
      now: new Date(NOW.getTime() + 1_000),
    });
    expect(retried.contract.candidateFingerprint).toBe(
      first.contract.candidateFingerprint,
    );
    expect(retried.record.recordVersion).toBe(first.record.recordVersion);
    expect(() =>
      compileCapabilityCandidate({
        acquisitionId: first.record.acquisitionId,
        selectedResources: [resource()],
        triggerSemantics: ['a different trigger'],
        requiredInputs: ['key'],
        expectedOutput: 'A verified fixture result with evidence.',
      }),
    ).toThrow(/immutable contract/);
    const prepared = prepareCapabilitySandbox({
      acquisitionId: first.record.acquisitionId,
      now: NOW,
    });
    const preparedRetry = prepareCapabilitySandbox({
      acquisitionId: first.record.acquisitionId,
      now: new Date(NOW.getTime() + 1_000),
    });
    expect(preparedRetry.recordVersion).toBe(prepared.recordVersion);
    expect(preparedRetry.state).toBe('sandbox_ready');
  });

  it('executes only an exact registered binding and verifies after the effect', async () => {
    const { record, calls, receipts, scope } = await verifiedSandbox();
    expect(record.state).toBe('sandbox_verified');
    expect(calls).toHaveLength(1);
    expect(receipts.at(-1)?.status).toBe('succeeded');
    const durableWork = getDurableWorkUnit(scope.workId);
    const checkpoint = durableWork?.checkpointHeadId
      ? getDurableWorkCheckpoint(durableWork.checkpointHeadId)
      : null;
    expect(durableWork?.status).toBe('completed');
    expect(checkpoint?.status).toBe('completed');
    expect(JSON.parse(checkpoint?.pendingNodeIdsJson || '[]')).toEqual([]);
    expect(JSON.parse(record.sandboxEvidenceJson)).toMatchObject({
      verified: true,
      postconditionVerified: true,
      falseSuccesses: 0,
      unauthorizedEffects: 0,
      duplicateEffects: 0,
      providerCalls: 0,
      costUsd: 0,
    });
  });

  it('returns canonical completion for an exact retry and rejects changed input', async () => {
    const first = await verifiedSandbox();
    const refreshedScope = prepareCapabilityExecutionScope({
      acquisitionId: first.record.acquisitionId,
      ownerId: 'fixture-owner',
      chatId: 'fixture-chat',
      groupId: 'main',
      channel: 'certification',
      targetScopeKey: 'fixture-target',
      now: new Date(NOW.getTime() + 1_000),
    });
    const retried = await runCapabilitySandbox({
      acquisitionId: first.record.acquisitionId,
      values: { key: 'alpha' },
      registry: first.registry,
      currentResources: [resource()],
      scope: refreshedScope,
      networkPolicy: 'none',
      now: new Date(NOW.getTime() + 1_000),
    });
    expect(retried.recordVersion).toBe(first.record.recordVersion);
    expect(first.calls).toHaveLength(1);
    await expect(
      runCapabilitySandbox({
        acquisitionId: first.record.acquisitionId,
        values: { key: 'changed' },
        registry: first.registry,
        currentResources: [resource()],
        scope: refreshedScope,
        networkPolicy: 'none',
        now: new Date(NOW.getTime() + 2_000),
      }),
    ).rejects.toThrow(/does not match canonical input/);
    expect(first.calls).toHaveLength(1);
  });

  it('does not reuse receipts across whitespace-normalized or truncated inputs', async () => {
    const first = await verifiedSandbox({ inputValue: 'alpha   beta' });
    const refreshedScope = prepareCapabilityExecutionScope({
      acquisitionId: first.record.acquisitionId,
      ownerId: 'fixture-owner',
      chatId: 'fixture-chat',
      groupId: 'main',
      channel: 'certification',
      targetScopeKey: 'fixture-target',
      now: new Date(NOW.getTime() + 1_000),
    });
    await expect(
      runCapabilitySandbox({
        acquisitionId: first.record.acquisitionId,
        values: { key: 'alpha beta' },
        registry: first.registry,
        currentResources: [resource()],
        scope: refreshedScope,
        networkPolicy: 'none',
        now: new Date(NOW.getTime() + 1_000),
      }),
    ).rejects.toThrow(/does not match canonical input/);
    expect(first.calls).toHaveLength(1);

    _closeDatabase();
    _initTestDatabase();
    const longPrefix = 'x'.repeat(2_400);
    const second = await verifiedSandbox({ inputValue: `${longPrefix}a` });
    const secondScope = prepareCapabilityExecutionScope({
      acquisitionId: second.record.acquisitionId,
      ownerId: 'fixture-owner',
      chatId: 'fixture-chat',
      groupId: 'main',
      channel: 'certification',
      targetScopeKey: 'fixture-target',
      now: new Date(NOW.getTime() + 1_000),
    });
    await expect(
      runCapabilitySandbox({
        acquisitionId: second.record.acquisitionId,
        values: { key: `${longPrefix}b` },
        registry: second.registry,
        currentResources: [resource()],
        scope: secondScope,
        networkPolicy: 'none',
        now: new Date(NOW.getTime() + 1_000),
      }),
    ).rejects.toThrow(/does not match canonical input/);
    expect(second.calls).toHaveLength(1);
  });

  it('recovers a crash after the completed checkpoint without replaying effects', async () => {
    const prepared = preparedVerifiedSandbox();
    let checkpointCommitted = false;
    _setDurableContinuityTestHook(({ boundary }) => {
      if (boundary === 'after_checkpoint_commit' && !checkpointCommitted) {
        checkpointCommitted = true;
        throw new Error('simulated process loss after checkpoint commit');
      }
    });
    await expect(
      runCapabilitySandbox({
        acquisitionId: prepared.candidate.record.acquisitionId,
        values: prepared.values,
        registry: prepared.registry,
        currentResources: prepared.currentResources,
        scope: prepared.scope,
        networkPolicy: 'none',
        now: NOW,
      }),
    ).rejects.toThrow(/simulated process loss/);
    _setDurableContinuityTestHook(null);
    expect(checkpointCommitted).toBe(true);
    expect(prepared.calls).toHaveLength(1);
    expect(
      getCapabilityAcquisition(prepared.candidate.record.acquisitionId)?.state,
    ).toBe('sandbox_running');

    const refreshedScope = prepareCapabilityExecutionScope({
      acquisitionId: prepared.candidate.record.acquisitionId,
      ownerId: 'fixture-owner',
      chatId: 'fixture-chat',
      groupId: 'main',
      channel: 'certification',
      targetScopeKey: 'fixture-target',
      now: new Date(NOW.getTime() + 1_000),
    });
    const recovered = await runCapabilitySandbox({
      acquisitionId: prepared.candidate.record.acquisitionId,
      values: prepared.values,
      registry: prepared.registry,
      currentResources: prepared.currentResources,
      scope: refreshedScope,
      networkPolicy: 'none',
      now: new Date(NOW.getTime() + 1_000),
    });
    expect(recovered.state).toBe('sandbox_verified');
    expect(prepared.calls).toHaveLength(1);
    expect(getDurableWorkUnit(refreshedScope.workId)?.status).toBe('completed');
  });

  it('marks a malformed executor result indeterminate without invoking the evaluator', async () => {
    const candidate = designed();
    prepareCapabilitySandbox({ acquisitionId: candidate.record.acquisitionId });
    let evaluatorCalled = false;
    let cleanupCalled = false;
    const registry = testRegistry([
      {
        bindingId: 'binding.fixture.lookup',
        operationId: 'lookup',
        evaluatorId: 'verify.fixture.lookup',
        resourceId: 'fixture.lookup',
        version: 'sha256:resource-v1',
        executorImplementationDigest: executorDigest(
          'binding.fixture.lookup',
          'sha256:resource-v1',
        ),
        evaluatorImplementationDigest: evaluatorDigest(
          'verify.fixture.lookup',
          'sha256:resource-v1',
        ),
        actionClass: 'local_lookup',
        effectClass: 'read_only',
        networkAccess: 'none',
        execute: async () => ({
          result: { value: 'unverified' },
          evidenceRefs: ['fixture:malformed-result'],
          effectClass: 'read_only',
          effectStatus: 'none',
          postStateFingerprint: 'short',
        }),
        verify: async () => {
          evaluatorCalled = true;
          return {
            verified: true,
            evidenceRefs: ['fixture:must-not-run'],
            verifiedPostconditions: [
              'the fixture value is returned and verified',
            ],
            postconditionFingerprint: '6'.repeat(64),
            reason: 'Must not run.',
          };
        },
        cleanup: async () => {
          cleanupCalled = true;
          return true;
        },
      },
    ]);
    const scope = prepareCapabilityExecutionScope({
      acquisitionId: candidate.record.acquisitionId,
      ownerId: 'fixture-owner',
      chatId: 'fixture-chat',
      groupId: 'main',
      channel: 'certification',
      targetScopeKey: 'fixture-malformed-target',
      now: NOW,
    });
    const result = await runCapabilitySandbox({
      acquisitionId: candidate.record.acquisitionId,
      values: { key: 'alpha' },
      registry,
      currentResources: [resource()],
      scope,
      networkPolicy: 'none',
      now: NOW,
    });
    expect(result.state).toBe('indeterminate');
    expect(evaluatorCalled).toBe(false);
    expect(cleanupCalled).toBe(false);
    expect(
      listDurableEffectReceipts({ workId: scope.workId }).at(-1)?.status,
    ).toBe('unknown');
    expect(
      listCapabilityAcquisitionTransitions(result.acquisitionId).some(
        (transition) => transition.toState === 'sandbox_verified',
      ),
    ).toBe(false);
  });

  it('permits a repository effect only inside an exact marked disposable sandbox', async () => {
    const sandboxResource: CapabilityResourceDescriptor = {
      ...resource('sha256:sandbox-repository-v1'),
      resourceId: 'fixture.sandbox-repository',
      displayName: 'Disposable repository adapter',
      supportedPostconditions: ['the isolated adapter passes its evaluator'],
      requiredInputs: ['contents'],
      bindingRefs: [
        {
          bindingId: 'binding.fixture.sandbox-repository',
          operationId: 'write-isolated-adapter',
          evaluatorId: 'verify.fixture.sandbox-repository',
          executorImplementationDigest: executorDigest(
            'binding.fixture.sandbox-repository',
            'sha256:sandbox-repository-v1',
          ),
          evaluatorImplementationDigest: evaluatorDigest(
            'verify.fixture.sandbox-repository',
            'sha256:sandbox-repository-v1',
          ),
          actionClass: 'sandbox_repository_write',
          version: 'sha256:sandbox-repository-v1',
          readOnly: false,
        },
      ],
    };
    const initial = observeCapabilityGap({
      metadataClassification: 'derived_metadata',
      groupFolder: 'main',
      targetOutcome: 'Build and verify an adapter in a disposable repository',
      postconditions: ['the isolated adapter passes its evaluator'],
      taskFamily: 'fixture_repository',
      gapKind: 'implementation_gap',
      provenanceRefs: ['fixture:repository-contract'],
      evidenceOrigin: 'synthetic',
      environmentFingerprint: 'sha256:fixture-environment',
      now: NOW,
    });
    scopeCapabilityAcquisition({
      acquisitionId: initial.acquisitionId,
      knownPrerequisites: ['disposable fixture repository'],
      missingPrerequisites: [],
      confidence: 0.8,
      now: NOW,
    });
    recordCapabilityResourceDiscovery({
      acquisitionId: initial.acquisitionId,
      candidates: [sandboxResource],
      selected: [sandboxResource],
      rejectedReasons: {},
      now: NOW,
    });
    const candidate = compileCapabilityCandidate({
      acquisitionId: initial.acquisitionId,
      selectedResources: [sandboxResource],
      triggerSemantics: ['build an isolated fixture adapter'],
      requiredInputs: ['contents'],
      expectedOutput: 'A verified disposable adapter artifact.',
      deterministicScenarioIds: ['fixture-repository-primary'],
      heldOutScenarioIds: ['fixture-repository-heldout'],
      now: NOW,
    });
    expect(candidate.contract.steps.some((step) => step.approvalRequired)).toBe(
      false,
    );
    prepareCapabilitySandbox({
      acquisitionId: candidate.record.acquisitionId,
      now: NOW,
    });

    const sandboxRoot = mkdtempSync(
      join(tmpdir(), 'andrea-capability-sandbox-'),
    );
    try {
      const scope = prepareCapabilityExecutionScope({
        acquisitionId: candidate.record.acquisitionId,
        ownerId: 'synthetic-owner',
        chatId: 'synthetic-chat',
        groupId: 'main',
        channel: 'certification',
        targetScopeKey: realpathSync(sandboxRoot),
        now: NOW,
      });
      const targetScopeHash = capabilitySandboxTargetScopeHash(sandboxRoot);
      expect(scope.targetScopeHash).toBe(targetScopeHash);
      writeFileSync(
        join(sandboxRoot, CAPABILITY_SANDBOX_MARKER),
        JSON.stringify({
          contractVersion: 1,
          acquisitionId: candidate.record.acquisitionId,
          candidateFingerprint: candidate.contract.candidateFingerprint,
          targetScopeHash,
          disposable: true,
        }),
      );
      let executorCalls = 0;
      let announceExecution!: () => void;
      const executionStarted = new Promise<void>((resolve) => {
        announceExecution = resolve;
      });
      let releaseExecution!: () => void;
      const executionRelease = new Promise<void>((resolve) => {
        releaseExecution = resolve;
      });
      const registry = testRegistry([
        {
          bindingId: 'binding.fixture.sandbox-repository',
          operationId: 'write-isolated-adapter',
          evaluatorId: 'verify.fixture.sandbox-repository',
          resourceId: sandboxResource.resourceId,
          version: sandboxResource.version,
          executorImplementationDigest: executorDigest(
            'binding.fixture.sandbox-repository',
            sandboxResource.version,
          ),
          evaluatorImplementationDigest: evaluatorDigest(
            'verify.fixture.sandbox-repository',
            sandboxResource.version,
          ),
          actionClass: 'sandbox_repository_write',
          effectClass: 'sandbox_repository_write',
          networkAccess: 'none',
          execute: async ({ values, sandboxRoot: exactRoot }) => {
            executorCalls += 1;
            announceExecution();
            await executionRelease;
            if (exactRoot !== sandboxRoot) {
              throw new Error('Sandbox adapter received the wrong root.');
            }
            const artifact = join(sandboxRoot, 'adapter.ts');
            writeFileSync(artifact, String(values.contents));
            return {
              result: { artifact },
              evidenceRefs: ['fixture:isolated-write-receipt'],
              effectClass: 'sandbox_repository_write',
              effectStatus: 'certain',
              postStateFingerprint: '4'.repeat(64),
            };
          },
          verify: async ({ requiredPostconditions }) => ({
            verified:
              readFileSync(join(sandboxRoot, 'adapter.ts'), 'utf8') ===
              'export const adapter = true;\n',
            evidenceRefs: ['fixture:isolated-adapter-evaluator'],
            verifiedPostconditions: requiredPostconditions,
            postconditionFingerprint: '5'.repeat(64),
            reason: 'The final isolated artifact passed its evaluator.',
          }),
          cleanup: async () => true,
        },
      ]);
      const sandboxParams: Parameters<typeof runCapabilitySandbox>[0] = {
        acquisitionId: candidate.record.acquisitionId,
        values: { contents: 'export const adapter = true;\n' },
        registry,
        currentResources: [sandboxResource],
        scope,
        networkPolicy: 'none',
        sandboxRoot,
        now: NOW,
      };
      const primaryRun = runCapabilitySandbox(sandboxParams);
      await executionStarted;
      const concurrentResume = await runCapabilitySandbox({
        ...sandboxParams,
        executionId: 'concurrent-sandbox-resume',
      });
      expect(concurrentResume.state).toBe('sandbox_running');
      expect(executorCalls).toBe(1);
      releaseExecution();
      const verified = await primaryRun;

      expect(verified.state).toBe('sandbox_verified');
      expect(executorCalls).toBe(1);
      expect(readFileSync(join(sandboxRoot, 'adapter.ts'), 'utf8')).toBe(
        'export const adapter = true;\n',
      );
    } finally {
      rmSync(sandboxRoot, { recursive: true, force: true });
    }

    expect(() => capabilitySandboxTargetScopeHash(process.cwd())).toThrow(
      /disposable temporary root/,
    );
  });

  it('pauses on version drift before invoking the binding', async () => {
    const candidate = designed();
    prepareCapabilitySandbox({
      acquisitionId: candidate.record.acquisitionId,
      now: NOW,
    });
    let invoked = false;
    const registry = testRegistry([
      {
        bindingId: 'binding.fixture.lookup',
        operationId: 'lookup',
        evaluatorId: 'verify.fixture.lookup',
        resourceId: 'fixture.lookup',
        version: 'sha256:resource-v1',
        executorImplementationDigest: executorDigest(
          'binding.fixture.lookup',
          'sha256:resource-v1',
        ),
        evaluatorImplementationDigest: evaluatorDigest(
          'verify.fixture.lookup',
          'sha256:resource-v1',
        ),
        actionClass: 'local_lookup',
        effectClass: 'read_only',
        networkAccess: 'none',
        execute: async () => {
          invoked = true;
          throw new Error('must not run');
        },
        verify: async () => ({
          verified: false,
          evidenceRefs: [],
          verifiedPostconditions: [],
          reason: 'must not run',
        }),
      },
    ]);
    const scope = prepareCapabilityExecutionScope({
      acquisitionId: candidate.record.acquisitionId,
      ownerId: 'fixture-owner',
      chatId: 'fixture-chat',
      groupId: 'main',
      channel: 'certification',
      targetScopeKey: 'fixture-drift-target',
      now: NOW,
    });
    const paused = await runCapabilitySandbox({
      acquisitionId: candidate.record.acquisitionId,
      values: { key: 'alpha' },
      registry,
      currentResources: [resource('sha256:resource-v2')],
      scope,
      networkPolicy: 'none',
      now: NOW,
    });
    expect(paused.state).toBe('paused');
    expect(invoked).toBe(false);
  });

  it('rejects an unisolated local write during whole-plan sandbox preflight', async () => {
    const localWriteResource: CapabilityResourceDescriptor = {
      ...resource(),
      resourceId: 'fixture.local-write',
      displayName: 'Unisolated local writer',
      bindingRefs: [
        {
          ...resource().bindingRefs[0]!,
          bindingId: 'binding.fixture.local-write',
          evaluatorId: 'verify.fixture.local-write',
          executorImplementationDigest: executorDigest(
            'binding.fixture.local-write',
            'sha256:resource-v1',
          ),
          evaluatorImplementationDigest: evaluatorDigest(
            'verify.fixture.local-write',
            'sha256:resource-v1',
          ),
          actionClass: 'local_save',
          readOnly: false,
        },
      ],
    };
    const initial = observed();
    scopeCapabilityAcquisition({
      acquisitionId: initial.acquisitionId,
      knownPrerequisites: ['fixture key'],
      missingPrerequisites: [],
      confidence: 0.8,
      now: NOW,
    });
    recordCapabilityResourceDiscovery({
      acquisitionId: initial.acquisitionId,
      candidates: [localWriteResource],
      selected: [localWriteResource],
      rejectedReasons: {},
      now: NOW,
    });
    const candidate = compileCapabilityCandidate({
      acquisitionId: initial.acquisitionId,
      selectedResources: [localWriteResource],
      triggerSemantics: ['write an unisolated local fixture'],
      requiredInputs: ['key'],
      expectedOutput: 'A local fixture write.',
      now: NOW,
    });
    prepareCapabilitySandbox({
      acquisitionId: candidate.record.acquisitionId,
      now: NOW,
    });
    let invoked = false;
    const registry = testRegistry([
      {
        bindingId: 'binding.fixture.local-write',
        operationId: 'lookup',
        evaluatorId: 'verify.fixture.local-write',
        resourceId: localWriteResource.resourceId,
        version: localWriteResource.version,
        executorImplementationDigest: executorDigest(
          'binding.fixture.local-write',
          localWriteResource.version,
        ),
        evaluatorImplementationDigest: evaluatorDigest(
          'verify.fixture.local-write',
          localWriteResource.version,
        ),
        actionClass: 'local_save',
        effectClass: 'local_write',
        networkAccess: 'none',
        execute: async () => {
          invoked = true;
          throw new Error('must not run');
        },
        verify: async () => ({
          verified: false,
          evidenceRefs: [],
          verifiedPostconditions: [],
          reason: 'must not run',
        }),
      },
    ]);
    const scope = prepareCapabilityExecutionScope({
      acquisitionId: candidate.record.acquisitionId,
      ownerId: 'fixture-owner',
      chatId: 'fixture-chat',
      groupId: 'main',
      channel: 'certification',
      targetScopeKey: 'fixture-local-write-target',
      now: NOW,
    });
    const paused = await runCapabilitySandbox({
      acquisitionId: candidate.record.acquisitionId,
      values: { key: 'alpha' },
      registry,
      currentResources: [localWriteResource],
      scope,
      networkPolicy: 'none',
      now: NOW,
    });
    expect(paused.state).toBe('paused');
    expect(invoked).toBe(false);
  });

  it('keeps certification evidence at owner review and live execution closed', async () => {
    const { record } = await verifiedSandbox();
    expect(
      applySkillControl({
        skillId: record.compiledSkillId!,
        control: 'activate',
        groupFolder: 'main',
        now: NOW,
      }).ok,
    ).toBe(false);
    const reviewed = recordCapabilityHeldOutEvidence({
      acquisitionId: record.acquisitionId,
      evidence: {
        passed: true,
        cases: 15,
        safetyInvariantRate: 1,
        falseSuccesses: 0,
        evidenceRefs: ['fixture:heldout'],
      },
      actorKind: 'certification',
      now: NOW,
    });
    expect(reviewed.state).toBe('owner_review_required');
    expect(reviewed.evidenceOrigin).toBe('synthetic');
    expect(() =>
      activateVerifiedCapability({
        acquisitionId: reviewed.acquisitionId,
        activationWorkId: 'work:activation-1',
        canaryWorkId: 'work:canary-1',
        outcomeId: 'outcome:live-1',
        ownerReviewSignalId: 'review:owner-1',
      }),
    ).toThrow(/requires canary_ready state/);
    expect(() =>
      recordCapabilityCanaryOutcome({
        acquisitionId: reviewed.acquisitionId,
        durableWorkId: 'work:canary-1',
        outcomeId: 'outcome:live-1',
        ownerReviewSignalId: 'review:canary-1',
      }),
    ).toThrow(/requires canary_ready state/);
    await expect(
      executeActiveCapability({
        acquisitionId: reviewed.acquisitionId,
        executionId: 'execution:untrusted',
      }),
    ).rejects.toThrow(/active or monitoring state/);
  });

  it('quarantines a candidate after two distinct negative evaluations', () => {
    const { record } = designed();
    const first = recordCapabilityCandidateNegativeEvaluation({
      acquisitionId: record.acquisitionId,
      evaluationId: 'evaluation:correction-1',
      failureClass: 'heldout_correction',
      evidenceRefs: ['fixture:correction-1'],
      actorKind: 'system',
      now: NOW,
    });
    expect(first.state).toBe('candidate_designed');
    const replayed = recordCapabilityCandidateNegativeEvaluation({
      acquisitionId: record.acquisitionId,
      evaluationId: 'evaluation:correction-1',
      failureClass: 'heldout_correction',
      evidenceRefs: ['fixture:correction-1'],
      actorKind: 'system',
      now: new Date(NOW.getTime() + 1_000),
    });
    expect(replayed.recordVersion).toBe(first.recordVersion);
    expect(replayed.negativeOutcomeCount).toBe(1);
    const quarantined = recordCapabilityCandidateNegativeEvaluation({
      acquisitionId: record.acquisitionId,
      evaluationId: 'evaluation:correction-2',
      failureClass: 'heldout_correction',
      evidenceRefs: ['fixture:correction-2'],
      actorKind: 'system',
      now: NOW,
    });
    expect(quarantined.state).toBe('quarantined');
    expect(quarantined.negativeOutcomeCount).toBe(2);
    expect(quarantined.correctionCount).toBe(2);
  });

  it('redacts secrets and keeps report reads isolated to the explicit group', () => {
    const initial = observeCapabilityGap({
      metadataClassification: 'derived_metadata',
      groupFolder: 'main',
      targetOutcome:
        'Use key BSA-TEST-SENTINEL-NOT-A-REAL-KEY only as a secret-regression sentinel',
      postconditions: ['return a safe result'],
      taskFamily: 'privacy_fixture',
      gapKind: 'credential_or_access_gap',
      provenanceRefs: ['https://user:pass@example.com/doc?api_key=secret#frag'],
      evidenceOrigin: 'synthetic',
      environmentFingerprint: 'sha256:privacy-fixture',
      now: NOW,
    });
    const stored = getCapabilityAcquisition(initial.acquisitionId)!;
    markCapabilityExternallyBlocked({
      acquisitionId: initial.acquisitionId,
      expectedState: 'observed',
      blocker: 'A fixture dependency is unavailable.',
      evidenceRefs: [
        '/Users/owner/private-proof.txt',
        'https://user:pass@example.com/private/token/path?api_key=secret#frag',
      ],
      now: NOW,
    });
    const transitionJson = JSON.stringify(
      listCapabilityAcquisitionTransitions(initial.acquisitionId),
    );
    expect(JSON.stringify(stored)).not.toContain('BSA-AAAAAAAA');
    expect(JSON.stringify(stored)).not.toContain('user:pass');
    expect(transitionJson).not.toContain('/Users/owner');
    expect(transitionJson).not.toContain('/private/token/path');
    expect(transitionJson).not.toContain('api_key');
    expect(transitionJson).not.toContain('user:pass');
    expect(
      buildCapabilityAcquisitionReport({ groupFolder: 'main' }).records,
    ).toHaveLength(1);
    expect(capabilityMetadataJson({ token: 'secret-value' })).not.toContain(
      'secret-value',
    );
  });

  it('hashes local source references across URL, Windows, UNC, and relative path forms', () => {
    const localRefs = [
      'file:///Users/owner/private-proof.txt',
      String.raw`C:\Users\owner\private-proof.txt`,
      String.raw`\\server\share\private-proof.txt`,
      '../../private-proof.txt',
      './private-proof.txt',
      'proofs/private-proof.txt',
      String.raw`proofs\private-proof.txt`,
      '~/.config/private-proof.txt',
    ];
    const initial = observeCapabilityGap({
      metadataClassification: 'derived_metadata',
      groupFolder: 'main',
      targetOutcome: 'Keep local source reference fixtures private',
      postconditions: ['persist only safe source reference metadata'],
      taskFamily: 'source_reference_privacy_fixture',
      gapKind: 'tool_usage_gap',
      provenanceRefs: [
        ...localRefs,
        'fixture:safe-proof',
        'https://owner:secret@example.com:8443/private/path?token=secret#frag',
        'ftp://example.com/private/path',
      ],
      evidenceOrigin: 'synthetic',
      environmentFingerprint: 'sha256:source-reference-privacy-fixture',
      now: NOW,
    });
    const provenance = JSON.parse(initial.provenanceJson) as {
      refs: string[];
    };
    const serialized = JSON.stringify(provenance);

    for (const localRef of localRefs) {
      expect(serialized).not.toContain(localRef);
    }
    expect(
      provenance.refs.filter((ref) => ref.startsWith('local-ref:')),
    ).toHaveLength(localRefs.length);
    expect(provenance.refs).toContain('fixture:safe-proof');
    expect(
      provenance.refs.some((ref) =>
        /^https:\/\/example\.com:8443\/source-ref-[a-f0-9]{24}$/.test(ref),
      ),
    ).toBe(true);
    expect(serialized).not.toContain('owner:secret');
    expect(serialized).not.toContain('/private/path');
    expect(serialized).not.toContain('?token=');
    expect(serialized).not.toContain('ftp://');
    expect(
      provenance.refs.some((ref) => /^opaque-ref:[a-f0-9]{24}$/.test(ref)),
    ).toBe(true);
  });
});
