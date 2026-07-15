import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { capabilityBindingImplementationDigest } from './capability-execution-guard.js';
import type { CapabilityCandidateContract } from './types.js';
import {
  createHermeticCertificationBindingRegistry,
  type CapabilityEvaluatorBinding,
  type CapabilityExecutorBinding,
} from './verified-capability-acquisition.js';

const VERSION = 'sha256:fixture-v1';
const EXECUTOR_DIGEST = capabilityBindingImplementationDigest({
  kind: 'executor',
  implementationId: 'fixture.executor',
  version: VERSION,
});
const EVALUATOR_DIGEST = capabilityBindingImplementationDigest({
  kind: 'evaluator',
  implementationId: 'fixture.evaluator',
  version: VERSION,
});

const step: CapabilityCandidateContract['steps'][number] = {
  stepId: 'step-1',
  title: 'Fixture step',
  resourceId: 'fixture.resource',
  bindingId: 'fixture.binding',
  operationId: 'fixture.operation',
  evaluatorId: 'fixture.evaluator',
  version: VERSION,
  executorImplementationDigest: EXECUTOR_DIGEST,
  evaluatorImplementationDigest: EVALUATOR_DIGEST,
  actionClass: 'local_lookup',
  readOnly: true,
  approvalRequired: false,
  idempotencyKeyRequired: true,
  expectedEvidence: ['fixture evidence'],
};

beforeEach(() => {
  vi.stubEnv('ANDREA_NOVEL_CAPABILITY_CERT_HERMETIC_PARENT', '1');
});

afterEach(() => vi.unstubAllEnvs());

function executor(
  overrides: Partial<CapabilityExecutorBinding> = {},
): CapabilityExecutorBinding {
  return {
    bindingId: step.bindingId,
    operationId: step.operationId,
    resourceId: step.resourceId,
    version: step.version,
    executorImplementationDigest: EXECUTOR_DIGEST,
    actionClass: 'local_lookup',
    effectClass: 'read_only',
    networkAccess: 'none',
    execute: async () => ({
      result: 'fixture',
      evidenceRefs: ['fixture:execution'],
      effectClass: 'read_only',
      effectStatus: 'certain',
    }),
    ...overrides,
  };
}

function evaluator(
  overrides: Partial<CapabilityEvaluatorBinding> = {},
): CapabilityEvaluatorBinding {
  return {
    evaluatorId: step.evaluatorId,
    operationId: step.operationId,
    resourceId: step.resourceId,
    version: step.version,
    evaluatorImplementationDigest: EVALUATOR_DIGEST,
    verify: async () => ({
      verified: true,
      evidenceRefs: ['fixture:evaluation'],
      verifiedPostconditions: ['fixture evidence'],
      reason: 'Fixture verified.',
    }),
    ...overrides,
  };
}

describe('verified capability binding implementation integrity', () => {
  it('refuses registry construction outside the guarded certification process', () => {
    vi.stubEnv('ANDREA_NOVEL_CAPABILITY_CERT_HERMETIC_PARENT', '0');
    expect(() =>
      createHermeticCertificationBindingRegistry({
        executors: [executor()],
        evaluators: [evaluator()],
      }),
    ).toThrow(/hermetic guarded certification process/);
  });

  it('requires cleanup for the certification-only repository write effect', () => {
    expect(() =>
      createHermeticCertificationBindingRegistry({
        executors: [
          executor({
            actionClass: 'sandbox_repository_write',
            effectClass: 'sandbox_repository_write',
          }),
        ],
        evaluators: [evaluator()],
      }),
    ).toThrow(/require a registered cleanup verifier/);
  });

  it('resolves only the exact version-bound executor and evaluator digests', () => {
    const registry = createHermeticCertificationBindingRegistry({
      executors: [executor()],
      evaluators: [evaluator()],
    });

    expect(registry.resolveExecutor(step).executorImplementationDigest).toBe(
      EXECUTOR_DIGEST,
    );
    expect(registry.resolveEvaluator(step).evaluatorImplementationDigest).toBe(
      EVALUATOR_DIGEST,
    );
  });

  it.each([
    ['executor digest', { executorImplementationDigest: 'e'.repeat(64) }, {}],
    ['executor version', { version: 'sha256:fixture-v2' }, {}],
    ['evaluator digest', {}, { evaluatorImplementationDigest: 'e'.repeat(64) }],
    ['evaluator version', {}, { version: 'sha256:fixture-v2' }],
  ] as const)(
    'rejects a substituted %s',
    (name, executorOverrides, evaluatorOverrides) => {
      const registry = createHermeticCertificationBindingRegistry({
        executors: [executor(executorOverrides)],
        evaluators: [evaluator(evaluatorOverrides)],
      });

      if (name.startsWith('executor')) {
        expect(() => registry.resolveExecutor(step)).toThrow(
          /compiled contract/,
        );
      } else {
        expect(() => registry.resolveEvaluator(step)).toThrow(
          /compiled contract/,
        );
      }
    },
  );

  it('rejects malformed implementation digests at registry construction', () => {
    expect(() =>
      createHermeticCertificationBindingRegistry({
        executors: [executor({ executorImplementationDigest: 'not-a-digest' })],
        evaluators: [evaluator()],
      }),
    ).toThrow(/Malformed capability executor identity/);
  });
});
