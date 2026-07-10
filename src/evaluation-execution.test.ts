import { describe, expect, it, vi } from 'vitest';

import {
  assertEvaluationCostWithinBudget,
  loopbackOnlyFetch,
  resolveEvaluationExecutionPolicy,
} from './evaluation-execution.js';

describe('evaluation execution policy', () => {
  it('keeps deterministic evaluation offline and cost-free', async () => {
    const underlying = vi.fn(async () => new Response('ok')) as typeof fetch;
    const guarded = loopbackOnlyFetch(underlying);

    await expect(guarded('https://api.example.com/eval')).rejects.toThrow(
      'blocked non-loopback request',
    );
    expect(underlying).not.toHaveBeenCalled();
    expect(resolveEvaluationExecutionPolicy()).toEqual({
      mode: 'deterministic',
      maxCostUsd: 0,
      network: 'loopback_only',
    });
  });

  it('allows loopback fixtures in deterministic mode', async () => {
    const underlying = vi.fn(async () => new Response('ok')) as typeof fetch;
    const response = await loopbackOnlyFetch(underlying)(
      'http://127.0.0.1:4400/fixture',
    );
    expect(await response.text()).toBe('ok');
  });

  it('requires an explicit positive budget for live evaluation', () => {
    expect(() => resolveEvaluationExecutionPolicy({ mode: 'live' })).toThrow(
      'explicit nonzero',
    );
    expect(
      resolveEvaluationExecutionPolicy({ mode: 'live', maxCostUsd: 0.5 }),
    ).toEqual({ mode: 'live', maxCostUsd: 0.5, network: 'enabled' });
    expect(() =>
      assertEvaluationCostWithinBudget(
        { mode: 'live', maxCostUsd: 0.5, network: 'enabled' },
        0.51,
      ),
    ).toThrow('exceeded');
  });
});
