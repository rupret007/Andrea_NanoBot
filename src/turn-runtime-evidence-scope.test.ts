import { describe, expect, it } from 'vitest';

import { TurnRuntimeEvidenceScope } from './turn-runtime-evidence-scope.js';
import type { RuntimeToolEvidenceV1 } from './types.js';

function receipt(
  evidenceId: string,
  actionClass: RuntimeToolEvidenceV1['actions'][number]['class'],
  options: {
    attempts?: number;
    count?: number;
    collectorStatus?: RuntimeToolEvidenceV1['collectorStatus'];
  } = {},
): RuntimeToolEvidenceV1 {
  const count = options.count ?? 1;
  return {
    version: 1,
    evidenceId,
    cumulative: true,
    attempts: options.attempts ?? count,
    collectorStatus: options.collectorStatus ?? 'complete',
    calls: {
      observed: count,
      succeeded: count,
      failed: 0,
      unresolved: 0,
    },
    actions: [
      {
        class: actionClass,
        observed: count,
        succeeded: count,
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
  };
}

describe('TurnRuntimeEvidenceScope', () => {
  it('freezes the first delivered turn against later same-id IPC evidence', () => {
    const scope = new TurnRuntimeEvidenceScope();
    scope.beginAttempt();
    scope.observe(receipt('persistent-query', 'repository_read'));
    scope.freezeDelivered();

    scope.observe(receipt('persistent-query', 'external_side_effect'));

    expect(scope.snapshot()).toMatchObject({
      evidenceId: 'persistent-query',
      actions: [{ class: 'repository_read' }],
    });
  });

  it('retains detached failed-attempt evidence in a later delivered scope', () => {
    const scope = new TurnRuntimeEvidenceScope();
    scope.beginAttempt();
    scope.observe(receipt('failed-attempt', 'repository_read'));
    scope.markCurrentAttemptFailed();
    scope.beginAttempt();
    scope.observe(receipt('delivered-attempt', 'verification_test'));
    scope.freezeDelivered();

    expect(scope.snapshot()).toMatchObject({
      evidenceId: expect.stringMatching(/^composite:/),
      calls: { observed: 2, succeeded: 2, failed: 0, unresolved: 0 },
      actions: [
        expect.objectContaining({ class: 'repository_read' }),
        expect.objectContaining({ class: 'verification_test' }),
      ],
    });
  });

  it('preserves same-id partial poison until genuine receipt progress occurs', () => {
    const scope = new TurnRuntimeEvidenceScope();
    scope.beginAttempt();
    scope.observe(receipt('same-query', 'repository_read'));
    scope.observe(
      receipt('same-query', 'repository_read', { collectorStatus: 'partial' }),
    );
    scope.observe(receipt('same-query', 'repository_read'));

    expect(scope.snapshot()?.collectorStatus).toBe('partial');

    scope.observe(
      receipt('same-query', 'repository_read', {
        attempts: 2,
        count: 2,
        collectorStatus: 'complete',
      }),
    );
    expect(scope.snapshot()).toMatchObject({
      collectorStatus: 'complete',
      calls: { observed: 2, succeeded: 2, failed: 0, unresolved: 0 },
    });
  });

  it('retains same-id poison across multiple failed outer attempts', () => {
    const scope = new TurnRuntimeEvidenceScope();
    scope.beginAttempt();
    scope.observe(
      receipt('reused-failed-query', 'repository_read', {
        collectorStatus: 'partial',
      }),
    );
    scope.markCurrentAttemptFailed();

    scope.beginAttempt();
    scope.observe(receipt('reused-failed-query', 'repository_read'));
    scope.markCurrentAttemptFailed();

    scope.beginAttempt();
    scope.observe(receipt('delivered-query', 'verification_test'));
    scope.freezeDelivered();

    expect(scope.snapshot()).toMatchObject({
      collectorStatus: 'partial',
      calls: { observed: 2, succeeded: 2, failed: 0, unresolved: 0 },
    });
  });
});
