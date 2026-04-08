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
