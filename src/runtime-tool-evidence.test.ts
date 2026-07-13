import { describe, expect, it } from 'vitest';

import {
  collapseRuntimeToolEvidenceV1,
  mergeRuntimeToolEvidenceV1,
  normalizeRuntimeToolEvidenceV1,
  type RuntimeToolActionClass,
  type RuntimeToolEvidenceV1,
} from './runtime-tool-evidence.js';

function evidence(
  overrides: Partial<RuntimeToolEvidenceV1> = {},
): RuntimeToolEvidenceV1 {
  return {
    version: 1,
    evidenceId: 'query-1',
    cumulative: true,
    attempts: 1,
    collectorStatus: 'complete',
    calls: { observed: 1, succeeded: 1, failed: 0, unresolved: 0 },
    actions: [
      {
        class: 'repository_read',
        observed: 1,
        succeeded: 1,
        failed: 0,
        unresolved: 0,
        succeededAfterLastRepositoryWrite: 0,
        lastOutcome: 'succeeded',
        recovered: false,
      },
    ],
    state: {
      preStateFingerprint: null,
      postStateFingerprint: null,
      repositoryHeadFingerprint: null,
    },
    privacy: {
      metadataOnly: true,
      rawInputsStored: false,
      resultBodiesStored: false,
      toolUseIdsStored: false,
    },
    ...overrides,
  };
}

function actionFailure(actionClass: RuntimeToolActionClass) {
  return {
    class: actionClass,
    observed: 1,
    succeeded: 0,
    failed: 1,
    unresolved: 0,
    succeededAfterLastRepositoryWrite: 0,
    lastOutcome: 'failed' as const,
    recovered: false,
  };
}

function stateActions(): RuntimeToolEvidenceV1['actions'] {
  return [
    {
      class: 'repository_state',
      observed: 2,
      succeeded: 2,
      failed: 0,
      unresolved: 0,
      succeededAfterLastRepositoryWrite: 0,
      lastOutcome: 'succeeded',
      recovered: false,
    },
    {
      class: 'repository_write',
      observed: 1,
      succeeded: 1,
      failed: 0,
      unresolved: 0,
      succeededAfterLastRepositoryWrite: 0,
      lastOutcome: 'succeeded',
      recovered: false,
    },
  ];
}

