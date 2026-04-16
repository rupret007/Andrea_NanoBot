import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTask, upsertLifeThread, _initTestDatabase } from './db.js';
import { handleLifeThreadCommand } from './life-threads.js';
import { saveKnowledgeSource } from './knowledge-library.js';
import * as openAiProvider from './openai-provider.js';
import {
  isResearchPrompt,
  planResearchRequest,
  runResearchOrchestrator,
} from './research-orchestrator.js';

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.OPENAI_API_KEY;
const originalBaseUrl = process.env.OPENAI_BASE_URL;
const originalSimpleModel = process.env.OPENAI_MODEL_SIMPLE;
const originalStandardModel = process.env.OPENAI_MODEL_STANDARD;
const originalComplexModel = process.env.OPENAI_MODEL_COMPLEX;

describe('research orchestrator', () => {
  beforeEach(() => {
    _initTestDatabase();
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_MODEL_SIMPLE;
    delete process.env.OPENAI_MODEL_STANDARD;
    delete process.env.OPENAI_MODEL_COMPLEX;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env.OPENAI_API_KEY = originalApiKey;
    process.env.OPENAI_BASE_URL = originalBaseUrl;
    process.env.OPENAI_MODEL_SIMPLE = originalSimpleModel;
    process.env.OPENAI_MODEL_STANDARD = originalStandardModel;
    process.env.OPENAI_MODEL_COMPLEX = originalComplexModel;
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

  it('plans outward-facing comparison prompts onto the OpenAI path even before config is present', () => {
    const plan = planResearchRequest({
      query: 'What are the pros and cons of meal delivery this week?',
      channel: 'telegram',
      groupFolder: 'main',
    });

    expect(plan.primarySource).toBe('openai_responses');
    expect(plan.sources.webSearch).toBe(true);
  });

  it('recognizes plain factoid and explanatory prompts as research-worthy without catching local utilities', () => {
    expect(isResearchPrompt("What is Jar Jar Binks' species?")).toBe(true);
    expect(isResearchPrompt('What should I know about Jar Jar Binks?')).toBe(
      true,
    );
    expect(isResearchPrompt('What time is it in Australia?')).toBe(false);
    expect(isResearchPrompt("What's still open with Candace?")).toBe(false);
  });

  it('plans saved-material prompts onto the knowledge-library route', () => {
    const plan = planResearchRequest({
      query: 'What do my saved notes say about Candace?',
      channel: 'telegram',
      groupFolder: 'main',
    });

    expect(plan.primarySource).toBe('knowledge_library');
    expect(plan.sources.knowledgeLibrary).toBe(true);
    expect(plan.sources.openAiResponses).toBe(false);
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
    expect(result.routeExplanation).toContain('local context');
    expect(result.structuredFindings[0]?.items[0]).toContain('Candace');
    expect(result.sourceNotes).toContain('life threads');
    expect(result.followupSuggestions.length).toBeGreaterThan(0);
  });

  it('strips reminder-system prompt wording from local task context before surfacing it', async () => {
    createTask({
      id: 'task-research-reminder',
      group_folder: 'main',
      chat_jid: 'tg:8004355504',
      prompt:
        'Send a concise reminder telling the user to decide whether to switch dinner plans.',
      schedule_type: 'once',
      schedule_value: '2026-04-05T20:00:00.000Z',
      context_mode: 'group',
      next_run: '2026-04-05T20:00:00.000Z',
      status: 'active',
      created_at: '2026-04-05T09:10:00.000Z',
    });

    const result = await runResearchOrchestrator({
      query: 'Summarize what matters from my current context',
      channel: 'alexa',
      groupFolder: 'main',
      now: new Date('2026-04-05T10:00:00.000Z'),
    });

    expect(result.handled).toBe(true);
    expect(result.summaryText).toContain('decide whether to switch dinner plans');
    expect(result.summaryText).not.toContain('Send a concise reminder');
    expect(result.fullText).not.toContain('Send a concise reminder');
  });

  it('normalizes generic life-thread titles and assistant-y thread summaries in local context research', async () => {
    upsertLifeThread({
      id: 'lt-research-followup',
      groupFolder: 'main',
      title: 'Follow-Up',
      category: 'personal',
      status: 'active',
      scope: 'personal',
      relatedSubjectIds: [],
      contextTags: ['pest-control'],
      summary:
        'The first fixed point in your day is pest control is coming at 1:00 PM.',
      nextAction: null,
      nextFollowupAt: null,
      sourceKind: 'inferred',
      confidenceKind: 'high',
      userConfirmed: true,
      sensitivity: 'normal',
      surfaceMode: 'default',
      mergedIntoThreadId: null,
      createdAt: '2026-04-05T08:55:00.000Z',
      lastUpdatedAt: '2026-04-05T09:30:00.000Z',
      lastUsedAt: '2026-04-05T09:30:00.000Z',
      followthroughMode: 'important_only',
      lastSurfacedAt: null,
      snoozedUntil: null,
      linkedTaskId: null,
    });

    const result = await runResearchOrchestrator({
      query: 'Summarize what matters from my current context',
      channel: 'telegram',
      groupFolder: 'main',
      now: new Date('2026-04-05T10:00:00.000Z'),
    });

    expect(result.handled).toBe(true);
    expect(result.summaryText).toContain('Pest control is coming at 1:00 PM');
    expect(result.summaryText).not.toContain('Follow-Up');
    expect(result.summaryText).not.toContain('The first fixed point in your day is');
    expect(result.structuredFindings[0]?.items[0]).toBe(
      'Pest control is coming at 1:00 PM.',
    );
  });

  it('builds a grounded library answer when saved sources are requested', async () => {
    saveKnowledgeSource({
      groupFolder: 'main',
      title: 'Candace Dinner Note',
      content:
        'Candace wants Friday dinner after rehearsal because pickup timing is easier and bedtime stays calmer.',
      sourceType: 'manual_reference',
      now: new Date('2026-04-05T09:00:00.000Z'),
    });

    const result = await runResearchOrchestrator({
      query: 'What do my saved notes say about Candace dinner timing?',
      channel: 'telegram',
      groupFolder: 'main',
      now: new Date('2026-04-05T10:00:00.000Z'),
    });

    expect(result.handled).toBe(true);
    expect(result.providerUsed).toBe('knowledge_library');
    expect(result.routeExplanation).toContain('saved material');
    expect(result.supportingSources?.[0]?.title).toBe('Candace Dinner Note');
    expect(result.structuredFindings[0]?.items[0]).toContain(
      'Candace Dinner Note',
    );
  });

  it('dedupes saved-source provenance and keeps Alexa library summaries concise', async () => {
    saveKnowledgeSource({
      groupFolder: 'main',
      title: 'Long Dinner Notes',
      content: [
        'Candace dinner timing note: Friday after rehearsal keeps pickup simpler.',
        'Candace dinner timing note: Friday also avoids a late bedtime if rehearsal runs long.',
        'Candace dinner timing note: Saturday leaves more prep time, but it makes the handoff less simple.',
      ].join('\n\n'),
      sourceType: 'manual_reference',
      now: new Date('2026-04-05T09:00:00.000Z'),
    });
    saveKnowledgeSource({
      groupFolder: 'main',
      title: 'Backup Dinner Summary',
      content:
        'Backup summary: Saturday dinner is calmer for prep, but Friday is easier for pickup and bedtime.',
      sourceType: 'saved_research_result',
      now: new Date('2026-04-05T09:05:00.000Z'),
    });

    const result = await runResearchOrchestrator({
      query:
        'Use only my saved material to compare saved sources about Candace dinner timing.',
      channel: 'alexa',
      groupFolder: 'main',
      now: new Date('2026-04-05T10:00:00.000Z'),
    });

    expect(result.handled).toBe(true);
    expect(result.providerUsed).toBe('knowledge_library');
    expect(result.supportingSources?.length).toBeGreaterThan(1);
    expect(
      new Set(result.supportingSources?.map((source) => source.title)).size,
    ).toBe(result.supportingSources?.length);
    expect(result.spokenText).toContain('saved material');
    expect(result.spokenText).not.toContain('Backup Dinner Summary');
    expect(result.spokenText).not.toContain('\n');
  });

  it('dedupes identical saved-material hits across different source records', async () => {
    saveKnowledgeSource({
      groupFolder: 'main',
      title: 'Candace Dinner Note',
      content:
        'Candace wants Friday dinner after rehearsal because pickup timing stays simpler and bedtime does not get squeezed.',
      sourceType: 'manual_reference',
      now: new Date('2026-04-05T09:00:00.000Z'),
    });
    saveKnowledgeSource({
      groupFolder: 'main',
      title: 'Candace Dinner Note',
      content:
        'Candace wants Friday dinner after rehearsal because pickup timing stays simpler and bedtime does not get squeezed.',
      sourceType: 'saved_research_result',
      now: new Date('2026-04-05T09:05:00.000Z'),
    });

    const result = await runResearchOrchestrator({
      query: 'Use only my saved material for Friday dinner with Candace.',
      channel: 'telegram',
      groupFolder: 'main',
      now: new Date('2026-04-05T10:00:00.000Z'),
    });

    const fullText = result.fullText || '';
    expect(result.supportingSources).toHaveLength(1);
    expect(result.supportingSources?.[0]?.title).toBe('Candace Dinner Note');
    expect(result.structuredFindings[0]?.items).toHaveLength(1);
    expect(fullText.match(/Candace Dinner Note/g)?.length).toBe(2);
  });

  it('returns an exact blocker when an OpenAI-style research question has no configured provider or local fallback', async () => {
    vi.spyOn(openAiProvider, 'getOpenAiProviderStatus').mockReturnValue({
      configured: false,
      missing: ['OPENAI_API_KEY'],
      baseUrl: 'https://api.openai.com/v1',
      simpleModel: 'gpt-5.4-mini',
      standardModel: 'gpt-5.4',
      complexModel: 'gpt-5.4',
      researchModel: 'gpt-5.4',
      imageModel: 'gpt-image-1',
    });

    const result = await runResearchOrchestrator({
      query: 'Compare the best standing desks for a small apartment',
      channel: 'telegram',
      now: new Date('2026-04-05T10:00:00.000Z'),
    });

    expect(result.handled).toBe(true);
    expect(result.summaryText).toContain("can't check that live right now");
    expect(result.summaryText).not.toContain('OPENAI_API_KEY');
    expect(result.sourceNotes[0]).toContain('OPENAI_API_KEY');
    expect(result.debugPath).toContain('openai.blocked=OPENAI_API_KEY');
  });

  it('uses OpenAI Responses when configured and returns a bounded research answer', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_BASE_URL = 'https://example.test/v1';
    process.env.OPENAI_MODEL_COMPLEX = 'gpt-5.4-complex';
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          output_text: [
            'Summary: The strongest option is the one with the lower cost and simpler delivery window.',
            'Findings:',
            '- Lower cost',
            '- Simpler delivery window',
            'Recommendation: Pick the cheaper option if flexibility matters most.',
            'Follow-ups:',
            '- Want the tradeoffs in one line?',
          ].join('\n'),
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
    const firstCallBody = JSON.parse(
      String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body),
    ) as { model: string };
    expect(firstCallBody.model).toBe('gpt-5.4-complex');
    expect(result.handled).toBe(true);
    expect(result.providerUsed).toBe('openai_responses');
    expect(result.summaryText).toContain('The strongest option');
    expect(result.routeExplanation).toContain('OpenAI-backed');
    expect(result.structuredFindings[0]?.items[0]).toContain('Lower cost');
  });

  it('asks for the two items when a compare prompt is too generic', async () => {
    const result = await runResearchOrchestrator({
      query: 'compare these two for me',
      channel: 'telegram',
      groupFolder: 'main',
      now: new Date('2026-04-16T13:00:00.000Z'),
    });

    expect(result.handled).toBe(true);
    expect(result.kind).toBe('compare');
    expect(result.summaryText).toContain(
      'Tell me the two things you want me to compare',
    );
    expect(result.debugPath).toContain('research.compare_clarify');
    expect(result.structuredFindings).toEqual([]);
  });

  it('asks for the options when a recommendation prompt is too generic', async () => {
    const result = await runResearchOrchestrator({
      query: 'recommend the better one',
      channel: 'telegram',
      groupFolder: 'main',
      now: new Date('2026-04-16T13:05:00.000Z'),
    });

    expect(result.handled).toBe(true);
    expect(result.kind).toBe('recommend');
    expect(result.summaryText).toContain(
      'Tell me the options you want me to weigh first',
    );
    expect(result.debugPath).toContain('research.compare_clarify');
    expect(result.structuredFindings).toEqual([]);
  });

  it('uses the simple tier for weather lookups and falls back upward when the cheap model is rejected', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_BASE_URL = 'https://example.test/v1';
    process.env.OPENAI_MODEL_SIMPLE = 'gpt-5.4-mini';
    process.env.OPENAI_MODEL_STANDARD = 'gpt-5.4-standard';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              message: 'The model gpt-5.4-mini does not exist.',
            },
          }),
          {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output_text: [
              'Summary: Dallas is warm and cloudy today.',
              'Findings:',
              '- High near 82°F',
              '- Small chance of rain after sunset',
              'Recommendation: Keep an umbrella handy tonight.',
              'Follow-ups:',
              '- Want tomorrow too?',
            ].join('\n'),
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      );
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await runResearchOrchestrator({
      query: 'What is the weather today in Dallas?',
      channel: 'telegram',
      groupFolder: 'main',
      now: new Date('2026-04-15T11:00:00.000Z'),
    });

    const firstModel = JSON.parse(
      String(fetchMock.mock.calls[0]?.[1]?.body),
    ) as { model: string };
    const secondModel = JSON.parse(
      String(fetchMock.mock.calls[1]?.[1]?.body),
    ) as { model: string };
    expect(firstModel.model).toBe('gpt-5.4-mini');
    expect(secondModel.model).toBe('gpt-5.4-standard');
    expect(result.summaryText).toContain('Dallas is warm and cloudy today.');
    expect(result.debugPath).toContain('selected_model_tier=standard');
  });

  it('can combine saved material with outside research when explicitly requested', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_BASE_URL = 'https://example.test/v1';
    saveKnowledgeSource({
      groupFolder: 'main',
      title: 'Saved Delivery Notes',
      content:
        'Saved note: grocery delivery wins when you need flexibility and lower weekly cost.',
      sourceType: 'saved_research_result',
    });
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          output_text: [
            'Summary: Grocery delivery stays more flexible, while meal delivery reduces planning effort.',
            'Findings:',
            '- Grocery delivery is cheaper over a full week.',
            '- Meal delivery cuts planning time.',
            'Recommendation: Start with grocery delivery unless convenience matters more.',
            'Follow-ups:',
            '- Want the short version?',
          ].join('\n'),
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }) as typeof fetch;

    const result = await runResearchOrchestrator({
      query:
        'Combine my notes with outside research on meal delivery versus grocery delivery.',
      channel: 'telegram',
      groupFolder: 'main',
      now: new Date('2026-04-05T11:30:00.000Z'),
    });

    expect(result.handled).toBe(true);
    expect(result.providerUsed).toBe('hybrid');
    expect(result.routeExplanation).toContain('combined');
    expect(result.supportingSources?.[0]?.title).toBe('Saved Delivery Notes');
  });

  it('returns an exact provider blocker instead of unrelated local context when OpenAI fails for an external prompt', async () => {
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

    const result = await runResearchOrchestrator({
      query:
        'Compare the Kindle Paperwhite and Kobo Clara Colour for someone who reads at night and cares about battery life.',
      channel: 'telegram',
      groupFolder: 'main',
      now: new Date('2026-04-05T11:00:00.000Z'),
    });

    expect(result.providerUsed).toBeUndefined();
    expect(result.summaryText).toContain("can't check that live right now");
    expect(result.routeExplanation).toContain('live lookup');
    expect(result.routeExplanation).not.toContain("OpenAI research path");
    expect(result.debugPath).toContain('openai.failed=true');
    expect(result.fullText).not.toContain('Band');
  });

  it('treats current-news requests as blocked external research instead of local context', async () => {
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

    const result = await runResearchOrchestrator({
      query: "What's the news today?",
      channel: 'telegram',
      groupFolder: 'main',
      now: new Date('2026-04-05T11:00:00.000Z'),
    });

    expect(result.providerUsed).toBeUndefined();
    expect(result.summaryText).toContain("can't check that live right now");
    expect(result.routeExplanation).toContain('live lookup');
    expect(result.fullText).not.toContain('Band');
    expect(result.fullText).not.toContain('local context');
  });

  it('treats weather requests as blocked external research instead of leaking runtime text', async () => {
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

    const result = await runResearchOrchestrator({
      query: 'What is the weather today in Dallas?',
      channel: 'telegram',
      groupFolder: 'main',
      now: new Date('2026-04-15T11:00:00.000Z'),
    });

    expect(result.providerUsed).toBeUndefined();
    expect(result.summaryText).toContain("can't check that live right now");
    expect(result.routeExplanation).toContain('live lookup');
    expect(result.fullText).not.toContain('temporary execution issue');
    expect(result.fullText).not.toContain('processing that request');
  });
});
