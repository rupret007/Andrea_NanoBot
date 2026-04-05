import { beforeEach, describe, expect, it } from 'vitest';

import {
  executeAssistantCapability,
  getAssistantCapability,
  getAssistantCapabilityRegistry,
} from './assistant-capabilities.js';
import { createTask, _initTestDatabase } from './db.js';

describe('assistant capabilities', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('registers shared daily, research, work, and media capabilities with safety metadata', () => {
    const registry = getAssistantCapabilityRegistry();
    expect(registry.some((entry) => entry.id === 'daily.loose_ends')).toBe(true);
    expect(registry.some((entry) => entry.id === 'pulse.interesting_thing')).toBe(
      true,
    );
    expect(registry.some((entry) => entry.id === 'research.compare')).toBe(true);
    expect(registry.some((entry) => entry.id === 'work.current_logs')).toBe(true);
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
    expect(getAssistantCapability('media.image_generate')?.availabilityNote).toContain(
      'Telegram image generation is wired',
    );
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
  });

  it('keeps media image generation explicit and reports the config blocker honestly', async () => {
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
    expect(result.replyText).toContain('OPENAI_API_KEY');
    expect(result.trace?.responseSource).toBe('unavailable');
  });
});
