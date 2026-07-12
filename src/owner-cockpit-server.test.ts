import type { AddressInfo } from 'net';
import { Script } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildOwnerCockpitMissionView,
  createOwnerCockpitHttpServer,
  resolveOwnerCockpitConfig,
  selectOwnerCockpitMission,
  type OwnerCockpitConfig,
} from './owner-cockpit-server.js';
import { OWNER_COCKPIT_JS } from './owner-cockpit-ui.js';
import type { VerifiedDeepWorkPacket } from './types.js';

const config: OwnerCockpitConfig = {
  enabled: true,
  host: '127.0.0.1',
  port: 4320,
  secret: 'a-test-secret-that-is-long-enough',
  sessionMinutes: 30,
  groupFolder: 'main',
};

const servers: ReturnType<typeof createOwnerCockpitHttpServer>[] = [];

function missionPacket(
  id: string,
  overrides: Partial<VerifiedDeepWorkPacket> = {},
): VerifiedDeepWorkPacket {
  return {
    packetId: id,
    groupFolder: 'main',
    taskFamily: 'planning',
    objective: `Mission ${id}`,
    status: 'active',
    currentStage: 'plan',
    stagesCompleted: [],
    checkpointVersion: 1,
    approvalRequired: false,
    approvalRef: null,
    sources: [],
    artifacts: [],
    checks: [],
    toolSnapshots: [],
    unresolvedRisks: [],
    outcomeSummary: null,
    nextDecision: 'Review the evidence.',
    createdAt: '2026-07-12T10:00:00.000Z',
    updatedAt: '2026-07-12T10:00:00.000Z',
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

async function start() {
  const server = createOwnerCockpitHttpServer(config);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return `http://127.0.0.1:${port}`;
}

describe('owner cockpit security', () => {
  it('rejects non-loopback configuration', () => {
    expect(() =>
      resolveOwnerCockpitConfig({
        ANDREA_OWNER_COCKPIT_ENABLED: 'true',
        ANDREA_OWNER_COCKPIT_HOST: '0.0.0.0',
      }),
    ).toThrow('loopback');
  });

  it('keeps snapshots private and sets defensive headers', async () => {
    const base = await start();
    const response = await fetch(`${base}/api/v1/snapshot`, {
      redirect: 'manual',
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('uses a POST login and HttpOnly strict session cookie', async () => {
    const base = await start();
    const response = await fetch(`${base}/auth/login`, {
      method: 'POST',
      body: new URLSearchParams({ secret: config.secret }),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
    });
    expect(response.status).toBe(303);
    const cookie = response.headers.get('set-cookie') || '';
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).not.toContain(config.secret);
  });

  it('rejects authenticated mutations without same-origin CSRF proof', async () => {
    const base = await start();
    const login = await fetch(`${base}/auth/login`, {
      method: 'POST',
      body: new URLSearchParams({ secret: config.secret }),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
    });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    const response = await fetch(`${base}/api/v1/reversible-state`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'thread', id: 'thread-1', state: 'paused' }),
    });
    expect(response.status).toBe(403);
  });

  it('does not accept a cockpit secret in a URL', async () => {
    const base = await start();
    const response = await fetch(
      `${base}/?token=${encodeURIComponent(config.secret)}`,
      { redirect: 'manual' },
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/login');
  });
});

describe('owner cockpit deep-work review', () => {
  it('prioritizes an unreviewed completed coding mission over newer activity', () => {
    const reviewed = missionPacket('reviewed', {
      taskFamily: 'coding',
      status: 'completed',
      updatedAt: '2026-07-12T13:00:00.000Z',
      review: {
        verdict: 'verified',
        ownerAccepted: true,
        summary: 'Already reviewed.',
        reviewedAt: '2026-07-12T13:00:00.000Z',
      },
    });
    const activeOperator = missionPacket('operator', {
      taskFamily: 'operator',
      updatedAt: '2026-07-12T12:00:00.000Z',
    });
    const codingAwaitingReview = missionPacket('coding', {
      taskFamily: 'coding',
      status: 'completed',
      updatedAt: '2026-07-12T11:00:00.000Z',
    });

    expect(
      selectOwnerCockpitMission([
        reviewed,
        activeOperator,
        codingAwaitingReview,
      ])?.packetId,
    ).toBe('coding');
  });

  it('provides bounded, actionable verification and replay evidence', () => {
    const incomplete = buildOwnerCockpitMissionView(
      missionPacket('incomplete', {
        approvalRequired: true,
        checks: [{ name: 'build', passed: false, evidenceRef: 'build:1' }],
        unresolvedRisks: ['postcondition_failed'],
      }),
    );
    expect(incomplete).toMatchObject({
      evidenceComplete: false,
      deterministicReplayPassed: false,
      reviewPending: true,
      evidenceGaps: [
        'artifact_missing',
        'check_failed',
        'risk_unresolved',
        'approval_evidence_missing',
      ],
      checks: [{ name: 'build', passed: false }],
    });
    expect(incomplete.evidenceGaps).toEqual([
      'artifact_missing',
      'check_failed',
      'risk_unresolved',
      'approval_evidence_missing',
    ]);

    const complete = buildOwnerCockpitMissionView(
      missionPacket('complete', {
        taskFamily: 'coding',
        artifacts: ['patch:bounded'],
        checks: [
          {
            name: 'deterministic test suite',
            passed: true,
            evidenceRef: 'test:1',
          },
        ],
      }),
    );
    expect(complete).toMatchObject({
      evidenceComplete: true,
      deterministicReplayPassed: true,
      evidenceGaps: [],
      artifactCount: 1,
      checksPassed: 1,
    });
  });

  it('exposes the full accessible owner verdict set with verification context', () => {
    expect(() => new Script(OWNER_COCKPIT_JS)).not.toThrow();
    expect(OWNER_COCKPIT_JS).toContain('aria-label="Review this mission"');
    expect(OWNER_COCKPIT_JS).toContain('aria-describedby="mission-evidence"');
    expect(OWNER_COCKPIT_JS).toContain('data-verdict="blocked"');
    expect(OWNER_COCKPIT_JS).toContain('data-verdict="rejected"');
    expect(OWNER_COCKPIT_JS).toContain('Verification still needs:');
    expect(OWNER_COCKPIT_JS).toContain('Deterministic replay:');
  });
});
