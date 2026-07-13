import type { AddressInfo } from 'net';
import { Script } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  approveCognitiveApprovalPacketCAS,
  getDurableWorkUnit,
  listCognitiveApprovalPackets,
  listDurableWorkLinks,
  upsertCognitiveApprovalPacket,
  upsertCognitiveRun,
} from './db.js';
import { beginAgentRuntimeSpineRun } from './agent-runtime-spine.js';
import { beginCognitiveKernelRun } from './cognitive-kernel.js';
import { issueDurableResumeGrant } from './durable-work-continuity.js';
import {
  buildOwnerCockpitMissionView,
  createOwnerCockpitHttpServer,
  resolveOwnerCockpitConfig,
  selectOwnerCockpitMission,
  type OwnerCockpitConfig,
} from './owner-cockpit-server.js';
import { OWNER_COCKPIT_JS } from './owner-cockpit-ui.js';
import { recordAssistantMetric } from './personal-assistant-metrics.js';
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

beforeEach(() => _initTestDatabase());

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
  _closeDatabase();
});

async function start() {
  const server = createOwnerCockpitHttpServer(config);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return `http://127.0.0.1:${port}`;
}

function seedApproval(input: {
  approvalPacketId: string;
  groupFolder: string;
  summary: string;
  expiresAt?: string | null;
}) {
  const runId = `run-${input.approvalPacketId}`;
  const updatedAt = '2026-07-13T12:00:00.000Z';
  upsertCognitiveRun({
    runId,
    createdAt: '2026-07-13T12:00:00.000Z',
    updatedAt,
    groupFolder: input.groupFolder,
    channel: 'owner_cockpit',
    taskFamily: 'operator',
    turnId: `turn-${input.approvalPacketId}`,
    runOrigin: 'live',
    goalSummary: 'Review one exact staged action.',
    selectedSkillId: 'operator.approval',
    status: 'awaiting_approval',
    autonomyLevel: 'plan_draft_only',
    cognitiveMode: 'approval_staged',
    taskGraphJson: '{}',
    evidenceContractJson: '{}',
    providerUsabilityJson: '{}',
    councilRunId: null,
    verificationJson: '{}',
    outcomeScore: 0,
    nextAction: 'Wait for owner review.',
    privacyJson: '{"metadataOnly":true}',
    linkedSkillCardId: null,
  });
  upsertCognitiveApprovalPacket({
    approvalPacketId: input.approvalPacketId,
    createdAt: '2026-07-13T12:00:00.000Z',
    updatedAt,
    runId,
    toolId: 'operator.test',
    actionClass: 'operator_change',
    status: 'staged',
    summary: input.summary,
    approvalChannel: null,
    approvalKey: null,
    expiresAt: input.expiresAt ?? '2099-01-01T00:00:00.000Z',
    decisionJson: '{}',
    privacyJson: '{"metadataOnly":true}',
  });
  return runId;
}

async function authenticate(base: string) {
  const login = await fetch(`${base}/auth/login`, {
    method: 'POST',
    body: new URLSearchParams({ secret: config.secret }),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    redirect: 'manual',
  });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const response = await fetch(`${base}/api/v1/snapshot`, {
    headers: { cookie },
  });
  const snapshot = (await response.json()) as {
    csrfToken: string;
    approvals: Array<{
      id: string;
      summary: string;
      approvalVersion: number;
      scopeDigest: string | null;
    }>;
  };
  return { cookie, snapshot };
}

