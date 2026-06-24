import { beforeEach, describe, expect, it } from 'vitest';

import { executeAssistantCapability } from './assistant-capabilities.js';
import {
  _initTestDatabase,
  getTasksForGroup,
  getAgentOSEpisode,
  listAgentOSEpisodes,
  listMessageActionsForGroup,
  listOutcomesForGroup,
  upsertCommunicationThread,
  upsertLifeThread,
  upsertOperatingProfile,
  upsertProfileSubject,
} from './db.js';
import {
  buildFollowThroughReview,
  formatFollowThroughReview,
  handleFollowThroughActivationCommand,
} from './follow-through-activation.js';
import type {
  CommunicationThreadRecord,
  LifeThread,
  OperatingProfilePlan,
} from './types.js';

const now = new Date('2026-06-18T17:00:00.000Z');

function seedProfile(groupFolder = 'main'): void {
  const plan: OperatingProfilePlan = {
    summary: 'Andrea should keep family logistics from slipping.',
    trackedAreas: ['texts', 'routines', 'school'],
    defaultGroups: [],
    routines: ['morning school check-in'],
    reminderSuggestions: ['ask about school forms before they slip'],
    richerSurface: 'telegram',
    desiredIntegrations: [
      {
        name: 'BlueBubbles',
        readiness: 'connected',
      },
    ],
    learningPolicy: 'suggest_then_confirm',
  };
  upsertOperatingProfile({
    profileId: `profile-${groupFolder}`,
    groupFolder,
    status: 'active',
    version: 1,
    basedOnProfileId: null,
    intakeJson: JSON.stringify({ source: 'test' }),
    planJson: JSON.stringify(plan),
    sourceChannel: 'telegram',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    approvedAt: now.toISOString(),
    supersededAt: null,
  });
  upsertProfileSubject({
    id: `subject-${groupFolder}-riley`,
    groupFolder,
    kind: 'person',
    canonicalName: 'riley',
    displayName: 'Riley',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    disabledAt: null,
  });
}

function seedLifeThread(overrides: Partial<LifeThread> = {}): LifeThread {
  const thread: LifeThread = {
    id: overrides.id || 'life-school',
    groupFolder: overrides.groupFolder || 'main',
    title: overrides.title || 'School logistics',
    category: overrides.category || 'school',
    status: overrides.status || 'active',
    scope: overrides.scope || 'family',
    relatedSubjectIds: overrides.relatedSubjectIds || ['subject-main-riley'],
    contextTags: overrides.contextTags || ['school'],
    summary:
      overrides.summary || 'Keep school forms and pickup changes visible.',
    nextAction: overrides.nextAction || 'Check whether forms need a reply.',
    nextFollowupAt: overrides.nextFollowupAt || null,
    sourceKind: overrides.sourceKind || 'explicit',
    confidenceKind: overrides.confidenceKind || 'explicit',
    userConfirmed: overrides.userConfirmed ?? true,
    sensitivity: overrides.sensitivity || 'normal',
    surfaceMode: overrides.surfaceMode || 'default',
    followthroughMode: overrides.followthroughMode || 'important_only',
    lastSurfacedAt: overrides.lastSurfacedAt || null,
    snoozedUntil: overrides.snoozedUntil || null,
    linkedTaskId: overrides.linkedTaskId || null,
    mergedIntoThreadId: overrides.mergedIntoThreadId || null,
    createdAt: overrides.createdAt || now.toISOString(),
    lastUpdatedAt: overrides.lastUpdatedAt || now.toISOString(),
    lastUsedAt: overrides.lastUsedAt || now.toISOString(),
  };
  upsertLifeThread(thread);
  return thread;
}

function seedCommunicationThread(
  overrides: Partial<CommunicationThreadRecord> = {},
): CommunicationThreadRecord {
  const thread: CommunicationThreadRecord = {
    id: overrides.id || 'comm-riley',
    groupFolder: overrides.groupFolder || 'main',
    title: overrides.title || 'Riley',
    linkedSubjectIds: overrides.linkedSubjectIds || ['subject-main-riley'],
    linkedLifeThreadIds: overrides.linkedLifeThreadIds || ['life-school'],
    channel: overrides.channel || 'bluebubbles',
    channelChatJid: overrides.channelChatJid || 'bb:iMessage;-;+14695550123',
    lastInboundSummary:
      overrides.lastInboundSummary ||
      'Riley asked if the school form is ready tonight.',
    lastOutboundSummary: overrides.lastOutboundSummary || null,
    followupState: overrides.followupState || 'reply_needed',
    urgency: overrides.urgency || 'tonight',
    followupDueAt: overrides.followupDueAt || null,
    suggestedNextAction: overrides.suggestedNextAction || 'create_reminder',
    toneStyleHints: overrides.toneStyleHints || ['warm'],
    lastContactAt: overrides.lastContactAt || now.toISOString(),
    lastMessageId: overrides.lastMessageId || 'msg-private-1',
    linkedTaskId: overrides.linkedTaskId || null,
    inferenceState: overrides.inferenceState || 'user_confirmed',
    trackingMode: overrides.trackingMode || 'default',
    createdAt: overrides.createdAt || now.toISOString(),
    updatedAt: overrides.updatedAt || now.toISOString(),
    disabledAt: overrides.disabledAt || null,
  };
  upsertCommunicationThread(thread);
  return thread;
}

