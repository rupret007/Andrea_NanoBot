import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createOrRefreshActionBundle } from './action-bundles.js';
import { completeAssistantActionFromAlexa } from './assistant-action-completion.js';
import {
  getAllTasks,
  listKnowledgeSourcesForGroup,
  listLifeThreadsForGroup,
  _initTestDatabase,
  upsertDelegationRule,
} from './db.js';
import type { DelegationRuleRecord } from './types.js';

function seedDelegationRule(
  overrides: Partial<DelegationRuleRecord> = {},
): DelegationRuleRecord {
  const record: DelegationRuleRecord = {
    ruleId: overrides.ruleId || 'rule-1',
    groupFolder: overrides.groupFolder || 'main',
    title: overrides.title || 'Default delegation rule',
    triggerType: overrides.triggerType || 'bundle_type',
    triggerScope: overrides.triggerScope || 'mixed',
    conditionsJson:
      overrides.conditionsJson ||
      JSON.stringify({
        actionType: 'create_reminder',
        originKind: 'daily_guidance',
      }),
    delegatedActionsJson:
      overrides.delegatedActionsJson ||
      JSON.stringify([
        {
          actionType: 'create_reminder',
          timingHint: 'tomorrow morning',
        },
      ]),
    approvalMode: overrides.approvalMode || 'auto_apply_when_safe',
    status: overrides.status || 'active',
    createdAt: overrides.createdAt || '2026-04-08T10:00:00.000Z',
    lastUsedAt: overrides.lastUsedAt ?? null,
    timesUsed: overrides.timesUsed ?? 0,
    timesAutoApplied: overrides.timesAutoApplied ?? 0,
    timesOverridden: overrides.timesOverridden ?? 0,
    lastOutcomeStatus: overrides.lastOutcomeStatus ?? null,
    userConfirmed: overrides.userConfirmed ?? true,
    channelApplicabilityJson:
      overrides.channelApplicabilityJson ||
      JSON.stringify(['telegram', 'alexa', 'bluebubbles']),
    safetyLevel:
      overrides.safetyLevel || 'safe_to_auto_after_delegation',
  };
  upsertDelegationRule(record);
  return record;
}

