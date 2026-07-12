import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ProviderHealthSnapshot } from './provider-health.js';
import {
  PROVIDER_LIVE_HEALTH_MAX_AGE_MS,
  applyRecentProviderLiveHealth,
  readProviderLiveHealthState,
  writeProviderLiveHealthState,
} from './provider-live-health-state.js';

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'provider-live-health-'));
  tempRoots.push(root);
  return root;
}

function snapshot(
  overrides: Partial<ProviderHealthSnapshot> = {},
): ProviderHealthSnapshot {
  return {
    providerId: 'openai_cloud',
    kind: 'llm',
    state: 'healthy',
    lastHealthyAt: '2026-07-12T08:00:00.000Z',
    lastCheckedAt: '2026-07-12T08:00:00.000Z',
    failureClass: 'none',
    quotaState: 'unknown',
    credentialState: 'configured',
    knownExpiresAt: null,
    rotationDueAt: null,
    blocker: '',
    nextAction: '',
    metadata: {
      healthEvidence: 'live_probe',
      liveProbe: 'ok',
      liveModel: 'gpt-test',
      liveRequestId: 'request-private-1',
    },
    ...overrides,
  };
}

describe('provider live health state', () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('persists only bounded probe metadata in an owner-only atomic file', () => {
    const root = tempRoot();
    const state = writeProviderLiveHealthState(
      [
        snapshot({
          blocker: 'provider said token=secret-value',
          nextAction: 'Replace api_key=secret-value and retry.',
        }),
      ],
      '2026-07-12T08:00:00.000Z',
      root,
    );

    expect(state?.providers).toHaveLength(1);
    const file = join(
      root,
      'data',
      'runtime',
      'provider-live-health-state.json',
    );
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain('secret-value');
    expect(raw).not.toContain('request-private-1');
    expect(raw).toContain('api_key=***');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readProviderLiveHealthState(root)?.providers[0]).toMatchObject({
      providerId: 'openai_cloud',
      liveProbe: 'ok',
      liveModel: 'gpt-test',
    });
  });

  it('uses only fresh cached observations and preserves current config blockers', () => {
    const root = tempRoot();
    writeProviderLiveHealthState(
      [snapshot()],
      '2026-07-12T08:00:00.000Z',
      root,
    );
    const configuredOnly = snapshot({
      state: 'unknown',
      lastHealthyAt: null,
      lastCheckedAt: '2026-07-12T08:05:00.000Z',
      metadata: {
        healthEvidence: 'configuration_only',
        liveProbe: 'not_run',
      },
    });

    expect(
      applyRecentProviderLiveHealth(
        [configuredOnly],
        '2026-07-12T08:05:00.000Z',
        { projectRoot: root },
      )[0],
    ).toMatchObject({
      state: 'healthy',
      lastCheckedAt: '2026-07-12T08:00:00.000Z',
      metadata: {
        healthEvidence: 'cached_live_probe',
        liveProbe: 'ok',
        liveCheckedAt: '2026-07-12T08:00:00.000Z',
      },
    });

    expect(
      applyRecentProviderLiveHealth(
        [configuredOnly],
        new Date(
          Date.parse('2026-07-12T08:00:00.000Z') +
            PROVIDER_LIVE_HEALTH_MAX_AGE_MS +
            1,
        ).toISOString(),
        { projectRoot: root },
      )[0]?.state,
    ).toBe('unknown');

    const quotaBlocked = snapshot({
      state: 'externally_blocked',
      failureClass: 'quota_or_rate_limit',
      quotaState: 'blocked',
      blocker: 'Current operator quota state is blocked.',
      metadata: {
        healthEvidence: 'configuration_only',
        liveProbe: 'not_run',
      },
    });
    expect(
      applyRecentProviderLiveHealth(
        [quotaBlocked],
        '2026-07-12T08:05:00.000Z',
        { projectRoot: root },
      )[0],
    ).toMatchObject({
      state: 'externally_blocked',
      failureClass: 'quota_or_rate_limit',
      quotaState: 'blocked',
    });
  });

  it('reuses a recent failed observation without persisting the raw provider error', () => {
    const root = tempRoot();
    writeProviderLiveHealthState(
      [
        snapshot({
          state: 'degraded',
          lastHealthyAt: null,
          failureClass: 'transport_error',
          blocker: 'timeout token=private-provider-error',
          nextAction: 'Check network access and retry.',
          metadata: {
            healthEvidence: 'live_probe',
            liveProbe: 'failed',
            liveModel: 'gpt-test',
          },
        }),
      ],
      '2026-07-12T08:00:00.000Z',
      root,
    );
    const configuredOnly = snapshot({
      state: 'unknown',
      lastHealthyAt: null,
      metadata: {
        healthEvidence: 'configuration_only',
        liveProbe: 'not_run',
      },
    });

    const applied = applyRecentProviderLiveHealth(
      [configuredOnly],
      '2026-07-12T08:05:00.000Z',
      { projectRoot: root },
    )[0];

    expect(applied).toMatchObject({
      state: 'degraded',
      failureClass: 'transport_error',
      blocker: 'Recent live probe failed with transport_error.',
      metadata: {
        healthEvidence: 'cached_live_probe',
        liveProbe: 'failed',
      },
    });
    expect(
      readFileSync(
        join(root, 'data', 'runtime', 'provider-live-health-state.json'),
        'utf8',
      ),
    ).not.toContain('private-provider-error');
  });
});
