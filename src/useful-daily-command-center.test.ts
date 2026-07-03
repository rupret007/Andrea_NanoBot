import { beforeEach, describe, expect, it } from 'vitest';

import {
  executeAssistantCapability,
  type AssistantCapabilityContext,
} from './assistant-capabilities.js';
import {
  continueAssistantCapabilityFromPriorSubjectData,
  matchAssistantCapabilityRequest,
} from './assistant-capability-router.js';
import {
  _initTestDatabase,
  getTasksForGroup,
  listMessageActionsForGroup,
  upsertCommunicationThread,
  upsertLifeThread,
  upsertOperatingProfile,
  upsertProfileSubject,
} from './db.js';
import { upsertOutcomeRecord } from './outcome-reviews.js';
import { buildUsefulDailyCommandCenter } from './useful-daily-command-center.js';
import type {
  CommunicationThreadRecord,
  LifeThread,
  OperatingProfilePlan,
} from './types.js';

const now = new Date('2026-06-22T15:00:00.000Z');

function seedProfile(groupFolder = 'main'): void {
  const plan: OperatingProfilePlan = {
    summary: 'Andrea should keep replies and family logistics moving.',
    trackedAreas: ['texts', 'family', 'follow-through'],
    defaultGroups: [],
    routines: ['morning check-in'],
    reminderSuggestions: ['morning check-in'],
    richerSurface: 'telegram',
    desiredIntegrations: [],
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

function seedLifeThread(overrides: Partial<LifeThread> = {}): void {
  upsertLifeThread({
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
  });
}

function seedCommunicationThread(
  overrides: Partial<CommunicationThreadRecord> = {},
): void {
  upsertCommunicationThread({
    id: overrides.id || 'comm-riley',
    groupFolder: overrides.groupFolder || 'main',
    title: overrides.title || 'Riley',
    linkedSubjectIds: overrides.linkedSubjectIds || ['subject-main-riley'],
    linkedLifeThreadIds: overrides.linkedLifeThreadIds || ['life-school'],
    channel: overrides.channel || 'bluebubbles',
    channelChatJid: overrides.channelChatJid || 'bb:iMessage;-;+14695550123',
    lastInboundSummary:
      overrides.lastInboundSummary ||
      'Riley said the violet zebra code is due tonight.',
    lastOutboundSummary: overrides.lastOutboundSummary || null,
    followupState: overrides.followupState || 'reply_needed',
    urgency: overrides.urgency || 'tonight',
    followupDueAt: overrides.followupDueAt || null,
    suggestedNextAction: overrides.suggestedNextAction || 'draft_reply',
    toneStyleHints: overrides.toneStyleHints || ['warm'],
    lastContactAt: overrides.lastContactAt || now.toISOString(),
    lastMessageId: overrides.lastMessageId || 'msg-private-1',
    linkedTaskId: overrides.linkedTaskId || null,
    inferenceState: overrides.inferenceState || 'assistant_inferred',
    trackingMode: overrides.trackingMode || 'default',
    createdAt: overrides.createdAt || now.toISOString(),
    updatedAt: overrides.updatedAt || now.toISOString(),
    disabledAt: overrides.disabledAt || null,
  });
}

function seedUsefulContext(): void {
  seedProfile();
  seedLifeThread();
  seedCommunicationThread();
}

describe('useful daily command center', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('routes normal daily usefulness prompts to the command center', () => {
    for (const prompt of [
      'what should I do today',
      'what needs me',
      'what is slipping',
      'show my daily command center',
    ]) {
      expect(matchAssistantCapabilityRequest(prompt)).toMatchObject({
        capabilityId: 'daily.command_center',
      });
    }
  });

  it('renders useful sections without private message snippets or identifiers', () => {
    seedUsefulContext();

    const result = buildUsefulDailyCommandCenter({
      groupFolder: 'main',
      now,
    });

    expect(result.replyText).toContain('Daily command center');
    expect(result.replyText).toContain('Do first');
    expect(result.replyText).toContain('Needs reply');
    expect(result.replyText).toContain('Follow-through to approve');
    expect(result.replyText).toContain('System truth');
    expect(result.replyText).toContain('review before drafting');
    expect(result.replyText).toContain('Safe fallback');
    expect(
      result.replyText.split('\n').filter((line) => /^#\d+ /.test(line.trim())),
    ).toHaveLength(1);
    expect(result.replyText).not.toContain('+14695550123');
    expect(result.replyText).not.toContain('bb:iMessage');
    expect(result.replyText).not.toContain('violet zebra');
    expect(result.reviewSeedJson).not.toContain('violet zebra');
  });

  it('ranks active approved follow-through above generic proposed candidates', () => {
    seedUsefulContext();
    upsertOutcomeRecord({
      groupFolder: 'main',
      sourceType: 'followthrough_candidate',
      sourceKey: 'followthrough:active-school',
      status: 'deferred',
      completionSummary: 'Approved local follow-through reminder for #1.',
      nextFollowupText: 'Keep school paperwork visible tonight.',
      linkedRefs: {
        followthroughCandidateId: 'followthrough:active-school',
        reminderTaskId: 'task-active-school',
      },
      dueAt: '2026-06-22T23:00:00.000Z',
      reviewHorizon: 'today',
      userConfirmed: true,
      showInDailyReview: true,
      showInWeeklyReview: true,
      now,
    });

    const result = buildUsefulDailyCommandCenter({
      groupFolder: 'main',
      now,
    });

    expect(result.replyText).toMatch(
      /Do first\nApproved follow-through: Keep this local reminder visible/,
    );
  });

  it('asks for confirmation when the safest visible item is inferred or group-scoped', () => {
    const plan: OperatingProfilePlan = {
      summary: 'Andrea should track text follow-through carefully.',
      trackedAreas: ['texts'],
      defaultGroups: [],
      routines: [],
      reminderSuggestions: [],
      richerSurface: 'telegram',
      desiredIntegrations: [],
      learningPolicy: 'suggest_then_confirm',
    };
    upsertOperatingProfile({
      profileId: 'profile-main',
      groupFolder: 'main',
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
      id: 'subject-main-riley',
      groupFolder: 'main',
      kind: 'person',
      canonicalName: 'riley',
      displayName: 'Riley',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      disabledAt: null,
    });
    seedCommunicationThread({
      linkedLifeThreadIds: [],
      channelChatJid: 'bb:iMessage;chat;+14695550123;+14695550124',
      inferenceState: 'assistant_inferred',
      suggestedNextAction: 'create_reminder',
    });

    const result = buildUsefulDailyCommandCenter({
      groupFolder: 'main',
      now,
    });

    expect(result.replyText).toContain(
      'confirm the exact thread or audience before tracking',
    );
    expect(result.replyText).toContain('Try `why this one` first');
    expect(result.replyText).not.toContain('approve local tracking');
    expect(result.replyText).not.toContain('+14695550123');
    expect(result.replyText).not.toContain('bb:iMessage');
  });

  it('seeds follow-through approval and supports approving the safest one', async () => {
    seedUsefulContext();

    const commandCenter = await executeAssistantCapability({
      capabilityId: 'daily.command_center',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:main',
        now,
      },
      input: {
        canonicalText: 'show my daily command center',
      },
    });
    const subjectData = commandCenter.conversationSeed
      ?.subjectData as AssistantCapabilityContext['priorSubjectData'];

    expect(commandCenter.replyText).toContain('approve the safest one');
    expect(
      continueAssistantCapabilityFromPriorSubjectData(
        'approve the safest one tonight',
        subjectData,
      ),
    ).toMatchObject({
      capabilityId: 'rituals.followthrough',
      continuation: true,
    });

    const approval = await executeAssistantCapability({
      capabilityId: 'rituals.followthrough',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:main',
        now,
        priorSubjectData: subjectData,
      },
      input: {
        canonicalText: 'approve the safest one tonight',
      },
    });

    expect(approval.outcomeMetadata).toMatchObject({
      source: 'followthrough_activation',
      outcomeKind: 'approved',
    });
    expect(approval.replyText).toContain('No message was sent');
    expect(getTasksForGroup('main')).toHaveLength(1);
    expect(listMessageActionsForGroup({ groupFolder: 'main' })).toHaveLength(0);
  });
});