describe('assistant action completion', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('saves the prior Alexa answer to the knowledge library', async () => {
    const result = await completeAssistantActionFromAlexa(
      {
        groupFolder: 'main',
        action: 'save_to_library',
        utterance: 'save that in my library',
        conversationSummary: 'Candace still needs a dinner answer tonight.',
        priorSubjectData: {
          lastAnswerSummary: 'Candace still needs a dinner answer tonight.',
          companionContinuationJson: JSON.stringify({
            capabilityId: 'daily.loose_ends',
            voiceSummary: 'Candace still needs a dinner answer tonight.',
            completionText: 'Candace still needs a dinner answer tonight.',
          }),
        },
      },
      {},
    );

    expect(result.handled).toBe(true);
    expect(result.replyText).toContain('Saved');
    expect(listKnowledgeSourcesForGroup('main')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceType: 'generated_note',
        }),
      ]),
    );
  });

  it('tracks the prior Alexa answer under the requested thread', async () => {
    const result = await completeAssistantActionFromAlexa(
      {
        groupFolder: 'main',
        action: 'track_thread',
        utterance: 'track that under Candace thread',
        conversationSummary: 'Dinner follow-up for Candace.',
        priorSubjectData: {
          companionContinuationJson: JSON.stringify({
            capabilityId: 'daily.loose_ends',
            voiceSummary: 'Dinner follow-up for Candace.',
            completionText: 'Candace still needs a dinner answer tonight.',
          }),
        },
      },
      {},
    );

    expect(result.handled).toBe(true);
    expect(result.replyText).toContain('Candace');
    expect(listLifeThreadsForGroup('main', ['active'])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'Candace',
        }),
      ]),
    );
  });

  it('delivers a richer handoff payload to Telegram', async () => {
    const sendTelegramMessage = vi.fn(async () => ({
      platformMessageId: 'tg-msg-42',
    }));

    const result = await completeAssistantActionFromAlexa(
      {
        groupFolder: 'main',
        action: 'send_details',
        utterance: 'send me the details',
        conversationSummary: 'Kindle comparison.',
        priorSubjectData: {
          companionContinuationJson: JSON.stringify({
            capabilityId: 'research.compare',
            voiceSummary: 'Kindle is the safer battery pick.',
            handoffPayload: {
              kind: 'message',
              title: 'Full comparison',
              text: '*Research Summary*\n\nKindle is the safer battery pick.',
              followupSuggestions: ['Save it if useful.'],
            },
            completionText: 'Kindle is the safer battery pick.',
          }),
        },
      },
      {
        resolveTelegramMainChat: () => ({ chatJid: 'tg:main' }),
        sendTelegramMessage,
      },
    );

    expect(result.handled).toBe(true);
    expect(result.replyText).toContain('sent the details to Telegram');
    expect(result.handoffResult?.ok).toBe(true);
    expect(sendTelegramMessage).toHaveBeenCalledWith(
      'tg:main',
      expect.stringContaining('*Research Summary*'),
    );
  });

  it('can send a text handoff to the linked BlueBubbles messages thread', async () => {
    const sendBlueBubblesMessage = vi.fn(async () => ({
      platformMessageId: 'bb-msg-42',
    }));

    const result = await completeAssistantActionFromAlexa(
      {
        groupFolder: 'main',
        action: 'send_details',
        utterance: 'send that to my messages',
        conversationSummary: 'Candace dinner follow-up.',
        priorSubjectData: {
          companionContinuationJson: JSON.stringify({
            capabilityId: 'knowledge.summarize_saved',
            voiceSummary: 'Candace still needs a dinner answer tonight.',
            handoffPayload: {
              kind: 'message',
              title: 'Dinner follow-up',
              text: 'Candace still needs a dinner answer tonight, and pickup works better after rehearsal.',
              followupSuggestions: [],
            },
            completionText:
              'Candace still needs a dinner answer tonight, and pickup works better after rehearsal.',
          }),
        },
      },
      {
        resolveTelegramMainChat: () => ({ chatJid: 'tg:main' }),
        resolveBlueBubblesCompanionChat: () => ({ chatJid: 'bb:chat-1' }),
        sendTelegramMessage: vi.fn(async () => ({ platformMessageId: 'tg-unused' })),
        sendBlueBubblesMessage,
      },
    );

    expect(result.handled).toBe(true);
    expect(result.replyText).toContain('your messages');
    expect(result.handoffResult?.ok).toBe(true);
    expect(sendBlueBubblesMessage).toHaveBeenCalledWith(
      'bb:chat-1',
      expect.stringContaining('Candace still needs a dinner answer'),
    );
  });

  it('creates a reminder when timing is explicit', async () => {
    const result = await completeAssistantActionFromAlexa(
      {
        groupFolder: 'main',
        action: 'create_reminder',
        utterance: 'turn that into a reminder tonight',
        conversationSummary: 'Band thing follow-up.',
        now: new Date('2026-04-03T14:00:00Z'),
        priorSubjectData: {
          companionContinuationJson: JSON.stringify({
            capabilityId: 'daily.loose_ends',
            voiceSummary: 'Do not forget the band thing.',
            completionText: 'Do not forget the band thing.',
          }),
        },
      },
      {
        resolveTelegramMainChat: () => ({ chatJid: 'tg:main' }),
      },
    );

    expect(result.handled).toBe(true);
    expect(result.replyText).toContain('remind you');
    expect(getAllTasks().some((task) => task.prompt.includes('band thing'))).toBe(
      true,
    );
  });

  it('routes save-for-later follow-ups through the shared bridge-backed path', async () => {
    const result = await completeAssistantActionFromAlexa(
      {
        groupFolder: 'main',
        action: 'save_for_later',
        utterance: 'save that for later',
        conversationSummary: 'Candace dinner follow-up.',
        priorSubjectData: {
          companionContinuationJson: JSON.stringify({
            capabilityId: 'daily.loose_ends',
            voiceSummary: 'Candace still needs a dinner answer tonight.',
            completionText:
              'Candace still needs a dinner answer tonight, and pickup works better after rehearsal.',
          }),
        },
      },
      {},
    );

    expect(result.handled).toBe(true);
    expect(result.bridgeSaveForLaterText).toContain(
      'pickup works better after rehearsal',
    );
  });

  it('uses a saved save-for-later rule to auto-create the usual reminder', async () => {
    seedDelegationRule({
      ruleId: 'rule-save-later',
      title: 'Save-for-later reminder default',
      conditionsJson: JSON.stringify({
        actionType: 'create_reminder',
        originKind: 'daily_guidance',
        promptPattern: 'save_that',
      }),
    });

    const result = await completeAssistantActionFromAlexa(
      {
        groupFolder: 'main',
        action: 'save_for_later',
        utterance: 'save that for later',
        conversationSummary: 'Candace dinner follow-up.',
        now: new Date('2026-04-03T14:00:00Z'),
        priorSubjectData: {
          companionContinuationJson: JSON.stringify({
            capabilityId: 'daily.loose_ends',
            voiceSummary: 'Candace still needs a dinner answer tonight.',
            completionText:
              'Candace still needs a dinner answer tonight, and pickup works better after rehearsal.',
          }),
        },
      },
      {
        resolveTelegramMainChat: () => ({ chatJid: 'tg:main' }),
      },
    );

    expect(result.handled).toBe(true);
    expect(result.replyText).toContain('usual save-for-later rule');
    expect(result.reminderTaskId).toBeTruthy();
    expect(getAllTasks()).toHaveLength(1);
  });

  it('turns keep-track-tonight follow-ups into bounded evening carryover', async () => {
    const result = await completeAssistantActionFromAlexa(
      {
        groupFolder: 'main',
        action: 'save_for_later',
        utterance: 'keep track of that for tonight',
        conversationSummary: 'Candace dinner follow-up.',
        priorSubjectData: {
          threadTitle: 'Candace',
          companionContinuationJson: JSON.stringify({
            capabilityId: 'daily.loose_ends',
            voiceSummary: 'Candace still needs a dinner answer tonight.',
            completionText:
              'Candace still needs a dinner answer tonight, and pickup works better after rehearsal.',
            threadTitle: 'Candace',
          }),
        },
        now: new Date('2026-04-03T14:00:00Z'),
      },
      {},
    );

    expect(result.handled).toBe(true);
    expect(result.replyText).toContain('evening reset');
    expect(listLifeThreadsForGroup('main', ['active'])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'Candace',
          followthroughMode: 'important_only',
        }),
      ]),
    );
  });

  it('prepares a draft-follow-up bridge request from prior Alexa context', async () => {
    const result = await completeAssistantActionFromAlexa(
      {
        groupFolder: 'main',
        action: 'draft_follow_up',
        utterance: 'draft that for me',
        conversationSummary: 'Candace dinner follow-up.',
        priorSubjectData: {
          threadTitle: 'Candace',
          companionContinuationJson: JSON.stringify({
            capabilityId: 'daily.loose_ends',
            voiceSummary: 'Candace still needs a dinner answer tonight.',
            completionText:
              'Candace still needs a dinner answer tonight, and pickup works better after rehearsal.',
            threadTitle: 'Candace',
          }),
        },
      },
      {},
    );

    expect(result.handled).toBe(true);
    expect(result.bridgeDraftReference).toBe('Candace');
  });

  it('uses the remembered reminder timing when the voice follow-up omits a time', async () => {
    seedDelegationRule({
      ruleId: 'rule-reminder',
      title: 'Reminder timing default',
      conditionsJson: JSON.stringify({
        actionType: 'create_reminder',
        originKind: 'daily_guidance',
      }),
    });

    const result = await completeAssistantActionFromAlexa(
      {
        groupFolder: 'main',
        action: 'create_reminder',
        utterance: 'turn that into a reminder',
        conversationSummary: 'Band thing follow-up.',
        now: new Date('2026-04-03T14:00:00Z'),
        priorSubjectData: {
          companionContinuationJson: JSON.stringify({
            capabilityId: 'daily.loose_ends',
            voiceSummary: 'Do not forget the band thing.',
            completionText: 'Do not forget the band thing.',
          }),
        },
      },
      {
        resolveTelegramMainChat: () => ({ chatJid: 'tg:main' }),
      },
    );

    expect(result.handled).toBe(true);
    expect(result.replyText).toContain('usual reminder rule');
    expect(result.reminderTaskId).toBeTruthy();
  });

  it('uses the remembered thread default when tracking without an explicit title', async () => {
    seedDelegationRule({
      ruleId: 'rule-thread',
      title: 'Family thread default',
      conditionsJson: JSON.stringify({
        actionType: 'save_to_thread',
        originKind: 'daily_guidance',
      }),
      delegatedActionsJson: JSON.stringify([
        {
          actionType: 'save_to_thread',
          threadTitle: 'Family',
        },
      ]),
    });

    const result = await completeAssistantActionFromAlexa(
      {
        groupFolder: 'main',
        action: 'track_thread',
        utterance: 'track that',
        conversationSummary: 'Dinner follow-up for Candace.',
        priorSubjectData: {
          companionContinuationJson: JSON.stringify({
            capabilityId: 'daily.loose_ends',
            voiceSummary: 'Dinner follow-up for Candace.',
            completionText: 'Candace still needs a dinner answer tonight.',
          }),
        },
      },
      {},
    );

    expect(result.handled).toBe(true);
    expect(result.replyText).toContain('usual thread rule');
    expect(listLifeThreadsForGroup('main', ['active'])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'Family',
        }),
      ]),
    );
  });

  it('can approve an action bundle from Alexa and execute the reminder action', async () => {
    const bundle = createOrRefreshActionBundle({
      groupFolder: 'main',
      presentationChannel: 'alexa',
      capabilityId: 'communication.understand_message',
      continuationCandidate: {
        capabilityId: 'communication.understand_message',
        voiceSummary: 'Candace still needs a dinner answer.',
        communicationThreadId: 'comm-1',
        lastCommunicationSummary: 'Candace still needs a dinner answer.',
        threadTitle: 'Candace',
        completionText: 'Candace still needs a dinner answer tonight.',
      },
      summaryText: 'Candace still needs a dinner answer.',
      utterance: 'what should I say back',
      now: new Date('2026-04-08T10:00:00.000Z'),
    });

    const result = await completeAssistantActionFromAlexa(
      {
        groupFolder: 'main',
        action: 'approve_bundle',
        utterance: 'do that',
        conversationSummary: 'Candace still needs a dinner answer.',
        priorSubjectData: {
          actionBundleId: bundle?.bundle.bundleId,
          companionContinuationJson: JSON.stringify({
            capabilityId: 'communication.understand_message',
            actionBundleId: bundle?.bundle.bundleId,
            completionText: 'Candace still needs a dinner answer tonight.',
          }),
        },
        now: new Date('2026-04-08T10:15:00.000Z'),
      },
      {
        resolveTelegramMainChat: () => ({ chatJid: 'tg:main' }),
        sendTelegramMessage: vi.fn(async () => ({ platformMessageId: 'tg-msg-1' })),
      },
    );

    expect(result.handled).toBe(true);
    expect(result.replyText).toContain('Andrea:');
    expect(getAllTasks().some((task) => task.chat_jid === 'tg:main')).toBe(true);
  });

  it('can hand the action bundle to Telegram from Alexa', async () => {
    const bundle = createOrRefreshActionBundle({
      groupFolder: 'main',
      presentationChannel: 'alexa',
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
      now: new Date('2026-04-08T10:00:00.000Z'),
    });
    const sendTelegramMessage = vi.fn(async () => ({
      platformMessageId: 'tg-bundle-1',
    }));

    const result = await completeAssistantActionFromAlexa(
      {
        groupFolder: 'main',
        action: 'send_details',
        utterance: 'send the details to Telegram',
        conversationSummary: 'Kindle is the safer battery pick.',
        priorSubjectData: {
          actionBundleId: bundle?.bundle.bundleId,
          companionContinuationJson: JSON.stringify({
            capabilityId: 'research.compare',
            actionBundleId: bundle?.bundle.bundleId,
            handoffPayload: {
              kind: 'message',
              title: 'Full comparison',
              text: 'Kindle is the safer battery pick for long travel days.',
              followupSuggestions: ['Save it if useful.'],
            },
            completionText: 'Kindle is the safer battery pick for long travel days.',
          }),
        },
      },
      {
        resolveTelegramMainChat: () => ({ chatJid: 'tg:main' }),
        sendTelegramMessage,
      },
    );

    expect(result.handled).toBe(true);
    expect(result.replyText).toContain('action bundle');
    expect(sendTelegramMessage).toHaveBeenCalledWith(
      'tg:main',
      expect.stringContaining('*Action bundle*'),
      expect.objectContaining({
        inlineActionRows: expect.any(Array),
      }),
    );
  });
});
