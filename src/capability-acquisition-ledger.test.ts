import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabaseAtPath,
  applyCapabilityAcquisitionTransitionCAS,
  getCapabilityAcquisition,
  insertCapabilityAcquisition,
  isDatabaseInitialized,
  listCapabilityAcquisitionTransitions,
} from './db.js';
import {
  assertCapabilityAcquisitionTransition,
  capabilityAcquisitionSnapshotJson,
  capabilityTransitionDigest,
} from './capability-acquisition-policy.js';
import { capabilityBindingImplementationDigest } from './capability-execution-guard.js';
import type {
  CapabilityAcquisitionRecord,
  CapabilityAcquisitionTransitionRecord,
  CapabilityResourceDescriptor,
} from './types.js';
import {
  capabilityMetadataJson,
  compileCapabilityCandidate,
  createHermeticCertificationBindingRegistry,
  observeCapabilityGap,
  prepareCapabilityExecutionScope,
  prepareCapabilitySandbox,
  recordCapabilityHeldOutEvidence,
  recordCapabilityResourceDiscovery,
  runCapabilitySandbox,
  scopeCapabilityAcquisition,
  type CapabilityEvaluatorBinding,
  type CapabilityExecutorBinding,
  type VerifiedCapabilityBindingRegistry,
} from './verified-capability-acquisition.js';

const NOW = new Date('2026-07-14T15:00:00.000Z');
const LATER = new Date('2026-07-14T15:01:00.000Z');

type CombinedTestBinding = CapabilityExecutorBinding &
  Pick<
    CapabilityEvaluatorBinding,
    'evaluatorId' | 'evaluatorImplementationDigest' | 'verify'
  >;

const EXECUTOR_DIGEST = capabilityBindingImplementationDigest({
  kind: 'executor',
  implementationId: 'binding.fixture.lookup',
  version: 'sha256:fixture-resource-v1',
});
const EVALUATOR_DIGEST = capabilityBindingImplementationDigest({
  kind: 'evaluator',
  implementationId: 'verify.fixture.lookup',
  version: 'sha256:fixture-resource-v1',
});

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

let testDirectory = '';
let databasePath = '';

beforeEach(() => {
  vi.stubEnv('ANDREA_NOVEL_CAPABILITY_CERT_HERMETIC_PARENT', '1');
  if (isDatabaseInitialized()) _closeDatabase();
  testDirectory = mkdtempSync(
    join(tmpdir(), 'andrea-capability-acquisition-ledger-'),
  );
  databasePath = join(testDirectory, 'messages.db');
  _initTestDatabaseAtPath(databasePath);
});

