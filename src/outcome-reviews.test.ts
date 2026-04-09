import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyActionBundleOperation,
  createOrRefreshActionBundle,
} from './action-bundles.js';
import { deliverCompanionHandoff } from './cross-channel-handoffs.js';
import {
  _closeDatabase,
  _initTestDatabase,
  createTask,
  getAllTasks,
  getCommunicationThread,
  getLifeThread,
  getMessageAction,
  upsertMessageAction,
  getOutcomeBySource,
  listOutcomesForGroup,
  replaceMissionSteps,
  upsertCommunicationThread,
  upsertLifeThread,
  upsertMission,
} from './db.js';
import {
  applyOutcomeReviewControl,
  buildOutcomeReviewResponse,
  buildReviewSnapshot,
  interpretOutcomeReviewControl,
  matchOutcomeReviewPrompt,
  seedOutcomeRecordsForGroup,
  syncOutcomeFromCommunicationThreadRecord,
  syncOutcomeFromLifeThreadRecord,
  syncOutcomeFromMessageActionRecord,
  syncOutcomeFromMissionRecord,
  syncOutcomeFromReminderTask,
} from './outcome-reviews.js';
import type {
  CommunicationThreadRecord,
  LifeThread,
  MissionRecord,
  MissionStepRecord,
} from './types.js';

function seedMission(
  overrides: Partial<MissionRecord> = {},
  stepOverrides: Partial<MissionStepRecord>[] = [],
): MissionRecord {
  const mission: MissionRecord = {
    missionId: overrides.missionId || 'mission-1',
    groupFolder: overrides.groupFolder || 'main',
    title: overrides.title || 'Friday dinner with Candace',
    objective: overrides.objective || 'Close the dinner loop cleanly.',
    category: overrides.category || 'communication',
    status: overrides.status || 'active',
    scope: overrides.scope || 'personal',
    linkedLifeThreadIds: overrides.linkedLifeThreadIds || [],
    linkedSubjectIds: overrides.linkedSubjectIds || [],
    linkedReminderIds: overrides.linkedReminderIds || [],
    linkedCurrentWorkJson: overrides.linkedCurrentWorkJson || null,
    linkedKnowledgeSourceIds: overrides.linkedKnowledgeSourceIds || [],
    summary: overrides.summary || 'Lock timing and send the follow-up.',
    suggestedNextActionJson: overrides.suggestedNextActionJson || null,
    blockersJson:
      overrides.blockersJson || JSON.stringify(['Candace still needs an answer.']),
    dueHorizon: overrides.dueHorizon || 'tonight',
    dueAt: overrides.dueAt || '2026-04-08T23:00:00.000Z',
    mutedSuggestedActionKinds: overrides.mutedSuggestedActionKinds || [],
    createdAt: overrides.createdAt || '2026-04-08T16:00:00.000Z',
    lastUpdatedAt: overrides.lastUpdatedAt || '2026-04-08T18:00:00.000Z',
    userConfirmed: overrides.userConfirmed ?? true,
  };
  const steps: MissionStepRecord[] =
    stepOverrides.length > 0
      ? stepOverrides.map((step, index) => ({
          stepId: step.stepId || `mission-step-${index + 1}`,
          missionId: mission.missionId,
          position: step.position || index + 1,
          title: step.title || `Mission step ${index + 1}`,
          detail: step.detail || null,
          stepStatus: step.stepStatus || 'pending',
          requiresUserJudgment: step.requiresUserJudgment ?? false,
          suggestedActionKind: step.suggestedActionKind || null,
          linkedRefJson: step.linkedRefJson || null,
          lastUpdatedAt: step.lastUpdatedAt || mission.lastUpdatedAt,
        }))
      : [
          {
            stepId: 'mission-step-1',
            missionId: mission.missionId,
            position: 1,
            title: 'Confirm dinner timing',
            detail: 'Text Candace back tonight.',
            stepStatus: 'pending',
            requiresUserJudgment: true,
            suggestedActionKind: 'draft_follow_up',
            linkedRefJson: null,
            lastUpdatedAt: mission.lastUpdatedAt,
          },
        ];
  upsertMission(mission);
  replaceMissionSteps(mission.missionId, steps);
  return mission;
}

