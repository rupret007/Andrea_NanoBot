import { describe, expect, it } from 'vitest';

import {
  capabilityBindingImplementationDigest,
  capabilityResourceDescriptorDigest,
  validateCapabilityBindingResult,
  validateCapabilityCandidateInput,
  validateCapabilityNetworkCeiling,
  validateCapabilityResourceDescriptors,
  validateCapabilityResourceHealth,
  validateCapabilityVerificationResult,
  type CapabilityResourceHealthEvidence,
  type SelectedCapabilityResourceFingerprint,
} from './capability-execution-guard.js';
import type {
  CapabilityCandidateContract,
  CapabilityResourceDescriptor,
} from './types.js';

const EXECUTOR_DIGEST = capabilityBindingImplementationDigest({
  kind: 'executor',
  implementationId: 'fixture-executor',
  version: 'v1',
});
const EVALUATOR_DIGEST = capabilityBindingImplementationDigest({
  kind: 'evaluator',
  implementationId: 'fixture-evaluator',
  version: 'v1',
});

describe('capability binding implementation digest', () => {
  it('is stable, role-separated, and version-bound', () => {
    expect(
      capabilityBindingImplementationDigest({
        kind: 'executor',
        implementationId: 'fixture-executor',
        version: 'v1',
      }),
    ).toBe(EXECUTOR_DIGEST);
    expect(
      capabilityBindingImplementationDigest({
        kind: 'evaluator',
        implementationId: 'fixture-executor',
        version: 'v1',
      }),
    ).not.toBe(EXECUTOR_DIGEST);
    expect(
      capabilityBindingImplementationDigest({
        kind: 'executor',
        implementationId: 'fixture-executor',
        version: 'v2',
      }),
    ).not.toBe(EXECUTOR_DIGEST);
  });

  it('rejects empty or oversized implementation identities', () => {
    expect(() =>
      capabilityBindingImplementationDigest({
        kind: 'executor',
        implementationId: '',
        version: 'v1',
      }),
    ).toThrow(/malformed/);
  });
});

function contract(
  overrides: Partial<CapabilityCandidateContract> = {},
): CapabilityCandidateContract {
  return {
    contractVersion: 1,
    candidateFingerprint: 'a'.repeat(64),
    capabilityId: 'capability.fixture',
    skillId: 'skill.fixture',
    title: 'Fixture capability',
    taskFamily: 'fixture',
    triggerSemantics: ['fixture'],
    implementationKind: 'existing_capability',
    requiredInputs: ['query'],
    optionalInputs: ['limit'],
    inputSchemaJson: JSON.stringify({
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer' },
      },
      additionalProperties: false,
    }),
    outputSchemaJson: '{}',
    preconditions: [],
    resourceBindings: [
      {
        resourceId: 'resource.fixture',
        bindingKind: 'execution_adapter',
        version: 'v1',
        required: true,
      },
    ],
    steps: [
      {
        stepId: 'step-1',
        title: 'Fixture step',
        resourceId: 'resource.fixture',
        bindingId: 'binding.fixture',
        operationId: 'operation.fixture',
        evaluatorId: 'evaluator.fixture',
        version: 'v1',
        executorImplementationDigest: EXECUTOR_DIGEST,
        evaluatorImplementationDigest: EVALUATOR_DIGEST,
        actionClass: 'local_lookup',
        readOnly: true,
        approvalRequired: false,
        idempotencyKeyRequired: true,
        expectedEvidence: ['fixture complete'],
      },
    ],
    fallbackPaths: [],
    allowedActions: ['local_lookup'],
    prohibitedActions: [],
    approvalRequirements: [],
    credentialRequirements: [],
    dataEgressClass: 'local_only',
    expectedOutput: 'fixture result',
    successPostconditions: [],
    verificationProcedure: [],
    verifierBindingIds: ['evaluator.fixture'],
    failureClassifications: [],
    rollbackProcedure: [],
    rollbackBindingIds: [],
    deterministicScenarioIds: [],
    heldOutScenarioIds: [],
    compatibleResourceVersions: { 'resource.fixture': ['v1'] },
    revalidationRequirements: [],
    provenanceRefs: [],
    ...overrides,
  };
}