afterEach(() => {
  if (isDatabaseInitialized()) _closeDatabase();
  rmSync(testDirectory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function observe(
  suffix: string,
  evidenceOrigin: CapabilityAcquisitionRecord['evidenceOrigin'] = 'synthetic',
): CapabilityAcquisitionRecord {
  return observeCapabilityGap({
    metadataClassification: 'derived_metadata',
    groupFolder: 'main',
    targetOutcome: `Return and verify fixture ${suffix}`,
    postconditions: ['the exact fixture value is verified'],
    taskFamily: 'ledger_fixture',
    gapKind: 'tool_usage_gap',
    provenanceRefs: [`owner-request:${suffix}`],
    evidenceOrigin,
    environmentFingerprint: 'sha256:ledger-environment-v1',
    now: NOW,
  });
}

function enterSandboxRunningWithoutEvidence(
  suffix: string,
  evidenceOrigin: CapabilityAcquisitionRecord['evidenceOrigin'],
): CapabilityAcquisitionRecord {
  const initial = observe(suffix, evidenceOrigin);
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
  const candidate = compileCapabilityCandidate({
    acquisitionId: initial.acquisitionId,
    selectedResources: [resource()],
    triggerSemantics: ['verify a fixture lookup'],
    requiredInputs: ['key'],
    expectedOutput: 'One verified fixture result.',
    now: NOW,
  });
  prepareCapabilitySandbox({
    acquisitionId: candidate.record.acquisitionId,
    now: NOW,
  });
  const ready = getCapabilityAcquisition(initial.acquisitionId)!;
  const runningAttempt = buildRawTransition({
    current: ready,
    toState: 'sandbox_running',
    idempotencyKey: `enter-sandbox-running-without-effect:${suffix}`,
  });
  expect(
    applyCapabilityAcquisitionTransitionCAS({
      expectedState: 'sandbox_ready',
      ...runningAttempt,
    }),
  ).toBe('applied');
  return getCapabilityAcquisition(initial.acquisitionId)!;
}

function resource(): CapabilityResourceDescriptor {
  return {
    resourceId: 'fixture.lookup',
    kind: 'local_script',
    displayName: 'Fixture lookup',
    taskFamilies: ['ledger_fixture'],
    capabilityIds: ['fixture.lookup'],
    supportedPostconditions: ['the exact fixture value is verified'],
    requiredInputs: ['key'],
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
    version: 'sha256:fixture-resource-v1',
    sourceRefs: ['fixture:lookup-contract'],
    maintenanceBurden: 'low',
    bindingRefs: [
      {
        bindingId: 'binding.fixture.lookup',
        operationId: 'lookup',
        evaluatorId: 'verify.fixture.lookup',
        executorImplementationDigest: EXECUTOR_DIGEST,
        evaluatorImplementationDigest: EVALUATOR_DIGEST,
        actionClass: 'local_lookup',
        version: 'sha256:fixture-resource-v1',
        readOnly: true,
      },
    ],
  };
}

function digestFor(
  transition: Pick<
    CapabilityAcquisitionTransitionRecord,
    | 'acquisitionId'
    | 'fromState'
    | 'toState'
    | 'expectedVersion'
    | 'resultingVersion'
    | 'actorKind'
    | 'reason'
    | 'evidenceRefsJson'
    | 'idempotencyKey'
    | 'resultingSnapshotJson'
  >,
): string {
  return capabilityTransitionDigest({
    acquisitionId: transition.acquisitionId,
    fromState: transition.fromState,
    toState: transition.toState,
    expectedVersion: transition.expectedVersion,
    resultingVersion: transition.resultingVersion,
    actorKind: transition.actorKind,
    reason: transition.reason,
    evidenceRefsJson: transition.evidenceRefsJson,
    idempotencyKey: transition.idempotencyKey,
    resultingSnapshotJson: transition.resultingSnapshotJson,
  });
}

function buildScopedTransition(params: {
  current: CapabilityAcquisitionRecord;
  idempotencyKey: string;
  nextOverrides?: Partial<CapabilityAcquisitionRecord>;
  transitionOverrides?: Partial<CapabilityAcquisitionTransitionRecord>;
}): {
  next: CapabilityAcquisitionRecord;
  transition: CapabilityAcquisitionTransitionRecord;
} {
  const next: CapabilityAcquisitionRecord = {
    ...params.current,
    state: 'scoped',
    updatedAt: LATER.toISOString(),
    recordVersion: params.current.recordVersion + 1,
    knownPrerequisitesJson: '["fixture key"]',
    nextSafeAction: 'Discover the exact fixture binding.',
    ...params.nextOverrides,
  };
  const base = {
    acquisitionId: params.current.acquisitionId,
    fromState: 'observed' as const,
    toState: 'scoped' as const,
    expectedVersion: params.current.recordVersion,
    resultingVersion: next.recordVersion,
    actorKind: 'system' as const,
    reason: 'Scope one adversarial ledger fixture.',
    evidenceRefsJson: '[]',
    idempotencyKey: params.idempotencyKey,
    resultingSnapshotJson: capabilityAcquisitionSnapshotJson(next),
    ...params.transitionOverrides,
  };
  return {
    next,
    transition: {
      transitionId: `transition:${params.idempotencyKey}`,
      createdAt: next.updatedAt,
      ...base,
      transitionDigest: digestFor(base),
      privacyJson: next.privacyJson,
    },
  };
}

function buildRawTransition(params: {
  current: CapabilityAcquisitionRecord;
  toState: CapabilityAcquisitionRecord['state'];
  idempotencyKey: string;
  actorKind?: CapabilityAcquisitionTransitionRecord['actorKind'];
  nextOverrides?: Partial<CapabilityAcquisitionRecord>;
}): {
  next: CapabilityAcquisitionRecord;
  transition: CapabilityAcquisitionTransitionRecord;
} {
  const next: CapabilityAcquisitionRecord = {
    ...params.current,
    ...params.nextOverrides,
    state: params.toState,
    updatedAt: LATER.toISOString(),
    recordVersion: params.current.recordVersion + 1,
  };
  const base = {
    acquisitionId: params.current.acquisitionId,
    fromState: params.current.state,
    toState: params.toState,
    expectedVersion: params.current.recordVersion,
    resultingVersion: next.recordVersion,
    actorKind: params.actorKind || ('system' as const),
    reason: 'Attempt one adversarial canonical ledger transition.',
    evidenceRefsJson: '[]',
    idempotencyKey: params.idempotencyKey,
    resultingSnapshotJson: capabilityAcquisitionSnapshotJson(next),
  };
  return {
    next,
    transition: {
      transitionId: `transition:${params.idempotencyKey}`,
      createdAt: next.updatedAt,
      ...base,
      transitionDigest: digestFor(base),
      privacyJson: next.privacyJson,
    },
  };
}

function withRawDatabase<T>(callback: (database: Database.Database) => T): T {
  const database = new Database(databasePath);
  database.pragma('busy_timeout = 5000');
  database.pragma('foreign_keys = ON');
  try {
    return callback(database);
  } finally {
    database.close();
  }
}

async function createSyntheticHeldOutCandidate(
  suffix: string,
): Promise<CapabilityAcquisitionRecord> {
  const initial = observe(suffix);
  scopeCapabilityAcquisition({
    acquisitionId: initial.acquisitionId,
    knownPrerequisites: ['fixture key'],
    missingPrerequisites: [],
    confidence: 0.9,
    now: NOW,
  });
  recordCapabilityResourceDiscovery({
    acquisitionId: initial.acquisitionId,
    candidates: [resource()],
    selected: [resource()],
    rejectedReasons: {},
    now: NOW,
  });
  const candidate = compileCapabilityCandidate({
    acquisitionId: initial.acquisitionId,
    selectedResources: [resource()],
    triggerSemantics: ['verify a ledger fixture'],
    requiredInputs: ['key'],
    expectedOutput: 'One verified fixture result.',
    deterministicScenarioIds: ['ledger-primary'],
    heldOutScenarioIds: ['ledger-heldout'],
    now: NOW,
  });
  prepareCapabilitySandbox({
    acquisitionId: candidate.record.acquisitionId,
    now: NOW,
  });
  const registry = testRegistry([
    {
      bindingId: 'binding.fixture.lookup',
      operationId: 'lookup',
      evaluatorId: 'verify.fixture.lookup',
      resourceId: 'fixture.lookup',
      version: 'sha256:fixture-resource-v1',
      executorImplementationDigest: EXECUTOR_DIGEST,
      evaluatorImplementationDigest: EVALUATOR_DIGEST,
      actionClass: 'local_lookup',
      effectClass: 'read_only',
      networkAccess: 'none',
      execute: async ({ values }) => ({
        result: { value: `value:${String(values.key)}` },
        evidenceRefs: ['fixture:read'],
        effectClass: 'read_only',
        effectStatus: 'certain',
        preStateFingerprint: '1'.repeat(64),
        postStateFingerprint: '2'.repeat(64),
        providerCalls: 0,
        costUsd: 0,
      }),
      verify: async ({ result, requiredPostconditions }) => ({
        verified:
          typeof (result.result as { value?: unknown }).value === 'string',
        evidenceRefs: ['fixture:verified'],
        verifiedPostconditions: requiredPostconditions,
        postconditionFingerprint: '3'.repeat(64),
        reason: 'The registered evaluator observed the fixture value.',
      }),
    },
  ]);
  const scope = prepareCapabilityExecutionScope({
    acquisitionId: candidate.record.acquisitionId,
    ownerId: 'fixture-owner',
    chatId: 'fixture-chat',
    groupId: 'main',
    channel: 'certification',
    targetScopeKey: `ledger-target-${suffix}`,
    now: NOW,
  });
  const verified = await runCapabilitySandbox({
    acquisitionId: candidate.record.acquisitionId,
    values: { key: suffix },
    registry,
    currentResources: [resource()],
    scope,
    networkPolicy: 'none',
    now: NOW,
  });
  return recordCapabilityHeldOutEvidence({
    acquisitionId: verified.acquisitionId,
    evidence: {
      passed: true,
      cases: 12,
      safetyInvariantRate: 1,
      falseSuccesses: 0,
      evidenceRefs: ['fixture:heldout'],
    },
    actorKind: 'certification',
    now: NOW,
  });
}

describe('capability acquisition canonical ledger', () => {
  it('survives repeated on-disk initialization and exact restart reconstruction', () => {
    const initial = observe('restart');
    scopeCapabilityAcquisition({
      acquisitionId: initial.acquisitionId,
      knownPrerequisites: ['fixture key'],
      missingPrerequisites: [],
      confidence: 0.91,
      now: LATER,
    });
    const expectedHead = capabilityAcquisitionSnapshotJson(
      getCapabilityAcquisition(initial.acquisitionId)!,
    );
    const expectedHistory = JSON.stringify(
      listCapabilityAcquisitionTransitions(initial.acquisitionId),
    );

    for (let reopen = 0; reopen < 2; reopen += 1) {
      _closeDatabase();
      _initTestDatabaseAtPath(databasePath);
      expect(
        capabilityAcquisitionSnapshotJson(
          getCapabilityAcquisition(initial.acquisitionId)!,
        ),
      ).toBe(expectedHead);
      expect(
        JSON.stringify(
          listCapabilityAcquisitionTransitions(initial.acquisitionId),
        ),
      ).toBe(expectedHistory);
    }
  });

  it('writes one atomic genesis whose canonical snapshot equals the head', () => {
    const initial = observe('genesis');
    const history = listCapabilityAcquisitionTransitions(initial.acquisitionId);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      acquisitionId: initial.acquisitionId,
      fromState: 'observed',
      toState: 'observed',
      expectedVersion: 0,
      resultingVersion: 1,
    });
    expect(history[0].resultingSnapshotJson).toBe(
      capabilityAcquisitionSnapshotJson(initial),
    );
    expect(history[0].transitionDigest).toBe(digestFor(history[0]));
  });

  it('rolls back the head when genesis revision insertion fails', () => {
    const placeholder = observe('atomic-placeholder');
    const target = observe('atomic-target');
    const targetId = target.acquisitionId;
    const placeholderGenesis = listCapabilityAcquisitionTransitions(
      placeholder.acquisitionId,
    )[0];

    withRawDatabase((database) => {
      database
        .prepare('DELETE FROM capability_acquisitions WHERE acquisition_id = ?')
        .run(targetId);
      database
        .prepare(
          `INSERT INTO capability_acquisition_transitions (
            transition_id, acquisition_id, created_at, from_state, to_state,
            expected_version, resulting_version, actor_kind, reason,
            evidence_refs_json, idempotency_key, transition_digest,
            resulting_snapshot_json, privacy_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'transition:genesis-conflict',
          placeholder.acquisitionId,
          NOW.toISOString(),
          'observed',
          'observed',
          0,
          1,
          'system',
          'Inject a disposable unique-key conflict.',
          '[]',
          `capability-acquisition:genesis:${targetId}`,
          placeholderGenesis.transitionDigest,
          placeholderGenesis.resultingSnapshotJson,
          placeholder.privacyJson,
        );
    });

    expect(() => observe('atomic-target')).toThrow(/UNIQUE constraint failed/i);
    expect(getCapabilityAcquisition(targetId)).toBeUndefined();
    expect(listCapabilityAcquisitionTransitions(targetId)).toEqual([]);
    expect(
      withRawDatabase((database) =>
        database
          .prepare(
            'SELECT COUNT(*) AS count FROM capability_acquisitions WHERE acquisition_id = ?',
          )
          .get(targetId),
      ),
    ).toEqual({ count: 0 });
  });

  it('reconstructs every revision and the exact head from canonical history', () => {
    const initial = observe('history');
    scopeCapabilityAcquisition({
      acquisitionId: initial.acquisitionId,
      knownPrerequisites: ['fixture key'],
      missingPrerequisites: [],
      confidence: 0.88,
      now: LATER,
    });
    recordCapabilityResourceDiscovery({
      acquisitionId: initial.acquisitionId,
      candidates: [resource()],
      selected: [resource()],
      rejectedReasons: {},
      now: LATER,
    });
    const history = listCapabilityAcquisitionTransitions(initial.acquisitionId);
    let previous: CapabilityAcquisitionRecord | null = null;
    for (const transition of history) {
      const snapshot = JSON.parse(
        transition.resultingSnapshotJson,
      ) as CapabilityAcquisitionRecord;
      expect(transition.transitionDigest).toBe(digestFor(transition));
      if (previous) {
        assertCapabilityAcquisitionTransition({
          current: previous,
          next: snapshot,
          transition,
          expectedState: previous.state,
        });
      } else {
        expect(snapshot).toMatchObject({ state: 'observed', recordVersion: 1 });
      }
      previous = snapshot;
    }
    expect(previous).not.toBeNull();
    expect(capabilityAcquisitionSnapshotJson(previous!)).toBe(
      capabilityAcquisitionSnapshotJson(
        getCapabilityAcquisition(initial.acquisitionId)!,
      ),
    );
  });

  it('is idempotent for the same key and digest but conflicts on changed content', () => {
    const initial = observe('idempotency');
    scopeCapabilityAcquisition({
      acquisitionId: initial.acquisitionId,
      knownPrerequisites: ['fixture key'],
      missingPrerequisites: [],
      confidence: 0.9,
      now: LATER,
    });
    const transition = listCapabilityAcquisitionTransitions(
      initial.acquisitionId,
    )[1];
    const next = JSON.parse(
      transition.resultingSnapshotJson,
    ) as CapabilityAcquisitionRecord;

    expect(
      applyCapabilityAcquisitionTransitionCAS({
        expectedState: 'observed',
        next,
        transition,
      }),
    ).toBe('idempotent');

    const changed: CapabilityAcquisitionTransitionRecord = {
      ...transition,
      reason: 'Same key, different canonical transition content.',
      transitionDigest: '',
    };
    changed.transitionDigest = digestFor(changed);
    expect(
      applyCapabilityAcquisitionTransitionCAS({
        expectedState: 'observed',
        next,
        transition: changed,
      }),
    ).toBe('conflict');
  });

  it('rejects cross-acquisition and from/to/version mismatches', () => {
    const first = observe('mismatch-first');
    const second = observe('mismatch-second');
    const cross = buildScopedTransition({
      current: first,
      idempotencyKey: 'mismatch-cross',
      transitionOverrides: { acquisitionId: second.acquisitionId },
    });
    expect(() =>
      applyCapabilityAcquisitionTransitionCAS({
        expectedState: 'observed',
        ...cross,
      }),
    ).toThrow(/identity mismatch/i);

    const from = buildScopedTransition({
      current: first,
      idempotencyKey: 'mismatch-from',
      transitionOverrides: { fromState: 'scoped' },
    });
    expect(() =>
      applyCapabilityAcquisitionTransitionCAS({
        expectedState: 'observed',
        ...from,
      }),
    ).toThrow(/state mismatch/i);

    const to = buildScopedTransition({
      current: first,
      idempotencyKey: 'mismatch-to',
      transitionOverrides: { toState: 'resource_discovery' },
    });
    expect(() =>
      applyCapabilityAcquisitionTransitionCAS({
        expectedState: 'observed',
        ...to,
      }),
    ).toThrow(/state mismatch/i);

    const version = buildScopedTransition({
      current: first,
      idempotencyKey: 'mismatch-version',
      transitionOverrides: { expectedVersion: 9, resultingVersion: 10 },
    });
    expect(() =>
      applyCapabilityAcquisitionTransitionCAS({
        expectedState: 'observed',
        ...version,
      }),
    ).toThrow(/version mismatch/i);
    expect(getCapabilityAcquisition(first.acquisitionId)).toMatchObject({
      state: 'observed',
      recordVersion: 1,
    });
  });

  it('fails closed on malformed structured JSON and candidate contracts', () => {
    const template = observe('malformed-template');
    expect(() =>
      insertCapabilityAcquisition({
        ...template,
        acquisitionId: 'capability-acquisition:malformed-json',
        postconditionJson: '{',
      }),
    ).toThrow(/valid JSON|contain valid JSON/i);

    scopeCapabilityAcquisition({
      acquisitionId: template.acquisitionId,
      knownPrerequisites: ['fixture key'],
      missingPrerequisites: [],
      confidence: 0.8,
      now: LATER,
    });
    recordCapabilityResourceDiscovery({
      acquisitionId: template.acquisitionId,
      candidates: [resource()],
      selected: [resource()],
      rejectedReasons: {},
      now: LATER,
    });
    const discovered = getCapabilityAcquisition(template.acquisitionId)!;
    const malformedJson = buildRawTransition({
      current: discovered,
      toState: 'candidate_designed',
      idempotencyKey: 'malformed-contract-json',
      nextOverrides: { candidateContractJson: '{' },
    });
    expect(() =>
      applyCapabilityAcquisitionTransitionCAS({
        expectedState: 'resource_discovery',
        ...malformedJson,
      }),
    ).toThrow(/valid JSON/i);
    const malformedShape = buildRawTransition({
      current: discovered,
      toState: 'candidate_designed',
      idempotencyKey: 'malformed-contract-shape',
      nextOverrides: { candidateContractJson: '{"contractVersion":1}' },
    });
    expect(() =>
      applyCapabilityAcquisitionTransitionCAS({
        expectedState: 'resource_discovery',
        ...malformedShape,
      }),
    ).toThrow(/incomplete or malformed/i);
  });

  it('rejects sandbox verification without canonical durable receipts', () => {
    const running = enterSandboxRunningWithoutEvidence(
      'missing-canonical-sandbox-evidence',
      'synthetic',
    );
    const forgedVerification = buildRawTransition({
      current: running,
      toState: 'sandbox_verified',
      idempotencyKey: 'forged-sandbox-verification',
      nextOverrides: {
        sandboxEvidenceJson: capabilityMetadataJson({
          verified: true,
          postconditionVerified: true,
          cleanupVerified: true,
          networkDenied: true,
          unauthorizedEffects: 0,
          duplicateEffects: 0,
          falseSuccesses: 0,
          cleanupReceiptIds: [],
          verificationReceiptIds: ['receipt:forged'],
        }),
      },
    });
    expect(() =>
      applyCapabilityAcquisitionTransitionCAS({
        expectedState: 'sandbox_running',
        ...forgedVerification,
      }),
    ).toThrow(/canonical durable completion evidence/i);

    const liveRunning = enterSandboxRunningWithoutEvidence(
      'live-sandbox-evidence-denied',
      'live',
    );
    const liveAttempt = buildRawTransition({
      current: liveRunning,
      toState: 'sandbox_verified',
      idempotencyKey: 'live-sandbox-verification-denied',
      nextOverrides: {
        sandboxEvidenceJson: capabilityMetadataJson({
          verified: true,
          postconditionVerified: true,
          cleanupVerified: true,
          networkDenied: true,
          unauthorizedEffects: 0,
          duplicateEffects: 0,
          falseSuccesses: 0,
          cleanupReceiptIds: [],
          verificationReceiptIds: ['receipt:forged-live'],
        }),
      },
    });
    expect(() =>
      applyCapabilityAcquisitionTransitionCAS({
        expectedState: 'sandbox_running',
        ...liveAttempt,
      }),
    ).toThrow(/restricted to synthetic certification evidence/i);
  });

  it('rejects changes to every immutable acquisition identity field', () => {
    const current = observe('immutable');
    const cases: Array<{
      field: string;
      overrides: Partial<CapabilityAcquisitionRecord>;
    }> = [
      {
        field: 'createdAt',
        overrides: { createdAt: LATER.toISOString() },
      },
      { field: 'groupFolder', overrides: { groupFolder: 'other' } },
      {
        field: 'targetOutcome',
        overrides: { targetOutcome: 'A different target' },
      },
      {
        field: 'postconditionJson',
        overrides: { postconditionJson: '{"required":["different"]}' },
      },
      { field: 'taskFamily', overrides: { taskFamily: 'different_family' } },
    ];
    for (const testCase of cases) {
      const attempt = buildScopedTransition({
        current,
        idempotencyKey: `immutable-${testCase.field}`,
        nextOverrides: testCase.overrides,
      });
      expect(() =>
        applyCapabilityAcquisitionTransitionCAS({
          expectedState: 'observed',
          ...attempt,
        }),
      ).toThrow(new RegExp(`${testCase.field} is immutable`, 'i'));
    }
  });

  it('rejects a direct canary-ready transition without the canonical authority join', async () => {
    const reviewed = await createSyntheticHeldOutCandidate(
      'direct-canary-denial',
    );
    const version = reviewed.recordVersion;
    expect(reviewed).toMatchObject({
      state: 'owner_review_required',
      evidenceOrigin: 'synthetic',
    });
    const canaryAttempt = buildRawTransition({
      current: reviewed,
      toState: 'canary_ready',
      actorKind: 'owner',
      idempotencyKey: 'direct-canary-ready-denied',
      nextOverrides: {
        ownerReviewJson: capabilityMetadataJson({
          approved: true,
          ownerVerified: true,
          reviewId: 'forged:owner-review',
        }),
      },
    });
    expect(() =>
      applyCapabilityAcquisitionTransitionCAS({
        expectedState: 'owner_review_required',
        ...canaryAttempt,
      }),
    ).toThrow(/canonical held-out evidence and owner-review authority join/i);
    expect(getCapabilityAcquisition(reviewed.acquisitionId)).toMatchObject({
      state: 'owner_review_required',
      evidenceOrigin: 'synthetic',
      recordVersion: version,
    });
  });

  it('detects projection tampering against canonical history', () => {
    const initial = observe('projection-tamper');
    withRawDatabase((database) => {
      database
        .prepare(
          `UPDATE capability_acquisitions
           SET next_safe_action = 'tampered projection'
           WHERE acquisition_id = ?`,
        )
        .run(initial.acquisitionId);
    });
    expect(() => getCapabilityAcquisition(initial.acquisitionId)).toThrow(
      /head projection does not match canonical history/i,
    );
  });

  it('detects a tampered canonical transition digest', () => {
    const initial = observe('digest-tamper');
    withRawDatabase((database) => {
      database
        .prepare(
          `UPDATE capability_acquisition_transitions
           SET transition_digest = ?
           WHERE acquisition_id = ? AND resulting_version = 1`,
        )
        .run('0'.repeat(64), initial.acquisitionId);
    });
    expect(() => getCapabilityAcquisition(initial.acquisitionId)).toThrow(
      /canonical revision digest mismatch/i,
    );
  });

  it('stores no secret values in the head or canonical snapshots', () => {
    const braveSecret = 'BSA-TEST-SENTINEL-NOT-A-REAL-KEY';
    const bearerSecret = 'bearer-secret-value-1234567890';
    const querySecret = 'query-secret-value-1234567890';
    const passwordSecret = 'url-password-value';
    const initial = observeCapabilityGap({
      metadataClassification: 'derived_metadata',
      groupFolder: 'main',
      targetOutcome: `Use ${braveSecret} only as a redaction sentinel`,
      postconditions: [`Never retain Authorization: Bearer ${bearerSecret}`],
      taskFamily: 'privacy_ledger_fixture',
      gapKind: 'credential_or_access_gap',
      authorityRequirements: [`api_key=${querySecret}`],
      provenanceRefs: [
        `https://owner:${passwordSecret}@example.com/doc?api_key=${querySecret}#private`,
      ],
      evidenceOrigin: 'synthetic',
      environmentFingerprint: `token=${bearerSecret}`,
      now: NOW,
    });
    const stored = withRawDatabase((database) => ({
      head: database
        .prepare(
          'SELECT * FROM capability_acquisitions WHERE acquisition_id = ?',
        )
        .get(initial.acquisitionId),
      history: database
        .prepare(
          'SELECT * FROM capability_acquisition_transitions WHERE acquisition_id = ?',
        )
        .all(initial.acquisitionId),
    }));
    const serialized = JSON.stringify(stored);
    for (const secret of [
      braveSecret,
      bearerSecret,
      querySecret,
      passwordSecret,
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain('owner:');
    expect(serialized).not.toContain('?api_key=');
  });
});
