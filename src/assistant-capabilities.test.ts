import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  executeAssistantCapability,
  getAssistantCapability,
  getAssistantCapabilityRegistry,
} from './assistant-capabilities.js';
import {
  createTask,
  listKnowledgeSourcesForGroup,
  listMessageActionsForGroup,
  storeChatMetadata,
  storeMessage,
  _initTestDatabase,
} from './db.js';
import { planSimpleReminder } from './local-reminder.js';
import { ALL_SYNCED_MESSAGES_TARGET } from './thread-summary-routing.js';

const originalFetch = globalThis.fetch;

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

  it('summarizes a synced BlueBubbles thread by name without creating side effects', async () => {
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
        chatJid: 'tg:8004355504',
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
    expect(result.replyText).toContain('adaptation choices');
    expect(result.replyText).toContain('The thread compared how faithfully');
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
      sender: 'bb:+14697852580',
      sender_name: '+14697852580',
      content:
        'Yesterday everyone was still just figuring out whether to read the comics first.',
      timestamp: '2026-04-14T23:10:00.000Z',
      is_from_me: false,
    });
    storeMessage({
      id: 'msg-pops-today-1',
      chat_jid: 'bb:iMessage;+;chat-pops-clean',
      sender: 'bb:+14697852580',
      sender_name: '+14697852580',
      content:
        'I think Fallout works because it keeps the world right while still telling a continuation story.',
      timestamp: '2026-04-15T16:46:28.314Z',
      is_from_me: false,
    });
    storeMessage({
      id: 'msg-pops-today-2',
      chat_jid: 'bb:iMessage;+;chat-pops-clean',
      sender: 'bb:+13373027596',
      sender_name: '+13373027596',
      content:
        'I do not want an adaptation to just repeat the exact same material with a different format.',
      timestamp: '2026-04-15T16:48:09.713Z',
      is_from_me: false,
    });
    storeMessage({
      id: 'msg-pops-today-3',
      chat_jid: 'bb:iMessage;+;chat-pops-clean',
      sender: 'bb:+13373027596',
      sender_name: '+13373027596',
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
        chatJid: 'tg:8004355504',
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
    expect(result.replyText).not.toContain('+14697852580');
    expect(result.replyText).not.toContain('+13373027596');
    expect(result.replyText).not.toContain(
      'Yesterday everyone was still just figuring out',
    );
  });

  it('summarizes all synced Messages activity for broad today requests', async () => {
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
      sender: 'bb:+13373027596',
      sender_name: '+13373027596',
      content: 'Fallout still has the best worldbuilding argument.',
      timestamp: '2026-04-15T18:51:51.947Z',
      is_from_me: false,
    });

    const result = await executeAssistantCapability({
      capabilityId: 'communication.summarize_thread',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:8004355504',
        now: new Date('2026-04-15T19:00:00-05:00'),
      },
      input: {
        canonicalText: 'summarize all synced text messages from today',
        targetChatJid: ALL_SYNCED_MESSAGES_TARGET,
        timeWindowKind: 'today',
      },
    });

    expect(result.handled).toBe(true);
    expect(result.replyText).toContain('I found 2 synced Messages turns');
    expect(result.replyText).toContain('Pops of Punk');
    expect(result.replyText).toContain('Messages chat');
    expect(result.replyText).not.toContain('+14695550123');
    expect(result.trace?.notes).toContain('window:today');
  });

  it('reads upcoming reminders from local scheduled tasks', async () => {
    const planned = planSimpleReminder(
      'remind me tomorrow afternoon at 4:15pm to review the Andrea QA reminder path',
      'main',
      'tg:8004355504',
      new Date('2026-04-15T12:00:00-05:00'),
    );
    expect(planned).not.toBeNull();
    createTask(planned!.task);

    const result = await executeAssistantCapability({
      capabilityId: 'followthrough.reminder_overview',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:8004355504',
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
        chatJid: 'tg:8004355504',
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
      chat_jid: 'tg:8004355504',
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
      chat_jid: 'tg:8004355504',
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
        chatJid: 'tg:8004355504',
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

  it('runs everyday capture execution and carries list continuation context forward', async () => {
    const add = await executeAssistantCapability({
      capabilityId: 'capture.add_item',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:8004355504',
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
        chatJid: 'tg:8004355504',
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
        chatJid: 'tg:8004355504',
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
        chatJid: 'tg:8004355504',
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
        chatJid: 'tg:8004355504',
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
        chatJid: 'tg:8004355504',
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
      chat_jid: 'tg:8004355504',
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
      chat_jid: 'tg:8004355504',
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
        chatJid: 'tg:8004355504',
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
    expect(telegram.replyText).toContain('*Why this route*');
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
        chatJid: 'tg:8004355504',
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
        chatJid: 'bb:iMessage;-;jeffstory007@gmail.com',
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
        chatJid: 'tg:8004355504',
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
        chatJid: 'tg:8004355504',
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
    expect(alexa.replyText).toContain('saved material');
    expect(alexa.researchResult?.supportingSources?.[0]?.title).toBeTruthy();
  });

  it('runs shared communication capabilities with continuation context across channels', async () => {
    const understand = await executeAssistantCapability({
      capabilityId: 'communication.understand_message',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:8004355504',
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
  });

  it('keeps explicit person-and-topic draft asks grounded after an open-loops turn', async () => {
    const understand = await executeAssistantCapability({
      capabilityId: 'communication.understand_message',
      context: {
        channel: 'telegram',
        groupFolder: 'main',
        chatJid: 'tg:8004355504',
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
        chatJid: 'tg:8004355504',
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
        chatJid: 'tg:8004355504',
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
        chatJid: 'tg:8004355504',
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
        chatJid: 'tg:8004355504',
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
        chatJid: 'tg:8004355504',
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
        chatJid: 'tg:8004355504',
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
        chatJid: 'tg:8004355504',
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
        chatJid: 'tg:8004355504',
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
        chatJid: 'tg:8004355504',
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
        chatJid: 'tg:8004355504',
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
    expect(followthrough.replyText).toContain('Follow-through right now');
    expect(followthrough.trace?.responseSource).toBe('life_thread_local');
    expect(alexaFollowthrough.handled).toBe(true);
    expect(alexaFollowthrough.replyText).not.toContain('- ');
  });
});