function resource(
  overrides: Partial<CapabilityResourceDescriptor> = {},
): CapabilityResourceDescriptor {
  return {
    resourceId: 'resource.fixture',
    kind: 'local_script',
    displayName: 'Fixture resource',
    taskFamilies: ['fixture'],
    capabilityIds: ['capability.fixture'],
    supportedPostconditions: ['fixture complete'],
    requiredInputs: ['query'],
    available: true,
    healthState: 'healthy',
    verificationStrength: 1,
    reliabilityScore: 1,
    authorityRequirement: 'none',
    riskLevel: 'low',
    dataEgressClass: 'local_only',
    reversible: true,
    expectedCostBand: 'zero',
    expectedLatencyBand: 'instant',
    version: 'v1',
    sourceRefs: ['fixture:resource'],
    maintenanceBurden: 'low',
    bindingRefs: [
      {
        bindingId: 'binding.fixture',
        operationId: 'operation.fixture',
        evaluatorId: 'evaluator.fixture',
        executorImplementationDigest: EXECUTOR_DIGEST,
        evaluatorImplementationDigest: EVALUATOR_DIGEST,
        actionClass: 'local_lookup',
        version: 'v1',
        readOnly: true,
      },
    ],
    ...overrides,
  };
}

function selected(
  descriptor: CapabilityResourceDescriptor,
): SelectedCapabilityResourceFingerprint[] {
  return [
    {
      resourceId: descriptor.resourceId,
      version: descriptor.version,
      descriptorDigest: capabilityResourceDescriptorDigest(descriptor),
    },
  ];
}

describe('capability execution input guard', () => {
  it('accepts exactly typed required and optional inputs', () => {
    expect(
      validateCapabilityCandidateInput(contract(), {
        query: 'status',
        limit: 3,
      }),
    ).toEqual({ ok: true });
  });

  it.each([
    [{ limit: 3 }, 'missing'],
    [{ query: 42 }, 'wrong type'],
    [{ query: 'status', surprise: true }, 'extra'],
  ])('rejects %s input (%s)', (value, _label) => {
    expect(validateCapabilityCandidateInput(contract(), value)).toMatchObject({
      ok: false,
      code: 'invalid_input',
    });
  });

  it.each([
    '{bad',
    JSON.stringify({
      type: 'object',
      required: ['query'],
      properties: { query: { type: 'string', pattern: '.*' } },
      additionalProperties: false,
    }),
    JSON.stringify({
      type: 'object',
      required: ['query'],
      properties: { query: { type: 'array' }, limit: { type: 'integer' } },
      additionalProperties: false,
    }),
    JSON.stringify({
      type: 'object',
      required: ['not-declared'],
      properties: { query: { type: 'string' }, limit: { type: 'integer' } },
      additionalProperties: false,
    }),
  ])(
    'fails closed for malformed or unsupported schema %s',
    (inputSchemaJson) => {
      expect(
        validateCapabilityCandidateInput(contract({ inputSchemaJson }), {
          query: 'status',
        }),
      ).toMatchObject({ ok: false, code: 'malformed_input_schema' });
    },
  );
});

