import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  executeAssistantCapability,
  getAssistantCapability,
  getAssistantCapabilityRegistry,
} from './assistant-capabilities.js';
import {
  createTask,
  listKnowledgeSourcesForGroup,
  _initTestDatabase,
} from './db.js';

const originalFetch = globalThis.fetch;

describe('assistant capabilities', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
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

    expect(getAssistantCapability('work.current_logs')).toMatchObject({
      operatorOnly: true,
      safeForAlexa: false,
      safeForTelegram: true,
      safeForBlueBubbles: false,
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
      getAssistantCapability('media.image_generate')?.availabilityNote,
    ).toContain('Telegram image generation is wired');
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
    expect(result.replyText).toContain('quota or billing limit');
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
        canonicalText: 'remind me to talk to Candace about dinner plans tonight',
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