function seedCommunicationThread(
  overrides: Partial<CommunicationThreadRecord> = {},
): CommunicationThreadRecord {
  const thread: CommunicationThreadRecord = {
    id: overrides.id || 'comm-1',
    groupFolder: overrides.groupFolder || 'main',
    title: overrides.title || 'Candace',
    linkedSubjectIds: overrides.linkedSubjectIds || [],
    linkedLifeThreadIds: overrides.linkedLifeThreadIds || [],
    channel: overrides.channel || 'telegram',
    channelChatJid: overrides.channelChatJid || 'tg:main',
    lastInboundSummary:
      overrides.lastInboundSummary ||
      'Candace still needs a dinner answer tonight.',
    lastOutboundSummary: overrides.lastOutboundSummary || null,
    followupState: overrides.followupState || 'reply_needed',
    urgency: overrides.urgency || 'tonight',
    followupDueAt: overrides.followupDueAt || '2026-04-08T22:00:00.000Z',
    suggestedNextAction: overrides.suggestedNextAction || 'draft_reply',
    toneStyleHints: overrides.toneStyleHints || [],
    lastContactAt: overrides.lastContactAt || '2026-04-08T17:00:00.000Z',
    lastMessageId: overrides.lastMessageId || 'msg-1',
    linkedTaskId: overrides.linkedTaskId || null,
    inferenceState: overrides.inferenceState || 'user_confirmed',
    trackingMode: overrides.trackingMode || 'default',
    createdAt: overrides.createdAt || '2026-04-08T16:30:00.000Z',
    updatedAt: overrides.updatedAt || '2026-04-08T18:30:00.000Z',
    disabledAt: overrides.disabledAt || null,
  };
  upsertCommunicationThread(thread);
  return thread;
}

function seedLifeThread(overrides: Partial<LifeThread> = {}): LifeThread {
  const thread: LifeThread = {
    id: overrides.id || 'thread-1',
    groupFolder: overrides.groupFolder || 'main',
    title: overrides.title || 'Household',
    category: overrides.category || 'household',
    status: overrides.status || 'active',
    scope: overrides.scope || 'personal',
    relatedSubjectIds: overrides.relatedSubjectIds || [],
    contextTags: overrides.contextTags || ['household'],
    summary: overrides.summary || 'Replace the HVAC filter this week.',
    nextAction: overrides.nextAction || 'Replace the air filter tomorrow.',
    nextFollowupAt: overrides.nextFollowupAt || '2026-04-09T15:00:00.000Z',
    sourceKind: overrides.sourceKind || 'explicit',
    confidenceKind: overrides.confidenceKind || 'high',
    userConfirmed: overrides.userConfirmed ?? true,
    sensitivity: overrides.sensitivity || 'normal',
    surfaceMode: overrides.surfaceMode || 'default',
    followthroughMode: overrides.followthroughMode || 'important_only',
    lastSurfacedAt: overrides.lastSurfacedAt || null,
    snoozedUntil: overrides.snoozedUntil || null,
    linkedTaskId: overrides.linkedTaskId || null,
    mergedIntoThreadId: overrides.mergedIntoThreadId || null,
    createdAt: overrides.createdAt || '2026-04-08T15:00:00.000Z',
    lastUpdatedAt: overrides.lastUpdatedAt || '2026-04-08T18:00:00.000Z',
    lastUsedAt: overrides.lastUsedAt || null,
  };
  upsertLifeThread(thread);
  return thread;
}