describe('capability executor and evaluator result guards', () => {
  const outputContract = () =>
    contract({
      outputSchemaJson: JSON.stringify({
        type: 'object',
        required: ['result', 'evidenceRefs'],
        additionalProperties: true,
      }),
    });

  it('accepts an exact certain result and evidence-backed verification', () => {
    expect(
      validateCapabilityBindingResult({
        contract: outputContract(),
        declaredEffectClass: 'read_only',
        value: {
          result: { value: 'fixture' },
          evidenceRefs: ['fixture:execution'],
          effectClass: 'read_only',
          effectStatus: 'certain',
          postStateFingerprint: 'a'.repeat(64),
          providerCalls: 0,
          costUsd: 0,
        },
      }),
    ).toEqual({ ok: true });
    expect(
      validateCapabilityVerificationResult({
        expectedEvidence: ['fixture complete'],
        value: {
          verified: true,
          evidenceRefs: ['fixture:evaluator'],
          verifiedPostconditions: ['fixture complete'],
          postconditionFingerprint: 'b'.repeat(64),
          reason: 'Verified the fixture postcondition.',
        },
      }),
    ).toEqual({ ok: true });
  });

  it.each([
    [
      'misclassified effect',
      {
        result: null,
        evidenceRefs: ['fixture:execution'],
        effectClass: 'local_write',
        effectStatus: 'certain',
        postStateFingerprint: 'a'.repeat(64),
      },
      'effect_policy_mismatch',
    ],
    [
      'uncertain effect',
      {
        result: null,
        evidenceRefs: ['fixture:execution'],
        effectClass: 'read_only',
        effectStatus: 'unknown',
        postStateFingerprint: 'a'.repeat(64),
      },
      'invalid_binding_result',
    ],
    [
      'missing post-state',
      {
        result: null,
        evidenceRefs: ['fixture:execution'],
        effectClass: 'read_only',
        effectStatus: 'certain',
      },
      'invalid_binding_result',
    ],
  ])('rejects a %s', (_label, value, code) => {
    expect(
      validateCapabilityBindingResult({
        contract: outputContract(),
        declaredEffectClass: 'read_only',
        value,
      }),
    ).toMatchObject({ ok: false, code });
  });

  it('fails closed for a malformed output schema or evaluator claim', () => {
    expect(
      validateCapabilityBindingResult({
        contract: contract({ outputSchemaJson: '{}' }),
        declaredEffectClass: 'read_only',
        value: {},
      }),
    ).toMatchObject({ ok: false, code: 'malformed_output_schema' });
    expect(
      validateCapabilityVerificationResult({
        expectedEvidence: ['fixture complete'],
        value: {
          verified: true,
          evidenceRefs: [],
          verifiedPostconditions: [],
          postconditionFingerprint: 'not-a-digest',
          reason: '',
        },
      }),
    ).toMatchObject({ ok: false, code: 'invalid_verification' });
  });
});

describe('capability resource descriptor guard', () => {
  it('accepts the exact selected canonical descriptor and compatible version', () => {
    const descriptor = resource();
    expect(
      validateCapabilityResourceDescriptors({
        contract: contract(),
        selected: selected(descriptor),
        currentResources: [descriptor],
      }),
    ).toEqual({ ok: true });
  });

  it('rejects a swapped binding under the same resource ID and version', () => {
    const descriptor = resource();
    const swapped = resource({
      bindingRefs: [
        {
          bindingId: 'binding.attacker',
          operationId: 'operation.attacker',
          evaluatorId: 'evaluator.attacker',
          executorImplementationDigest: capabilityBindingImplementationDigest({
            kind: 'executor',
            implementationId: 'attacker-executor',
            version: 'v1',
          }),
          evaluatorImplementationDigest: capabilityBindingImplementationDigest({
            kind: 'evaluator',
            implementationId: 'attacker-evaluator',
            version: 'v1',
          }),
          actionClass: 'local_lookup',
          version: 'v1',
          readOnly: true,
        },
      ],
    });
    expect(
      validateCapabilityResourceDescriptors({
        contract: contract(),
        selected: selected(descriptor),
        currentResources: [swapped],
      }),
    ).toMatchObject({ ok: false, code: 'resource_descriptor_drift' });
  });

  it('rejects an implementation digest swap despite stable public IDs', () => {
    const descriptor = resource();
    expect(
      validateCapabilityResourceDescriptors({
        contract: contract({
          steps: contract().steps.map((step) => ({
            ...step,
            executorImplementationDigest: 'f'.repeat(64),
          })),
        }),
        selected: selected(descriptor),
        currentResources: [descriptor],
      }),
    ).toMatchObject({ ok: false, code: 'resource_descriptor_drift' });
  });

  it('rejects descriptor and contract version drift', () => {
    const descriptor = resource();
    const drifted = resource({ version: 'v2' });
    expect(
      validateCapabilityResourceDescriptors({
        contract: contract(),
        selected: selected(descriptor),
        currentResources: [drifted],
      }),
    ).toMatchObject({ ok: false, code: 'resource_descriptor_drift' });

    expect(
      validateCapabilityResourceDescriptors({
        contract: contract({
          compatibleResourceVersions: { 'resource.fixture': ['v2'] },
        }),
        selected: selected(descriptor),
        currentResources: [descriptor],
      }),
    ).toMatchObject({ ok: false, code: 'resource_version_drift' });
  });
});

