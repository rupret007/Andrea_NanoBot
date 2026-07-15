import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(async () => {
  const db = await import('./db.js');
  if (db.isDatabaseInitialized()) db._closeDatabase();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function testModules() {
  vi.stubEnv('ANDREA_PLATFORM_COORDINATOR_ENABLED', 'false');
  vi.stubEnv('ANDREA_PLATFORM_FALLBACK_TO_DIRECT_RUNTIME', 'true');
  const db = await import('./db.js');
  db._initTestDatabase();
  const acquisition = await import('./turn-capability-acquisition.js');
  return { db, acquisition };
}

describe('turn capability acquisition boundary', () => {
  it('detects explicit capability-learning intent without treating ordinary research as acquisition', async () => {
    const { acquisition } = await testModules();

    expect(
      acquisition.hasExplicitCapabilityLearningIntent(
        'Teach yourself how to invoke this unfamiliar tool.',
      ),
    ).toBe(true);
    expect(
      acquisition.hasExplicitCapabilityLearningIntent(
        'Figure out how to integrate the new adapter.',
      ),
    ).toBe(true);
    expect(
      acquisition.hasExplicitCapabilityLearningIntent(
        'Learn about the weather tomorrow.',
      ),
    ).toBe(false);
    expect(
      acquisition.hasExplicitCapabilityLearningIntent(
        'Explain how this existing function works.',
      ),
    ).toBe(false);
  });

  it('stores only scoped metadata and is idempotent for the same owner intent', async () => {
    const { db, acquisition } = await testModules();
    const privateBody =
      'Teach yourself how to invoke PRIVATE-PAYLOAD-937 with account details.';
    const input = {
      turnId: 'turn-private-1',
      channel: 'telegram',
      groupFolder: 'main',
      actorId: 'owner-1',
      text: privateBody,
      requestRoute: 'direct_assistant',
      runOrigin: 'live' as const,
      taskFamily: 'code' as const,
      selectedSkillId: 'code.assistance',
      selectedSkillRisk: 'medium' as const,
      selectedSkillApprovalNeed: 'conditional' as const,
    };

    const first = acquisition.observeTurnCapabilityGap(input);
    const second = acquisition.observeTurnCapabilityGap({
      ...input,
      turnId: 'turn-private-retry',
    });

    expect(first).toMatchObject({
      state: 'observed',
      gapKind: 'implementation_gap',
      taskFamily: 'code',
      metadataOnly: true,
      rawContentStored: false,
      durableWorkLinked: false,
    });
    expect(second?.acquisitionId).toBe(first?.acquisitionId);
    const records = db.listCapabilityAcquisitions({ groupFolder: 'main' });
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records[0])).not.toContain('PRIVATE-PAYLOAD-937');
    expect(JSON.stringify(records[0])).not.toContain('account details');
    expect(records[0]?.targetOutcome).toContain('explicit unfamiliar-task');
    expect(records[0]?.privacyJson).toContain('"rawMessagesStored":false');
  });

  it('does not create evidence for ordinary, replay, synthetic, unscoped, or unavailable-storage turns', async () => {
    const { db, acquisition } = await testModules();
    const base = {
      turnId: 'turn-no-observation',
      channel: 'telegram',
      groupFolder: 'main',
      actorId: 'owner-1',
      text: 'Explain the current adapter.',
      requestRoute: 'direct_assistant',
      runOrigin: 'live' as const,
      taskFamily: 'code' as const,
      selectedSkillId: 'code.assistance',
      selectedSkillRisk: 'medium' as const,
      selectedSkillApprovalNeed: 'conditional' as const,
    };

    expect(acquisition.observeTurnCapabilityGap(base)).toBeNull();
    expect(
      acquisition.observeTurnCapabilityGap({
        ...base,
        text: 'Teach yourself how to run this unfamiliar tool.',
        runOrigin: 'replay',
      }),
    ).toBeNull();
    expect(
      acquisition.observeTurnCapabilityGap({
        ...base,
        text: 'Teach yourself how to run this unfamiliar tool.',
        runOrigin: 'synthetic',
      }),
    ).toBeNull();
    expect(
      acquisition.observeTurnCapabilityGap({
        ...base,
        text: 'Teach yourself how to run this unfamiliar tool.',
        groupFolder: null,
      }),
    ).toBeNull();
    expect(db.listCapabilityAcquisitions({})).toEqual([]);

    db._closeDatabase();
    expect(
      acquisition.observeTurnCapabilityGap({
        ...base,
        text: 'Teach yourself how to run this unfamiliar tool.',
      }),
    ).toBeNull();
  });

  it('wires an explicit repository gap into the same durable coding mission surface', async () => {
    const { db } = await testModules();
    const { beginTurnAgentHarness } = await import('./turn-agent-harness.js');

    const context = await beginTurnAgentHarness({
      turnId: 'turn-repository-gap',
      channel: 'telegram',
      groupFolder: 'main',
      actorId: 'owner-1',
      chatId: 'chat-1',
      text: 'Teach yourself how to implement this unfamiliar repository adapter.',
      requestRoute: 'direct_assistant',
      runOrigin: 'live',
    });

    expect(context?.taskFamily).toBe('code');
    expect(context?.capabilityAcquisition).toMatchObject({
      state: 'observed',
      gapKind: 'implementation_gap',
      metadataOnly: true,
      rawContentStored: false,
      durableWorkLinked: true,
      deepWorkPacketId: context?.verifiedDeepWorkPacket?.packetId,
    });
    expect(
      context?.contextCompile.metadata.capability_acquisition_privacy,
    ).toBe('metadata_only');
    expect(
      context?.contextCompile.metadata
        .capability_acquisition_raw_content_stored,
    ).toBe('false');

    const workId = context?.runtimeSpine?.durableWork?.workId;
    expect(workId).toBeTruthy();
    const links = db.listDurableWorkLinks(workId!);
    expect(links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          linkKind: 'deep_work_packet',
          linkedId: context?.verifiedDeepWorkPacket?.packetId,
        }),
        expect.objectContaining({
          linkKind: 'capability_acquisition',
          linkedId: context?.capabilityAcquisition?.acquisitionId,
        }),
      ]),
    );
  });

  it('honors the canonical learn-first posture without requiring trigger words', async () => {
    const { acquisition } = await testModules();
    const status = acquisition.observeTurnCapabilityGap({
      turnId: 'turn-platform-learn-first',
      channel: 'telegram',
      groupFolder: 'main',
      actorId: 'owner-1',
      text: 'Handle this request safely.',
      requestRoute: 'direct_assistant',
      runOrigin: 'live',
      taskFamily: 'unknown',
      selectedSkillId: 'unknown.learn_first',
      selectedSkillRisk: 'none',
      selectedSkillApprovalNeed: 'none',
      executionPosture: 'learn_first',
    });

    expect(status).toMatchObject({
      state: 'observed',
      taskFamily: 'unknown',
      evidenceOrigin: 'live',
      metadataOnly: true,
    });
  });
});