describe('outcome reviews', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    _closeDatabase();
  });

  it('tracks partial bundle execution and reminder deferral separately', async () => {
    const snapshot = createOrRefreshActionBundle({
      groupFolder: 'main',
      presentationChannel: 'bluebubbles',
      presentationChatJid: 'bb:chat-1',
      capabilityId: 'research.compare',
      continuationCandidate: {
        capabilityId: 'research.compare',
        voiceSummary: 'Kindle is the safer battery pick.',
        handoffPayload: {
          kind: 'message',
          title: 'Full comparison',
          text: 'Kindle is the safer battery pick for long travel days.',
          followupSuggestions: ['Save it if useful.'],
        },
        completionText: 'Kindle is the safer battery pick for long travel days.',
      },
      summaryText: 'Kindle is the safer battery pick.',
      utterance: 'compare kindle versus kobo',
      now: new Date('2026-04-08T19:00:00.000Z'),
    });

    await applyActionBundleOperation(
      snapshot!.bundle.bundleId,
      { kind: 'approve_all' },
      {
        groupFolder: 'main',
        channel: 'bluebubbles',
        chatJid: 'bb:chat-1',
        currentTime: new Date('2026-04-08T19:05:00.000Z'),
        resolveTelegramMainChat: () => undefined,
        sendTelegramMessage: vi.fn(async () => ({ platformMessageId: 'unused' })),
      },
    );

    expect(
      getOutcomeBySource('main', 'action_bundle', snapshot!.bundle.bundleId)
        ?.status,
    ).toBe('partial');
    expect(
      listOutcomesForGroup({
        groupFolder: 'main',
        sourceTypes: ['reminder'],
        limit: 10,
      })[0]?.status,
    ).toBe('deferred');
  });

  it('seeds outcome rows lazily from open mission, communication, and life-thread state', () => {
    const mission = seedMission();
    const communication = seedCommunicationThread();
    const lifeThread = seedLifeThread();

    seedOutcomeRecordsForGroup('main', new Date('2026-04-08T19:10:00.000Z'));

    expect(getOutcomeBySource('main', 'mission', mission.missionId)?.status).toBe(
      'partial',
    );
    expect(
      getOutcomeBySource('main', 'communication_thread', communication.id)
        ?.status,
    ).toBe('partial');
    expect(
      getOutcomeBySource('main', 'life_thread', lifeThread.id)?.status,
    ).toBe('partial');
  });

  it('builds daily review snapshots and person-scoped review from unified outcomes', () => {
    const now = new Date('2026-04-08T20:00:00.000Z');
    const mission = seedMission({
      missionId: 'mission-blocked',
      title: 'Weekend prep',
      status: 'blocked',
      blockersJson: JSON.stringify(['Waiting on the equipment list.']),
      dueHorizon: 'this_week',
    });
    syncOutcomeFromMissionRecord(
      mission,
      [
        {
          stepId: 'mission-blocked-step',
          missionId: mission.missionId,
          position: 1,
          title: 'Get the equipment list',
          detail: null,
          stepStatus: 'blocked',
          requiresUserJudgment: false,
          suggestedActionKind: null,
          linkedRefJson: null,
          lastUpdatedAt: now.toISOString(),
        },
      ],
      now,
    );

    syncOutcomeFromCommunicationThreadRecord(
      seedCommunicationThread({
        id: 'comm-candace',
        title: 'Candace',
        lastInboundSummary: 'Candace still needs a dinner answer tonight.',
      }),
      now,
    );

    syncOutcomeFromReminderTask(
      {
        id: 'task-done',
        group_folder: 'main',
        chat_jid: 'tg:main',
        prompt: 'Wrap the client deck.',
        status: 'completed',
        next_run: null,
      },
      {
        summaryText: 'Wrapped the client deck.',
        now,
      },
    );

    const snapshot = buildReviewSnapshot({
      groupFolder: 'main',
      match: { kind: 'daily_review' },
      now,
    });

    expect(snapshot.completedToday[0]?.summaryText).toContain('Wrapped');
    expect(snapshot.stillOpenTonight.some((item) => item.sourceLabel === 'Candace')).toBe(
      true,
    );
    expect(snapshot.blocked.some((item) => item.sourceLabel.includes('Weekend prep'))).toBe(
      true,
    );

    const personSnapshot = buildReviewSnapshot({
      groupFolder: 'main',
      match: { kind: 'still_open_person', personName: 'Candace' },
      now,
    });
    expect(personSnapshot.owedReplies).toHaveLength(1);
    expect(personSnapshot.owedReplies[0]?.sourceLabel).toBe('Candace');

    const presentation = buildOutcomeReviewResponse({
      groupFolder: 'main',
      match: { kind: 'daily_review' },
      channel: 'telegram',
      now,
    });
    expect(presentation.text).toContain('*Still Open Tonight*');
    expect(presentation.inlineActionRows[0]?.[0]?.label).toContain('Mark handled');
  });

  it('surfaces rule-driven follow-through in review output', () => {
    const now = new Date('2026-04-08T20:05:00.000Z');
    syncOutcomeFromReminderTask(
      {
        id: 'task-rule',
        group_folder: 'main',
        chat_jid: 'tg:main',
        prompt: 'Check in with Candace tomorrow morning.',
        status: 'active',
        next_run: '2026-04-09T14:00:00.000Z',
      },
      {
        linkedRefs: {
          reminderTaskId: 'task-rule',
          communicationThreadId: 'comm-1',
          delegationRuleId: 'rule-1',
          delegationMode: 'auto_apply_when_safe',
          delegationExplanation: 'Used your usual reminder rule here.',
        },
        summaryText: 'Saved a reminder for tomorrow morning.',
        now,
      },
    );

    const snapshot = buildReviewSnapshot({
      groupFolder: 'main',
      match: { kind: 'daily_review' },
      now,
    });
    const presentation = buildOutcomeReviewResponse({
      groupFolder: 'main',
      match: { kind: 'daily_review' },
      channel: 'telegram',
      now,
    });

    expect(snapshot.carryIntoTomorrow[0]?.summaryText).toContain(
      'usual reminder rule',
    );
    expect(presentation.text).toContain('usual reminder rule');
  });

  it('separates message review sections for sent, scheduled, failed, and unsent drafts', () => {
    const now = new Date('2026-04-08T20:10:00.000Z');
    const baseFields = {
      groupFolder: 'main',
      sourceType: 'communication_thread' as const,
      sourceKey: 'comm-candace',
      sourceSummary: 'Candace follow-through',
      targetKind: 'external_thread' as const,
      targetChannel: 'bluebubbles' as const,
      targetConversationJson: JSON.stringify({
        kind: 'external_thread',
        chatJid: 'bb:chat-1',
        personName: 'Candace',
      }),
      requiresApproval: true,
      delegationRuleId: null,
      delegationMode: null,
      explanationJson: null,
      linkedRefsJson: JSON.stringify({
        communicationThreadId: 'comm-candace',
        personName: 'Candace',
      }),
      platformMessageId: null,
      dedupeKey: 'msg-review-base',
      presentationChatJid: 'tg:main',
      presentationThreadId: null,
      presentationMessageId: null,
      createdAt: now.toISOString(),
      lastUpdatedAt: now.toISOString(),
    };

    upsertMessageAction({
      ...baseFields,
      messageActionId: 'msg-sent',
      dedupeKey: 'msg-review-sent',
      draftText: 'Yes, tonight still works.',
      trustLevel: 'approve_before_send',
      sendStatus: 'sent',
      followupAt: null,
      scheduledTaskId: null,
      approvedAt: '2026-04-08T19:55:00.000Z',
      lastActionKind: 'sent',
      lastActionAt: '2026-04-08T20:00:00.000Z',
      sentAt: '2026-04-08T20:00:00.000Z',
    });
    upsertMessageAction({
      ...baseFields,
      messageActionId: 'msg-scheduled',
      dedupeKey: 'msg-review-scheduled',
      draftText: 'I can do 7 instead.',
      trustLevel: 'schedule_send',
      sendStatus: 'deferred',
      followupAt: '2026-04-08T22:00:00.000Z',
      scheduledTaskId: 'task-scheduled',
      approvedAt: '2026-04-08T20:02:00.000Z',
      lastActionKind: 'scheduled_send',
      lastActionAt: '2026-04-08T20:02:00.000Z',
      sentAt: null,
    });
    upsertMessageAction({
      ...baseFields,
      messageActionId: 'msg-failed',
      dedupeKey: 'msg-review-failed',
      draftText: 'Running a bit late.',
      trustLevel: 'approve_before_send',
      sendStatus: 'failed',
      followupAt: null,
      scheduledTaskId: null,
      approvedAt: '2026-04-08T20:03:00.000Z',
      lastActionKind: 'failed',
      lastActionAt: '2026-04-08T20:04:00.000Z',
      sentAt: null,
    });
    upsertMessageAction({
      ...baseFields,
      messageActionId: 'msg-draft',
      dedupeKey: 'msg-review-draft',
      draftText: 'Want to do dinner after rehearsal?',
      trustLevel: 'approve_before_send',
      sendStatus: 'drafted',
      followupAt: null,
      scheduledTaskId: null,
      approvedAt: null,
      lastActionKind: 'drafted',
      lastActionAt: '2026-04-08T20:05:00.000Z',
      sentAt: null,
    });

    syncOutcomeFromMessageActionRecord(getMessageAction('msg-sent')!, now);
    syncOutcomeFromMessageActionRecord(getMessageAction('msg-scheduled')!, now);
    syncOutcomeFromMessageActionRecord(getMessageAction('msg-failed')!, now);
    syncOutcomeFromMessageActionRecord(getMessageAction('msg-draft')!, now);

    const presentation = buildOutcomeReviewResponse({
      groupFolder: 'main',
      match: { kind: 'messages_unsent' },
      channel: 'telegram',
      now,
    });
    const sentPresentation = buildOutcomeReviewResponse({
      groupFolder: 'main',
      match: { kind: 'messages_sent_today' },
      channel: 'telegram',
      now,
    });

    expect(presentation.text).toContain('*Waiting For Approval*');
    expect(presentation.text).toContain('*Scheduled Sends*');
    expect(presentation.text).toContain('*Failed Sends*');
    expect(presentation.text).toContain('*Unsent Drafts*');
    expect(sentPresentation.text).toContain('*Sent Today*');
  });

  it('distinguishes saved-under-thread drafts from reminder-backed message follow-through', () => {
    const now = new Date('2026-04-08T20:15:00.000Z');
    const baseFields = {
      groupFolder: 'main',
      sourceType: 'communication_thread' as const,
      sourceKey: 'comm-candace',
      sourceSummary: 'Candace follow-through',
      targetKind: 'external_thread' as const,
      targetChannel: 'bluebubbles' as const,
      targetConversationJson: JSON.stringify({
        kind: 'external_thread',
        chatJid: 'bb:chat-1',
        personName: 'Candace',
      }),
      requiresApproval: false,
      delegationRuleId: null,
      delegationMode: null,
      explanationJson: null,
      linkedRefsJson: JSON.stringify({
        communicationThreadId: 'comm-candace',
        personName: 'Candace',
      }),
      platformMessageId: null,
      presentationChatJid: 'tg:main',
      presentationThreadId: null,
      presentationMessageId: null,
      createdAt: now.toISOString(),
      lastUpdatedAt: now.toISOString(),
    };

    upsertMessageAction({
      ...baseFields,
      messageActionId: 'msg-thread-save',
      dedupeKey: 'msg-thread-save',
      draftText: 'Yes, tonight still works for me.',
      trustLevel: 'approve_before_send',
      sendStatus: 'deferred',
      followupAt: null,
      scheduledTaskId: null,
      approvedAt: null,
      lastActionKind: 'save_to_thread',
      lastActionAt: '2026-04-08T20:11:00.000Z',
      sentAt: null,
    });
    upsertMessageAction({
      ...baseFields,
      messageActionId: 'msg-reminder-save',
      dedupeKey: 'msg-reminder-save',
      draftText: 'I can do 7 instead.',
      trustLevel: 'approve_before_send',
      sendStatus: 'deferred',
      followupAt: '2026-04-09T14:00:00.000Z',
      scheduledTaskId: null,
      approvedAt: null,
      lastActionKind: 'remind_instead',
      lastActionAt: '2026-04-08T20:12:00.000Z',
      sentAt: null,
    });

    syncOutcomeFromMessageActionRecord(getMessageAction('msg-thread-save')!, now);
    syncOutcomeFromMessageActionRecord(getMessageAction('msg-reminder-save')!, now);

    const presentation = buildOutcomeReviewResponse({
      groupFolder: 'main',
      match: { kind: 'messages_unsent' },
      channel: 'telegram',
      now,
    });

    expect(presentation.text).toContain('saved under the thread');
    expect(presentation.text).toContain('Converted to a reminder');
  });

  it('applies review controls to handle, defer, and suppress open loops', () => {
    const now = new Date('2026-04-08T20:30:00.000Z');
    const communication = seedCommunicationThread({
      id: 'comm-handle',
      title: 'Candace',
    });
    const handledOutcome = syncOutcomeFromCommunicationThreadRecord(
      communication,
      now,
    );

    const handled = applyOutcomeReviewControl({
      groupFolder: 'main',
      outcomeId: handledOutcome.outcomeId,
      control: { kind: 'mark_handled' },
      now,
    });
    expect(handled.handled).toBe(true);
    expect(getCommunicationThread('comm-handle')?.followupState).toBe('resolved');
    expect(
      getOutcomeBySource('main', 'communication_thread', 'comm-handle')?.status,
    ).toBe('completed');

    const lifeThread = seedLifeThread({
      id: 'thread-remind',
      title: 'Household',
      nextAction: 'Replace the air filter.',
    });
    const lifeOutcome = syncOutcomeFromLifeThreadRecord(lifeThread, now);
    const deferred = applyOutcomeReviewControl({
      groupFolder: 'main',
      outcomeId: lifeOutcome.outcomeId,
      control: { kind: 'remind_tomorrow' },
      chatJid: 'tg:main',
      now,
    });
    expect(deferred.handled).toBe(true);
    expect(getAllTasks().some((task) => task.id === getLifeThread('thread-remind')?.linkedTaskId)).toBe(
      true,
    );
    expect(getOutcomeBySource('main', 'life_thread', 'thread-remind')?.status).toBe(
      'deferred',
    );

    const hidden = applyOutcomeReviewControl({
      groupFolder: 'main',
      outcomeId: lifeOutcome.outcomeId,
      control: { kind: 'hide' },
      now,
    });
    expect(hidden.handled).toBe(true);
    expect(
      getOutcomeBySource('main', 'life_thread', 'thread-remind')
        ?.showInDailyReview,
    ).toBe(false);
  });

  it('tracks delivered handoffs as deferred until someone acts on them', async () => {
    const result = await deliverCompanionHandoff(
      {
        groupFolder: 'main',
        originChannel: 'alexa',
        voiceSummary: 'Send the fuller plan to Telegram.',
        payload: {
          kind: 'message',
          title: 'Full plan',
          text: 'Here is the fuller plan.',
          followupSuggestions: [],
        },
      },
      {
        resolveTelegramMainChat: () => ({ chatJid: 'tg:main' }),
        sendTelegramMessage: vi.fn(async () => ({
          platformMessageId: 'tg-msg-1',
        })),
      },
    );

    expect(result.ok).toBe(true);
    expect(
      getOutcomeBySource('main', 'cross_channel_handoff', result.handoffId)
        ?.status,
    ).toBe('deferred');
  });

  it('matches review prompts and natural review controls', () => {
    expect(matchOutcomeReviewPrompt('daily review')).toEqual({
      kind: 'daily_review',
    });
    expect(matchOutcomeReviewPrompt('what messages are still unsent')).toEqual({
      kind: 'messages_unsent',
    });
    expect(matchOutcomeReviewPrompt('what messages were sent today')).toEqual({
      kind: 'messages_sent_today',
    });
    expect(matchOutcomeReviewPrompt("what's still open with Candace")).toEqual({
      kind: 'still_open_person',
      personName: 'Candace',
    });
    expect(interpretOutcomeReviewControl("that's done")).toEqual({
      kind: 'mark_handled',
    });
    expect(interpretOutcomeReviewControl('remind me tomorrow instead')).toEqual({
      kind: 'remind_tomorrow',
    });
  });
});
