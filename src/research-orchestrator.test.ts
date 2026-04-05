import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTask, _initTestDatabase } from './db.js';
import { handleLifeThreadCommand } from './life-threads.js';
import {
  planResearchRequest,
  runResearchOrchestrator,
} from './research-orchestrator.js';

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.OPENAI_API_KEY;
const originalBaseUrl = process.env.OPENAI_BASE_URL;

describe('research orchestrator', () => {
  beforeEach(() => {
    _initTestDatabase();
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    process.env.OPENAI_API_KEY = originalApiKey;
    process.env.OPENAI_BASE_URL = originalBaseUrl;
    globalThis.fetch = originalFetch;
  });

  it('selects the runtime delegate for execution-heavy requests', () => {
    const plan = planResearchRequest({
      query: 'Research the runtime logs for this repo and compare failures',
      channel: 'telegram',
      groupFolder: 'main',
    });

    expect(plan.primarySource).toBe('runtime_delegate');
  });

  it('builds a grounded local-context answer when personal context is available', async () => {
    handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:8004355504',
      text: 'save this under the Candace thread',
      replyText: 'Confirm dinner plans and pickup timing.',
      now: new Date('2026-04-05T09:00:00.000Z'),
    });
    createTask({
      id: 'task-research-local',
      group_folder: 'main',
      chat_jid: 'tg:8004355504',
      prompt: 'Review the school pickup timing',
      schedule_type: 'once',
      schedule_value: '2026-04-05T20:00:00.000Z',
      context_mode: 'group',
      next_run: '2026-04-05T20:00:00.000Z',
      status: 'active',
      created_at: '2026-04-05T09:10:00.000Z',
    });

    const result = await runResearchOrchestrator({
      query: 'Summarize what matters from my current context',
      channel: 'telegram',
      groupFolder: 'main',
      now: new Date('2026-04-05T10:00:00.000Z'),
    });

    expect(result.handled).toBe(true);
    expect(result.providerUsed).toBe('local_context');
    expect(result.fullText).toContain('grounded');
    expect(result.sourceNotes).toContain('life threads');
  });

  it('uses OpenAI Responses when configured and returns a bounded research answer', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_BASE_URL = 'https://example.test/v1';
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          output_text:
            'The strongest option is the one with the lower cost and simpler delivery window.',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }) as typeof fetch;

    const result = await runResearchOrchestrator({
      query: 'Compare meal delivery options for this week',
      channel: 'alexa',
      groupFolder: 'main',
      now: new Date('2026-04-05T11:00:00.000Z'),
    });

    expect(globalThis.fetch).toHaveBeenCalled();
    expect(result.handled).toBe(true);
    expect(result.providerUsed).toBe('openai_responses');
    expect(result.summaryText).toContain('The strongest option');
  });
});
