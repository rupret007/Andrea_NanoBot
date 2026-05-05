import { describe, expect, it, vi } from 'vitest';

import { runObservableProviderCouncil } from './provider-council-runner.js';

describe('provider council runner', () => {
  it('runs bounded planner critic verifier evidence sequence and finalizes platform arbitration', async () => {
    const events: Array<Record<string, unknown>> = [];
    const members: Array<Record<string, unknown>> = [];
    const finalize = vi.fn(async () => ({}));

    const result = await runObservableProviderCouncil(
      {
        goal: 'Handle research turn from telegram via direct_assistant.',
        taskFamily: 'research',
        channel: 'telegram',
        correlationId: 'turn-council-runner',
        requestedMode: 'max_iq_council',
        requiredEvidence: 'strong',
      },
      {
        emitProviderCouncil: vi.fn(async () => ({
          councilRunId: 'council-runner-1',
          requestId: 'request-1',
          verdictId: 'verdict-1',
          mode: 'max_iq_council' as const,
          status: 'completed',
          traceId: 'turn-council-runner',
          finalRoute: 'max_iq_council',
          answerStrategy: 'verified_synthesis',
          confidence: 0.9,
          approvalRequired: false,
        })),
        emitCouncilEvent: vi.fn(async (event) => {
          events.push(event as unknown as Record<string, unknown>);
          return {};
        }),
        emitMemberResult: vi.fn(async (member) => {
          members.push(member as unknown as Record<string, unknown>);
          return {};
        }),
        finalizeCouncil: finalize,
        searchBrave: vi.fn(async () => ({
          query: 'q',
          requestId: 'brave-1',
          results: [
            {
              title: 'Agent orchestration',
              url: 'https://example.com/agents',
              description: 'Observable agent councils need evidence.',
            },
          ],
        })),
        runOpenAi: vi.fn(async () => ({
          text: 'Plan: use evidence, critic, verifier, then platform arbitration.',
          model: 'gpt-5.4',
          requestId: 'openai-1',
        })),
        runMiniMax: vi.fn(async () => ({
          text: 'Critique: ensure the verifier can override weak evidence.',
          model: 'MiniMax-M2.7',
          requestId: 'minimax-1',
        })),
        runGemini: vi.fn(async () => ({
          text: 'Verdict: proceed with verified synthesis.',
          model: 'gemini-2.5-pro',
          requestId: 'gemini-1',
        })),
        now: (() => {
          let value = 0;
          return () => {
            value += 10;
            return value;
          };
        })(),
      },
    );

    expect(result?.councilRunId).toBe('council-runner-1');
    expect(events.map((event) => event.eventType)).toContain('start');
    expect(members.map((member) => member.memberId)).toEqual([
      'brave_search',
      'openai_cloud',
      'minimax_cloud',
      'gemini_cloud',
    ]);
    expect(
      members.find((member) => member.memberId === 'gemini_cloud'),
    ).toMatchObject({
      role: 'verifier',
      status: 'completed',
      model: 'gemini-2.5-pro',
    });
    expect(finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        councilRunId: 'council-runner-1',
        platformArbitrationReason: expect.stringContaining(
          'Platform arbitration',
        ),
      }),
    );
  });

  it('records degraded council truth instead of pretending full provider participation', async () => {
    const members: Array<Record<string, unknown>> = [];

    await runObservableProviderCouncil(
      {
        goal: 'Handle operator turn from telegram via direct_assistant.',
        taskFamily: 'operator',
        channel: 'telegram',
        correlationId: 'turn-council-degraded',
        requestedMode: 'max_iq_council',
      },
      {
        emitProviderCouncil: vi.fn(async () => ({
          councilRunId: 'council-degraded-1',
          mode: 'max_iq_council' as const,
          traceId: 'turn-council-degraded',
        })),
        emitCouncilEvent: vi.fn(async () => ({})),
        emitMemberResult: vi.fn(async (member) => {
          members.push(member as unknown as Record<string, unknown>);
          return {};
        }),
        finalizeCouncil: vi.fn(async () => ({})),
        searchBrave: vi.fn(async () => ({
          providerFailure: 'Brave Search quota blocked this request.',
          status: 429,
        })),
        runOpenAi: vi.fn(async () => null),
        runMiniMax: vi.fn(async () => null),
        runGemini: vi.fn(async () => null),
      },
    );

    expect(members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memberId: 'brave_search',
          status: 'blocked',
          riskFlags: ['brave_unavailable_saved_context'],
        }),
        expect.objectContaining({
          memberId: 'openai_cloud',
          status: 'blocked',
          riskFlags: ['openai_planner_unavailable'],
        }),
        expect.objectContaining({
          memberId: 'minimax_cloud',
          status: 'blocked',
          riskFlags: ['minimax_critic_unavailable'],
        }),
        expect.objectContaining({
          memberId: 'gemini_cloud',
          status: 'blocked',
          riskFlags: ['gemini_verifier_unavailable'],
        }),
      ]),
    );
  });
});