async function confirmApproval(input: {
  base: string;
  cookie: string;
  csrfToken: string;
  approvalPacketId: string;
  summary: string;
  approvalVersion: number;
  scopeDigest: string | null;
}) {
  return fetch(
    `${input.base}/api/v1/approvals/${encodeURIComponent(input.approvalPacketId)}/confirm`,
    {
      method: 'POST',
      headers: {
        cookie: input.cookie,
        origin: input.base,
        'content-type': 'application/json',
        'x-csrf-token': input.csrfToken,
      },
      body: JSON.stringify({
        confirmation: 'APPROVE',
        summary: input.summary,
        approvalVersion: input.approvalVersion,
        scopeDigest: input.scopeDigest,
      }),
    },
  );
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

  it('serves authenticated baseline and attributed latency evidence without saving a baseline', async () => {
    recordAssistantMetric({
      groupFolder: 'main',
      kind: 'latency_sample',
      value: 1_250,
      metadata: {
        latencyClass: 'interaction_delivery',
        runOrigin: 'live',
        routeKey: 'council.doctor',
        latencyTargetClass: 'local_command',
        providerId: 'local_runtime',
        toolClass: 'council_doctor',
        deliveryInstrumentationVersion: 3,
        queueWaitMs: 100,
        preprocessingMs: 0,
        harnessMs: 400,
        responsePreparationMs: 550,
        channelDeliveryMs: 200,
        hostPressureClass: 'high',
      },
    });
    recordAssistantMetric({
      groupFolder: 'main',
      kind: 'latency_sample',
      value: 900,
      metadata: {
        latencyClass: 'interaction_delivery_degraded',
        deliveryOutcome: 'unknown',
        runOrigin: 'live',
        routeKey: 'telegram.uncertain',
      },
    });
    const base = await start();
    const login = await fetch(`${base}/auth/login`, {
      method: 'POST',
      body: new URLSearchParams({ secret: config.secret }),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
    });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    const response = await fetch(`${base}/api/v1/snapshot`, {
      headers: { cookie },
    });
    const snapshot = (await response.json()) as {
      intelligence: {
        reviewedOutcomeCount: number;
        baselineReady: boolean;
        baselineSaved: boolean;
        latency: {
          sampleCount: number;
          p95Ms: number;
          targetBreaches: number;
          hostPressureSampleCount: number;
          highHostPressureSampleCount: number;
          latestHostPressureClass: string | null;
          degradedDeliveryCount: number;
          partialDeliveryCount: number;
          unknownDeliveryCount: number;
          latestDegradedDeliveryOutcome: string | null;
          latestDegradedDeliveryRoute: string | null;
          routes: Array<{ routeKey: string; targetMs: number }>;
          providers: Array<{ providerId: string }>;
          tools: Array<{ toolClass: string }>;
        };
      };
    };

    expect(response.status).toBe(200);
    expect(snapshot.intelligence).toMatchObject({
      reviewedOutcomeCount: 0,
      baselineReady: false,
      baselineSaved: false,
      latency: {
        sampleCount: 1,
        p95Ms: 1_250,
        targetBreaches: 0,
        hostPressureSampleCount: 1,
        highHostPressureSampleCount: 1,
        latestHostPressureClass: 'high',
        degradedDeliveryCount: 1,
        partialDeliveryCount: 0,
        unknownDeliveryCount: 1,
        latestDegradedDeliveryOutcome: 'unknown',
        latestDegradedDeliveryRoute: 'telegram.uncertain',
        routes: [
          expect.objectContaining({
            routeKey: 'council.doctor',
            targetMs: 2_000,
          }),
        ],
        providers: [expect.objectContaining({ providerId: 'local_runtime' })],
        tools: [expect.objectContaining({ toolClass: 'council_doctor' })],
      },
    });
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

  it('does not expose or confirm an approval from another group', async () => {
    const otherRunId = seedApproval({
      approvalPacketId: 'approval-other-group',
      groupFolder: 'other-group',
      summary: 'Change another group setting.',
    });
    const base = await start();
    const { cookie, snapshot } = await authenticate(base);

    expect(snapshot.approvals).toEqual([]);
    const response = await confirmApproval({
      base,
      cookie,
      csrfToken: snapshot.csrfToken,
      approvalPacketId: 'approval-other-group',
      summary: 'Change another group setting.',
      approvalVersion: 1,
      scopeDigest: null,
    });

    expect(response.status).toBe(409);
    expect(
      listCognitiveApprovalPackets({ runId: otherRunId, limit: 1 })[0]?.status,
    ).toBe('staged');
  });

  it('rejects an approval that expired before confirmation', async () => {
    const runId = seedApproval({
      approvalPacketId: 'approval-expired',
      groupFolder: 'main',
      summary: 'Restart a bounded local service.',
      expiresAt: '2020-01-01T00:00:00.000Z',
    });
    const base = await start();
    const { cookie, snapshot } = await authenticate(base);

    expect(snapshot.approvals).toEqual([]);
    const response = await confirmApproval({
      base,
      cookie,
      csrfToken: snapshot.csrfToken,
      approvalPacketId: 'approval-expired',
      summary: 'Restart a bounded local service.',
      approvalVersion: 1,
      scopeDigest: null,
    });

    expect(response.status).toBe(409);
    expect(
      listCognitiveApprovalPackets({ runId, limit: 1 })[0]?.status,
    ).not.toBe('approved');
  });

  it('rejects a snapshot after the staged approval is decided elsewhere', async () => {
    const runId = seedApproval({
      approvalPacketId: 'approval-stale-status',
      groupFolder: 'main',
      summary: 'Apply the staged configuration.',
    });
    const base = await start();
    const { cookie, snapshot } = await authenticate(base);
    const decidedElsewhere = approveCognitiveApprovalPacketCAS({
      approvalPacketId: 'approval-stale-status',
      groupFolder: 'main',
      expectedSummary: 'Apply the staged configuration.',
      expectedApprovalVersion: snapshot.approvals[0]!.approvalVersion,
      expectedScopeDigest: snapshot.approvals[0]!.scopeDigest,
      now: '2026-07-13T12:01:00.000Z',
      approvalChannel: 'another_authorized_surface',
    });
    expect(decidedElsewhere.status).toBe('approved');

    const response = await confirmApproval({
      base,
      cookie,
      csrfToken: snapshot.csrfToken,
      approvalPacketId: 'approval-stale-status',
      summary: 'Apply the staged configuration.',
      approvalVersion: snapshot.approvals[0]!.approvalVersion,
      scopeDigest: snapshot.approvals[0]!.scopeDigest,
    });

    expect(response.status).toBe(409);
    expect(listCognitiveApprovalPackets({ runId, limit: 1 })[0]?.status).toBe(
      'approved',
    );
  });

  it('rejects confirmation when the submitted action summary changes', async () => {
    const runId = seedApproval({
      approvalPacketId: 'approval-summary-change',
      groupFolder: 'main',
      summary: 'Restart service A.',
    });
    const base = await start();
    const { cookie, snapshot } = await authenticate(base);
    expect(snapshot.approvals).toEqual([
      expect.objectContaining({
        id: 'approval-summary-change',
        summary: 'Restart service A.',
      }),
    ]);

    const response = await confirmApproval({
      base,
      cookie,
      csrfToken: snapshot.csrfToken,
      approvalPacketId: 'approval-summary-change',
      summary: 'Restart service B.',
      approvalVersion: snapshot.approvals[0]!.approvalVersion,
      scopeDigest: snapshot.approvals[0]!.scopeDigest,
    });

    expect(response.status).toBe(409);
    const packet = listCognitiveApprovalPackets({ runId, limit: 1 })[0];
    expect(packet?.status).toBe('staged');
    expect(packet?.summary).toBe('Restart service A.');
  });

  it('allows only the first confirmation to consume a staged approval', async () => {
    const runId = seedApproval({
      approvalPacketId: 'approval-single-use',
      groupFolder: 'main',
      summary: 'Apply one exact reversible change.',
    });
    const base = await start();
    const { cookie, snapshot } = await authenticate(base);
    const request = {
      base,
      cookie,
      csrfToken: snapshot.csrfToken,
      approvalPacketId: 'approval-single-use',
      summary: 'Apply one exact reversible change.',
      approvalVersion: snapshot.approvals[0]!.approvalVersion,
      scopeDigest: snapshot.approvals[0]!.scopeDigest,
    };

    const first = await confirmApproval(request);
    const approvedAfterFirst = listCognitiveApprovalPackets({
      runId,
      limit: 1,
    })[0];
    const second = await confirmApproval(request);
    const approvedAfterSecond = listCognitiveApprovalPackets({
      runId,
      limit: 1,
    })[0];

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(approvedAfterFirst?.status).toBe('approved');
    expect(approvedAfterSecond).toEqual(approvedAfterFirst);
  });

  it('confirms a normal-turn exact durable scope before a grant can be issued', async () => {
    const generatedAt = new Date().toISOString();
    const binding = {
      ownerId: 'owner-normal-turn',
      chatId: 'chat-normal-turn',
      groupId: 'main',
      channel: 'telegram',
      targetScopeKey: 'bluebubbles:self-thread',
    };
    const cognitive = beginCognitiveKernelRun({
      turnId: 'owner-normal-turn',
      channel: 'telegram',
      groupFolder: 'main',
      taskFamily: 'communication',
      goal: 'Send the approved proof message.',
      requestRoute: 'message_action',
      selectedSkillId: 'communication.send',
      selectedSkillPurpose: 'Stage one exact message action for review.',
      selectedSkillApprovalNeed: 'explicit',
      selectedSkillSideEffectRisk: 'high',
      selectedSkillEvidenceLevel: 'strong',
    });
    const runtime = beginAgentRuntimeSpineRun({
      turnId: 'owner-normal-turn',
      channel: binding.channel,
      groupFolder: binding.groupId,
      actorId: binding.ownerId,
      chatId: binding.chatId,
      targetScopeKey: binding.targetScopeKey,
      taskFamily: 'communication',
      requestRoute: 'message_action',
      goal: 'Send the approved proof message.',
      cognitiveRun: cognitive,
      generatedAt,
      mode: 'assistive',
    });
    const stagedWork = runtime?.durableWork;
    expect(stagedWork).toMatchObject({
      status: 'awaiting_approval',
      approvalVersion: 1,
      cognitiveRunId: cognitive.run.runId,
    });
    expect(stagedWork?.approvalPacketId).toMatch(/^approval:durable:/);
    expect(
      listDurableWorkLinks(stagedWork?.workId || '').filter(
        (link) => link.linkKind === 'approval_packet',
      ),
    ).toEqual([
      expect.objectContaining({ linkedId: stagedWork?.approvalPacketId }),
    ]);
    const stagedPacket = listCognitiveApprovalPackets({
      runId: cognitive.run.runId,
      status: 'staged',
      limit: 100,
    }).find(
      (packet) => packet.approvalPacketId === stagedWork?.approvalPacketId,
    );
    expect(stagedPacket).toMatchObject({
      durableWorkId: stagedWork?.workId,
      durableCheckpointId: stagedWork?.checkpointHeadId,
      planVersion: stagedWork?.planVersion,
      targetScopeDigest: stagedWork?.targetScopeHash,
      actionClass: 'send',
      approvalVersion: 1,
    });
    expect(() =>
      issueDurableResumeGrant({
        workId: stagedWork?.workId || '',
        binding,
        actionClass: 'send',
        approvalPacketId: stagedPacket?.approvalPacketId,
        approvalVersion: stagedPacket?.approvalVersion,
        now: generatedAt,
      }),
    ).toThrow(/current exact-scope approval/i);

    const base = await start();
    const { cookie, snapshot } = await authenticate(base);
    const ownerRecord = snapshot.approvals.find(
      (approval) => approval.id === stagedPacket?.approvalPacketId,
    );
    expect(ownerRecord).toEqual(
      expect.objectContaining({
        summary: stagedPacket?.summary,
        approvalVersion: 1,
        scopeDigest: stagedPacket?.scopeDigest,
      }),
    );
    const confirmation = await confirmApproval({
      base,
      cookie,
      csrfToken: snapshot.csrfToken,
      approvalPacketId: ownerRecord?.id || '',
      summary: ownerRecord?.summary || '',
      approvalVersion: ownerRecord?.approvalVersion || 0,
      scopeDigest: ownerRecord?.scopeDigest || null,
    });
    expect(confirmation.status).toBe(200);
    const approvedWork = getDurableWorkUnit(stagedWork?.workId || '');
    expect(approvedWork).toMatchObject({
      approvalPacketId: stagedPacket?.approvalPacketId,
      approvalVersion: 2,
      checkpointHeadId: stagedPacket?.durableCheckpointId,
      planVersion: stagedPacket?.planVersion,
    });

    expect(() =>
      issueDurableResumeGrant({
        workId: approvedWork?.workId || '',
        binding,
        actionClass: 'send',
        approvalPacketId: stagedPacket?.approvalPacketId,
        approvalVersion: 1,
        now: generatedAt,
      }),
    ).toThrow(/current exact-scope approval/i);
    expect(() =>
      issueDurableResumeGrant({
        workId: approvedWork?.workId || '',
        binding: { ...binding, targetScopeKey: 'bluebubbles:other-thread' },
        actionClass: 'send',
        approvalPacketId: stagedPacket?.approvalPacketId,
        approvalVersion: 2,
        now: generatedAt,
      }),
    ).toThrow(/scope does not match/i);
    const grant = issueDurableResumeGrant({
      workId: approvedWork?.workId || '',
      binding,
      actionClass: 'send',
      approvalPacketId: stagedPacket?.approvalPacketId,
      approvalVersion: 2,
      inboundMessageId: 'owner-normal-turn-confirmation',
      now: generatedAt,
    });
    expect(grant.grant).toMatchObject({
      approvalPacketId: stagedPacket?.approvalPacketId,
      approvalVersion: 2,
      checkpointId: stagedPacket?.durableCheckpointId,
      planVersion: stagedPacket?.planVersion,
    });
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
    expect(OWNER_COCKPIT_JS).toContain('p50');
    expect(OWNER_COCKPIT_JS).toContain('p95');
    expect(OWNER_COCKPIT_JS).toContain('Slowest stage:');
  });
});