describe('runtime tool evidence V1', () => {
  it('strictly validates and canonically orders metadata-only evidence', () => {
    const value = evidence({
      calls: { observed: 2, succeeded: 2, failed: 0, unresolved: 0 },
      actions: [
        {
          class: 'verification_test',
          observed: 1,
          succeeded: 1,
          failed: 0,
          unresolved: 0,
          succeededAfterLastRepositoryWrite: 0,
          lastOutcome: 'succeeded',
          recovered: false,
        },
        evidence().actions[0],
      ],
    });

    expect(
      normalizeRuntimeToolEvidenceV1(value)?.actions.map((item) => item.class),
    ).toEqual(['repository_read', 'verification_test']);
  });

  it.each([
    ['future version', { ...evidence(), version: 2 }],
    ['unknown field', { ...evidence(), secretResult: 'not allowed' }],
    [
      'inconsistent counts',
      evidence({
        calls: { observed: 2, succeeded: 1, failed: 0, unresolved: 0 },
      }),
    ],
    [
      'complete unresolved collector',
      evidence({
        calls: { observed: 1, succeeded: 0, failed: 0, unresolved: 1 },
      }),
    ],
    [
      'duplicate action class',
      evidence({
        calls: { observed: 2, succeeded: 2, failed: 0, unresolved: 0 },
        actions: [evidence().actions[0], evidence().actions[0]],
      }),
    ],
    [
      'missing state',
      (() => {
        const { state: _state, ...withoutState } = evidence();
        return withoutState;
      })(),
    ],
    [
      'raw state field',
      {
        ...evidence(),
        state: { ...evidence().state, repositoryPath: '/private/repo' },
      },
    ],
    [
      'invalid state fingerprint',
      {
        ...evidence(),
        state: {
          ...evidence().state,
          repositoryHeadFingerprint: 'SHA256:not-normalized',
        },
      },
    ],
    [
      'state without an observed call',
      evidence({
        attempts: 0,
        collectorStatus: 'partial',
        calls: { observed: 0, succeeded: 0, failed: 0, unresolved: 0 },
        actions: [],
        state: {
          ...evidence().state,
          repositoryHeadFingerprint: `sha256:${'a'.repeat(64)}`,
        },
      }),
    ],
    [
      'privacy violation',
      {
        ...evidence(),
        privacy: { ...evidence().privacy, resultBodiesStored: true },
      },
    ],
    [
      'invalid recovery claim',
      evidence({
        actions: [{ ...evidence().actions[0], recovered: true }],
      }),
    ],
    [
      'post-write success exceeds successes',
      evidence({
        actions: [
          {
            ...evidence().actions[0],
            succeededAfterLastRepositoryWrite: 2,
          },
        ],
      }),
    ],
    [
      'post-write success without a repository write',
      evidence({
        actions: [
          {
            ...evidence().actions[0],
            succeededAfterLastRepositoryWrite: 1,
          },
        ],
      }),
    ],
    [
      'action count exceeds total calls',
      evidence({
        actions: [{ ...evidence().actions[0], observed: 2, succeeded: 2 }],
      }),
    ],
    ['observed calls without a classified action', evidence({ actions: [] })],
    [
      'state fingerprint without a successful state action',
      evidence({
        state: {
          ...evidence().state,
          repositoryHeadFingerprint: `sha256:${'a'.repeat(64)}`,
        },
      }),
    ],
    [
      'pre-state fingerprint without a write action',
      evidence({
        actions: [
          {
            ...evidence().actions[0],
            class: 'repository_state',
          },
        ],
        state: {
          ...evidence().state,
          preStateFingerprint: `sha256:${'a'.repeat(64)}`,
        },
      }),
    ],
  ])('fails closed for %s', (_label, value) => {
    expect(normalizeRuntimeToolEvidenceV1(value)).toBeNull();
  });

  it('replaces a same-ID cumulative snapshot without double-counting', () => {
    const partial = evidence({
      collectorStatus: 'partial',
      calls: { observed: 1, succeeded: 0, failed: 0, unresolved: 1 },
      actions: [
        {
          class: 'repository_read',
          observed: 1,
          succeeded: 0,
          failed: 0,
          unresolved: 1,
          succeededAfterLastRepositoryWrite: 0,
          lastOutcome: 'unresolved',
          recovered: false,
        },
      ],
    });
    const complete = evidence({
      calls: { observed: 1, succeeded: 1, failed: 0, unresolved: 0 },
    });

    expect(mergeRuntimeToolEvidenceV1(partial, complete)).toEqual(complete);
    expect(mergeRuntimeToolEvidenceV1(complete, complete)).toEqual(complete);
  });

  it('poisons a complete receipt after a later valid partial downgrade', () => {
    const complete = evidence();
    const partial = evidence({ collectorStatus: 'partial' });

    const downgraded = mergeRuntimeToolEvidenceV1(complete, partial);
    expect(downgraded).toEqual(partial);
    expect(mergeRuntimeToolEvidenceV1(downgraded, complete)).toEqual(partial);
    expect(
      collapseRuntimeToolEvidenceV1([complete, partial, complete]),
    ).toEqual(partial);
  });

  it('retains trusted evidence when an update is malformed, future, or stale', () => {
    const current = evidence({ attempts: 2 });
    expect(
      mergeRuntimeToolEvidenceV1(current, { ...current, version: 2 }),
    ).toEqual(current);
    expect(
      mergeRuntimeToolEvidenceV1(current, evidence({ attempts: 1 })),
    ).toEqual(current);
  });

  it('fills same-ID state nulls but degrades conflicting replacements', () => {
    const fingerprintA = `sha256:${'a'.repeat(64)}`;
    const fingerprintB = `sha256:${'b'.repeat(64)}`;
    const current = evidence({
      collectorStatus: 'partial',
      calls: { observed: 3, succeeded: 3, failed: 0, unresolved: 0 },
      actions: stateActions(),
      state: {
        preStateFingerprint: fingerprintA,
        postStateFingerprint: null,
        repositoryHeadFingerprint: fingerprintA,
      },
    });
    const filled = evidence({
      calls: { observed: 3, succeeded: 3, failed: 0, unresolved: 0 },
      actions: stateActions(),
      state: {
        preStateFingerprint: null,
        postStateFingerprint: fingerprintB,
        repositoryHeadFingerprint: fingerprintA,
      },
    });

    expect(mergeRuntimeToolEvidenceV1(current, filled)?.state).toEqual({
      preStateFingerprint: fingerprintA,
      postStateFingerprint: fingerprintB,
      repositoryHeadFingerprint: fingerprintA,
    });
    expect(
      mergeRuntimeToolEvidenceV1(current, {
        ...filled,
        state: { ...filled.state, preStateFingerprint: fingerprintB },
      }),
    ).toMatchObject({
      collectorStatus: 'partial',
      state: {
        preStateFingerprint: null,
        postStateFingerprint: fingerprintB,
        repositoryHeadFingerprint: fingerprintA,
      },
    });
  });

  it('collapses distinct retries once and preserves ordered failures and recovery', () => {
    const first = evidence({
      evidenceId: 'attempt-a',
      calls: { observed: 1, succeeded: 0, failed: 1, unresolved: 0 },
      actions: [actionFailure('repository_read')],
    });
    const second = evidence({ evidenceId: 'attempt-b' });

    const combined = collapseRuntimeToolEvidenceV1([first, second, second]);
    expect(combined).toMatchObject({
      evidenceId: expect.stringMatching(/^composite:[a-f0-9]{32}$/),
      attempts: 2,
      calls: { observed: 2, succeeded: 1, failed: 1, unresolved: 0 },
    });
    expect(combined?.actions).toContainEqual(
      expect.objectContaining({
        class: 'repository_read',
        observed: 2,
        succeeded: 1,
        failed: 1,
        lastOutcome: 'succeeded',
        recovered: true,
      }),
    );
  });

  it('does not infer cross-class recovery', () => {
    const first = evidence({
      evidenceId: 'attempt-a',
      calls: { observed: 1, succeeded: 0, failed: 1, unresolved: 0 },
      actions: [actionFailure('repository_state')],
    });
    const second = evidence({ evidenceId: 'attempt-b' });

    const combined = collapseRuntimeToolEvidenceV1([first, second]);
    expect(
      combined?.actions.find((item) => item.class === 'repository_state'),
    ).toMatchObject({ lastOutcome: 'failed', recovered: false });
    expect(
      combined?.actions.find((item) => item.class === 'repository_read'),
    ).toMatchObject({ lastOutcome: 'succeeded', recovered: false });
  });

  it('invalidates earlier post-write verification when a later ID writes again', () => {
    const first = evidence({
      evidenceId: 'attempt-a',
      calls: { observed: 2, succeeded: 2, failed: 0, unresolved: 0 },
      actions: [
        {
          class: 'repository_write',
          observed: 1,
          succeeded: 1,
          failed: 0,
          unresolved: 0,
          succeededAfterLastRepositoryWrite: 0,
          lastOutcome: 'succeeded',
          recovered: false,
        },
        {
          class: 'verification_test',
          observed: 1,
          succeeded: 1,
          failed: 0,
          unresolved: 0,
          succeededAfterLastRepositoryWrite: 1,
          lastOutcome: 'succeeded',
          recovered: false,
        },
      ],
    });
    const second = evidence({
      evidenceId: 'attempt-b',
      actions: [
        {
          class: 'repository_write',
          observed: 1,
          succeeded: 1,
          failed: 0,
          unresolved: 0,
          succeededAfterLastRepositoryWrite: 0,
          lastOutcome: 'succeeded',
          recovered: false,
        },
      ],
    });

    expect(
      collapseRuntimeToolEvidenceV1([first, second])?.actions.find(
        (item) => item.class === 'verification_test',
      ),
    ).toMatchObject({ succeededAfterLastRepositoryWrite: 0 });
  });

  it('keeps the latest coherent retry transition without cross-ID splicing', () => {
    const fingerprintA = `sha256:${'a'.repeat(64)}`;
    const fingerprintB = `sha256:${'b'.repeat(64)}`;
    const fingerprintC = `sha256:${'c'.repeat(64)}`;
    const first = evidence({
      evidenceId: 'attempt-a',
      calls: { observed: 3, succeeded: 3, failed: 0, unresolved: 0 },
      actions: stateActions(),
      state: {
        preStateFingerprint: fingerprintA,
        postStateFingerprint: fingerprintA,
        repositoryHeadFingerprint: fingerprintA,
      },
    });
    const second = evidence({
      evidenceId: 'attempt-b',
      calls: { observed: 3, succeeded: 3, failed: 0, unresolved: 0 },
      actions: stateActions(),
      state: {
        preStateFingerprint: fingerprintB,
        postStateFingerprint: fingerprintC,
        repositoryHeadFingerprint: fingerprintB,
      },
    });

    expect(collapseRuntimeToolEvidenceV1([first, second])).toMatchObject({
      collectorStatus: 'partial',
      state: {
        preStateFingerprint: fingerprintB,
        postStateFingerprint: fingerprintC,
        repositoryHeadFingerprint: null,
      },
    });
  });

  it('drops transition fragments that only form a pair across evidence IDs', () => {
    const fingerprintA = `sha256:${'a'.repeat(64)}`;
    const fingerprintB = `sha256:${'b'.repeat(64)}`;
    const first = evidence({
      evidenceId: 'attempt-a',
      calls: { observed: 3, succeeded: 3, failed: 0, unresolved: 0 },
      actions: stateActions(),
      state: {
        preStateFingerprint: fingerprintA,
        postStateFingerprint: null,
        repositoryHeadFingerprint: fingerprintA,
      },
    });
    const second = evidence({
      evidenceId: 'attempt-b',
      calls: { observed: 3, succeeded: 3, failed: 0, unresolved: 0 },
      actions: stateActions(),
      state: {
        preStateFingerprint: null,
        postStateFingerprint: fingerprintB,
        repositoryHeadFingerprint: fingerprintA,
      },
    });

    expect(collapseRuntimeToolEvidenceV1([first, second])).toMatchObject({
      collectorStatus: 'partial',
      state: {
        preStateFingerprint: null,
        postStateFingerprint: null,
        repositoryHeadFingerprint: null,
      },
    });
  });

  it('does not reuse an earlier coherent transition after a later write', () => {
    const fingerprintA = `sha256:${'a'.repeat(64)}`;
    const fingerprintB = `sha256:${'b'.repeat(64)}`;
    const first = evidence({
      evidenceId: 'attempt-a',
      calls: { observed: 3, succeeded: 3, failed: 0, unresolved: 0 },
      actions: stateActions(),
      state: {
        preStateFingerprint: fingerprintA,
        postStateFingerprint: fingerprintB,
        repositoryHeadFingerprint: fingerprintA,
      },
    });
    const second = evidence({
      evidenceId: 'attempt-b',
      actions: [
        {
          class: 'repository_write',
          observed: 1,
          succeeded: 1,
          failed: 0,
          unresolved: 0,
          succeededAfterLastRepositoryWrite: 0,
          lastOutcome: 'succeeded',
          recovered: false,
        },
      ],
    });

    expect(collapseRuntimeToolEvidenceV1([first, second])).toMatchObject({
      collectorStatus: 'partial',
      state: {
        preStateFingerprint: null,
        postStateFingerprint: null,
        repositoryHeadFingerprint: null,
      },
    });
  });
});
