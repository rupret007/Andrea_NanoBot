import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  executeAssistantCapability,
  getAssistantCapability,
  getAssistantCapabilityRegistry,
} from './assistant-capabilities.js';
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
  _initTestDatabase,
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
    storeMessage({
      id: 'msg-pops-command',
      chat_jid: 'bb:iMessage;+;chat-pops-clean',
      sender: 'me',
      sender_name: 'Jeff',
      content: '@Andrea summarize this',
      timestamp: '2026-04-15T18:55:51.947Z',
      is_from_me: true,
    });

    const result = await executeAssistantCapability({
      capabilityId: 'communication.summarize_thread',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
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
    expect(result.replyText).not.toContain('+12025550102');
    expect(result.replyText).not.toContain('+12025550103');
    expect(result.replyText).not.toContain('@Andrea');
    expect(result.replyText).not.toContain(
      'Yesterday everyone was still just figuring out',
    );
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

    const result = await executeAssistantCapability({
      capabilityId: 'communication.summarize_thread',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:100000001',
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
    expect(result.replyText).toContain('Decisions');
    expect(result.replyText).toContain(
      "We agreed to use Fallout's worldbuilding",
    );
    expect(result.replyText).toContain('Open questions');
    expect(result.replyText).toContain('Can you send me the dinner address?');
    expect(result.replyText).toContain('Reply priorities');
    expect(result.replyText).toContain('Pops of Punk');
    expect(result.replyText).toContain('Messages chat');
    expect(result.replyText).not.toContain('+14695550123');
    expect(result.trace?.notes).toContain('window:today');
    expect(result.trace?.notes).toContain('digest_source:openai_grounded');
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
    expect(result.trace?.notes).toContain(
      'digest_source:local_untrusted_provider',
    );
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

  it('reviews recent texts without creating message actions until a selected draft follow-up', async () => {
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
        now: new Date('2026-04-15T17:00:00.000Z'),
      },
      input: {
        canonicalText: 'review recent text messages from today',
        timeWindowKind: 'today',
      },
    });

    expect(review.handled).toBe(true);
    expect(review.replyText).toContain('Needs reply');
    expect(review.replyText).toContain('draft #1');
    expect(review.outcomeMetadata).toMatchObject({
      source: 'recent_text_review',
      outcomeKind: 'suggested',
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
        priorSubjectData: review.conversationSeed?.subjectData,
      },
      input: {
        text: 'draft #1',
        canonicalText: 'draft #1',
      },
    });

    expect(draft.handled).toBe(true);
    expect(draft.messageAction).toMatchObject({
      targetChannel: 'bluebubbles',
      targetKind: 'external_thread',
      sendStatus: 'drafted',
      requiresApproval: true,
      delegationRuleId: null,
    });
    expect(draft.outcomeMetadata).toMatchObject({
      source: 'recent_text_review',
      outcomeKind: 'drafted',
      sendStatus: 'drafted',
      itemRank: 1,
    });
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
    const recentTextReviewJson = JSON.stringify({
      version: 1,
      reviewedAt: '2026-04-15T17:00:00.000Z',
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
        },
      ],
    });
    const baseContext = {
      channel: 'telegram' as const,
      groupFolder: 'main',
      chatJid: 'tg:100000001',
      now: new Date('2026-04-15T17:05:00.000Z'),
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
    expect(skipped.messageAction).toMatchObject({
      sendStatus: 'skipped',
      lastActionKind: 'skipped',
    });
    expect(skipped.outcomeMetadata).toMatchObject({
      outcomeKind: 'skipped',
      lastActionKind: 'skipped',
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
    expect(result.replyText).toContain('current Messages thread binding');
    expect(result.messageAction).toBeUndefined();
    expect(result.outcomeMetadata).toMatchObject({
      outcomeKind: 'blocked_unbound',
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
    expect(draft.replyText).toContain('Draft:');
    expect(draft.handoffPayload?.kind).toBe('message');
    expect(draft.messageAction?.messageActionId).toBeTruthy();
    expect(
      listMessageActionsForGroup({ groupFolder: 'main', includeSent: true }),
    ).toContainEqual(
      expect.objectContaining({
        messageActionId: draft.messageAction?.messageActionId,
        presentationChatJid: 'bb:chat-1',
        sendStatus: 'drafted',
      }),
    );

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

  it('uses the Messages model lane for BlueBubbles draft replies when available', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_BASE_URL', 'https://openai.test/v1');
    globalThis.fetch = vi.fn(
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
    ) as typeof fetch;

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
    expect(draft.replyText).toContain('tonight still works for me');
    expect(draft.messageAction?.messageActionId).toBeTruthy();
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