describe('capability resource health guard', () => {
  const now = new Date('2026-07-14T12:00:00.000Z');
  const descriptor = resource();
  const selection = selected(descriptor);

  function health(
    overrides: Partial<CapabilityResourceHealthEvidence> = {},
  ): CapabilityResourceHealthEvidence {
    return {
      resourceId: descriptor.resourceId,
      descriptorDigest: selection[0]!.descriptorDigest,
      healthState: 'healthy',
      observedAt: '2026-07-14T11:59:30.000Z',
      expiresAt: '2026-07-14T12:05:00.000Z',
      maxAgeMs: 60_000,
      ...overrides,
    };
  }

  it('accepts fresh, unexpired health bound to the selected descriptor', () => {
    expect(
      validateCapabilityResourceHealth({
        selected: selection,
        evidence: [health()],
        now,
      }),
    ).toEqual({ ok: true });
  });

  it.each([
    [{ observedAt: '2026-07-14T11:58:00.000Z' }, 'resource_health_stale'],
    [{ observedAt: '2026-07-14T12:00:01.000Z' }, 'resource_health_future'],
    [{ expiresAt: '2026-07-14T12:00:00.000Z' }, 'resource_health_expired'],
  ])('rejects invalid freshness evidence %#', (overrides, code) => {
    expect(
      validateCapabilityResourceHealth({
        selected: selection,
        evidence: [health(overrides)],
        now,
      }),
    ).toMatchObject({ ok: false, code });
  });
});

describe('capability network ceiling guard', () => {
  it('allows loopback for a local-only acquisition', () => {
    expect(
      validateCapabilityNetworkCeiling({
        contractDataEgressClass: 'local_only',
        acquisitionDataEgressClass: 'local_only',
        requestedNetworkAccess: 'loopback',
      }),
    ).toEqual({ ok: true });
  });

  it('rejects external network for a local-only contract', () => {
    expect(
      validateCapabilityNetworkCeiling({
        contractDataEgressClass: 'local_only',
        acquisitionDataEgressClass: 'local_only',
        requestedNetworkAccess: 'external',
      }),
    ).toMatchObject({ ok: false, code: 'network_policy_denied' });
  });

  it('denies every network request for prohibited data egress', () => {
    for (const requestedNetworkAccess of ['loopback', 'external'] as const) {
      expect(
        validateCapabilityNetworkCeiling({
          contractDataEgressClass: 'prohibited',
          acquisitionDataEgressClass: 'prohibited',
          requestedNetworkAccess,
        }),
      ).toMatchObject({ ok: false, code: 'network_policy_denied' });
    }
    expect(
      validateCapabilityNetworkCeiling({
        contractDataEgressClass: 'prohibited',
        acquisitionDataEgressClass: 'prohibited',
        requestedNetworkAccess: 'none',
      }),
    ).toEqual({ ok: true });
  });

  it('rejects a contract/acquisition egress mismatch', () => {
    expect(
      validateCapabilityNetworkCeiling({
        contractDataEgressClass: 'sanitized_metadata',
        acquisitionDataEgressClass: 'local_only',
        requestedNetworkAccess: 'loopback',
      }),
    ).toMatchObject({ ok: false, code: 'egress_policy_mismatch' });
  });
});
