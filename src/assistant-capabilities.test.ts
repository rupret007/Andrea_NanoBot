import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  executeAssistantCapability,
  formatMessagesSummaryCouncilDisclosure,
  getAssistantCapability,
  getAssistantCapabilityRegistry,
} from './assistant-capabilities.js';
import {
  applyMessageActionOperation,
  buildMessageActionPresentation,
  createOrRefreshMessageActionFromDraft,
  executeExplicitlyAuthorizedMessageAction,
} from './message-actions.js';
import {
  buildRecentTextReviewSeedJson,
  reviewRecentTexts,
} from './recent-text-review.js';
import {
  createTask,
  getCommunicationThread,
  getTaskById,
  listCommunicationSignalsForThread,
  listKnowledgeSourcesForGroup,
  listMessageActionsForGroup,
  storeChatMetadata,
  storeMessage,
  storeMessageDirect,
  _initTestDatabase,
  updateMessageAction,
  upsertCommunicationThread,
  upsertDelegationRule,
  upsertProfileSubject,
} from './db.js';
import { planSimpleReminder } from './local-reminder.js';
import { handleLifeThreadCommand } from './life-threads.js';
import { cacheInboundMediaBytes } from './media-cache.js';
import { ALL_SYNCED_MESSAGES_TARGET } from './thread-summary-routing.js';
import type {
  CommunicationThreadRecord,
  DelegationRuleRecord,
} from './types.js';

const originalFetch = globalThis.fetch;

vi.setConfig({ testTimeout: 15000 });

function seedRecentTextSafeSendRule(
  overrides: Partial<DelegationRuleRecord> = {},
): DelegationRuleRecord {
  const rule: DelegationRuleRecord = {
    ruleId: overrides.ruleId || 'rule-recent-text-safe-send',
    groupFolder: overrides.groupFolder || 'main',
    title: overrides.title || 'Recent text safe-send rule',
    triggerType: overrides.triggerType || 'communication_context',
    triggerScope: overrides.triggerScope || 'personal',
    conditionsJson:
      overrides.conditionsJson ||
      JSON.stringify({
        actionType: 'send_message',
        personName: 'Candace',
        communicationContext: 'reply_followthrough',
      }),
    delegatedActionsJson:
      overrides.delegatedActionsJson ||
      JSON.stringify([{ actionType: 'send_message' }]),
    approvalMode: overrides.approvalMode || 'auto_apply_when_safe',
    status: overrides.status || 'active',
    createdAt: overrides.createdAt || '2026-04-15T12:00:00.000Z',
    lastUsedAt: overrides.lastUsedAt ?? null,
    timesUsed: overrides.timesUsed ?? 1,
    timesAutoApplied: overrides.timesAutoApplied ?? 0,
    timesOverridden: overrides.timesOverridden ?? 0,
    lastOutcomeStatus: overrides.lastOutcomeStatus ?? null,
    userConfirmed: overrides.userConfirmed ?? true,
    channelApplicabilityJson:
      overrides.channelApplicabilityJson ||
      JSON.stringify(['telegram', 'bluebubbles']),
    safetyLevel: overrides.safetyLevel || 'safe_to_auto_after_delegation',
  };
  upsertDelegationRule(rule);
  return rule;
}

function seedCommunicationThread(
  overrides: Partial<CommunicationThreadRecord> = {},
): CommunicationThreadRecord {
  const now = overrides.updatedAt || '2026-04-15T16:00:00.000Z';
  const record: CommunicationThreadRecord = {
    id: overrides.id || 'comm-candace',
    groupFolder: overrides.groupFolder || 'main',
    title: overrides.title || 'Candace',
    linkedSubjectIds: overrides.linkedSubjectIds || [],
    linkedLifeThreadIds: overrides.linkedLifeThreadIds || [],
    channel: overrides.channel || 'bluebubbles',
    channelChatJid: overrides.channelChatJid || 'bb:iMessage;-;+14695550123',
    lastInboundSummary:
      overrides.lastInboundSummary ||
      'Candace asked whether dinner still works tonight.',
    lastOutboundSummary: overrides.lastOutboundSummary || null,
    followupState: overrides.followupState || 'reply_needed',
    urgency: overrides.urgency || 'soon',
    followupDueAt: overrides.followupDueAt || null,
    suggestedNextAction: overrides.suggestedNextAction || 'draft_reply',
    toneStyleHints: overrides.toneStyleHints || [],
    lastContactAt: overrides.lastContactAt || now,
    lastMessageId: overrides.lastMessageId || null,
    linkedTaskId: overrides.linkedTaskId || null,
    inferenceState: overrides.inferenceState || 'assistant_inferred',
    trackingMode: overrides.trackingMode || 'default',
    createdAt: overrides.createdAt || now,
    updatedAt: now,
    disabledAt: overrides.disabledAt || null,
  };
  upsertCommunicationThread(record);
  return record;
}