function seedSafeFollowThrough(): void {
  seedProfile();
  seedLifeThread();
  seedCommunicationThread();
}

describe('follow-through activation', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('renders proposed follow-through candidates without raw identifiers', () => {
    seedSafeFollowThrough();

    const review = buildFollowThroughReview({
      groupFolder: 'main',
      now,
    });
    const rendered =
      review.reviewSeedJson + '\n' + review.items[0]?.suggestedTiming;
    const serialized = JSON.stringify(review);

    expect(review.items.length).toBeGreaterThan(0);
    expect(review.items[0]?.source).toContain('text');
    expect(review.items[0]?.decisionScore).toBeGreaterThan(0);
    expect(review.items[0]?.approvalReadiness).toBe('ready');
    expect(review.items[0]?.suggestedTiming).toBeTruthy();
    expect(rendered).toContain('suggestedTiming');
    expect(serialized).not.toContain('+14695550123');
    expect(serialized).not.toContain('bb:iMessage');
    expect(serialized).not.toContain('msg-private-1');
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9_-]{16,}/);
  });

  it('does not carry private text snippets into follow-through review seeds or output', () => {
    seedProfile();
    seedLifeThread();
    seedCommunicationThread({
      lastInboundSummary:
        'Riley said the secret launch code is violet zebra tonight.',
      suggestedNextAction: 'draft_reply',
    });

    const review = buildFollowThroughReview({
      groupFolder: 'main',
      now,
    });
    const rendered = formatFollowThroughReview(review);
    const seed = review.reviewSeedJson;

    expect(rendered).toContain('recent text thread');
    expect(seed).toContain('Text follow-through');
    for (const unsafe of ['secret launch code', 'violet zebra', 'Riley said']) {
      expect(rendered).not.toContain(unsafe);
      expect(seed).not.toContain(unsafe);
    }
  });

  it('coaches the best first approval without creating any action state', async () => {
    seedSafeFollowThrough();

    const result = await handleFollowThroughActivationCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      text: 'what should I approve first',
      now,
    });

    expect(result.outcomeKind).toBe('reviewed');
    expect(result.replyText).toContain('Best first approval');
    expect(result.replyText).toContain('Suggested timing');
    expect(result.replyText).toContain('Readiness: ready');
    expect(result.replyText).toContain('remind me about #');
    expect(getTasksForGroup('main')).toHaveLength(0);
    expect(listOutcomesForGroup({ groupFolder: 'main' })).toHaveLength(0);
  });

  it('asks one concrete timing question for approve without timing', async () => {
    seedSafeFollowThrough();

    const review = await handleFollowThroughActivationCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      text: 'what follow-through should I approve',
      now,
    });
    const result = await handleFollowThroughActivationCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      text: 'approve #1',
      now,
      priorReviewJson: review.reviewSeedJson,
    });

    expect(result.outcomeKind).toBe('clarified');
    expect(result.replyText).toContain('What timing should I use for #1?');
    expect(getTasksForGroup('main')).toHaveLength(0);
    expect(listOutcomesForGroup({ groupFolder: 'main' })).toHaveLength(0);
  });

  it('creates only local reminder and outcome state for timed approval', async () => {
    seedSafeFollowThrough();

    const review = await handleFollowThroughActivationCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      text: 'show proposed reminders',
      now,
    });
    const result = await handleFollowThroughActivationCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      text: 'remind me about #1 tonight',
      now,
      priorReviewJson: review.reviewSeedJson,
    });

    expect(result.outcomeKind).toBe('approved');
    expect(result.replyText).toContain('No message was sent');
    expect(getTasksForGroup('main')).toHaveLength(1);
    const outcomes = listOutcomesForGroup({ groupFolder: 'main' });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      sourceType: 'followthrough_candidate',
      status: 'deferred',
      userConfirmed: true,
    });
    expect(outcomes[0]?.linkedRefsJson).toContain('agentOSEpisodeId');
    expect(outcomes[0]?.linkedRefsJson).toContain('reminderTaskId');
    expect(listMessageActionsForGroup({ groupFolder: 'main' })).toHaveLength(0);
    expect(result.agentOSEpisodeId).toBeTruthy();
    expect(getAgentOSEpisode(result.agentOSEpisodeId!)).toBeTruthy();
    expect(
      listAgentOSEpisodes({ groupFolder: 'main', limit: 10 }).length,
    ).toBeGreaterThan(0);
  });

  it('supports why, defer, dismiss, and handled item follow-ups', async () => {
    seedSafeFollowThrough();

    const review = await handleFollowThroughActivationCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      text: 'what is slipping',
      now,
    });
    const why = await handleFollowThroughActivationCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      text: 'why #1',
      now,
      priorReviewJson: review.reviewSeedJson,
    });
    const defer = await handleFollowThroughActivationCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      text: 'defer #2',
      now,
      priorReviewJson: review.reviewSeedJson,
    });
    const dismiss = await handleFollowThroughActivationCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      text: 'dismiss #3',
      now,
      priorReviewJson: review.reviewSeedJson,
    });
    const handled = await handleFollowThroughActivationCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      text: 'mark #4 handled',
      now,
      priorReviewJson: review.reviewSeedJson,
    });

    expect(why.outcomeKind).toBe('explained');
    expect(defer.outcomeKind).toBe('deferred');
    expect(dismiss.outcomeKind).toBe('dismissed');
    expect(handled.outcomeKind).toBe('handled');
    expect(
      listOutcomesForGroup({ groupFolder: 'main' }).map(
        (outcome) => outcome.status,
      ),
    ).toEqual(expect.arrayContaining(['deferred', 'skipped', 'completed']));
  });

  it('blocks group-chat or inferred candidates before reminder approval', async () => {
    seedProfile();
    seedLifeThread();
    seedCommunicationThread({
      channelChatJid: 'bb:iMessage;chat;+14695550123;+14695550124',
      inferenceState: 'assistant_inferred',
    });

    const review = await handleFollowThroughActivationCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      text: 'show proposed reminders',
      now,
    });
    const result = await handleFollowThroughActivationCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      text: 'remind me about #1 tonight',
      now,
      priorReviewJson: review.reviewSeedJson,
    });

    expect(result.outcomeKind).toBe('blocked_risky');
    expect(result.replyText).toContain('confirm the exact audience or thread');
    expect(getTasksForGroup('main')).toHaveLength(0);
    const outcomes = listOutcomesForGroup({ groupFolder: 'main' });
    expect(outcomes[0]).toMatchObject({
      sourceType: 'followthrough_candidate',
      status: 'failed',
      userConfirmed: false,
    });
    expect(outcomes[0]?.blockerText).toContain('explicit audience');
    expect(outcomes[0]?.linkedRefsJson).toContain('agentOSEpisodeId');
  });

  it('marks risky group candidates as confirmation-first while recommending safer approvals first', async () => {
    seedProfile();
    seedLifeThread();
    seedCommunicationThread({
      channelChatJid: 'bb:iMessage;chat;+14695550123;+14695550124',
      inferenceState: 'assistant_inferred',
    });

    const result = await handleFollowThroughActivationCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      text: 'what should I approve first',
      now,
    });

    expect(result.replyText).toContain('Best first approval');
    expect(result.replyText).toContain('Readiness: ready. Try: `remind me');
    expect(result.replyText).toContain('Readiness: confirm first');
    expect(result.replyText).toContain('group_chat_confirm_audience');
    expect(getTasksForGroup('main')).toHaveLength(0);
  });

  it('blocks stale follow-through selections when the candidate changed', async () => {
    seedSafeFollowThrough();

    const review = await handleFollowThroughActivationCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      text: 'show proposed reminders',
      now,
    });
    seedCommunicationThread({
      lastInboundSummary: 'Riley changed the request after the first review.',
      updatedAt: '2026-06-18T17:05:00.000Z',
      lastMessageId: 'msg-private-2',
    });

    const result = await handleFollowThroughActivationCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      text: 'remind me about #1 tonight',
      now: new Date('2026-06-18T17:06:00.000Z'),
      priorReviewJson: review.reviewSeedJson,
    });

    expect(result.outcomeKind).toBe('blocked_stale');
    expect(result.replyText).toContain('fresh numbered list');
    expect(getTasksForGroup('main')).toHaveLength(0);
    const outcomes = listOutcomesForGroup({ groupFolder: 'main' });
    expect(outcomes[0]?.status).toBe('failed');
    expect(outcomes[0]?.blockerText).toMatch(/changed|updated|no longer/i);
  });

  it('routes through the assistant capability and keeps selected follow-ups seeded', async () => {
    seedSafeFollowThrough();

    const review = await executeAssistantCapability({
      capabilityId: 'rituals.followthrough',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:main',
        now,
      },
      input: {
        text: 'show proposed reminders',
        canonicalText: 'show proposed reminders',
      },
    });

    expect(review.handled).toBe(true);
    expect(review.replyText).toContain('Follow-through candidates');
    expect(review.outcomeMetadata).toMatchObject({
      source: 'followthrough_activation',
      outcomeKind: 'reviewed',
    });
    expect(
      review.conversationSeed?.subjectData?.followthroughReviewJson,
    ).toBeTruthy();

    const timed = await executeAssistantCapability({
      capabilityId: 'rituals.followthrough',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:main',
        now,
        priorSubjectData: review.conversationSeed?.subjectData,
      },
      input: {
        text: 'remind me about #1 tonight',
        canonicalText: 'remind me about #1 tonight',
      },
    });

    expect(timed.outcomeMetadata).toMatchObject({
      source: 'followthrough_activation',
      outcomeKind: 'approved',
      itemRank: 1,
    });
    expect(getTasksForGroup('main')).toHaveLength(1);
  });
});
