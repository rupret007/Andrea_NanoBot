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

  it('contains transport exceptions as provider degradation', async () => {
    const members: Array<Record<string, unknown>> = [];

    const result = await runObservableProviderCouncil(
      {
        goal: 'Research the current provider status safely.',
        taskFamily: 'research',
        channel: 'system',
        correlationId: 'turn-council-transport-error',
        requestedMode: 'max_iq_council',
      },
      {
        emitProviderCouncil: vi.fn(async () => ({
          councilRunId: 'council-transport-error',
          mode: 'max_iq_council' as const,
          traceId: 'turn-council-transport-error',
        })),
        emitCouncilEvent: vi.fn(async () => ({})),
        emitMemberResult: vi.fn(async (member) => {
          members.push(member as unknown as Record<string, unknown>);
          return {};
        }),
        finalizeCouncil: vi.fn(async () => ({})),
        searchBrave: vi.fn(async () => {
          throw new TypeError('fetch failed');
        }),
        runOpenAi: vi.fn(async () => ({
          text: 'Planner can continue with degraded live evidence.',
          model: 'gpt-5.4',
        })),
        runMiniMax: vi.fn(async () => ({
          text: 'Critic flags missing live evidence.',
          model: 'MiniMax-M2.7',
        })),
        runGemini: vi.fn(async () => ({
          text: 'Verifier says proceed only with blocker wording.',
          model: 'gemini-2.5-pro',
        })),
      },
    );

    expect(
      members.find((member) => member.memberId === 'brave_search'),
    ).toMatchObject({
      status: 'blocked',
      riskFlags: ['brave_unavailable_saved_context'],
    });
    expect(result?.providerFailures || []).toContain(
      'brave_unavailable_saved_context',
    );
  });

  it('falls back to the fast Gemini verifier when Pro produces no artifact', async () => {
    const members: Array<Record<string, unknown>> = [];
    const runGemini = vi
      .fn()
      .mockResolvedValueOnce({
        providerFailure: 'Gemini returned an empty text payload.',
      })
      .mockResolvedValueOnce({
        text: 'Fast verifier verdict: warn, proceed only with evidence gates.',
        model: 'gemini-2.5-flash',
        requestId: 'gemini-fast-1',
      });

    const result = await runObservableProviderCouncil(
      {
        goal: 'Review a high-impact repair policy.',
        taskFamily: 'operator',
        channel: 'system',
        correlationId: 'turn-council-gemini-fallback',
        requestedMode: 'max_iq_council',
        requiredEvidence: 'strong',
      },
      {
        emitProviderCouncil: vi.fn(async () => ({
          councilRunId: 'council-gemini-fallback',
          mode: 'max_iq_council' as const,
          traceId: 'turn-council-gemini-fallback',
        })),
        emitCouncilEvent: vi.fn(async () => ({})),
        emitMemberResult: vi.fn(async (member) => {
          members.push(member as unknown as Record<string, unknown>);
          return {};
        }),
        finalizeCouncil: vi.fn(async () => ({})),
        searchBrave: vi.fn(async () => ({
          query: 'q',
          results: [
            {
              title: 'Evidence',
              url: 'https://example.com/evidence',
              description: 'Verification needs evidence.',
            },
          ],
        })),
        runOpenAi: vi.fn(async () => ({
          text: 'Planner artifact.',
          model: 'gpt-5.4',
        })),
        runMiniMax: vi.fn(async () => ({
          text: 'Critic artifact.',
          model: 'MiniMax-M2.7',
        })),
        runGemini,
      },
    );

    expect(runGemini).toHaveBeenCalledTimes(2);
    expect(runGemini.mock.calls[0]?.[0]).toMatchObject({
      modelTier: 'critic',
    });
    expect(runGemini.mock.calls[1]?.[0]).toMatchObject({
      modelTier: 'fast',
    });
    expect(
      members.find((member) => member.memberId === 'gemini_cloud'),
    ).toMatchObject({
      status: 'completed',
      model: 'gemini-2.5-flash',
      riskFlags: ['gemini_fast_fallback_used'],
    });
    expect(result?.providerFailures || []).not.toContain(
      'gemini_verifier_unavailable',
    );
  });
});