describe('assistant capabilities', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('discloses attempted and actual council participation without claiming council wording was rendered', () => {
    expect(
      formatMessagesSummaryCouncilDisclosure({
        councilAttempted: true,
        councilProviderUsed: true,
      }),
    ).toContain('configured council provider processed');
    expect(
      formatMessagesSummaryCouncilDisclosure({
        councilAttempted: true,
        councilProviderUsed: false,
      }),
    ).toContain('provider council was attempted');
    expect(
      formatMessagesSummaryCouncilDisclosure({
        councilAttempted: false,
        councilProviderUsed: false,
      }),
    ).toBeNull();
  });

  it('registers shared daily, research, work, and media capabilities with safety metadata', () => {
    const registry = getAssistantCapabilityRegistry();
    expect(registry.some((entry) => entry.id === 'daily.loose_ends')).toBe(
      true,
    );
    expect(
      registry.some((entry) => entry.id === 'pulse.interesting_thing'),
    ).toBe(true);
    expect(
      registry.some((entry) => entry.id === 'knowledge.summarize_saved'),
    ).toBe(true);
    expect(registry.some((entry) => entry.id === 'rituals.followthrough')).toBe(
      true,
    );
    expect(registry.some((entry) => entry.id === 'research.compare')).toBe(
      true,
    );
    expect(registry.some((entry) => entry.id === 'work.current_logs')).toBe(
      true,
    );
    expect(registry.some((entry) => entry.id === 'media.video_generate')).toBe(
      true,
    );
    expect(registry.some((entry) => entry.id === 'capture.add_item')).toBe(
      true,
    );
    expect(registry.some((entry) => entry.id === 'capture.read_items')).toBe(
      true,
    );
    expect(
      registry.some((entry) => entry.id === 'followthrough.reminder_overview'),
    ).toBe(true);

    expect(getAssistantCapability('work.current_logs')).toMatchObject({
      operatorOnly: true,
      safeForAlexa: false,
      safeForTelegram: true,
      safeForBlueBubbles: false,
    });
    expect(getAssistantCapability('capture.add_item')).toMatchObject({
      category: 'capture',
      safeForAlexa: true,
      safeForTelegram: true,
      safeForBlueBubbles: true,
    });
    expect(getAssistantCapability('pulse.surprise_me')).toMatchObject({
      category: 'pulse',
      safeForAlexa: true,
      safeForTelegram: true,
      safeForBlueBubbles: true,
    });
    expect(getAssistantCapability('knowledge.save_source')).toMatchObject({
      category: 'knowledge',
      safeForAlexa: true,
      safeForTelegram: true,
      safeForBlueBubbles: true,
    });
    expect(getAssistantCapability('rituals.configure')).toMatchObject({
      category: 'rituals',
      safeForAlexa: true,
      safeForTelegram: true,
      safeForBlueBubbles: true,
    });
    expect(
      getAssistantCapability('communication.understand_message'),
    ).toMatchObject({
      category: 'communication',
      safeForAlexa: true,
      safeForTelegram: true,
      safeForBlueBubbles: true,
    });
    expect(
      getAssistantCapability('communication.review_recent_texts'),
    ).toMatchObject({
      category: 'communication',
      safeForAlexa: false,
      safeForTelegram: true,
      safeForBlueBubbles: true,
    });
    expect(
      getAssistantCapability('communication.manage_identity_links'),
    ).toMatchObject({
      category: 'communication',
      requiresConfirmation: false,
      safeForAlexa: false,
      safeForTelegram: true,
      safeForBlueBubbles: true,
    });
    expect(getAssistantCapability('staff.prioritize')).toMatchObject({
      category: 'staff',
      safeForAlexa: true,
      safeForTelegram: true,
      safeForBlueBubbles: true,
    });
    expect(getAssistantCapability('missions.propose')).toMatchObject({
      category: 'missions',
      safeForAlexa: true,
      safeForTelegram: true,
      safeForBlueBubbles: true,
    });
    expect(
      getAssistantCapability('media.image_generate')?.availabilityNote,
    ).toContain('Telegram image generation is wired');
  });

  it('carries private identity-review controls through the Telegram capability result', async () => {
    upsertProfileSubject({
      id: 'person-candace',
      groupFolder: 'main',
      kind: 'person',
      canonicalName: 'candace',
      displayName: 'Candace',
      createdAt: '2026-07-12T03:00:00.000Z',
      updatedAt: '2026-07-12T03:00:00.000Z',
      disabledAt: null,
    });
    seedCommunicationThread({
      id: 'communication:opaque-owner-review',
      title: '+1 (469) 555-0199',
      channelChatJid: 'bb:iMessage;-;+14695550199',
    });

    const result = await executeAssistantCapability({
      capabilityId: 'communication.manage_identity_links',
      context: { channel: 'telegram', groupFolder: 'main' },
      input: { canonicalText: 'review communication identities' },
    });

    expect(result.handled).toBe(true);
    expect(result.sendOptions?.inlineActionRows?.flat()).toEqual([
      expect.objectContaining({ label: 'Link Candace' }),
      expect.objectContaining({ label: 'Keep without person link' }),
    ]);
    expect(JSON.stringify(result.sendOptions)).not.toContain('+1 (469)');
  });

  it('analyzes only media attached to the current turn', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_BASE_URL', 'https://example.test/v1');
    vi.stubEnv('OPENAI_MODEL_STANDARD', 'gpt-vision-test');
    const olderBytes = Buffer.from([1, 2, 3]);
    const currentBytes = Buffer.from([9, 8, 7, 6]);
    const older = cacheInboundMediaBytes({
      bytes: olderBytes,
      filename: 'older-photo.jpg',
      mimeType: 'image/jpeg',
    });
    const current = cacheInboundMediaBytes({
      bytes: currentBytes,
      filename: 'current-photo.jpg',
      mimeType: 'image/jpeg',
    });
    storeChatMetadata('tg:media-current', '2026-07-11T12:00:00.000Z');
    storeMessage({
      id: 'media-message-older',
      chat_jid: 'tg:media-current',
      sender: 'owner',
      sender_name: 'Owner',
      content: '[Photo] older',
      timestamp: '2026-07-11T11:59:00.000Z',
      is_from_me: false,
      attachments: [
        {
          attachmentId: 'media:older-turn',
          chatJid: 'tg:media-current',
          messageId: 'media-message-older',
          sourceChannel: 'telegram',
          kind: 'image',
          mimeType: 'image/jpeg',
          filename: 'older-photo.jpg',
          localPath: older.localPath,
          fetchStatus: 'cached',
          analysisStatus: 'not_requested',
        },
      ],
    });
    storeMessage({
      id: 'media-message-current',
      chat_jid: 'tg:media-current',
      sender: 'owner',
      sender_name: 'Owner',
      content: '[Photo] This is my meal plan',
      timestamp: '2026-07-11T12:00:00.000Z',
      is_from_me: false,
      attachments: [
        {
          attachmentId: 'media:current-turn',
          chatJid: 'tg:media-current',
          messageId: 'media-message-current',
          sourceChannel: 'telegram',
          kind: 'image',
          mimeType: 'image/jpeg',
          filename: 'current-photo.jpg',
          localPath: current.localPath,
          fetchStatus: 'cached',
          analysisStatus: 'not_requested',
        },
      ],
    });
    globalThis.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body || '{}')) as {
        input?: Array<{ content?: Array<Record<string, string>> }>;
      };
      const imageUrls = (body.input?.[0]?.content || [])
        .filter((item) => item.type === 'input_image')
        .map((item) => item.image_url || '');
      expect(imageUrls).toHaveLength(1);
      expect(imageUrls[0]).toContain(currentBytes.toString('base64'));
      expect(imageUrls[0]).not.toContain(olderBytes.toString('base64'));
      return new Response(JSON.stringify({ output_text: 'Meal plan read.' }), {
        status: 200,
      });
    }) as typeof fetch;

    const result = await executeAssistantCapability({
      capabilityId: 'media.analyze',
      context: {
        channel: 'telegram',
        chatJid: 'tg:media-current',
        currentMessageId: 'media-message-current',
        currentAttachmentIds: ['media:current-turn'],
      },
      input: { text: '[Photo] This is my meal plan' },
    });

    expect(result.handled).toBe(true);
    expect(result.replyText).toBe('Meal plan read.');
  });

  it('rejects an ungrounded synced-thread digest without creating side effects', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_MODEL_STANDARD', 'gpt-5.4');
    globalThis.fetch = vi.fn(async (_input, init) => {
      const payload = JSON.parse(String(init?.body)) as {
        model: string;
        input: string;
      };
      expect(payload.model).toBe('gpt-5.4');
      expect(payload.input).toContain('almost-full digest of the conversation');
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            lead: 'Pops of Punk spent most of today debating adaptation choices across a few shows.',
            digest:
              'The thread compared how faithfully Fallout, Invincible, and The Boys handle their source material. One person argued that Fallout works because it protects the world while still telling a continuation story, while another pushed back that adaptations should avoid just reusing the same material beat for beat.',
            bullets: [
              'The conversation bounced between Fallout, Invincible, and The Boys as examples of what works.',
              'A clear disagreement emerged over whether an adaptation should mirror the source closely or tell a looser continuation story.',
              'The latest turn landed on liking the Fallout story while still feeling less familiar with the wider world behind it.',
            ],
            suggestedReplies: [
              {
                label: 'warm',
                text: 'I like that framing. I think Fallout works best when it keeps the world intact without just replaying the same plot.',
              },
              {
                label: 'brief',
                text: 'Yeah, that is why Fallout works for me: same world, new story.',
              },
            ],
          }),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;
    storeChatMetadata(
      'bb:iMessage;-;pops-of-punk',
      '2026-04-15T11:00:00.000Z',
      'Pops of Punk',
      'bluebubbles',
      true,
    );
    storeMessage({
      id: 'msg-pops-1',
      chat_jid: 'bb:iMessage;-;pops-of-punk',
      sender: 'Alex',
      sender_name: 'Alex',
      content: 'Let us lock the set list and confirm load-in for Friday.',
      timestamp: '2026-04-14T18:30:00.000Z',
      is_from_me: false,
    });
    storeMessage({
      id: 'msg-pops-2',
      chat_jid: 'bb:iMessage;-;pops-of-punk',
      sender: 'Jeff',
      sender_name: 'Jeff',
      content: 'I can reply after dinner once I hear back from the venue.',
      timestamp: '2026-04-15T09:10:00.000Z',
      is_from_me: true,
    });

    const result = await executeAssistantCapability({
      capabilityId: 'communication.summarize_thread',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
        ownerReviewAllowed: true,
        now: new Date('2026-04-15T12:00:00-05:00'),
      },
      input: {
        canonicalText:
          'summarize my text messages in Pops of Punk from the last 2 days',
        targetChatName: 'Pops of Punk',
        threadTitle: 'Pops of Punk',
        timeWindowKind: 'last_days',
        timeWindowValue: 2,
      },
    });

    expect(result.handled).toBe(true);
    expect(result.capabilityId).toBe('communication.summarize_thread');
    expect(result.replyText).toContain('Pops of Punk');
    expect(result.replyText).toContain('lock the set list');
    expect(result.replyText).toContain('load-in for Friday');
    expect(result.replyText).toContain(
      'Pending proposal — Shared plan: lock the set list and confirm load-in for Friday. Deadline: not stated.',
    );
    expect(result.replyText).toContain('Synthesis: Visible output is local');
    expect(result.replyText).toContain(
      'An OpenAI draft was rejected by grounding checks',
    );
    expect(result.replyText).not.toContain('adaptation choices');
    expect(result.replyText).not.toContain('Fallout');
    expect(result.replyText).not.toContain('Suggested replies');
    expect(result.trace?.notes).toContain('digest_source:fallback');
    expect(result.trace?.responseSource).toBe('local_companion');
    expect(result.conversationSeed?.subjectData?.threadTitle).toBe(
      'Pops of Punk',
    );
    expect(
      listMessageActionsForGroup({
        groupFolder: 'main',
      }),
    ).toHaveLength(0);
    expect(listKnowledgeSourcesForGroup('main')).toHaveLength(0);
  });

  it.each([
    {
      label: 'registered Telegram owner chat',
      channel: 'telegram' as const,
      presentationChatJid: 'tg:named-summary-owner',
    },
    {
      label: 'configured Messages self-thread',
      channel: 'bluebubbles' as const,
      presentationChatJid: 'bb:iMessage;-;owner-self-summary',
    },
  ])(
    'keeps a named-summary draft bound to the exact external Messages target when presented in the $label',
    async ({ channel, presentationChatJid }) => {
      vi.stubEnv('OPENAI_API_KEY', ' ');
      vi.stubEnv(
        'BLUEBUBBLES_CANONICAL_SELF_THREAD_JID',
        'bb:iMessage;-;owner-self-summary',
      );
      vi.stubEnv(
        'BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS',
        'bb:iMessage;-;owner-self-summary',
      );
      const targetChatJid = 'bb:iMessage;-;opaque-named-summary-target';
      storeChatMetadata(
        targetChatJid,
        '2026-04-15T16:30:00.000Z',
        'Avery Exact',
        'bluebubbles',
        false,
      );
      storeMessage({
        id: `named-summary-inbound-${channel}`,
        chat_jid: targetChatJid,
        sender: 'Avery',
        sender_name: 'Avery Exact',
        content: 'Practice starts at seven tonight. Can you make it?',
        timestamp: '2026-04-15T16:30:00.000Z',
        is_from_me: false,
      });

      const summary = await executeAssistantCapability({
        capabilityId: 'communication.summarize_thread',
        context: {
          channel,
          groupFolder: 'main',
          chatJid: presentationChatJid,
          ownerReviewAllowed: true,
          now: new Date('2026-04-15T17:00:00.000Z'),
        },
        input: {
          canonicalText: 'summarize Avery Exact from today',
          targetChatName: 'Avery Exact',
          timeWindowKind: 'today',
        },
      });

      expect(
        summary.conversationSeed?.subjectData?.namedMessagesSummaryTargetJson,
      ).toBeTruthy();
      const primeMessagesChatHistory = vi.fn(async (chatJid: string) => {
        expect(chatJid).toBe(targetChatJid);
        return { chatJid, storedCount: 1, totalCount: 1 };
      });

      const draft = await executeAssistantCapability({
        capabilityId: 'communication.draft_reply',
        context: {
          channel,
          groupFolder: 'main',
          chatJid: presentationChatJid,
          primeMessagesChatHistory,
          priorSubjectData: summary.conversationSeed?.subjectData,
          now: new Date('2026-04-15T17:01:00.000Z'),
        },
        input: {
          text: 'Draft this reply: Yes, I can make practice at seven tonight.',
          canonicalText:
            'Draft this reply: Yes, I can make practice at seven tonight.',
        },
      });
      const target = JSON.parse(
        draft.messageAction?.targetConversationJson || '{}',
      );

      expect(draft.messageAction).toMatchObject({
        presentationChatJid,
        targetChannel: 'bluebubbles',
        targetKind: 'external_thread',
        sendStatus: 'drafted',
        requiresApproval: true,
        draftText: 'Yes, I can make practice at seven tonight.',
      });
      expect(target).toMatchObject({
        kind: 'external_thread',
        chatJid: targetChatJid,
        isGroup: false,
      });
      expect(target.chatJid).not.toBe(presentationChatJid);
      expect(primeMessagesChatHistory).toHaveBeenCalledTimes(2);
      expect(
        draft.conversationSeed?.subjectData?.namedMessagesSummaryTargetJson,
      ).toBeTruthy();
    },
  );

  it('drops a named-summary draft when the exact thread changes during the async draft window', async () => {
    vi.stubEnv('OPENAI_API_KEY', ' ');
    vi.stubEnv(
      'BLUEBUBBLES_CANONICAL_SELF_THREAD_JID',
      'bb:iMessage;-;owner-self-summary-window',
    );
    vi.stubEnv(
      'BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS',
      'bb:iMessage;-;owner-self-summary-window',
    );
    const targetChatJid = 'bb:iMessage;-;named-summary-window-target';
    storeChatMetadata(
      targetChatJid,
      '2026-04-15T16:30:00.000Z',
      'Avery Window',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'named-summary-window-before',
      chat_jid: targetChatJid,
      sender: 'Avery Window',
      sender_name: 'Avery Window',
      content: 'Can you still make dinner tonight?',
      timestamp: '2026-04-15T16:30:00.000Z',
      is_from_me: false,
    });
    const summary = await executeAssistantCapability({
      capabilityId: 'communication.summarize_thread',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:named-summary-window-owner',
        ownerReviewAllowed: true,
        now: new Date('2026-04-15T17:00:00.000Z'),
      },
      input: {
        canonicalText: 'summarize Avery Window from today',
        targetChatName: 'Avery Window',
        timeWindowKind: 'today',
      },
    });
    let refreshCount = 0;
    const primeMessagesChatHistory = vi.fn(async (chatJid: string) => {
      refreshCount += 1;
      expect(chatJid).toBe(targetChatJid);
      if (refreshCount === 2) {
        storeMessage({
          id: 'named-summary-window-never-mind',
          chat_jid: targetChatJid,
          sender: 'Avery Window',
          sender_name: 'Avery Window',
          content: 'Never mind, dinner is handled.',
          timestamp: '2026-04-15T17:01:30.000Z',
          is_from_me: false,
        });
      }
      return { chatJid, storedCount: 1, totalCount: 1 };
    });

    const result = await executeAssistantCapability({
      capabilityId: 'communication.draft_reply',
      context: {
        channel: 'bluebubbles',
        groupFolder: 'main',
        chatJid: 'bb:iMessage;-;owner-self-summary-window',
        primeMessagesChatHistory,
        priorSubjectData: summary.conversationSeed?.subjectData,
        now: new Date('2026-04-15T17:01:00.000Z'),
      },
      input: {
        text: 'Draft this reply: Yes, dinner still works.',
        canonicalText: 'Draft this reply: Yes, dinner still works.',
      },
    });

    expect(primeMessagesChatHistory).toHaveBeenCalledTimes(2);
    expect(result.replyText).toContain('could not be proven unchanged');
    expect(result.messageAction).toBeUndefined();
    expect(result.sendOptions).toBeUndefined();
    expect(result.followupActions).toEqual([]);
    expect(
      listMessageActionsForGroup({ groupFolder: 'main', includeSent: true }),
    ).toHaveLength(0);
  });

  it('fails closed when the exact named-summary target cannot be refreshed before drafting', async () => {
    vi.stubEnv('OPENAI_API_KEY', ' ');
    const targetChatJid = 'bb:iMessage;-;named-summary-refresh-failure';
    storeChatMetadata(
      targetChatJid,
      '2026-04-15T16:30:00.000Z',
      'Refresh Failure',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'named-summary-refresh-failure-inbound',
      chat_jid: targetChatJid,
      sender: 'Refresh Failure',
      sender_name: 'Refresh Failure',
      content: 'Can you confirm the plan tonight?',
      timestamp: '2026-04-15T16:30:00.000Z',
      is_from_me: false,
    });
    const summary = await executeAssistantCapability({
      capabilityId: 'communication.summarize_thread',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:named-summary-owner',
        ownerReviewAllowed: true,
        now: new Date('2026-04-15T17:00:00.000Z'),
      },
      input: {
        canonicalText: 'summarize Refresh Failure from today',
        targetChatName: 'Refresh Failure',
        timeWindowKind: 'today',
      },
    });
    const primeMessagesChatHistory = vi.fn(async (chatJid: string) => {
      expect(chatJid).toBe(targetChatJid);
      throw new Error('offline targeted refresh fixture failed');
    });

    const result = await executeAssistantCapability({
      capabilityId: 'communication.draft_reply',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:named-summary-owner',
        primeMessagesChatHistory,
        priorSubjectData: summary.conversationSeed?.subjectData,
        now: new Date('2026-04-15T17:01:00.000Z'),
      },
      input: {
        text: 'Draft this reply: Yes, the plan works.',
        canonicalText: 'Draft this reply: Yes, the plan works.',
      },
    });

    expect(primeMessagesChatHistory).toHaveBeenCalledTimes(1);
    expect(result.replyText).toContain('could not refresh the exact Messages');
    expect(result.replyText).toContain('did not create a draft');
    expect(result.messageAction).toBeUndefined();
    expect(result.sendOptions).toBeUndefined();
    expect(result.followupActions).toEqual([]);
    expect(result.trace?.notes).toContain('target_refresh:failed');
    expect(
      listMessageActionsForGroup({ groupFolder: 'main', includeSent: true }),
    ).toHaveLength(0);
  });

  it('keeps a named Messages group continuation draft-only with no send controls', async () => {
    vi.stubEnv('OPENAI_API_KEY', ' ');
    const groupChatJid = 'bb:iMessage;+;named-summary-group';
    storeChatMetadata(
      groupChatJid,
      '2026-04-15T16:30:00.000Z',
      'Band Logistics',
      'bluebubbles',
      true,
    );
    storeMessage({
      id: 'named-summary-group-inbound',
      chat_jid: groupChatJid,
      sender: 'Bandmate',
      sender_name: 'Bandmate',
      content: 'Load-in moved to seven tonight. Does that work?',
      timestamp: '2026-04-15T16:30:00.000Z',
      is_from_me: false,
    });
    const summary = await executeAssistantCapability({
      capabilityId: 'communication.summarize_thread',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:named-summary-owner',
        ownerReviewAllowed: true,
        now: new Date('2026-04-15T17:00:00.000Z'),
      },
      input: {
        canonicalText: 'summarize Band Logistics from today',
        targetChatName: 'Band Logistics',
        timeWindowKind: 'today',
      },
    });
    const primeMessagesChatHistory = vi.fn(async (chatJid: string) => {
      expect(chatJid).toBe(groupChatJid);
      return { chatJid, storedCount: 1, totalCount: 1 };
    });

    const result = await executeAssistantCapability({
      capabilityId: 'communication.draft_reply',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:named-summary-owner',
        primeMessagesChatHistory,
        priorSubjectData: summary.conversationSeed?.subjectData,
        now: new Date('2026-04-15T17:01:00.000Z'),
      },
      input: {
        text: 'Draft this reply: Seven works for me.',
        canonicalText: 'Draft this reply: Seven works for me.',
      },
    });

    expect(primeMessagesChatHistory).toHaveBeenCalledTimes(2);
    expect(result.replyText).toContain('Draft:');
    expect(result.replyText).toContain('Seven works for me.');
    expect(result.replyText).toContain('Group draft only');
    expect(result.replyText).toContain('unsent and not sendable');
    expect(result.messageAction).toBeUndefined();
    expect(result.sendOptions).toBeUndefined();
    expect(
      listMessageActionsForGroup({ groupFolder: 'main', includeSent: true }),
    ).toHaveLength(0);
  });

  it('fails closed without send controls when a named-summary target seed is missing', async () => {
    const result = await executeAssistantCapability({
      capabilityId: 'communication.draft_reply',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:named-summary-owner',
        priorSubjectData: {
          activeCapabilityId: 'communication.summarize_thread',
          threadTitle: 'Avery Exact',
        },
      },
      input: {
        text: 'Draft this reply: I can make it.',
        canonicalText: 'Draft this reply: I can make it.',
      },
    });

    expect(result.replyText).toContain('no longer bind that summary');
    expect(result.replyText).toContain('did not create a draft');
    expect(result.messageAction).toBeUndefined();
    expect(result.sendOptions).toBeUndefined();
    expect(result.followupActions).toEqual([]);
    expect(result.trace?.notes).toContain('target_validation:missing_seed');
    expect(
      listMessageActionsForGroup({ groupFolder: 'main', includeSent: true }),
    ).toHaveLength(0);
  });

  it('fails closed when a named-summary seed points to a Messages chat that is no longer current', async () => {
    const result = await executeAssistantCapability({
      capabilityId: 'communication.draft_reply',
      context: {
        channel: 'bluebubbles',
        groupFolder: 'main',
        chatJid: 'bb:iMessage;-;owner-self-summary',
        priorSubjectData: {
          activeCapabilityId: 'communication.summarize_thread',
          namedMessagesSummaryTargetJson: JSON.stringify({
            version: 2,
            query: 'No Longer Synced',
            target: {
              chatJid: 'bb:iMessage;-;missing-named-summary-target',
              displayName: 'No Longer Synced',
              isGroup: false,
            },
            historyStartTimestamp: '2026-04-15T05:00:00.000Z',
            freshnessSnapshot: {
              latestMessageIdentityHash: 'a'.repeat(16),
              latestMessageAt: '2026-04-15T16:00:00.000Z',
              latestInboundAt: '2026-04-15T16:00:00.000Z',
              latestOutboundAt: null,
              messageCount: 1,
              snapshotHash: 'b'.repeat(16),
              transcriptHash: 'c'.repeat(16),
            },
          }),
        },
      },
      input: {
        text: 'Draft this reply: I can make it.',
        canonicalText: 'Draft this reply: I can make it.',
      },
    });

    expect(result.replyText).toContain('no longer bind that summary');
    expect(result.messageAction).toBeUndefined();
    expect(result.sendOptions).toBeUndefined();
    expect(result.followupActions).toEqual([]);
    expect(result.trace?.notes).toContain('target_validation:missing');
    expect(
      listMessageActionsForGroup({ groupFolder: 'main', includeSent: true }),
    ).toHaveLength(0);
  });

  it('fails closed without send controls when a named-summary target becomes ambiguous', async () => {
    vi.stubEnv('OPENAI_API_KEY', ' ');
    const originalTarget = 'bb:iMessage;-;named-summary-taylor-one';
    storeChatMetadata(
      originalTarget,
      '2026-04-15T16:30:00.000Z',
      'Taylor Project',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'named-summary-taylor-inbound',
      chat_jid: originalTarget,
      sender: 'Taylor',
      sender_name: 'Taylor',
      content: 'The project outline is ready for review.',
      timestamp: '2026-04-15T16:30:00.000Z',
      is_from_me: false,
    });
    const summary = await executeAssistantCapability({
      capabilityId: 'communication.summarize_thread',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:named-summary-owner',
        ownerReviewAllowed: true,
        now: new Date('2026-04-15T17:00:00.000Z'),
      },
      input: {
        canonicalText: 'summarize Taylor Project from today',
        targetChatName: 'Taylor Project',
        timeWindowKind: 'today',
      },
    });
    storeChatMetadata(
      'bb:iMessage;-;named-summary-taylor-two',
      '2026-04-15T17:00:30.000Z',
      'Taylor Project',
      'bluebubbles',
      false,
    );

    const result = await executeAssistantCapability({
      capabilityId: 'communication.draft_reply',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:named-summary-owner',
        priorSubjectData: summary.conversationSeed?.subjectData,
        now: new Date('2026-04-15T17:01:00.000Z'),
      },
      input: {
        text: 'Draft this reply: Thanks, I will review it.',
        canonicalText: 'Draft this reply: Thanks, I will review it.',
      },
    });

    expect(result.replyText).toContain('matches more than one current chat');
    expect(result.replyText).toContain('did not create a draft');
    expect(result.messageAction).toBeUndefined();
    expect(result.sendOptions).toBeUndefined();
    expect(result.followupActions).toEqual([]);
    expect(result.trace?.notes).toContain('target_validation:ambiguous');
    expect(
      listMessageActionsForGroup({ groupFolder: 'main', includeSent: true }),
    ).toHaveLength(0);
  });

  it('falls back to a clean local digest for today without surfacing raw identifiers', async () => {
    vi.stubEnv('OPENAI_API_KEY', ' ');
    storeChatMetadata(
      'bb:iMessage;+;chat-pops-clean',
      '2026-04-15T18:51:51.947Z',
      'Pops of Punk',
      'bluebubbles',
      true,
    );
    storeMessage({
      id: 'msg-pops-old',
      chat_jid: 'bb:iMessage;+;chat-pops-clean',
      sender: 'bb:+12025550102',
      sender_name: '+12025550102',
      content:
        'Yesterday everyone was still just figuring out whether to read the comics first.',
      timestamp: '2026-04-14T23:10:00.000Z',
      is_from_me: false,
    });
    storeMessage({
      id: 'msg-pops-today-1',
      chat_jid: 'bb:iMessage;+;chat-pops-clean',
      sender: 'bb:+12025550102',
      sender_name: '+12025550102',
      content:
        'I think Fallout works because it keeps the world right while still telling a continuation story.',
      timestamp: '2026-04-15T16:46:28.314Z',
      is_from_me: false,
    });
    storeMessage({
      id: 'msg-pops-today-2',
      chat_jid: 'bb:iMessage;+;chat-pops-clean',
      sender: 'bb:+12025550103',
      sender_name: '+12025550103',
      content:
        'I do not want an adaptation to just repeat the exact same material with a different format.',
      timestamp: '2026-04-15T16:48:09.713Z',
      is_from_me: false,
    });
    storeMessage({
      id: 'msg-pops-today-3',
      chat_jid: 'bb:iMessage;+;chat-pops-clean',
      sender: 'bb:+12025550103',
      sender_name: '+12025550103',
      content:
        'Yeah I like the Fallout story but I do not know too much about the world yet.',
      timestamp: '2026-04-15T18:51:51.947Z',
      is_from_me: false,
    });
    const result = await executeAssistantCapability({
      capabilityId: 'communication.summarize_thread',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
        ownerReviewAllowed: true,
        now: new Date('2026-04-15T19:00:00-05:00'),
      },
      input: {
        canonicalText: 'summarize my text messages in Pops of Punk from today',
        targetChatName: 'Pops of Punk',
        threadTitle: 'Pops of Punk',
        timeWindowKind: 'today',
      },
    });

    expect(result.handled).toBe(true);
    expect(result.replyText).toContain(
      'Here’s the gist from Pops of Punk today.',
    );
    expect(result.replyText).toContain('Suggested replies');
    expect(result.replyText).toContain('Thanks for the update.');
    expect(result.replyText).not.toContain('+12025550102');
    expect(result.replyText).not.toContain('+12025550103');
    expect(result.replyText).not.toContain(
      'Yesterday everyone was still just figuring out',
    );
  });

  it('withholds named-thread reply options for an unanswered request without a question mark', async () => {
    vi.stubEnv('OPENAI_API_KEY', ' ');
    storeChatMetadata(
      'bb:iMessage;-;dinner-request',
      '2026-04-15T18:51:51.947Z',
      'Dinner Plans',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'dinner-request-1',
      chat_jid: 'bb:iMessage;-;dinner-request',
      sender: 'Candace',
      sender_name: 'Candace',
      content: 'Please bring ice tonight.',
      timestamp: '2026-04-15T18:51:51.947Z',
      is_from_me: false,
    });

    const result = await executeAssistantCapability({
      capabilityId: 'communication.summarize_thread',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
        ownerReviewAllowed: true,
        now: new Date('2026-04-15T19:00:00-05:00'),
      },
      input: {
        canonicalText: 'summarize Dinner Plans from today',
        targetChatName: 'Dinner Plans',
        threadTitle: 'Dinner Plans',
        timeWindowKind: 'today',
      },
    });

    expect(result.handled).toBe(true);
    expect(result.replyText).toContain('Please bring ice tonight.');
    expect(result.replyText).not.toContain('Suggested replies');
    expect(result.replyText).not.toContain('I saw your question');
    expect(result.replyText).not.toContain('Got your question');
  });

  it('redacts raw identifiers from named summaries and labels every suggestion as unsent', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_BASE_URL', 'https://openai.test/v1');
    let providerBody = '';
    const fetchSpy = vi.fn(async (_input, init) => {
      providerBody = String(init?.body || '');
      return new Response('provider unavailable', { status: 503 });
    });
    globalThis.fetch = fetchSpy as typeof fetch;
    storeChatMetadata(
      'bb:SMS;-;12345',
      '2026-04-15T18:51:51.947Z',
      '12345',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'named-summary-verification-code',
      chat_jid: 'bb:SMS;-;12345',
      sender: 'SMS;-;12345',
      sender_name: 'iMessage;-;opaque-handle',
      content: 'Your verification code is 765432. Do not share it.',
      timestamp: '2026-04-15T18:50:00.000Z',
      is_from_me: false,
    });
    storeMessage({
      id: 'named-summary-private-identifiers',
      chat_jid: 'bb:SMS;-;12345',
      sender: 'SMS;-;12345',
      sender_name: 'iMessage;-;opaque-handle',
      content:
        'Email private.person@example.com or call +1 469 555 0123 about pickup.',
      timestamp: '2026-04-15T18:51:51.947Z',
      is_from_me: false,
    });

    const result = await executeAssistantCapability({
      capabilityId: 'communication.summarize_thread',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
        ownerReviewAllowed: true,
        now: new Date('2026-04-15T19:00:00-05:00'),
      },
      input: {
        canonicalText: 'summarize 12345 from today',
        targetChatName: '12345',
        threadTitle: '12345',
        timeWindowKind: 'today',
      },
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(providerBody).not.toContain('private.person@example.com');
    expect(providerBody).not.toContain('+1 469 555 0123');
    expect(providerBody).not.toContain('iMessage;-;opaque-handle');
    expect(providerBody).not.toContain('SMS;-;12345');
    expect(providerBody).not.toContain('765432');
    expect(providerBody).toContain('[redacted email]');
    expect(providerBody).toContain('[redacted code]');
    expect(result.replyText).toContain('Messages chat');
    expect(result.replyText).toContain(
      'Suggested replies (unsent; review before using)',
    );
    expect(result.replyText).toContain('not device unread/read status');
    expect(result.replyText).toContain('any suggested reply is unsent');
    expect(result.replyText).toContain(
      'OpenAI synthesis was attempted on the bounded transcript but did not return usable output',
    );
    expect(result.replyText).toContain('Visible output is local');
    expect(result.replyText).not.toContain('No OpenAI synthesis was used');
    expect(result.replyText).not.toContain('private.person@example.com');
    expect(result.replyText).not.toContain('+1 469 555 0123');
    expect(result.replyText).not.toContain('iMessage;-;opaque-handle');
    expect(result.replyText).not.toContain('SMS;-;12345');
    expect(result.replyText).not.toContain('765432');
    expect(
      listMessageActionsForGroup({ groupFolder: 'main', includeSent: true }),
    ).toHaveLength(0);
  });

  it('includes timestamps in chronological order in named and broad model transcripts', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_BASE_URL', 'https://openai.test/v1');
    const providerInputs: string[] = [];
    globalThis.fetch = vi.fn(async (_input, init) => {
      const payload = JSON.parse(String(init?.body || '{}')) as {
        input?: string;
      };
      providerInputs.push(String(payload.input || ''));
      return new Response('provider unavailable', { status: 503 });
    }) as typeof fetch;
    const chatJid = 'bb:iMessage;-;timestamp-order-fixture';
    storeChatMetadata(
      chatJid,
      '2026-04-15T16:10:00.000Z',
      'Timestamp Order',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'timestamp-order-first',
      chat_jid: chatJid,
      sender: 'other',
      sender_name: 'Other person',
      content: 'First chronological turn.',
      timestamp: '2026-04-15T16:00:00.000Z',
      is_from_me: false,
    });
    storeMessage({
      id: 'timestamp-order-second',
      chat_jid: chatJid,
      sender: 'me',
      sender_name: 'Jeff',
      content: 'Second chronological turn.',
      timestamp: '2026-04-15T16:10:00.000Z',
      is_from_me: true,
    });

    const named = await executeAssistantCapability({
      capabilityId: 'communication.summarize_thread',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
        ownerReviewAllowed: true,
        now: new Date('2026-04-15T19:00:00-05:00'),
      },
      input: {
        canonicalText: 'summarize Timestamp Order from today',
        targetChatName: 'Timestamp Order',
        timeWindowKind: 'today',
      },
    });
    const broad = await executeAssistantCapability({
      capabilityId: 'communication.summarize_thread',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
        ownerReviewAllowed: true,
        now: new Date('2026-04-15T19:00:00-05:00'),
      },
      input: {
        canonicalText: 'summarize all synced text messages from today',
        targetChatJid: ALL_SYNCED_MESSAGES_TARGET,
        timeWindowKind: 'today',
      },
    });

    expect(providerInputs).toHaveLength(2);
    for (const result of [named, broad]) {
      expect(result.replyText).toContain('Visible output is local');
      expect(result.replyText).toContain('OpenAI synthesis was attempted');
      expect(result.replyText).not.toContain('No OpenAI synthesis was used');
    }
    for (const providerInput of providerInputs) {
      const firstTimestamp = providerInput.indexOf(
        '[2026 Apr 15 16:00:00 UTC]',
      );
      const secondTimestamp = providerInput.indexOf(
        '[2026 Apr 15 16:10:00 UTC]',
      );
      expect(firstTimestamp).toBeGreaterThanOrEqual(0);
      expect(secondTimestamp).toBeGreaterThan(firstTimestamp);
      expect(providerInput).toContain('First chronological turn.');
      expect(providerInput).toContain('Second chronological turn.');
      expect(providerInput).not.toContain('[redacted number] UTC');
    }
  });

  it('summarizes an automated past-due notice without inventing a conversational reply', async () => {
    vi.stubEnv('OPENAI_API_KEY', ' ');
    storeChatMetadata(
      'bb:SMS;-;city-water',
      '2026-04-15T18:51:51.947Z',
      'City Water',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'named-summary-past-due-notice',
      chat_jid: 'bb:SMS;-;city-water',
      sender: 'SMS;-;city-water',
      sender_name: 'City Water',
      content:
        'CITY WATER: Your bill is past due. Pay online now at https://billing.example.com/water.',
      timestamp: '2026-04-15T18:51:51.947Z',
      is_from_me: false,
    });

    const result = await executeAssistantCapability({
      capabilityId: 'communication.summarize_thread',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
        ownerReviewAllowed: true,
        now: new Date('2026-04-15T19:00:00-05:00'),
      },
      input: {
        canonicalText: 'summarize City Water from today',
        targetChatName: 'City Water',
        threadTitle: 'City Water',
        timeWindowKind: 'today',
      },
    });

    expect(result.replyText).toContain('bill is past due');
    expect(result.replyText).not.toContain('Suggested replies');
    expect(result.replyText).not.toContain('Thanks for the update.');
    expect(
      listMessageActionsForGroup({ groupFolder: 'main', includeSent: true }),
    ).toHaveLength(0);
  });

  it('shows attachment presence in named and broad Messages summaries without inventing file contents', async () => {
    vi.stubEnv('OPENAI_API_KEY', ' ');
    const chatJid = 'bb:iMessage;-;media-digest-fixture';
    storeChatMetadata(
      chatJid,
      '2026-04-15T18:51:51.947Z',
      'Media Digest',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'media-digest-attachment-only',
      chat_jid: chatJid,
      sender: 'media-contact',
      sender_name: 'Media contact',
      content: '',
      timestamp: '2026-04-15T18:51:51.947Z',
      is_from_me: false,
      attachments: [
        {
          attachmentId: 'media:digest-audio',
          chatJid,
          messageId: 'media-digest-attachment-only',
          sourceChannel: 'bluebubbles',
          kind: 'audio',
          fetchStatus: 'download_failed',
        },
        {
          attachmentId: 'media:digest-file',
          chatJid,
          messageId: 'media-digest-attachment-only',
          sourceChannel: 'bluebubbles',
          kind: 'file',
          fetchStatus: 'metadata_only',
        },
      ],
    });

    const named = await executeAssistantCapability({
      capabilityId: 'communication.summarize_thread',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
        ownerReviewAllowed: true,
        now: new Date('2026-04-15T19:00:00-05:00'),
      },
      input: {
        canonicalText: 'summarize Media Digest from today',
        targetChatName: 'Media Digest',
        timeWindowKind: 'today',
      },
    });
    const broad = await executeAssistantCapability({
      capabilityId: 'communication.summarize_thread',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
        ownerReviewAllowed: true,
        now: new Date('2026-04-15T19:00:00-05:00'),
      },
      input: {
        canonicalText: 'summarize all synced text messages from today',
        targetChatJid: ALL_SYNCED_MESSAGES_TARGET,
        timeWindowKind: 'today',
      },
    });

    for (const result of [named, broad]) {
      expect(result.replyText).toContain(
        '[Attached: audio clip, file; contents not included in this text summary]',
      );
      expect(result.replyText).not.toMatch(/transcript|heard in the audio/i);
    }
  });

  it('semantically summarizes all synced Messages for broad today requests', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_MODEL_STANDARD', 'gpt-5.4');
    globalThis.fetch = vi.fn(async (_input, init) => {
      const payload = JSON.parse(String(init?.body || '{}')) as {
        input?: string;
      };
      expect(payload.input).toContain('Can you send me the dinner address?');
      expect(payload.input).toContain("Fallout's worldbuilding");
      expect(payload.input).not.toContain('654321');
      expect(payload.input).toContain('[redacted code]');
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            lead: 'Dinner logistics and Fallout worldbuilding were the main themes.',
            digest:
              "The direct chat asked for the dinner address, while Pops of Punk agreed to use Fallout's worldbuilding as Friday's discussion topic.",
            bullets: [
              'The dinner-address request is the clearest unanswered item.',
              'Pops of Punk agreed on a Fallout worldbuilding topic for Friday.',
            ],
            suggestedReplies: [],
          }),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;
    storeChatMetadata(
      'bb:iMessage;-;+14695550123',
      '2026-04-15T16:50:00.000Z',
      '+14695550123',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'msg-all-today-1',
      chat_jid: 'bb:iMessage;-;+14695550123',
      sender: 'bb:+14695550123',
      sender_name: '+14695550123',
      content: 'Can you send me the dinner address?',
      timestamp: '2026-04-15T16:46:28.314Z',
      is_from_me: false,
    });
    storeChatMetadata(
      'bb:iMessage;+;chat-pops-clean',
      '2026-04-15T18:51:51.947Z',
      'Pops of Punk',
      'bluebubbles',
      true,
    );
    storeMessage({
      id: 'msg-all-today-2',
      chat_jid: 'bb:iMessage;+;chat-pops-clean',
      sender: 'bb:+12025550103',
      sender_name: '+12025550103',
      content:
        "We agreed to use Fallout's worldbuilding as Friday's discussion topic.",
      timestamp: '2026-04-15T18:51:51.947Z',
      is_from_me: false,
    });
    storeChatMetadata(
      'bb:SMS;-;security-code-fixture',
      '2026-04-15T18:55:00.000Z',
      'Account notice',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'msg-all-today-security-code',
      chat_jid: 'bb:SMS;-;security-code-fixture',
      sender: 'account-notice',
      sender_name: 'Account notice',
      content: 'Your one-time security code is 654321. Do not share it.',
      timestamp: '2026-04-15T18:55:00.000Z',
      is_from_me: false,
    });

    const result = await executeAssistantCapability({
      capabilityId: 'communication.summarize_thread',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
        ownerReviewAllowed: true,
        now: new Date('2026-04-15T19:00:00-05:00'),
      },
      input: {
        canonicalText: 'summarize all synced text messages from today',
        targetChatJid: ALL_SYNCED_MESSAGES_TARGET,
        timeWindowKind: 'today',
      },
    });

    expect(result.handled).toBe(true);
    expect(result.replyText).toContain('Messages digest — today');
    expect(result.replyText).toContain('Themes');
    expect(result.replyText).toContain(
      'Dinner logistics and Fallout worldbuilding',
    );
    expect(result.replyText).toContain('Commitments and decisions');
    expect(result.replyText).toContain(
      "Decided — Shared plan: use Fallout's worldbuilding as Friday's discussion topic. Deadline: not stated.",
    );
    expect(result.replyText).toContain(
      'Synthesis: OpenAI generated the Themes wording',
    );
    expect(result.replyText).toContain('Open questions');
    expect(result.replyText).toContain('Can you send me the dinner address?');
    expect(result.replyText).toContain('Reply priorities');
    expect(result.replyText).toContain('Pops of Punk');
    expect(result.replyText).toContain('Messages chat');
    expect(result.replyText).not.toContain('+14695550123');
    expect(result.replyText).toContain(
      'Available local synced snapshot only; sync completeness was not independently verified.',
    );
    expect(result.replyText).toContain(
      'Model-generated Themes used at most 8 conversations and their newest 16 messages.',
    );
    expect(result.replyText).toContain('not device unread/read status');
    expect(result.trace?.notes).toContain('window:today');
    expect(result.trace?.notes).toContain('digest_source:openai_grounded');
  });

  it('describes an empty broad digest as a bounded local snapshot', async () => {
    vi.stubEnv('OPENAI_API_KEY', ' ');

    const result = await executeAssistantCapability({
      capabilityId: 'communication.summarize_thread',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
        ownerReviewAllowed: true,
        now: new Date('2026-04-15T19:00:00-05:00'),
      },
      input: {
        canonicalText: 'summarize all synced text messages from today',
        targetChatJid: ALL_SYNCED_MESSAGES_TARGET,
        timeWindowKind: 'today',
      },
    });

    expect(result.replyText).toContain(
      'In the available local Messages snapshot, I did not find activity',
    );
    expect(result.replyText).toContain(
      'Sync completeness was not independently verified',
    );
    expect(result.replyText).toContain('Synthesis: Local-only');
    expect(result.replyText).toContain('newest 80 in-window messages');
    expect(result.replyText).toContain('not device unread/read status');
  });

  it('redacts email and raw BlueBubbles identifiers used as chat names', async () => {
    vi.stubEnv('OPENAI_API_KEY', ' ');
    storeChatMetadata(
      'bb:iMessage;-;email-label-fixture',
      '2026-04-15T16:20:00.000Z',
      'private.person@example.com',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'private-email-label-message',
      chat_jid: 'bb:iMessage;-;email-label-fixture',
      sender: 'private-person',
      sender_name: 'Private person',
      content: 'Dinner is at seven.',
      timestamp: '2026-04-15T16:20:00.000Z',
      is_from_me: false,
    });
    storeChatMetadata(
      'bb:iMessage;-;raw-jid-label-fixture',
      '2026-04-15T16:25:00.000Z',
      'iMessage;-;opaque-handle',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'private-raw-jid-label-message',
      chat_jid: 'bb:iMessage;-;raw-jid-label-fixture',
      sender: 'private-person-2',
      sender_name: 'Private person 2',
      content: 'Can you bring ice?',
      timestamp: '2026-04-15T16:25:00.000Z',
      is_from_me: false,
    });

    const result = await executeAssistantCapability({
      capabilityId: 'communication.summarize_thread',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
        ownerReviewAllowed: true,
        now: new Date('2026-04-15T19:00:00-05:00'),
      },
      input: {
        canonicalText: 'summarize all synced text messages from today',
        targetChatJid: ALL_SYNCED_MESSAGES_TARGET,
        timeWindowKind: 'today',
      },
    });

    expect(result.replyText).toContain('Messages chat');
    expect(result.replyText).not.toContain('private.person@example.com');
    expect(result.replyText).not.toContain('iMessage;-;opaque-handle');
    expect(result.replyText).not.toContain(
      'bb:iMessage;-;raw-jid-label-fixture',
    );
  });

  it('summarizes all synced BlueBubbles texts for the exact 48-hour phrasing', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_MODEL_STANDARD', 'gpt-5.4');
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            output_text: JSON.stringify({
              lead: 'A dinner-address request is the main theme.',
              digest:
                'The other person asked you to send the dinner address, and that request remains unanswered.',
              bullets: ['Reply with the dinner address when you have it.'],
              suggestedReplies: [],
            }),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    ) as typeof fetch;
    storeChatMetadata(
      'bb:iMessage;-;+14695550123',
      '2026-04-15T16:50:00.000Z',
      '+14695550123',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'msg-all-48h-1',
      chat_jid: 'bb:iMessage;-;+14695550123',
      sender: 'bb:+14695550123',
      sender_name: '+14695550123',
      content: 'Can you send me the dinner address?',
      timestamp: '2026-04-15T16:46:28.314Z',
      is_from_me: false,
    });

    const result = await executeAssistantCapability({
      capabilityId: 'communication.summarize_thread',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
        ownerReviewAllowed: true,
        now: new Date('2026-04-15T19:00:00-05:00'),
      },
      input: {
        text: 'Ok Andrea can you use blue bubbles and provide a summary of my texts for the past 48 hours',
        canonicalText:
          'summarize all synced text messages from the last 48 hours',
        targetChatJid: ALL_SYNCED_MESSAGES_TARGET,
        targetChatName: 'all synced Messages',
        timeWindowKind: 'last_hours',
        timeWindowValue: 48,
      },
    });

    expect(result.handled).toBe(true);
    expect(result.replyText).toContain('Messages digest — the last 48 hours');
    expect(result.replyText).toContain('A dinner-address request');
    expect(result.replyText).toContain('Can you send me the dinner address?');
    expect(result.replyText).toContain('Reply priorities');
    expect(result.replyText).not.toContain("couldn't match");
    expect(result.replyText).not.toContain('Agent OS episode');
    expect(result.replyText).not.toContain('+14695550123');
    expect(result.trace?.notes).toContain('window:the last 48 hours');
    expect(result.trace?.notes).toContain('digest_source:openai_grounded');
  });

  it('keeps configured self-thread controls out of all-synced summaries without dropping passive contact @Andrea text', async () => {
    vi.stubEnv('OPENAI_API_KEY', ' ');
    vi.stubEnv(
      'BLUEBUBBLES_CANONICAL_SELF_THREAD_JID',
      'iMessage;-;owner@example.invalid',
    );
    vi.stubEnv(
      'BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS',
      'iMessage;-;owner@example.invalid,iMessage;-;+15550009999',
    );
    const selfThreadAliasJid = 'bb:iMessage;-;+15550009999';
    const contactJid = 'bb:iMessage;-;+15550001111';

    storeChatMetadata(
      selfThreadAliasJid,
      '2026-04-15T16:40:00.000Z',
      'Owner Messages self-thread',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'all-synced-self-control',
      chat_jid: selfThreadAliasJid,
      sender: 'owner',
      sender_name: 'Owner',
      content: 'summarize all my recent texts',
      timestamp: '2026-04-15T16:40:00.000Z',
      is_from_me: true,
    });
    storeChatMetadata(
      contactJid,
      '2026-04-15T16:45:00.000Z',
      'Andrea G',
      'bluebubbles',
      false,
    );
    storeMessageDirect({
      id: 'all-synced-passive-contact',
      chat_jid: contactJid,
      sender: 'bb:+15550001111',
      sender_name: 'Andrea G',
      content: '@Andrea can you bring the salad tonight?',
      timestamp: '2026-04-15T16:45:00.000Z',
      is_from_me: false,
      message_ingress_origin: 'passive_contact_sync',
    });

    const result = await executeAssistantCapability({
      capabilityId: 'communication.summarize_thread',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
        ownerReviewAllowed: true,
        now: new Date('2026-04-15T17:00:00-05:00'),
      },
      input: {
        canonicalText: 'summarize all synced text messages from today',
        targetChatJid: ALL_SYNCED_MESSAGES_TARGET,
        timeWindowKind: 'today',
      },
    });

    expect(result.replyText).toContain(
      '@Andrea can you bring the salad tonight?',
    );
    expect(result.replyText).not.toContain('summarize all my recent texts');
    expect(result.trace?.notes).toEqual(
      expect.arrayContaining(['threads:1', 'messages:1']),
    );
  });

  it('rejects an unrelated provider digest and falls back to grounded message evidence', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_MODEL_STANDARD', 'gpt-5.4');
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            output_text: JSON.stringify({
              lead: 'The family finalized a beach trip to Miami.',
              digest:
                'Flights and a waterfront hotel were booked for August, and everyone agreed to rent a car.',
              bullets: [
                'The Miami flights are nonrefundable.',
                'A rental car still needs an additional driver.',
              ],
              suggestedReplies: [],
            }),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    globalThis.fetch = fetchSpy as typeof fetch;
    storeChatMetadata(
      'bb:iMessage;-;+14695550123',
      '2026-04-15T16:50:00.000Z',
      'Candace',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'msg-untrusted-provider-1',
      chat_jid: 'bb:iMessage;-;+14695550123',
      sender: 'bb:+14695550123',
      sender_name: 'Candace',
      content: 'Can you confirm the dinner address for tonight?',
      timestamp: '2026-04-15T16:46:28.314Z',
      is_from_me: false,
    });

    const result = await executeAssistantCapability({
      capabilityId: 'communication.summarize_thread',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
        ownerReviewAllowed: true,
        now: new Date('2026-04-15T19:00:00-05:00'),
      },
      input: {
        canonicalText: 'summarize all synced text messages from today',
        targetChatJid: ALL_SYNCED_MESSAGES_TARGET,
        timeWindowKind: 'today',
      },
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.replyText).toContain(
      'Can you confirm the dinner address for tonight?',
    );
    expect(result.replyText).toContain('Open questions');
    expect(result.replyText).not.toContain('Miami');
    expect(result.replyText).not.toContain('waterfront hotel');
    expect(result.replyText).not.toContain('rental car');
    expect(result.replyText).toContain(
      'Synthesis: Local-only output. An OpenAI draft was rejected by grounding checks',
    );
    expect(result.trace?.notes).toContain(
      'digest_source:local_untrusted_provider',
    );
  });

  it('rejects a broad digest when one of several otherwise grounded bullets is fabricated', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_MODEL_STANDARD', 'gpt-5.4');
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            output_text: JSON.stringify({
              lead: 'Dinner address and Fallout worldbuilding were discussed.',
              digest:
                'The messages covered the dinner address and Fallout worldbuilding.',
              bullets: [
                'The dinner address remains an open question.',
                "Fallout worldbuilding is Friday's topic.",
                'The discussion centered on garden renovation plans.',
              ],
              suggestedReplies: [],
            }),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    ) as typeof fetch;
    const chatJid = 'bb:iMessage;-;mixed-grounding-fixture';
    storeChatMetadata(
      chatJid,
      '2026-04-15T18:00:00.000Z',
      'Planning',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'mixed-grounding-dinner',
      chat_jid: chatJid,
      sender: 'planning-contact',
      sender_name: 'Planning contact',
      content: 'The dinner address is still an open question.',
      timestamp: '2026-04-15T17:50:00.000Z',
      is_from_me: false,
    });
    storeMessage({
      id: 'mixed-grounding-fallout',
      chat_jid: chatJid,
      sender: 'planning-contact',
      sender_name: 'Planning contact',
      content: 'Fallout worldbuilding is the topic Friday.',
      timestamp: '2026-04-15T18:00:00.000Z',
      is_from_me: false,
    });

    const result = await executeAssistantCapability({
      capabilityId: 'communication.summarize_thread',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
        ownerReviewAllowed: true,
        now: new Date('2026-04-15T19:00:00-05:00'),
      },
      input: {
        canonicalText: 'summarize all synced text messages from today',
        targetChatJid: ALL_SYNCED_MESSAGES_TARGET,
        timeWindowKind: 'today',
      },
    });

    expect(result.replyText).toContain('OpenAI draft was rejected');
    expect(result.replyText).not.toContain('garden renovation');
    expect(result.trace?.notes).toContain(
      'digest_source:local_untrusted_provider',
    );
  });

  it('rejects a mixed broad digest when one anchored claim inverts evidence polarity', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_MODEL_STANDARD', 'gpt-5.4');
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            output_text: JSON.stringify({
              lead: 'Dinner planning and the pickup schedule were discussed.',
              digest:
                'The dinner plan is confirmed, while the pickup remains scheduled.',
              bullets: [
                'The pickup remains scheduled.',
                'The dinner plan is confirmed.',
              ],
              suggestedReplies: [],
            }),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    ) as typeof fetch;
    const chatJid = 'bb:iMessage;-;polarity-grounding-fixture';
    storeChatMetadata(
      chatJid,
      '2026-04-15T18:10:00.000Z',
      'Plan status',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'polarity-grounding-dinner',
      chat_jid: chatJid,
      sender: 'planning-contact',
      sender_name: 'Planning contact',
      content: 'The dinner plan is not confirmed.',
      timestamp: '2026-04-15T18:00:00.000Z',
      is_from_me: false,
    });
    storeMessage({
      id: 'polarity-grounding-pickup',
      chat_jid: chatJid,
      sender: 'planning-contact',
      sender_name: 'Planning contact',
      content: 'The pickup remains scheduled.',
      timestamp: '2026-04-15T18:10:00.000Z',
      is_from_me: false,
    });

    const result = await executeAssistantCapability({
      capabilityId: 'communication.summarize_thread',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
        ownerReviewAllowed: true,
        now: new Date('2026-04-15T19:00:00-05:00'),
      },
      input: {
        canonicalText: 'summarize all synced text messages from today',
        targetChatJid: ALL_SYNCED_MESSAGES_TARGET,
        timeWindowKind: 'today',
      },
    });

    expect(result.replyText).toContain('OpenAI draft was rejected');
    expect(result.replyText).not.toContain('The dinner plan is confirmed.');
    expect(result.trace?.notes).toContain(
      'digest_source:local_untrusted_provider',
    );
  });

  it('rejects a near-grounded digest that invents an amount or deadline', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_MODEL_STANDARD', 'gpt-5.4');
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            output_text: JSON.stringify({
              lead: 'A rent payment needs attention.',
              digest: 'A $2,500 rent payment is due Friday.',
              bullets: ['Pay $2,500 by Friday.'],
              suggestedReplies: [],
            }),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    ) as typeof fetch;
    storeChatMetadata(
      'bb:SMS;-;rent-notice-fixture',
      '2026-04-15T16:50:00.000Z',
      'Rent notice',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'rent-notice-grounding',
      chat_jid: 'bb:SMS;-;rent-notice-fixture',
      sender: 'rent-notice',
      sender_name: 'Rent notice',
      content: 'Your rent payment is due.',
      timestamp: '2026-04-15T16:50:00.000Z',
      is_from_me: false,
    });

    const result = await executeAssistantCapability({
      capabilityId: 'communication.summarize_thread',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
        ownerReviewAllowed: true,
        now: new Date('2026-04-15T19:00:00-05:00'),
      },
      input: {
        canonicalText: 'summarize all synced text messages from today',
        targetChatJid: ALL_SYNCED_MESSAGES_TARGET,
        timeWindowKind: 'today',
      },
    });

    expect(result.replyText).toContain('Your rent payment is due.');
    expect(result.replyText).not.toContain('$2,500');
    expect(result.replyText).not.toContain('Friday');
    expect(result.trace?.notes).toContain(
      'digest_source:local_untrusted_provider',
    );
  });

  it('does not report a superseded or explicitly unconfirmed plan as a current decision', async () => {
    vi.stubEnv('OPENAI_API_KEY', ' ');
    const changedChat = 'bb:iMessage;-;changed-plan-fixture';
    storeChatMetadata(
      changedChat,
      '2026-04-15T17:10:00.000Z',
      'Changed plan',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'changed-plan-old',
      chat_jid: changedChat,
      sender: 'planner',
      sender_name: 'Planner',
      content: 'We decided to meet Friday.',
      timestamp: '2026-04-15T17:00:00.000Z',
      is_from_me: false,
    });
    storeMessage({
      id: 'changed-plan-new',
      chat_jid: changedChat,
      sender: 'planner',
      sender_name: 'Planner',
      content: 'Change of plans — Saturday instead.',
      timestamp: '2026-04-15T17:10:00.000Z',
      is_from_me: false,
    });
    const unconfirmedChat = 'bb:iMessage;-;unconfirmed-plan-fixture';
    storeChatMetadata(
      unconfirmedChat,
      '2026-04-15T17:15:00.000Z',
      'Unconfirmed plan',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'unconfirmed-plan-message',
      chat_jid: unconfirmedChat,
      sender: 'planner-two',
      sender_name: 'Planner two',
      content: "We haven't confirmed Friday.",
      timestamp: '2026-04-15T17:15:00.000Z',
      is_from_me: false,
    });

    const result = await executeAssistantCapability({
      capabilityId: 'communication.summarize_thread',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
        ownerReviewAllowed: true,
        now: new Date('2026-04-15T19:00:00-05:00'),
      },
      input: {
        canonicalText: 'summarize all synced text messages from today',
        targetChatJid: ALL_SYNCED_MESSAGES_TARGET,
        timeWindowKind: 'today',
      },
    });

    const decisions =
      result.replyText
        ?.split('\n\nCommitments and decisions\n')[1]
        ?.split('\n\nOpen questions')[0] || '';
    expect(decisions).toContain(
      'No explicit commitments, decisions, or pending proposals were captured',
    );
    expect(decisions).not.toContain('We decided to meet Friday.');
    expect(decisions).not.toContain("haven't confirmed Friday");
  });

  it('keeps short but decisive turns in the local named-thread fallback', async () => {
    vi.stubEnv('OPENAI_API_KEY', ' ');
    const chatJid = 'bb:iMessage;-;short-logistics-fixture';
    storeChatMetadata(
      chatJid,
      '2026-04-15T17:20:00.000Z',
      'Short Logistics',
      'bluebubbles',
      false,
    );
    for (const [index, content] of [
      '7 works.',
      'No.',
      '8 instead.',
      'Done.',
    ].entries()) {
      storeMessage({
        id: `short-logistics-${index}`,
        chat_jid: chatJid,
        sender: index % 2 === 0 ? 'other' : 'me',
        sender_name: index % 2 === 0 ? 'Other person' : 'Me',
        content,
        timestamp: `2026-04-15T17:${String(10 + index).padStart(2, '0')}:00.000Z`,
        is_from_me: index % 2 === 1,
      });
    }

    const result = await executeAssistantCapability({
      capabilityId: 'communication.summarize_thread',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
        ownerReviewAllowed: true,
        now: new Date('2026-04-15T19:00:00-05:00'),
      },
      input: {
        canonicalText: 'summarize Short Logistics from today',
        targetChatName: 'Short Logistics',
        timeWindowKind: 'today',
      },
    });

    expect(result.replyText).toContain('7 works.');
    expect(result.replyText).toContain('8 instead.');
    expect(result.replyText).toContain('Done.');
  });

  it('keeps the latest current-state turn in the compact BlueBubbles named-thread fallback', async () => {
    vi.stubEnv('OPENAI_API_KEY', ' ');
    const chatJid = 'bb:iMessage;-;latest-current-state-fixture';
    storeChatMetadata(
      chatJid,
      '2026-04-15T17:13:00.000Z',
      'Entrance Update',
      'bluebubbles',
      false,
    );
    for (const [index, content] of [
      'Let us meet at the north entrance.',
      'I can be there around six.',
      'Actually, parking is closed on that side.',
      'CURRENT STATE: use the east entrance instead.',
    ].entries()) {
      const isFromMe = index % 2 === 1;
      storeMessage({
        id: `latest-current-state-${index}`,
        chat_jid: chatJid,
        sender: isFromMe ? 'me' : 'other',
        sender_name: isFromMe ? 'Jeff' : 'Other person',
        content,
        timestamp: `2026-04-15T17:${String(10 + index).padStart(2, '0')}:00.000Z`,
        is_from_me: isFromMe,
      });
    }

    const result = await executeAssistantCapability({
      capabilityId: 'communication.summarize_thread',
      context: {
        channel: 'bluebubbles',
        groupFolder: 'main',
        chatJid: 'bb:iMessage;-;owner-self-thread',
        ownerReviewAllowed: true,
        now: new Date('2026-04-15T19:00:00-05:00'),
      },
      input: {
        canonicalText: 'summarize Entrance Update from today',
        targetChatName: 'Entrance Update',
        timeWindowKind: 'today',
      },
    });

    expect(result.replyText).toContain(
      'CURRENT STATE: use the east entrance instead.',
    );
    expect(result.replyText).toContain('By the end');
    expect(result.replyText).toContain('Latest turn');
    expect(result.trace?.notes).toContain('digest_source:fallback');
  });

  it('does not treat cancelled questions or automated surveys as reply priorities', async () => {
    vi.stubEnv('OPENAI_API_KEY', ' ');
    storeChatMetadata(
      'bb:iMessage;-;cancelled-question',
      '2026-04-15T16:05:00.000Z',
      'Morgan',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'cancelled-question-1',
      chat_jid: 'bb:iMessage;-;cancelled-question',
      sender: 'Morgan',
      sender_name: 'Morgan',
      content: 'Can you bring the tickets tonight?',
      timestamp: '2026-04-15T16:00:00.000Z',
      is_from_me: false,
    });
    storeMessage({
      id: 'cancelled-question-2',
      chat_jid: 'bb:iMessage;-;cancelled-question',
      sender: 'Morgan',
      sender_name: 'Morgan',
      content: 'Never mind, I already got them.',
      timestamp: '2026-04-15T16:05:00.000Z',
      is_from_me: false,
    });
    storeChatMetadata(
      'bb:iMessage;-;automated-survey',
      '2026-04-15T16:10:00.000Z',
      'Auto Survey',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'automated-survey-1',
      chat_jid: 'bb:iMessage;-;automated-survey',
      sender: 'Auto Survey',
      sender_name: 'Auto Survey',
      content: 'Can you take our survey? Text STOP to unsubscribe.',
      timestamp: '2026-04-15T16:10:00.000Z',
      is_from_me: false,
    });

    const result = await executeAssistantCapability({
      capabilityId: 'communication.summarize_thread',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
        ownerReviewAllowed: true,
        now: new Date('2026-04-15T19:00:00-05:00'),
      },
      input: {
        canonicalText: 'summarize all synced text messages from today',
        targetChatJid: ALL_SYNCED_MESSAGES_TARGET,
        timeWindowKind: 'today',
      },
    });

    expect(result.replyText).toContain(
      'No unanswered question is obvious from the latest turns.',
    );
    expect(result.replyText).toContain(
      'No reply looks clearly due from the latest turns.',
    );
    expect(result.replyText).not.toContain('respond to');
  });

  it('keeps a person-to-person survey request as an open reply priority', async () => {
    vi.stubEnv('OPENAI_API_KEY', ' ');
    const chatJid = 'bb:iMessage;-;reunion-survey-request';
    storeChatMetadata(
      chatJid,
      '2026-04-15T16:10:00.000Z',
      'Reunion planning',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'human-survey-request-1',
      chat_jid: chatJid,
      sender: 'planner',
      sender_name: 'Planner',
      content: 'Can you fill out the reunion survey by tonight?',
      timestamp: '2026-04-15T16:10:00.000Z',
      is_from_me: false,
    });

    const result = await executeAssistantCapability({
      capabilityId: 'communication.summarize_thread',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
        ownerReviewAllowed: true,
        now: new Date('2026-04-15T19:00:00-05:00'),
      },
      input: {
        canonicalText: 'summarize all synced text messages from today',
        targetChatJid: ALL_SYNCED_MESSAGES_TARGET,
        timeWindowKind: 'today',
      },
    });

    expect(result.replyText).toContain(
      'Can you fill out the reunion survey by tonight?',
    );
    expect(result.replyText).toContain(
      'Reunion planning — respond to "Can you fill out the reunion survey by tonight?"',
    );
  });

  it('does not assign a general group question to the owner without a reply binding', async () => {
    vi.stubEnv('OPENAI_API_KEY', ' ');
    const generalGroup = 'bb:iMessage;+;general-group-question';
    storeChatMetadata(
      generalGroup,
      '2026-04-15T16:10:00.000Z',
      'General group',
      'bluebubbles',
      true,
    );
    storeMessage({
      id: 'general-group-question-1',
      chat_jid: generalGroup,
      sender: 'group-member',
      sender_name: 'Group member',
      content: 'Can someone bring ice tonight?',
      timestamp: '2026-04-15T16:10:00.000Z',
      is_from_me: false,
    });

    const replyBoundGroup = 'bb:iMessage;+;owner-bound-group-question';
    storeChatMetadata(
      replyBoundGroup,
      '2026-04-15T16:20:00.000Z',
      'Reply-bound group',
      'bluebubbles',
      true,
    );
    storeMessage({
      id: 'owner-group-turn',
      chat_jid: replyBoundGroup,
      sender: 'owner',
      sender_name: 'Me',
      content: 'I can help with setup.',
      timestamp: '2026-04-15T16:15:00.000Z',
      is_from_me: true,
    });
    storeMessage({
      id: 'owner-bound-group-question-1',
      chat_jid: replyBoundGroup,
      sender: 'group-member-two',
      sender_name: 'Group member two',
      content: 'Could you bring the folding table?',
      timestamp: '2026-04-15T16:20:00.000Z',
      is_from_me: false,
      reply_to_id: 'owner-group-turn',
    });

    const result = await executeAssistantCapability({
      capabilityId: 'communication.summarize_thread',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
        ownerReviewAllowed: true,
        now: new Date('2026-04-15T19:00:00-05:00'),
      },
      input: {
        canonicalText: 'summarize all synced text messages from today',
        targetChatJid: ALL_SYNCED_MESSAGES_TARGET,
        timeWindowKind: 'today',
      },
    });

    expect(result.replyText).not.toContain(
      'General group — respond to "Can someone bring ice tonight?"',
    );
    expect(result.replyText).toContain(
      'Reply-bound group — respond to "Could you bring the folding table?"',
    );
  });

  it('keeps an earlier unanswered request visible after a later inbound addendum', async () => {
    vi.stubEnv('OPENAI_API_KEY', ' ');
    const chatJid = 'bb:iMessage;-;venue-addendum';
    storeChatMetadata(
      chatJid,
      '2026-04-15T16:12:00.000Z',
      'Riley',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'broad-addendum-owner-context',
      chat_jid: chatJid,
      sender: 'me',
      sender_name: 'Jeff',
      content: 'I am heading over after work.',
      timestamp: '2026-04-15T16:00:00.000Z',
      is_from_me: true,
    });
    storeMessage({
      id: 'broad-addendum-open-request',
      chat_jid: chatJid,
      sender: 'Riley',
      sender_name: 'Riley',
      content: 'Please send the venue address.',
      timestamp: '2026-04-15T16:10:00.000Z',
      is_from_me: false,
    });
    storeMessage({
      id: 'broad-addendum-latest-inbound',
      chat_jid: chatJid,
      sender: 'Riley',
      sender_name: 'Riley',
      content: 'The doors open at six.',
      timestamp: '2026-04-15T16:12:00.000Z',
      is_from_me: false,
    });

    const result = await executeAssistantCapability({
      capabilityId: 'communication.summarize_thread',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
        ownerReviewAllowed: true,
        now: new Date('2026-04-15T19:00:00-05:00'),
      },
      input: {
        canonicalText: 'summarize all synced text messages from today',
        targetChatJid: ALL_SYNCED_MESSAGES_TARGET,
        timeWindowKind: 'today',
      },
    });

    expect(result.replyText).toContain('Open questions');
    expect(result.replyText).toContain('Please send the venue address.');
    expect(result.replyText).toContain(
      'Riley — respond to "Please send the venue address."',
    );
    expect(result.replyText).not.toContain(
      'respond to "The doors open at six."',
    );
    expect(result.replyText).not.toContain('Suggested replies');
    expect(
      listMessageActionsForGroup({ groupFolder: 'main', includeSent: true }),
    ).toHaveLength(0);
  });

  it('keeps the all-synced digest compact on BlueBubbles', async () => {
    vi.stubEnv('OPENAI_API_KEY', ' ');
    for (let index = 1; index <= 4; index += 1) {
      const chatJid = `bb:iMessage;-;compact-${index}`;
      storeChatMetadata(
        chatJid,
        `2026-04-15T1${index}:30:00.000Z`,
        `Conversation ${index}`,
        'bluebubbles',
        false,
      );
      storeMessage({
        id: `compact-decision-${index}`,
        chat_jid: chatJid,
        sender: `person-${index}`,
        sender_name: `Person ${index}`,
        content: `We agreed to meet at ${index + 4} tonight.`,
        timestamp: `2026-04-15T1${index}:20:00.000Z`,
        is_from_me: false,
      });
      storeMessage({
        id: `compact-question-${index}`,
        chat_jid: chatJid,
        sender: `person-${index}`,
        sender_name: `Person ${index}`,
        content: `Can you bring item ${index} tonight?`,
        timestamp: `2026-04-15T1${index}:30:00.000Z`,
        is_from_me: false,
      });
    }

    const result = await executeAssistantCapability({
      capabilityId: 'communication.summarize_thread',
      context: {
        channel: 'bluebubbles',
        groupFolder: 'main',
        chatJid: 'bb:iMessage;-;owner-self-thread',
        ownerReviewAllowed: true,
        now: new Date('2026-04-15T19:00:00-05:00'),
      },
      input: {
        canonicalText: 'summarize all synced text messages from today',
        targetChatJid: ALL_SYNCED_MESSAGES_TARGET,
        timeWindowKind: 'today',
      },
    });

    expect(result.replyText!.length).toBeLessThan(1_400);
    expect(result.replyText!.match(/respond to/g)).toHaveLength(2);
    expect(result.replyText).toContain(
      'Coverage note: 1 additional active conversation',
    );
    expect(result.trace?.notes).toContain('digest_source:local');
  });

  it('withholds a draft when a recent-text question needs the owner answer', async () => {
    seedRecentTextSafeSendRule();
    storeChatMetadata(
      'bb:iMessage;-;+14695550123',
      '2026-04-15T16:10:00.000Z',
      'Candace',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'review-candace-1',
      chat_jid: 'bb:iMessage;-;+14695550123',
      sender: 'bb:+14695550123',
      sender_name: 'Candace',
      content: 'Can you confirm if dinner still works tonight?',
      timestamp: '2026-04-15T16:10:00.000Z',
      is_from_me: false,
    });

    const review = await executeAssistantCapability({
      capabilityId: 'communication.review_recent_texts',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
        ownerReviewAllowed: true,
        now: new Date('2026-04-15T17:00:00.000Z'),
      },
      input: {
        canonicalText: 'review recent text messages from today',
        timeWindowKind: 'today',
      },
    });

    expect(review.handled).toBe(true);
    expect(review.replyText).toContain('Needs reply');
    expect(review.replyText).not.toContain('draft #1');
    expect(review.replyText).toContain('answer you want to send for #1');
    expect(review.outcomeMetadata).toMatchObject({
      source: 'recent_text_review',
      outcomeKind: 'reviewed',
      counts: {
        needsReply: 1,
        worthWatching: 0,
        noReplyNeeded: 0,
      },
    });
    expect(
      listMessageActionsForGroup({ groupFolder: 'main', includeSent: true }),
    ).toHaveLength(0);
    const seedJson = review.conversationSeed?.subjectData?.recentTextReviewJson;
    expect(seedJson).toBeTruthy();
    expect(seedJson).not.toContain('bb:iMessage');
    expect(seedJson).not.toContain('+14695550123');
    expect(seedJson).not.toContain('review-candace-1');

    const draft = await executeAssistantCapability({
      capabilityId: 'communication.draft_reply',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
        now: new Date('2026-04-15T17:05:00.000Z'),
        primeMessagesChatHistory: async (chatJid) => ({
          chatJid,
          storedCount: 1,
          totalCount: 1,
        }),
        priorSubjectData: review.conversationSeed?.subjectData,
      },
      input: {
        text: 'draft #1',
        canonicalText: 'draft #1',
      },
    });

    expect(draft.handled).toBe(true);
    expect(draft.replyText).toContain('asks for your actual answer');
    expect(draft.replyText).toContain('did not create or send a draft');
    expect(draft.messageAction).toBeUndefined();
    expect(draft.outcomeMetadata).toMatchObject({
      source: 'recent_text_review',
      outcomeKind: 'reviewed',
      handled: false,
      itemRank: 1,
    });
    expect(
      listMessageActionsForGroup({ groupFolder: 'main', includeSent: true }),
    ).toHaveLength(0);
  });

  it('handles numbered recent text review follow-ups without sending messages', async () => {
    seedCommunicationThread({
      id: 'comm-candace-review',
      title: 'Candace',
      channelChatJid: 'bb:iMessage;-;+14695550123',
    });
    seedCommunicationThread({
      id: 'comm-alex-review',
      title: 'Alex',
      channelChatJid: 'bb:iMessage;-;+14695550124',
    });
    seedCommunicationThread({
      id: 'comm-morgan-review',
      title: 'Morgan',
      channelChatJid: 'bb:iMessage;-;+14695550125',
    });
    for (const fixture of [
      {
        jid: 'bb:iMessage;-;+14695550123',
        name: 'Candace',
        messageId: 'review-candace-current',
        content: 'Can you confirm whether dinner still works tonight?',
        timestamp: '2026-04-15T16:00:00.000Z',
      },
      {
        jid: 'bb:iMessage;-;+14695550124',
        name: 'Alex',
        messageId: 'review-alex-current',
        content: 'Please send the latest set list when you can.',
        timestamp: '2026-04-15T16:10:00.000Z',
      },
      {
        jid: 'bb:iMessage;-;+14695550125',
        name: 'Morgan',
        messageId: 'review-morgan-current',
        content: 'The loose follow-up can wait until tonight.',
        timestamp: '2026-04-15T16:20:00.000Z',
      },
    ]) {
      storeChatMetadata(
        fixture.jid,
        fixture.timestamp,
        fixture.name,
        'bluebubbles',
        false,
      );
      storeMessage({
        id: fixture.messageId,
        chat_jid: fixture.jid,
        sender: fixture.name,
        sender_name: fixture.name,
        content: fixture.content,
        timestamp: fixture.timestamp,
        is_from_me: false,
      });
    }
    const freshnessReview = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    const freshnessByThreadId = new Map(
      freshnessReview.items.map((item) => [
        item.communicationThreadId,
        item.freshnessSnapshot,
      ]),
    );
    expect(freshnessByThreadId.get('comm-candace-review')).toBeTruthy();
    expect(freshnessByThreadId.get('comm-alex-review')).toBeTruthy();
    expect(freshnessByThreadId.get('comm-morgan-review')).toBeTruthy();
    const recentTextReviewJson = JSON.stringify({
      version: 1,
      reviewedAt: freshnessReview.reviewedAt,
      windowStartTimestamp: freshnessReview.window.startTimestamp,
      windowEndTimestamp: freshnessReview.window.endTimestamp,
      items: [
        {
          itemId: 'review-1',
          rank: 1,
          section: 'needs_reply',
          communicationThreadId: 'comm-candace-review',
          chatLabel: 'Candace',
          isGroup: false,
          summaryText: 'Candace asked whether dinner still works tonight.',
          whyText: 'asks for an answer; has timing pressure',
          recommendedAction: 'Draft a reply.',
          linkedSubjectIds: [],
          linkedLifeThreadIds: [],
          freshnessSnapshot: freshnessByThreadId.get('comm-candace-review'),
        },
        {
          itemId: 'review-2',
          rank: 2,
          section: 'needs_reply',
          communicationThreadId: 'comm-alex-review',
          chatLabel: 'Alex',
          isGroup: false,
          summaryText: 'Alex asked for a set list update.',
          whyText: 'latest message from them after your last reply',
          recommendedAction: 'Draft a warmer reply.',
          suggestedReply: 'I saw this and will send it shortly.',
          linkedSubjectIds: [],
          linkedLifeThreadIds: [],
          freshnessSnapshot: freshnessByThreadId.get('comm-alex-review'),
        },
        {
          itemId: 'review-3',
          rank: 3,
          section: 'worth_watching',
          communicationThreadId: 'comm-morgan-review',
          chatLabel: 'Morgan',
          isGroup: false,
          summaryText: 'Morgan mentioned a loose follow-up for tonight.',
          whyText: 'worth keeping visible',
          recommendedAction: 'Set a reminder if useful.',
          linkedSubjectIds: [],
          linkedLifeThreadIds: [],
          freshnessSnapshot: freshnessByThreadId.get('comm-morgan-review'),
        },
      ],
    });
    const baseContext = {
      channel: 'telegram' as const,
      groupFolder: 'main',
      chatJid: 'tg:100000001',
      now: new Date('2026-04-15T17:05:00.000Z'),
      primeMessagesChatHistory: async (chatJid: string) => ({
        chatJid,
        storedCount: 1,
        totalCount: 1,
      }),
      priorSubjectData: {
        activeCapabilityId: 'communication.review_recent_texts' as const,
        recentTextReviewJson,
      },
    };

    const warmer = await executeAssistantCapability({
      capabilityId: 'communication.draft_reply',
      context: baseContext,
      input: {
        text: 'make #2 warmer',
        canonicalText: 'make #2 warmer',
      },
    });

    expect(warmer.handled).toBe(true);
    expect(warmer.messageAction).toMatchObject({
      targetChannel: 'bluebubbles',
      targetKind: 'external_thread',
      sendStatus: 'drafted',
      requiresApproval: true,
    });
    expect(warmer.outcomeMetadata).toMatchObject({
      outcomeKind: 'drafted',
      itemRank: 2,
      sendStatus: 'drafted',
    });
    expect(
      warmer.conversationSeed?.subjectData?.recentTextReviewJson,
    ).toBeTruthy();

    const reminder = await executeAssistantCapability({
      capabilityId: 'communication.draft_reply',
      context: {
        ...baseContext,
        priorSubjectData: warmer.conversationSeed?.subjectData,
      },
      input: {
        text: 'remind me about #3 tonight',
        canonicalText: 'remind me about #3 tonight',
      },
    });
    const reminderRefs = JSON.parse(
      reminder.messageAction?.linkedRefsJson || '{}',
    );

    expect(reminder.handled).toBe(true);
    expect(reminder.replyText).toContain('kept the draft unsent');
    expect(reminder.messageAction).toMatchObject({
      sendStatus: 'deferred',
      lastActionKind: 'remind_instead',
    });
    expect(reminder.outcomeMetadata).toMatchObject({
      outcomeKind: 'reminded',
      lastActionKind: 'remind_instead',
      itemRank: 3,
    });
    expect(getCommunicationThread('comm-morgan-review')).toMatchObject({
      followupState: 'scheduled',
      suggestedNextAction: 'create_reminder',
    });
    expect(getTaskById(reminderRefs.reminderTaskId)?.prompt).toContain(
      'Revisit this draft reply',
    );

    const saved = await executeAssistantCapability({
      capabilityId: 'communication.draft_reply',
      context: baseContext,
      input: {
        text: 'save #2',
        canonicalText: 'save #2',
      },
    });

    expect(saved.handled).toBe(true);
    expect(saved.messageAction).toMatchObject({
      sendStatus: 'deferred',
      lastActionKind: 'save_to_thread',
      requiresApproval: false,
    });
    expect(saved.outcomeMetadata).toMatchObject({
      outcomeKind: 'saved',
      lastActionKind: 'save_to_thread',
      itemRank: 2,
    });

    const skipped = await executeAssistantCapability({
      capabilityId: 'communication.draft_reply',
      context: baseContext,
      input: {
        text: 'skip #1',
        canonicalText: 'skip #1',
      },
    });

    expect(skipped.handled).toBe(true);
    expect(skipped.replyText).toContain('I did not draft or send anything');
    expect(skipped.messageAction).toBeUndefined();
    expect(skipped.outcomeMetadata).toMatchObject({
      outcomeKind: 'skipped',
      handled: true,
      itemRank: 1,
    });
    expect(getCommunicationThread('comm-candace-review')).toMatchObject({
      followupState: 'ignored',
      suggestedNextAction: 'ignore',
    });

    const actionCountBeforeWhy = listMessageActionsForGroup({
      groupFolder: 'main',
      includeSent: true,
    }).length;
    const why = await executeAssistantCapability({
      capabilityId: 'communication.draft_reply',
      context: baseContext,
      input: {
        text: 'why #1',
        canonicalText: 'why #1',
      },
    });

    expect(why.handled).toBe(true);
    expect(why.replyText).toContain('asks for an answer');
    expect(why.outcomeMetadata).toMatchObject({
      outcomeKind: 'handled',
      itemRank: 1,
    });
    expect(
      listMessageActionsForGroup({ groupFolder: 'main', includeSent: true }),
    ).toHaveLength(actionCountBeforeWhy);

    const handled = await executeAssistantCapability({
      capabilityId: 'communication.draft_reply',
      context: baseContext,
      input: {
        text: 'mark #2 handled',
        canonicalText: 'mark #2 handled',
      },
    });

    expect(handled.handled).toBe(true);
    expect(handled.messageAction).toBeUndefined();
    expect(handled.replyText).toContain('did not draft or send');
    expect(handled.outcomeMetadata).toMatchObject({
      outcomeKind: 'handled',
      itemRank: 2,
    });
    expect(getCommunicationThread('comm-alex-review')).toMatchObject({
      followupState: 'resolved',
      suggestedNextAction: 'ignore',
    });
    expect(
      listCommunicationSignalsForThread('comm-alex-review').some((signal) =>
        signal.summaryText.includes('handled'),
      ),
    ).toBe(true);
  });

  it('routes telegram recent text review follow-up drafts to telegram', async () => {
    seedCommunicationThread({
      id: 'comm-telegram-review',
      title: 'Olive',
      channel: 'telegram',
      channelChatJid: 'tg:555555501',
    });
    storeChatMetadata(
      'tg:555555501',
      '2026-04-15T16:00:00.000Z',
      'Olive',
      'telegram',
      false,
    );
    storeMessage({
      id: 'review-olive-current',
      chat_jid: 'tg:555555501',
      sender: 'Olive',
      sender_name: 'Olive',
      content: 'Can we connect later this afternoon?',
      timestamp: '2026-04-15T16:00:00.000Z',
      is_from_me: false,
    });

    const review = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    const [seededItem] = review.items;
    if (!seededItem) {
      throw new Error('expected seeded telegram review item');
    }

    const telegramReviewJson = JSON.stringify({
      version: 1,
      reviewedAt: review.reviewedAt,
      windowStartTimestamp: review.window.startTimestamp,
      windowEndTimestamp: review.window.endTimestamp,
      items: [
        {
          ...seededItem,
          itemId: 'review-1',
          rank: 1,
          communicationThreadId: 'comm-telegram-review',
          summaryText: 'Olive asked if we can connect.',
          whyText: 'asks for a response',
          section: 'needs_reply',
          linkedSubjectIds: [],
          linkedLifeThreadIds: [],
          sourceChannel: 'telegram',
          recommendedAction: 'Draft a warmer reply.',
          riskFlags: [],
        },
      ],
    });

    const draft = await executeAssistantCapability({
      capabilityId: 'communication.draft_reply',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
        now: new Date('2026-04-15T17:05:00.000Z'),
        primeMessagesChatHistory: async (chatJid) => ({
          chatJid,
          storedCount: 1,
          totalCount: 1,
        }),
        priorSubjectData: {
          activeCapabilityId: 'communication.review_recent_texts' as const,
          recentTextReviewJson: telegramReviewJson,
        },
      },
      input: {
        text: 'make #1 warmer',
        canonicalText: 'make #1 warmer',
      },
    });

    expect(draft.handled).toBe(true);
    expect(draft.messageAction).toMatchObject({
      targetChannel: 'telegram',
      targetKind: 'external_thread',
      sendStatus: 'drafted',
      requiresApproval: true,
    });
  });

  it('keeps a numbered recent-text group reply draft-only with no send controls or dispatch follow-up', async () => {
    const groupChatJid = 'bb:iMessage;+;review-group-logistics';
    seedCommunicationThread({
      id: 'comm-review-group-logistics',
      title: 'Band Logistics',
      channelChatJid: groupChatJid,
    });
    const action = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'telegram',
      presentationChatJid: 'tg:100000001',
      sourceType: 'communication_thread',
      sourceKey: 'text-review:group-logistics',
      sourceSummary: 'Recent text review #1: Band Logistics',
      draftText: 'Got it—seven tonight. Thanks for the update.',
      personName: 'Band Logistics',
      threadTitle: 'Band Logistics',
      communicationThreadId: 'comm-review-group-logistics',
      communicationContext: 'reply_followthrough',
      forceApproval: true,
      targetOverride: {
        kind: 'external_thread',
        chatJid: groupChatJid,
        isGroup: true,
        personName: 'Band Logistics',
      },
      targetChannelOverride: 'bluebubbles',
      now: new Date('2026-04-15T17:05:00.000Z'),
    });

    expect(action).toMatchObject({
      targetChannel: 'bluebubbles',
      targetKind: 'external_thread',
      trustLevel: 'draft_only',
      sendStatus: 'drafted',
      requiresApproval: true,
    });
    expect(JSON.parse(action.targetConversationJson)).toMatchObject({
      chatJid: groupChatJid,
      isGroup: true,
    });
    const presentation = buildMessageActionPresentation(action, 'telegram');
    const controlLabels = presentation.inlineActionRows
      .flat()
      .map((control) => control.label);
    expect(presentation.text).toContain('group draft only');
    expect(controlLabels).not.toContain('Send now');
    expect(controlLabels).not.toContain('Send later');
    expect(controlLabels).toContain('Show draft');
    expect(controlLabels).toContain('More direct');

    updateMessageAction(action.messageActionId, {
      presentationMessageId: 'tg:review-group-card',
      lastUpdatedAt: '2026-04-15T17:05:01.000Z',
    });
    const sendToTarget = vi.fn();
    const deps = {
      groupFolder: 'main',
      channel: 'telegram' as const,
      chatJid: 'tg:100000001',
      currentTime: new Date('2026-04-15T17:06:00.000Z'),
      ownerAuthorizationAt: '2026-04-15T17:06:00.000Z',
      sendToTarget,
    };
    for (const operation of [
      { kind: 'send' } as const,
      { kind: 'defer', timingHint: 'tonight' } as const,
      { kind: 'rewrite_and_send', style: 'warmer' } as const,
    ]) {
      const blocked = await applyMessageActionOperation(
        action.messageActionId,
        operation,
        deps,
      );
      expect(blocked.replyText).toContain('group draft only');
      expect(blocked.presentation?.inlineActionRows.flat()).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: expect.stringMatching(/^Send/) }),
        ]),
      );
    }
    const directDispatch = await executeExplicitlyAuthorizedMessageAction(
      action.messageActionId,
      deps,
    );
    expect(directDispatch.replyText).toContain('group draft only');
    expect(directDispatch.action?.sendStatus).toBe('drafted');
    expect(sendToTarget).not.toHaveBeenCalled();
  });

  it('resolves a mismatched-surface review follow-up to the thread channel target', async () => {
    seedCommunicationThread({
      id: 'comm-cross-surface-review',
      title: 'Nate',
      channel: 'bluebubbles',
      channelChatJid: 'bb:iMessage;-;+555555502',
    });
    storeChatMetadata(
      'bb:iMessage;-;+555555502',
      '2026-04-15T16:00:00.000Z',
      'Nate',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'review-nate-current',
      chat_jid: 'bb:iMessage;-;+555555502',
      sender: 'Nate',
      sender_name: 'Nate',
      content: 'Can you confirm the pickup window?',
      timestamp: '2026-04-15T16:00:00.000Z',
      is_from_me: false,
    });

    const review = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    const [seededItem] = review.items;
    if (!seededItem) {
      throw new Error('expected seeded text-review item');
    }

    const mismatchedReviewJson = JSON.stringify({
      version: 1,
      reviewedAt: review.reviewedAt,
      windowStartTimestamp: review.window.startTimestamp,
      windowEndTimestamp: review.window.endTimestamp,
      items: [
        {
          ...seededItem,
          itemId: 'review-2',
          rank: 1,
          communicationThreadId: 'comm-cross-surface-review',
          summaryText: 'Nate asked for pickup confirmation.',
          whyText: 'asks for a response',
          section: 'needs_reply',
          linkedSubjectIds: [],
          linkedLifeThreadIds: [],
          sourceChannel: 'telegram',
          recommendedAction: 'Draft a warmer reply.',
          riskFlags: [],
        },
      ],
    });

    const draft = await executeAssistantCapability({
      capabilityId: 'communication.draft_reply',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
        now: new Date('2026-04-15T17:05:00.000Z'),
        primeMessagesChatHistory: async (chatJid) => ({
          chatJid,
          storedCount: 1,
          totalCount: 1,
        }),
        priorSubjectData: {
          activeCapabilityId: 'communication.review_recent_texts' as const,
          recentTextReviewJson: mismatchedReviewJson,
        },
      },
      input: {
        text: 'make #1 warmer',
        canonicalText: 'make #1 warmer',
      },
    });

    expect(draft.handled).toBe(true);
    expect(draft.messageAction).toMatchObject({
      targetChannel: 'bluebubbles',
      targetKind: 'external_thread',
      sendStatus: 'drafted',
      requiresApproval: true,
    });
    expect(
      JSON.parse(draft.messageAction!.targetConversationJson),
    ).toMatchObject({
      chatJid: 'bb:iMessage;-;+555555502',
      kind: 'external_thread',
    });
  });

  it('blocks stale selected recent-text items before drafting', async () => {
    seedCommunicationThread({
      id: 'comm-stale-review',
      title: 'Candace',
      channelChatJid: 'bb:iMessage;-;+14695550123',
    });
    const staleSeedJson = JSON.stringify({
      version: 1,
      reviewedAt: '2026-04-13T00:00:00.000Z',
      items: [
        {
          itemId: 'review-stale',
          rank: 1,
          section: 'needs_reply',
          communicationThreadId: 'comm-stale-review',
          chatLabel: 'Candace',
          isGroup: false,
          summaryText: 'Candace asked whether dinner still works tonight.',
          whyText: 'asks for an answer',
          linkedSubjectIds: [],
          linkedLifeThreadIds: [],
        },
      ],
    });

    const result = await executeAssistantCapability({
      capabilityId: 'communication.draft_reply',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
        now: new Date('2026-04-15T17:05:00.000Z'),
        priorSubjectData: {
          activeCapabilityId: 'communication.review_recent_texts' as const,
          recentTextReviewJson: staleSeedJson,
        },
      },
      input: {
        text: 'draft #1',
        canonicalText: 'draft #1',
      },
    });

    expect(result.handled).toBe(true);
    expect(result.replyText).toContain('text review is stale');
    expect(result.messageAction).toBeUndefined();
    expect(
      listMessageActionsForGroup({ groupFolder: 'main', includeSent: true }),
    ).toHaveLength(0);
  });

  it('blocks selected recent-text follow-ups when the thread changed after review', async () => {
    seedRecentTextSafeSendRule();
    storeChatMetadata(
      'bb:iMessage;-;+14695550123',
      '2026-04-15T16:10:00.000Z',
      'Candace',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'cap-freshness-1',
      chat_jid: 'bb:iMessage;-;+14695550123',
      sender: 'bb:+14695550123',
      sender_name: 'Candace',
      content: 'Can you confirm dinner tonight?',
      timestamp: '2026-04-15T16:10:00.000Z',
      is_from_me: false,
    });
    const review = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    const recentTextReviewJson = buildRecentTextReviewSeedJson(review);
    storeMessage({
      id: 'cap-freshness-2',
      chat_jid: 'bb:iMessage;-;+14695550123',
      sender: 'me',
      sender_name: 'Jeff',
      content: 'Yes, dinner still works.',
      timestamp: '2026-04-15T17:03:00.000Z',
      is_from_me: true,
    });

    const result = await executeAssistantCapability({
      capabilityId: 'communication.draft_reply',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
        now: new Date('2026-04-15T17:05:00.000Z'),
        priorSubjectData: {
          activeCapabilityId: 'communication.review_recent_texts' as const,
          recentTextReviewJson,
        },
      },
      input: {
        text: 'draft #1',
        canonicalText: 'draft #1',
      },
    });

    expect(result.handled).toBe(true);
    expect(result.replyText).toContain('thread changed');
    expect(result.messageAction).toBeUndefined();
    expect(result.outcomeMetadata).toMatchObject({
      outcomeKind: 'blocked_stale',
      handled: false,
      itemRank: 1,
    });
    expect(
      listMessageActionsForGroup({ groupFolder: 'main', includeSent: true }),
    ).toHaveLength(0);
  });

  it('refreshes the exact quiet review target and blocks a newly discovered update before drafting', async () => {
    const targetChatJid = 'bb:iMessage;-;quiet-review-target';
    storeChatMetadata(
      targetChatJid,
      '2026-04-15T16:10:00.000Z',
      'Quiet Review Target',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'quiet-review-before-refresh',
      chat_jid: targetChatJid,
      sender: 'Quiet Review Target',
      sender_name: 'Quiet Review Target',
      content: 'Can you confirm the pickup plan tonight?',
      timestamp: '2026-04-15T16:10:00.000Z',
      is_from_me: false,
    });
    const review = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    const recentTextReviewJson = buildRecentTextReviewSeedJson(review);
    const primeMessagesChatHistory = vi.fn(async (chatJid: string) => {
      expect(chatJid).toBe(targetChatJid);
      storeMessage({
        id: 'quiet-review-discovered-by-targeted-refresh',
        chat_jid: chatJid,
        sender: 'Quiet Review Target',
        sender_name: 'Quiet Review Target',
        content: 'Never mind, the pickup plan is handled.',
        timestamp: '2026-04-15T17:03:00.000Z',
        is_from_me: false,
      });
      return { chatJid, storedCount: 1, totalCount: 1 };
    });

    const result = await executeAssistantCapability({
      capabilityId: 'communication.draft_reply',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
        now: new Date('2026-04-15T17:05:00.000Z'),
        primeMessagesChatHistory,
        priorSubjectData: {
          activeCapabilityId: 'communication.review_recent_texts',
          recentTextReviewJson,
        },
      },
      input: {
        text: 'draft #1',
        canonicalText: 'draft #1',
      },
    });

    expect(primeMessagesChatHistory).toHaveBeenCalledTimes(1);
    expect(result.replyText).toContain('thread changed');
    expect(result.messageAction).toBeUndefined();
    expect(result.sendOptions).toBeUndefined();
    expect(result.outcomeMetadata).toMatchObject({
      outcomeKind: 'blocked_stale',
      handled: false,
      itemRank: 1,
    });
    expect(
      listMessageActionsForGroup({ groupFolder: 'main', includeSent: true }),
    ).toHaveLength(0);
  });

  it('blocks a fresh numbered review continuation when no exact-thread refresh callback is available', async () => {
    const targetChatJid = 'bb:iMessage;-;review-refresh-unavailable';
    storeChatMetadata(
      targetChatJid,
      '2026-04-15T16:10:00.000Z',
      'Refresh Required',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'review-refresh-unavailable-inbound',
      chat_jid: targetChatJid,
      sender: 'Refresh Required',
      sender_name: 'Refresh Required',
      content: 'Can you confirm the plan tonight?',
      timestamp: '2026-04-15T16:10:00.000Z',
      is_from_me: false,
    });
    const review = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });

    const result = await executeAssistantCapability({
      capabilityId: 'communication.draft_reply',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
        now: new Date('2026-04-15T17:05:00.000Z'),
        priorSubjectData: {
          activeCapabilityId: 'communication.review_recent_texts',
          recentTextReviewJson: buildRecentTextReviewSeedJson(review),
        },
      },
      input: {
        text: 'draft #1',
        canonicalText: 'draft #1',
      },
    });

    expect(result.replyText).toContain(
      'could not refresh the exact Messages thread',
    );
    expect(result.trace?.notes).toContain('targeted_refresh_failed');
    expect(result.messageAction).toBeUndefined();
    expect(result.sendOptions).toBeUndefined();
    expect(
      listMessageActionsForGroup({ groupFolder: 'main', includeSent: true }),
    ).toHaveLength(0);
  });

  it('blocks mark-handled when a selected review item loses its Messages binding', async () => {
    storeChatMetadata(
      'bb:iMessage;-;+14695550123',
      '2026-04-15T16:10:00.000Z',
      'Candace',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'cap-unbound-1',
      chat_jid: 'bb:iMessage;-;+14695550123',
      sender: 'bb:+14695550123',
      sender_name: 'Candace',
      content: 'Can you confirm dinner tonight?',
      timestamp: '2026-04-15T16:10:00.000Z',
      is_from_me: false,
    });
    const review = await reviewRecentTexts({
      groupFolder: 'main',
      now: new Date('2026-04-15T17:00:00.000Z'),
      timeWindowKind: 'today',
      cloudAnalysisMode: 'disabled',
    });
    const recentTextReviewJson = buildRecentTextReviewSeedJson(review);
    const threadId = review.items[0]!.communicationThreadId!;
    upsertCommunicationThread({
      ...getCommunicationThread(threadId)!,
      channel: 'telegram',
      channelChatJid: 'tg:other-thread',
      updatedAt: '2026-04-15T17:03:00.000Z',
    });

    const result = await executeAssistantCapability({
      capabilityId: 'communication.draft_reply',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
        now: new Date('2026-04-15T17:05:00.000Z'),
        priorSubjectData: {
          activeCapabilityId: 'communication.review_recent_texts' as const,
          recentTextReviewJson,
        },
      },
      input: {
        text: 'mark #1 handled',
        canonicalText: 'mark #1 handled',
      },
    });

    expect(result.handled).toBe(true);
    expect(result.replyText).toMatch(
      /current Messages thread binding|could not refresh the exact Messages thread/,
    );
    expect(result.messageAction).toBeUndefined();
    expect(result.outcomeMetadata).toMatchObject({
      outcomeKind: expect.stringMatching(/^blocked_(unbound|stale)$/),
      handled: false,
      itemRank: 1,
    });
    expect(getCommunicationThread(threadId)).toMatchObject({
      followupState: 'reply_needed',
    });
  });

  it('reads upcoming reminders from local scheduled tasks', async () => {
    const planned = planSimpleReminder(
      'remind me tomorrow afternoon at 4:15pm to review the Andrea QA reminder path',
      'main',
      'tg:100000001',
      new Date('2026-04-15T12:00:00-05:00'),
    );
    expect(planned).not.toBeNull();
    createTask(planned!.task);

    const result = await executeAssistantCapability({
      capabilityId: 'followthrough.reminder_overview',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
        now: new Date('2026-04-15T12:05:00-05:00'),
      },
      input: {
        canonicalText: 'what reminders do I have tomorrow',
      },
    });

    expect(result.handled).toBe(true);
    expect(result.capabilityId).toBe('followthrough.reminder_overview');
    expect(result.replyText).toContain('Tomorrow you have one reminder.');
    expect(result.replyText).toContain(
      '4:15 PM review the Andrea QA reminder path',
    );
    expect(result.trace?.responseSource).toBe('local_companion');
  });

  it('asks to clarify when a named BlueBubbles thread summary is ambiguous', async () => {
    storeChatMetadata(
      'bb:iMessage;-;pops-of-punk-band',
      '2026-04-15T11:00:00.000Z',
      'Pops of Punk Band',
      'bluebubbles',
      true,
    );
    storeChatMetadata(
      'bb:iMessage;-;pops-of-punk-fans',
      '2026-04-15T11:05:00.000Z',
      'Pops of Punk Fans',
      'bluebubbles',
      true,
    );

    const result = await executeAssistantCapability({
      capabilityId: 'communication.summarize_thread',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
        ownerReviewAllowed: true,
        now: new Date('2026-04-15T12:00:00-05:00'),
      },
      input: {
        canonicalText: 'summarize my text messages in Pops of Punk',
        targetChatName: 'Pops of Punk',
      },
    });

    expect(result.handled).toBe(true);
    expect(result.replyText).toContain('Which one do you want');
    expect(result.replyText).toContain('Pops of Punk Band');
    expect(result.replyText).toContain('Pops of Punk Fans');
  });

  it('runs chief-of-staff capability execution and carries continuation context forward', async () => {
    createTask({
      id: 'task-chief-of-staff',
      group_folder: 'main',
      chat_jid: 'tg:100000001',
      prompt: 'Reply to Candace about dinner tonight',
      schedule_type: 'once',
      schedule_value: '2026-04-05T19:00:00.000Z',
      context_mode: 'group',
      next_run: '2026-04-05T19:00:00.000Z',
      status: 'active',
      created_at: '2026-04-05T09:00:00.000Z',
    });

    const result = await executeAssistantCapability({
      capabilityId: 'staff.prioritize',
      context: {
        channel: 'alexa',
        groupFolder: 'main',
        selectedWork: {
          laneLabel: 'Cursor',
          title: 'Ship docs',
          statusLabel: 'Running',
          summary: 'Polish the rollout docs',
        },
      },
      input: {
        canonicalText: 'what matters most today',
      },
    });

    expect(result.handled).toBe(true);
    expect(result.replyText).toBeTruthy();
    expect(result.trace?.responseSource).toBe('local_companion');
    expect(
      result.conversationSeed?.subjectData?.chiefOfStaffContextJson,
    ).toBeTruthy();
    expect(result.continuationCandidate?.chiefOfStaffContextJson).toBeTruthy();
  });

  it('runs mission proposal execution and carries mission continuation context forward', async () => {
    const result = await executeAssistantCapability({
      capabilityId: 'missions.propose',
      context: {
        channel: 'alexa',
        groupFolder: 'main',
        selectedWork: {
          laneLabel: 'Cursor',
          title: 'Ship docs',
          statusLabel: 'Running',
          summary: 'Polish the rollout docs',
        },
      },
      input: {
        canonicalText: 'help me plan Friday dinner with Candace',
      },
    });

    expect(result.handled).toBe(true);
    expect(result.replyText).toBeTruthy();
    expect(result.conversationSeed?.subjectKind).toBe('mission');
    expect(result.conversationSeed?.subjectData?.missionId).toBeTruthy();
    expect(result.continuationCandidate?.missionId).toBeTruthy();
    expect(
      result.continuationCandidate?.missionSuggestedActionsJson,
    ).toBeTruthy();
  });

  it('runs shared daily capability execution against the existing daily companion logic', async () => {
    createTask({
      id: 'task-loose-ends',
      group_folder: 'main',
      chat_jid: 'tg:100000001',
      prompt: 'Call Candace about dinner plans',
      schedule_type: 'once',
      schedule_value: '2026-04-05T19:00:00.000Z',
      context_mode: 'group',
      next_run: '2026-04-05T19:00:00.000Z',
      status: 'active',
      created_at: '2026-04-05T09:00:00.000Z',
    });

    const result = await executeAssistantCapability({
      capabilityId: 'daily.loose_ends',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
      },
      input: {
        canonicalText: 'what am I forgetting',
      },
    });

    expect(result.handled).toBe(true);
    expect(result.capabilityId).toBe('daily.loose_ends');
    expect(result.trace?.responseSource).toBe('local_companion');
    expect(result.dailyResponse?.context.subjectData).toBeDefined();
  });

  it('does not append speculative life threads as current follow-through', async () => {
    handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'synthetic:capability-speculation',
      text: 'I might reorganize the garage someday.',
      now: new Date('2026-04-05T09:00:00.000Z'),
    });

    const result = await executeAssistantCapability({
      capabilityId: 'daily.loose_ends',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
        now: new Date('2026-04-05T09:00:00.000Z'),
      },
      input: { canonicalText: 'what am I forgetting' },
    });

    expect(result.replyText).not.toContain('reorganize the garage');
    expect(result.replyText).not.toContain('Still open right now');
  });

  it('runs everyday capture execution and carries list continuation context forward', async () => {
    const add = await executeAssistantCapability({
      capabilityId: 'capture.add_item',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
        now: new Date('2026-04-12T09:00:00-05:00'),
      },
      input: {
        canonicalText: 'add milk to my shopping list',
      },
    });

    expect(add.handled).toBe(true);
    expect(add.replyText).toContain('groceries');
    expect(add.conversationSeed?.subjectData?.activeListItemIds).toHaveLength(
      1,
    );
    expect(add.sendOptions?.inlineActionRows?.flat()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Done' }),
        expect.objectContaining({ label: 'Groceries' }),
        expect.objectContaining({ label: 'Plan' }),
      ]),
    );

    const read = await executeAssistantCapability({
      capabilityId: 'capture.read_items',
      context: {
        channel: 'alexa',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
        now: new Date('2026-04-12T09:05:00-05:00'),
        priorSubjectData: add.conversationSeed?.subjectData,
      },
      input: {
        canonicalText: 'what do I still need to buy',
      },
    });

    expect(read.handled).toBe(true);
    expect(read.replyText?.toLowerCase()).toContain('milk');
    expect(read.conversationSeed?.subjectData?.activeTaskKind).toBe(
      'list_read',
    );
  });

  it('keeps grocery-list read capability on the read path for explicit show-me phrasing', async () => {
    const add = await executeAssistantCapability({
      capabilityId: 'capture.add_item',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
        now: new Date('2026-04-12T10:00:00-05:00'),
      },
      input: {
        canonicalText: 'add eggs to my shopping list',
      },
    });

    const read = await executeAssistantCapability({
      capabilityId: 'capture.read_items',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
        now: new Date('2026-04-12T10:05:00-05:00'),
        priorSubjectData: add.conversationSeed?.subjectData,
      },
      input: {
        canonicalText: 'show me my grocery list',
      },
    });

    expect(read.handled).toBe(true);
    expect(read.replyText).toContain('*Groceries*');
    expect(read.replyText?.toLowerCase()).toContain('eggs');
    expect(read.conversationSeed?.subjectData?.activeTaskKind).toBe(
      'list_read',
    );
  });

  it('keeps explicit store read asks on the read path even if they land on the update capability', async () => {
    await executeAssistantCapability({
      capabilityId: 'capture.add_item',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
        now: new Date('2026-04-12T10:10:00-05:00'),
      },
      input: {
        canonicalText: 'add milk to my grocery list',
      },
    });

    const read = await executeAssistantCapability({
      capabilityId: 'capture.update_item',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
        now: new Date('2026-04-12T10:15:00-05:00'),
      },
      input: {
        text: 'what do I need from the store again',
        canonicalText: 'mark that done',
      },
    });

    expect(read.handled).toBe(true);
    expect(read.replyText).toContain('*Groceries*');
    expect(read.replyText?.toLowerCase()).toContain('milk');
    expect(read.conversationSeed?.subjectData?.activeTaskKind).toBe(
      'list_read',
    );
  });

  it('adds companion continuation payloads to Alexa-safe daily answers', async () => {
    createTask({
      id: 'task-daily-handoff',
      group_folder: 'main',
      chat_jid: 'tg:100000001',
      prompt: 'Candace still needs a dinner answer',
      schedule_type: 'once',
      schedule_value: '2026-04-05T19:00:00.000Z',
      context_mode: 'group',
      next_run: '2026-04-05T19:00:00.000Z',
      status: 'active',
      created_at: '2026-04-05T09:00:00.000Z',
    });

    const result = await executeAssistantCapability({
      capabilityId: 'daily.loose_ends',
      context: {
        channel: 'alexa',
        groupFolder: 'main',
      },
      input: {
        canonicalText: 'what am I forgetting',
      },
    });

    expect(result.followupActions).toEqual(
      expect.arrayContaining([
        'send_details',
        'save_to_library',
        'track_thread',
        'create_reminder',
        'save_for_later',
        'draft_follow_up',
      ]),
    );
    expect(result.continuationCandidate?.handoffPayload?.kind).toBe('message');
    expect(
      result.conversationSeed?.subjectData?.companionContinuationJson,
    ).toBeTruthy();
  });

  it('blocks operator-only capabilities on Alexa while keeping them registered', async () => {
    const result = await executeAssistantCapability({
      capabilityId: 'work.current_logs',
      context: {
        channel: 'alexa',
        groupFolder: 'main',
      },
    });

    expect(result.handled).toBe(true);
    expect(result.replyText).toContain('Telegram');
    expect(result.trace?.responseSource).toBe('unavailable');
  });

  it('blocks operator-only capabilities on BlueBubbles while keeping pulse available', async () => {
    const blocked = await executeAssistantCapability({
      capabilityId: 'work.current_logs',
      context: {
        channel: 'bluebubbles',
        groupFolder: 'main',
      },
    });
    const pulse = await executeAssistantCapability({
      capabilityId: 'pulse.interesting_thing',
      context: {
        channel: 'bluebubbles',
        groupFolder: 'main',
      },
      input: {
        canonicalText: 'tell me something interesting',
      },
    });

    expect(blocked.handled).toBe(true);
    expect(blocked.replyText).toContain('Telegram or operator side');
    expect(pulse.handled).toBe(true);
    expect(pulse.trace?.responseSource).toBe('pulse_local');
    expect(pulse.replyText).toContain('\n');
  });

  it('keeps synced Messages reviews out of non-owner Telegram and Messages surfaces', async () => {
    const privateBody =
      'Private pickup details that must not leave the owner surface.';
    storeChatMetadata(
      'bb:iMessage;-;private-owner-review-fixture',
      '2026-04-15T16:10:00.000Z',
      'Private conversation',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'private-owner-review-message',
      chat_jid: 'bb:iMessage;-;private-owner-review-fixture',
      sender: 'private-contact',
      sender_name: 'Private contact',
      content: privateBody,
      timestamp: '2026-04-15T16:10:00.000Z',
      is_from_me: false,
    });
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;

    const telegram = await executeAssistantCapability({
      capabilityId: 'communication.summarize_thread',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:-100123456789',
        ownerReviewAllowed: false,
      },
      input: {
        canonicalText: 'summarize all synced text messages from today',
        targetChatJid: ALL_SYNCED_MESSAGES_TARGET,
        timeWindowKind: 'today',
      },
    });
    const bluebubbles = await executeAssistantCapability({
      capabilityId: 'communication.review_recent_texts',
      context: {
        channel: 'bluebubbles',
        groupFolder: 'main',
        chatJid: 'bb:iMessage;-;ordinary-contact-thread',
        ownerReviewAllowed: false,
      },
      input: {
        canonicalText: 'review recent text messages from the last 24 hours',
      },
    });
    const missingProvenance = await executeAssistantCapability({
      capabilityId: 'communication.summarize_thread',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:unverified-owner-looking-chat',
      },
      input: {
        canonicalText: 'summarize all synced text messages from today',
        targetChatJid: ALL_SYNCED_MESSAGES_TARGET,
        timeWindowKind: 'today',
      },
    });

    for (const result of [telegram, bluebubbles, missingProvenance]) {
      expect(result.handled).toBe(true);
      expect(result.replyText).toContain('registered owner control chat');
      expect(result.replyText).toContain('did not read or summarize');
      expect(result.replyText).not.toContain(privateBody);
      expect(result.replyText).not.toContain('Private conversation');
      expect(result.trace?.reason).toContain('blocked private Messages review');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('formats research answers richly for Telegram and briefly for Alexa', async () => {
    createTask({
      id: 'task-research-rich',
      group_folder: 'main',
      chat_jid: 'tg:100000001',
      prompt: 'Decide whether to switch dinner plans',
      schedule_type: 'once',
      schedule_value: '2026-04-05T19:00:00.000Z',
      context_mode: 'group',
      next_run: '2026-04-05T19:00:00.000Z',
      status: 'active',
      created_at: '2026-04-05T09:30:00.000Z',
    });

    const telegram = await executeAssistantCapability({
      capabilityId: 'research.summarize',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
      },
      input: {
        canonicalText: 'Summarize what matters from my current context',
      },
    });
    const alexa = await executeAssistantCapability({
      capabilityId: 'research.summarize',
      context: {
        channel: 'alexa',
        groupFolder: 'main',
      },
      input: {
        canonicalText: 'Summarize what matters from my current context',
      },
    });

    expect(telegram.replyText).toContain('*Research Summary*');
    expect(telegram.replyText).not.toContain('*Why this route*');
    expect(alexa.replyText).toContain('Want');
    expect(alexa.researchResult?.routeExplanation).toContain('local context');
    expect(alexa.followupActions).toEqual(
      expect.arrayContaining([
        'send_details',
        'save_to_library',
        'track_thread',
        'create_reminder',
        'save_for_later',
        'draft_follow_up',
      ]),
    );
    expect(alexa.handoffPayload?.kind).toBe('message');
  });

  it('propagates explicit research depth and web permission into the research plan', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('BRAVE_SEARCH_ENABLED', 'false');
    vi.stubEnv('MINIMAX_ENABLED', 'false');
    const result = await executeAssistantCapability({
      capabilityId: 'research.recommend',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
      },
      input: {
        canonicalText: 'recommend a good meditation for me',
        researchDepth: 'deep',
        allowWebSearch: true,
      },
    });

    expect(result.handled).toBe(true);
    expect(result.researchResult?.plan.kind).toBe('deep_research');
    expect(result.researchResult?.plan.sources).toMatchObject({
      localContext: true,
      openAiResponses: true,
      webSearch: true,
    });
  });

  it('requires explicit research follow-ups for a pending compound calendar request without changing standalone research', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('BRAVE_SEARCH_ENABLED', 'false');
    vi.stubEnv('MINIMAX_ENABLED', 'false');
    const input = {
      canonicalText: 'recommend a good meditation for me',
      researchDepth: 'standard' as const,
      allowWebSearch: true,
    };
    const explicitResults = await Promise.all(
      (['telegram', 'bluebubbles', 'alexa'] as const).map((channel) =>
        executeAssistantCapability({
          capabilityId: 'research.recommend',
          context: {
            channel,
            groupFolder: 'main',
            chatJid:
              channel === 'bluebubbles'
                ? 'bb:iMessage;-;+12025550101'
                : 'tg:100000001',
          },
          input: {
            ...input,
            researchFollowupMode: 'explicit_only',
          },
        }),
      ),
    );

    for (const result of explicitResults) {
      expect(result.handled).toBe(true);
      expect(result.replyText).toMatch(/ask explicitly/i);
      expect(result.replyText).toMatch(
        /a bare (?:“yes”|yes) or (?:“okay”|okay) is not a research follow-up/,
      );
      expect(result.replyText).not.toContain('*Next if useful*');
      expect(result.replyText).not.toMatch(/\bWant\b/);
      expect(result.replyText).not.toContain('If you want');
    }

    const standalone = await executeAssistantCapability({
      capabilityId: 'research.recommend',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
      },
      input,
    });
    expect(standalone.replyText).toContain('*Next if useful*');
    expect(standalone.replyText).toMatch(/\bWant\b/);
    expect(standalone.replyText).not.toMatch(/ask explicitly/i);
  });

  it('shows retained web citations as visible URLs on text channels', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_BASE_URL = 'https://example.test/v1';
    vi.stubEnv('BRAVE_SEARCH_ENABLED', 'false');
    const outputText = [
      'Summary: The cited comparison favors the simpler delivery window.',
      'Findings:',
      '- The delivery window is easier to manage.',
      'Recommendation: Verify the current price before choosing.',
      'Follow-ups:',
      '- Want the short version?',
    ].join('\n');
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            output: [
              {
                type: 'message',
                content: [
                  {
                    type: 'output_text',
                    text: outputText,
                    annotations: [
                      {
                        type: 'url_citation',
                        start_index: 0,
                        end_index: 18,
                        url: 'https://example.test/cited-comparison',
                        title: 'Cited comparison',
                      },
                    ],
                  },
                ],
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    ) as typeof fetch;

    const telegram = await executeAssistantCapability({
      capabilityId: 'research.compare',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
      },
      input: { canonicalText: 'Compare meal delivery options this week' },
    });
    const bluebubbles = await executeAssistantCapability({
      capabilityId: 'research.compare',
      context: {
        channel: 'bluebubbles',
        groupFolder: 'main',
        chatJid: 'bb:iMessage;-;owner@example.com',
      },
      input: { canonicalText: 'Compare meal delivery options this week' },
    });

    expect(telegram.replyText).toContain(
      'https://example.test/cited-comparison',
    );
    expect(bluebubbles.replyText).toContain(
      'https://example.test/cited-comparison',
    );
  });

  it('labels MiniMax-backed research with a MiniMax trace source', async () => {
    vi.stubEnv('OPENAI_API_KEY', ' ');
    vi.stubEnv('BRAVE_SEARCH_ENABLED', 'false');
    vi.stubEnv('MINIMAX_ENABLED', 'true');
    vi.stubEnv('MINIMAX_API_KEY', 'test-minimax-key');
    vi.stubEnv('MINIMAX_ANTHROPIC_BASE_URL', 'https://minimax.test/anthropic');
    vi.stubEnv('MINIMAX_MODEL_COMPLEX', 'MiniMax-M3');
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          content: [
            {
              type: 'text',
              text: [
                'Summary: MiniMax can synthesize the comparison from the available prompt, with live grounding unavailable in this test.',
                'Findings:',
                '- It keeps the answer bounded.',
                '- It does not use OpenAI.',
                'Recommendation: Treat this as a MiniMax-backed research answer.',
                'Follow-ups:',
                '- Want live sources checked too?',
              ].join('\n'),
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }) as typeof fetch;

    const result = await executeAssistantCapability({
      capabilityId: 'research.compare',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
      },
      input: {
        canonicalText: 'Compare meal delivery options for this week',
      },
    });

    expect(result.handled).toBe(true);
    expect(result.researchResult?.providerUsed).toBe('minimax_anthropic');
    expect(result.trace?.responseSource).toBe('research_minimax');
    expect(result.replyText).not.toContain('I only have partial support');
  });

  it('keeps blocked weather lookups calm on protected user surfaces', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_BASE_URL = 'https://example.test/v1';
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: {
            message:
              'You exceeded your current quota, please check your plan and billing details.',
            type: 'insufficient_quota',
            code: 'insufficient_quota',
          },
        }),
        {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }) as typeof fetch;

    const telegram = await executeAssistantCapability({
      capabilityId: 'research.topic',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
      },
      input: {
        canonicalText: 'What is the weather today in Dallas?',
      },
    });
    const bluebubbles = await executeAssistantCapability({
      capabilityId: 'research.topic',
      context: {
        channel: 'bluebubbles',
        groupFolder: 'main',
        chatJid: 'bb:iMessage;-;owner@example.com',
      },
      input: {
        canonicalText: 'What is the weather today in Dallas?',
      },
    });

    expect(telegram.replyText).toContain("can't check that live right now");
    expect(telegram.replyText).not.toContain('temporary execution issue');
    expect(bluebubbles.replyText).toContain("can't check that live right now");
    expect(bluebubbles.replyText).not.toContain('processing that request');
  });

  it('saves explicit library material and renders source-grounded answers differently by channel', async () => {
    const save = await executeAssistantCapability({
      capabilityId: 'knowledge.save_source',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
      },
      input: {
        text: 'Save this note to my library: Candace wants Friday dinner after rehearsal because pickup is easier.',
        canonicalText:
          'Save this note to my library: Candace wants Friday dinner after rehearsal because pickup is easier.',
      },
    });

    expect(save.handled).toBe(true);
    expect(save.replyText).toContain('Saved');
    expect(save.trace?.responseSource).toBe('knowledge_library');

    const telegram = await executeAssistantCapability({
      capabilityId: 'knowledge.summarize_saved',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
      },
      input: {
        canonicalText:
          'What do my saved notes say about Candace dinner timing?',
      },
    });
    const alexa = await executeAssistantCapability({
      capabilityId: 'knowledge.summarize_saved',
      context: {
        channel: 'alexa',
        groupFolder: 'main',
      },
      input: {
        canonicalText:
          'What do my saved notes say about Candace dinner timing?',
      },
    });

    expect(telegram.replyText).toContain('*Supporting Sources*');
    expect(telegram.replyText).toContain('Candace');
    expect(telegram.replyText).toMatch(/updated \d{4}-\d{2}-\d{2}, fresh/);
    expect(alexa.replyText).toContain('saved material');
    expect(alexa.researchResult?.supportingSources?.[0]?.title).toBeTruthy();

    const providerAttempt = vi.fn(async () => {
      throw new Error('saved-only continuation attempted network access');
    });
    globalThis.fetch = providerAttempt as typeof fetch;
    const referenced = await executeAssistantCapability({
      capabilityId: 'knowledge.summarize_saved',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
        priorSubjectData: {
          knowledgeSourceIds:
            telegram.conversationSeed?.subjectData?.knowledgeSourceIds,
          knowledgeSourceTitles:
            telegram.conversationSeed?.subjectData?.knowledgeSourceTitles,
          knowledgeSourceMatches:
            telegram.conversationSeed?.subjectData?.knowledgeSourceMatches,
        },
      },
      input: {
        canonicalText: 'Research this using what we already saved.',
      },
    });

    expect(referenced.handled).toBe(true);
    expect(referenced.researchResult?.providerUsed).toBe('knowledge_library');
    expect(referenced.researchResult?.supportingSources?.[0]?.sourceId).toBe(
      telegram.researchResult?.supportingSources?.[0]?.sourceId,
    );
    expect(providerAttempt).not.toHaveBeenCalled();
  });

  it('runs shared communication capabilities with continuation context across channels', async () => {
    const understand = await executeAssistantCapability({
      capabilityId: 'communication.understand_message',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
      },
      input: {
        canonicalText:
          'Summarize this message: Candace: Can you let me know if dinner still works tonight?',
      },
    });

    expect(understand.handled).toBe(true);
    expect(understand.replyText).toContain(
      'Candace wants a follow-up about whether dinner still works tonight.',
    );
    expect(understand.replyText).toContain('Next:');
    expect(understand.replyText).toContain('Keep in mind:');
    expect(
      understand.continuationCandidate?.communicationThreadId,
    ).toBeTruthy();
    expect(
      understand.conversationSeed?.subjectData?.lastCommunicationSummary,
    ).toBeTruthy();

    const draft = await executeAssistantCapability({
      capabilityId: 'communication.draft_reply',
      context: {
        channel: 'bluebubbles',
        groupFolder: 'main',
        chatJid: 'bb:chat-1',
        priorSubjectData: understand.conversationSeed?.subjectData,
      },
      input: {
        canonicalText: 'make it warmer',
      },
    });

    expect(draft.handled).toBe(true);
    expect(draft.replyText).toContain(
      'What answer do you want to give Candace?',
    );
    expect(draft.handoffPayload).toBeUndefined();
    expect(draft.messageAction).toBeUndefined();
    expect(
      listMessageActionsForGroup({ groupFolder: 'main', includeSent: true }),
    ).toHaveLength(0);

    const openLoops = await executeAssistantCapability({
      capabilityId: 'communication.open_loops',
      context: {
        channel: 'alexa',
        groupFolder: 'main',
      },
      input: {
        canonicalText: 'what do I owe people',
      },
    });

    expect(openLoops.handled).toBe(true);
    expect(openLoops.replyText).toContain('needs attention');
  }, 15_000);

  it('does not create follow-through candidates for empty communication open loops', async () => {
    const openLoops = await executeAssistantCapability({
      capabilityId: 'communication.open_loops',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
      },
      input: {
        text: "what's still open with Candace?",
        canonicalText: "what's still open with Candace?",
      },
    });

    expect(openLoops.handled).toBe(true);
    expect(openLoops.replyText).toContain('Nothing important');
    expect(openLoops.continuationCandidate).toBeUndefined();
    expect(openLoops.handoffPayload).toBeUndefined();
  });

  it('keeps explicit person-and-topic draft asks grounded after an open-loops turn', async () => {
    const understand = await executeAssistantCapability({
      capabilityId: 'communication.understand_message',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
      },
      input: {
        text: 'Candace: Can you let me know if dinner still works tonight?',
        canonicalText:
          'Candace: Can you let me know if dinner still works tonight?',
      },
    });

    expect(understand.handled).toBe(true);

    const openLoops = await executeAssistantCapability({
      capabilityId: 'communication.open_loops',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
        priorSubjectData: understand.conversationSeed?.subjectData,
      },
      input: {
        text: 'What do I still need to reply to?',
        canonicalText: 'what do i still need to reply to?',
      },
    });

    expect(openLoops.handled).toBe(true);
    expect(openLoops.replyText).toContain('Candace');

    const draft = await executeAssistantCapability({
      capabilityId: 'communication.draft_reply',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
        priorSubjectData: openLoops.conversationSeed?.subjectData,
      },
      input: {
        text: 'What should I say back to Candace about dinner tonight?',
        canonicalText:
          'what should i say back to candace about dinner tonight?',
      },
    });

    expect(draft.handled).toBe(true);
    expect(draft.replyText).toContain('Hey Candace,');
    expect(draft.replyText).toMatch(
      /dinner still works tonight|dinner tonight/i,
    );
    expect(draft.replyText).not.toContain('circle back on What do I');
  });

  it('asks for the owner answer before entering the Messages model draft lane', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_BASE_URL', 'https://openai.test/v1');
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            output_text:
              '{"draftText":"Hey Candace, tonight still works for me. Let me know what feels easiest."}',
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
    );
    globalThis.fetch = fetchSpy as typeof fetch;

    const draft = await executeAssistantCapability({
      capabilityId: 'communication.draft_reply',
      context: {
        channel: 'bluebubbles',
        groupFolder: 'main',
        chatJid: 'bb:chat-1',
      },
      input: {
        canonicalText:
          'Candace: Can you let me know if dinner still works tonight?',
      },
    });

    expect(draft.handled).toBe(true);
    expect(draft.replyText).toContain(
      'What answer do you want to give Candace?',
    );
    expect(draft.messageAction).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('stages exact owner-supplied reply bytes without provider rewriting', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_BASE_URL', 'https://openai.test/v1');
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;

    const understand = await executeAssistantCapability({
      capabilityId: 'communication.understand_message',
      context: {
        channel: 'bluebubbles',
        groupFolder: 'main',
        chatJid: 'bb:chat-1',
      },
      input: {
        canonicalText:
          'Candace: Can you let me know if dinner still works tonight?',
      },
    });
    const draft = await executeAssistantCapability({
      capabilityId: 'communication.draft_reply',
      context: {
        channel: 'bluebubbles',
        groupFolder: 'main',
        chatJid: 'bb:chat-1',
        priorSubjectData: understand.conversationSeed?.subjectData,
      },
      input: {
        canonicalText:
          'Draft this reply: Yes, dinner still works for me tonight.',
      },
    });

    expect(draft.handled).toBe(true);
    expect(draft.messageAction?.draftText).toBe(
      'Yes, dinner still works for me tonight.',
    );
    expect(
      JSON.parse(draft.messageAction?.explanationJson || '{}'),
    ).toMatchObject({ draftProvenance: 'owner_literal' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('preserves explicit library titles and explains matched sources by topic', async () => {
    await executeAssistantCapability({
      capabilityId: 'knowledge.save_source',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
      },
      input: {
        text: 'Save this to my library titled Knowledge Proof Dinner Title: Friday dinner after rehearsal keeps pickup simpler and avoids a late bedtime. tags: proof,candace',
        canonicalText:
          'Save this to my library titled Knowledge Proof Dinner Title: Friday dinner after rehearsal keeps pickup simpler and avoids a late bedtime. tags: proof,candace',
      },
    });
    await executeAssistantCapability({
      capabilityId: 'knowledge.save_source',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
      },
      input: {
        text: 'Save this to my library titled Knowledge Proof Dinner Backup: If rehearsal runs late, skipping Friday dinner may protect bedtime and keep the evening less rushed. tags: proof,candace',
        canonicalText:
          'Save this to my library titled Knowledge Proof Dinner Backup: If rehearsal runs late, skipping Friday dinner may protect bedtime and keep the evening less rushed. tags: proof,candace',
      },
    });

    const sourceTitles = listKnowledgeSourcesForGroup('main').map(
      (source) => source.title,
    );
    expect(sourceTitles).toContain('Knowledge Proof Dinner Title');

    const telegram = await executeAssistantCapability({
      capabilityId: 'knowledge.explain_sources',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
      },
      input: {
        canonicalText:
          'What sources are you using about Friday dinner after rehearsal?',
      },
    });
    const alexa = await executeAssistantCapability({
      capabilityId: 'knowledge.explain_sources',
      context: {
        channel: 'alexa',
        groupFolder: 'main',
      },
      input: {
        canonicalText:
          'What sources are you using about Friday dinner after rehearsal?',
      },
    });

    expect(telegram.replyText).toContain('*Sources I would use*');
    expect(telegram.replyText).toContain('Knowledge Proof Dinner Title');
    expect(telegram.replyText).toContain('*Why these sources*');
    expect(alexa.replyText).toContain('I would use');
    expect((alexa.replyText || '').toLowerCase()).toContain(
      'friday dinner after rehearsal',
    );
  });

  it('keeps media image generation explicit and reports provider unavailability honestly', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: {
            message: 'Billing hard limit has been reached.',
            type: 'billing_limit_user_error',
            code: 'billing_hard_limit_reached',
          },
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }) as typeof fetch;

    const result = await executeAssistantCapability({
      capabilityId: 'media.image_generate',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
      },
      input: {
        canonicalText: 'a poster for a spring dinner party',
      },
    });

    expect(result.handled).toBe(true);
    expect(result.mediaResult?.providerStatus.provider).toBe('openai_images');
    expect(result.replyText).toContain("I can't make that image right now");
    expect(result.replyText).toContain('tighten the prompt');
    expect(result.mediaResult?.blocker?.toLowerCase()).toMatch(/quota|billing/);
    expect(result.trace?.responseSource).toBe('unavailable');
  });

  it('runs ritual status, configuration, and follow-through capabilities through the shared core', async () => {
    const enabled = await executeAssistantCapability({
      capabilityId: 'rituals.configure',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
      },
      input: {
        canonicalText: 'enable morning brief',
      },
    });

    expect(enabled.handled).toBe(true);
    expect(enabled.replyText).toContain('Telegram');

    await executeAssistantCapability({
      capabilityId: 'threads.explicit_lookup',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
      },
      input: {
        canonicalText:
          'remind me to talk to Candace about dinner plans tonight',
      },
    });

    const status = await executeAssistantCapability({
      capabilityId: 'rituals.status',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
      },
      input: {
        canonicalText: 'what rituals do I have enabled',
      },
    });
    const followthrough = await executeAssistantCapability({
      capabilityId: 'rituals.followthrough',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
      },
      input: {
        canonicalText: 'what follow-ups am I carrying right now',
      },
    });
    const alexaFollowthrough = await executeAssistantCapability({
      capabilityId: 'rituals.followthrough',
      context: {
        channel: 'alexa',
        groupFolder: 'main',
      },
      input: {
        canonicalText: 'what should I follow up on',
      },
    });

    expect(status.handled).toBe(true);
    expect(status.replyText).toContain('Morning brief: scheduled');
    expect(followthrough.handled).toBe(true);
    expect(followthrough.replyText).toContain('Follow-through candidates');
    expect(followthrough.replyText).toContain('approve #1');
    expect(followthrough.trace?.responseSource).toBe('local_companion');
    expect(followthrough.outcomeMetadata).toMatchObject({
      source: 'followthrough_activation',
      outcomeKind: 'reviewed',
    });
    expect(alexaFollowthrough.handled).toBe(true);
    expect(alexaFollowthrough.replyText).not.toContain('- ');
  });
});
