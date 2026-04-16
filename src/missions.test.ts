import { beforeEach, describe, expect, it } from 'vitest';

import { executeAssistantCapability } from './assistant-capabilities.js';
import {
  _initTestDatabase,
  getMission,
  listMissionSteps,
  upsertLifeThread,
  updateCommunicationThread,
} from './db.js';
import { analyzeCommunicationMessage } from './communication-companion.js';
import { handleLifeThreadCommand } from './life-threads.js';
import { buildMissionTurn } from './missions.js';
import type { SelectedWorkContext } from './daily-command-center.js';

const selectedWork: SelectedWorkContext = {
  laneLabel: 'Cursor',
  title: 'Ship release notes',
  statusLabel: 'Running',
  summary: 'Finish the release note draft and prep the handoff blurb.',
};

beforeEach(() => {
  _initTestDatabase();
});

describe('missions', () => {
  it('creates a stored proposed mission with readable steps and blockers', async () => {
    const now = new Date('2026-04-06T17:00:00.000Z');

    analyzeCommunicationMessage({
      channel: 'bluebubbles',
      groupFolder: 'main',
      chatJid: 'bb:main',
      text: 'Candace: can you let me know if Friday dinner still works after rehearsal?',
      now,
    });

    handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      text: 'save this under the Candace thread',
      replyText: 'Friday dinner timing is still open.',
      now,
    });

    const result = await buildMissionTurn({
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      text: 'help me plan Friday dinner with Candace',
      mode: 'propose',
      selectedWork,
      now,
    });

    expect(result.ok).toBe(true);
    expect(result.mission.status).toBe('proposed');
    expect(result.mission.userConfirmed).toBe(false);
    expect(result.steps.length).toBeGreaterThanOrEqual(3);
    expect(result.blockers.length).toBeGreaterThan(0);

    const stored = getMission(result.mission.missionId);
    expect(stored?.title).toContain('Friday dinner');
    expect(stored?.status).toBe('proposed');
  });

  it('can activate and simplify an existing mission without replacing it', async () => {
    const now = new Date('2026-04-06T17:30:00.000Z');
    const proposed = await buildMissionTurn({
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      text: 'help me get ready for the weekend',
      mode: 'propose',
      selectedWork,
      now,
    });

    const activated = await buildMissionTurn({
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      text: 'save this plan',
      mode: 'manage',
      priorContext: {
        missionId: proposed.mission.missionId,
      },
      selectedWork,
      now,
    });

    expect(activated.mission.status).toBe('active');
    expect(activated.mission.userConfirmed).toBe(true);

    const simpler = await buildMissionTurn({
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      text: 'make it simpler',
      mode: 'manage',
      priorContext: {
        missionId: proposed.mission.missionId,
      },
      selectedWork,
      now,
    });

    expect(
      listMissionSteps(simpler.mission.missionId).length,
    ).toBeLessThanOrEqual(3);
  });

  it('executes a confirmed reminder action from mission context', async () => {
    const now = new Date('2026-04-06T18:00:00.000Z');
    const proposed = await executeAssistantCapability({
      capabilityId: 'missions.propose',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:main',
        selectedWork,
        now,
      },
      input: {
        canonicalText: 'help me plan tonight',
      },
    });

    const execution = await executeAssistantCapability({
      capabilityId: 'missions.execute',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:main',
        selectedWork,
        priorSubjectData: proposed.conversationSeed?.subjectData,
        now,
      },
      input: {
        canonicalText: 'remind me',
      },
    });

    expect(execution.handled).toBe(true);
    expect(execution.replyText?.toLowerCase()).toContain('remind');

    const missionId = proposed.conversationSeed?.subjectData?.missionId;
    expect(missionId).toBeTruthy();
    expect(getMission(missionId!)?.linkedReminderIds.length).toBeGreaterThan(0);
  });

  it('answers blocker follow-ups with blocker-specific mission copy', async () => {
    const now = new Date('2026-04-06T18:15:00.000Z');
    const blockedWork: SelectedWorkContext = {
      laneLabel: 'Cursor',
      title: 'Ship release notes',
      statusLabel: 'Blocked',
      summary: 'Blocked waiting on release sign-off.',
    };

    const proposed = await buildMissionTurn({
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      text: 'help me plan tonight',
      mode: 'propose',
      selectedWork: blockedWork,
      now,
    });

    const explained = await buildMissionTurn({
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      text: "what's blocking this",
      mode: 'explain',
      priorContext: {
        missionId: proposed.mission.missionId,
      },
      selectedWork: blockedWork,
      now,
    });

    expect(explained.replyText).toContain(
      'The main blocker right now is this:',
    );
    expect(explained.replyText).toContain(
      'Current work still has pressure around Ship release notes.',
    );
    expect(explained.replyText).toContain('Clear it by: Lock the timing.');
  });

  it('keeps mission wording natural when a linked thread title is generic', async () => {
    const now = new Date('2026-04-06T18:18:00.000Z');

    const candace = analyzeCommunicationMessage({
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      text: 'Candace: can you let me know if dinner still works tonight?',
      now,
    });

    updateCommunicationThread(candace.thread!.id, {
      lastInboundSummary:
        'Candace wants a follow-up about whether dinner still works tonight.',
    });

    upsertLifeThread({
      id: 'thread-generic-followup',
      groupFolder: 'main',
      title: 'Follow-Up',
      category: 'personal',
      status: 'active',
      scope: 'personal',
      relatedSubjectIds: [],
      contextTags: ['candace', 'dinner'],
      summary:
        'Candace wants a follow-up about whether dinner still works tonight.',
      nextAction:
        'Candace wants a follow-up about whether dinner still works tonight.',
      nextFollowupAt: null,
      sourceKind: 'inferred',
      confidenceKind: 'high',
      userConfirmed: true,
      sensitivity: 'normal',
      surfaceMode: 'default',
      mergedIntoThreadId: null,
      createdAt: '2026-04-06T18:10:00.000Z',
      lastUpdatedAt: '2026-04-06T18:10:00.000Z',
      lastUsedAt: '2026-04-06T18:10:00.000Z',
      followthroughMode: 'important_only',
      lastSurfacedAt: null,
      snoozedUntil: null,
      linkedTaskId: null,
    });

    const proposed = await buildMissionTurn({
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      text: 'help me plan tonight',
      mode: 'propose',
      now,
    });

    expect(proposed.replyText).not.toContain('Tie this back to Follow-Up');
    expect(proposed.replyText).not.toContain('Track this under Follow-Up');

    const explained = await buildMissionTurn({
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      text: "what's blocking this",
      mode: 'explain',
      priorContext: {
        missionId: proposed.mission.missionId,
      },
      now,
    });

    expect(explained.replyText).not.toContain('life_threads');
    expect(explained.replyText).not.toContain('communication_threads');
    expect(explained.replyText).toContain('recent conversations');
  });

  it('starts a fresh explicit proposal instead of reusing the prior mission id', async () => {
    const now = new Date('2026-04-06T18:20:00.000Z');

    const first = await buildMissionTurn({
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      text: 'help me plan tonight',
      mode: 'propose',
      selectedWork,
      now,
    });

    const second = await buildMissionTurn({
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      text: 'help me plan Friday dinner with Candace',
      mode: 'propose',
      priorContext: {
        missionId: first.mission.missionId,
      },
      selectedWork,
      now,
    });

    expect(second.mission.missionId).not.toBe(first.mission.missionId);
    expect(second.mission.title).toContain('Friday dinner with Candace');
    expect(second.replyText).toContain('For Friday dinner with Candace');
  });

  it('keeps unrelated current work out of a general tonight plan', async () => {
    const now = new Date('2026-04-06T18:22:00.000Z');

    const result = await buildMissionTurn({
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      text: 'help me plan tonight',
      mode: 'propose',
      selectedWork: {
        laneLabel: 'Cursor',
        title: 'Reply with exactly: live cloud smoke ok',
        statusLabel: 'Running',
        summary: 'Reply with exactly: live cloud smoke ok. Do not modify files.',
      },
      now,
    });

    expect(result.mission.category).not.toBe('work');
    expect(result.mission.scope).not.toBe('work');
    expect(result.mission.linkedCurrentWorkJson).toBeNull();
    expect(result.replyText).not.toContain('live cloud smoke ok');
    expect(result.replyText).not.toContain('Current work still has pressure');
  });

  it('does not surface malformed orphaned open-loop summaries as mission blockers', async () => {
    const now = new Date('2026-04-06T18:25:00.000Z');

    const candace = analyzeCommunicationMessage({
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      text: 'Candace: can you let me know if dinner still works tonight?',
      now,
    });
    const generic = analyzeCommunicationMessage({
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      text: 'Can you get back to me?',
      now: new Date('2026-04-06T18:26:00.000Z'),
    });

    updateCommunicationThread(candace.thread!.id, {
      lastInboundSummary:
        'Candace wants a follow-up about whether dinner still works tonight.',
    });
    updateCommunicationThread(generic.thread!.id, {
      linkedSubjectIds: [],
      linkedLifeThreadIds: [],
      lastInboundSummary: 'They wants an answer about .',
      lastOutboundSummary:
        'Hey, I wanted to circle back on They wants an answer about .',
    });

    const result = await buildMissionTurn({
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      text: 'help me plan tonight',
      mode: 'propose',
      now,
    });

    expect(result.replyText).not.toContain('They wants an answer about .');
    expect(result.replyText).toContain(
      'Candace wants a follow-up about whether dinner still works tonight.',
    );
  });
});
