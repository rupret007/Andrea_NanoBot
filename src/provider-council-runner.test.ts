import { describe, expect, it, vi } from 'vitest';

import { runObservableProviderCouncil } from './provider-council-runner.js';
import type { ProviderHealthSnapshot } from './provider-health.js';

function providerSnapshot(
  providerId: string,
  overrides: Partial<ProviderHealthSnapshot> = {},
): ProviderHealthSnapshot {
  return {
    providerId,
    kind: providerId === 'brave_search' ? 'search' : 'llm',
    state: 'healthy',
    lastHealthyAt: '2026-06-05T12:00:00.000Z',
    lastCheckedAt: '2026-06-05T12:00:00.000Z',
    failureClass: 'none',
    quotaState: 'unknown',
    credentialState: 'configured',
    knownExpiresAt: null,
    rotationDueAt: null,
    blocker: '',
    nextAction: '',
    metadata: {},
    ...overrides,
  };
}

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
        runAnthropic: vi.fn(async () => ({
          text: 'Independent reasoning: answer can proceed if uncertainty is named.',
          model: 'claude-test-sonnet',
          requestId: 'anthropic-1',
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
      'anthropic_cloud',
      'minimax_cloud',
      'gemini_cloud',
    ]);
    expect(
      members.find((member) => member.memberId === 'anthropic_cloud'),
    ).toMatchObject({
      role: 'synthesizer',
      status: 'completed',
      model: 'claude-test-sonnet',
    });
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
        metadata: expect.objectContaining({
          answer_guidance_status: 'warn',
        }),
      }),
    );
    expect(result?.answerGuidance).toMatchObject({
      status: 'warn',
      sourceMemberIds: expect.arrayContaining(['anthropic_cloud']),
    });
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
        runAnthropic: vi.fn(async () => null),
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
          memberId: 'anthropic_cloud',
          status: 'blocked',
          riskFlags: ['anthropic_reasoner_unavailable'],
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
        runAnthropic: vi.fn(async () => ({
          text: 'Independent reasoner says proceed with explicit uncertainty.',
          model: 'claude-test-sonnet',
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
        runAnthropic: vi.fn(async () => ({
          text: 'Independent reasoner artifact.',
          model: 'claude-test-sonnet',
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

  it('plans around blocked providers and substitutes OpenAI verifier when Gemini is unavailable', async () => {
    const members: Array<Record<string, unknown>> = [];
    const finalize = vi.fn(async () => ({}));
    const runOpenAi = vi
      .fn()
      .mockResolvedValueOnce({
        text: JSON.stringify({
          verdict: 'pass',
          confidence: 0.82,
          evidence_grade: 'partial',
          recommended_action: 'answer',
          answer_direction: 'Plan with available providers.',
          uncertainty: 'MiniMax and Gemini are unavailable.',
          risk_flags: [],
          evidence_ids: ['intent:turn-council-participation'],
          approval_need: 'none',
        }),
        model: 'gpt-5.4',
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          verdict: 'warn',
          confidence: 0.7,
          evidence_grade: 'partial',
          recommended_action: 'answer',
          answer_direction:
            'Proceed with reduced provider independence and clear uncertainty.',
          uncertainty:
            'Gemini verifier was quota-blocked, so OpenAI verified as fallback.',
          risk_flags: ['provider_independence_reduced'],
          evidence_ids: ['intent:turn-council-participation'],
          approval_need: 'none',
        }),
        model: 'gpt-5.4',
      });
    const runMiniMax = vi.fn(async () => ({
      text: 'MiniMax should not be called while health is externally blocked.',
      model: 'MiniMax-M2.7',
    }));
    const runGemini = vi.fn(async () => ({
      text: 'Gemini should not be called while health is externally blocked.',
      model: 'gemini-2.5-pro',
    }));

    const result = await runObservableProviderCouncil(
      {
        goal: 'Verify provider-aware route.',
        taskFamily: 'operator',
        channel: 'system',
        correlationId: 'turn-council-participation',
        requestedMode: 'max_iq_council',
      },
      {
        emitProviderCouncil: vi.fn(async () => ({
          councilRunId: 'council-participation',
          mode: 'max_iq_council' as const,
          traceId: 'turn-council-participation',
        })),
        emitCouncilEvent: vi.fn(async () => ({})),
        emitMemberResult: vi.fn(async (member) => {
          members.push(member as unknown as Record<string, unknown>);
          return {};
        }),
        finalizeCouncil: finalize,
        searchBrave: vi.fn(async () => ({
          query: 'provider-aware route',
          results: [],
        })),
        runOpenAi,
        runAnthropic: vi.fn(async () => ({
          text: JSON.stringify({
            verdict: 'warn',
            confidence: 0.76,
            evidence_grade: 'partial',
            recommended_action: 'answer',
            answer_direction: 'Keep the degraded-provider warning visible.',
            uncertainty: 'Provider independence is reduced.',
            risk_flags: ['provider_independence_reduced'],
            evidence_ids: ['intent:turn-council-participation'],
            approval_need: 'none',
          }),
          model: 'claude-test-sonnet',
        })),
        runMiniMax,
        runGemini,
        providerHealthSnapshots: [
          providerSnapshot('openai_cloud'),
          providerSnapshot('anthropic_cloud'),
          providerSnapshot('brave_search'),
          providerSnapshot('minimax_cloud', {
            state: 'externally_blocked',
            failureClass: 'quota_or_rate_limit',
            quotaState: 'blocked',
            lastHealthyAt: null,
            blocker: 'MiniMax quota is currently blocked.',
            nextAction: 'Wait for MiniMax quota recovery.',
          }),
          providerSnapshot('gemini_cloud', {
            state: 'externally_blocked',
            failureClass: 'quota_or_rate_limit',
            quotaState: 'blocked',
            lastHealthyAt: null,
            blocker: 'Gemini quota is currently blocked.',
            nextAction: 'Wait for Gemini quota recovery.',
          }),
        ],
      },
    );

    expect(runMiniMax).not.toHaveBeenCalled();
    expect(runGemini).not.toHaveBeenCalled();
    expect(runOpenAi).toHaveBeenCalledTimes(2);
    expect(members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memberId: 'minimax_cloud',
          role: 'critic',
          status: 'skipped',
          riskFlags: ['minimax_cloud_quota_or_rate_limit'],
        }),
        expect.objectContaining({
          memberId: 'gemini_cloud',
          role: 'verifier',
          status: 'blocked',
          riskFlags: ['gemini_cloud_quota_or_rate_limit'],
        }),
        expect.objectContaining({
          memberId: 'openai_verifier_fallback',
          role: 'verifier',
          providerId: 'openai_cloud',
          status: 'completed',
          riskFlags: expect.arrayContaining([
            'verifier_substituted_openai_for_gemini',
            'provider_independence_reduced',
          ]),
        }),
      ]),
    );
    expect(result?.skippedMemberCount).toBeGreaterThanOrEqual(1);
    expect(result?.providerFailures).toEqual(
      expect.arrayContaining([
        'gemini_cloud_quota_or_rate_limit',
        'minimax_cloud_quota_or_rate_limit',
        'verifier_substituted_openai_for_gemini',
      ]),
    );
    expect(result?.structuredVerdict?.providerParticipation).toMatchObject({
      status: 'degraded',
      skippedProviderIds: expect.arrayContaining([
        'gemini_cloud',
        'minimax_cloud',
      ]),
      substitutedRoles: expect.arrayContaining([
        'verifier:gemini_cloud->openai_cloud',
      ]),
    });
    expect(finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          provider_participation_status: 'degraded',
          provider_participation_skipped:
            expect.stringContaining('gemini_cloud'),
          provider_participation_substitutions:
            'verifier:gemini_cloud->openai_cloud',
        }),
      }),
    );
  });

  it('repairs structured member JSON and lets verifier blocks override planner passes', async () => {
    const finalize = vi.fn(async () => ({}));

    const result = await runObservableProviderCouncil(
      {
        goal: 'Draft a message that would require explicit approval.',
        taskFamily: 'communication',
        channel: 'bluebubbles',
        correlationId: 'turn-council-verifier-block',
        requestedMode: 'dual_review',
        requiredEvidence: 'weak',
        allowedSideEffects: 'approval_required',
      },
      {
        emitProviderCouncil: vi.fn(async () => ({
          councilRunId: 'council-verifier-block',
          mode: 'dual_review' as const,
          traceId: 'turn-council-verifier-block',
          finalRoute: 'dual_review',
        })),
        emitCouncilEvent: vi.fn(async () => ({})),
        emitMemberResult: vi.fn(async () => ({})),
        finalizeCouncil: finalize,
        runOpenAi: vi.fn(async () => ({
          text: JSON.stringify({
            verdict: 'pass',
            confidence: 0.86,
            evidence_grade: 'partial',
            recommended_action: 'answer',
            answer_direction: 'Prepare a draft only.',
            uncertainty: 'Approval still matters.',
            risk_flags: [],
            evidence_ids: ['intent:turn-council-verifier-block'],
            approval_need: 'explicit',
          }),
          model: 'gpt-5.4',
        })),
        runAnthropic: vi.fn(async () => ({
          text: JSON.stringify({
            verdict: 'pass',
            confidence: 0.81,
            evidence_grade: 'partial',
            recommended_action: 'draft_only',
            answer_direction: 'Draft without sending.',
            uncertainty: 'Needs same-thread approval.',
            risk_flags: ['approval_required'],
            evidence_ids: ['intent:turn-council-verifier-block'],
            approval_need: 'explicit',
          }),
          model: 'claude-test-sonnet',
        })),
        runMiniMax: vi.fn(async () => ({
          text: JSON.stringify({
            verdict: 'warn',
            confidence: 0.74,
            evidence_grade: 'partial',
            recommended_action: 'draft_only',
            answer_direction: 'Keep approval-first posture.',
            uncertainty: 'The user has not approved a send.',
            risk_flags: ['message_send_approval_gap'],
            evidence_ids: ['policy:sanitized_snippets'],
            approval_need: 'explicit',
          }),
          model: 'MiniMax-M2.7',
        })),
        runGemini: vi.fn(async () => ({
          text: [
            '```json',
            "{'verdict':'block','confidence':0.91,'evidence_grade':'partial','recommended_action':'block','answer_direction':'Do not send; ask for explicit approval.','uncertainty':'Approval is missing.','risk_flags':['approval_missing'],'evidence_ids':['policy:sanitized_snippets',],'approval_need':'explicit','blocker':'Same-thread approval is missing.'}",
            '```',
          ].join('\n'),
          model: 'gemini-2.5-pro',
        })),
      },
    );

    expect(result?.answerGuidance).toMatchObject({
      status: 'block',
      blocker: 'Same-thread approval is missing.',
      recommendedAction: 'block',
      approvalNeed: 'explicit',
    });
    expect(result?.structuredVerdict).toMatchObject({
      status: 'block',
      recommendedAction: 'block',
      approvalNeed: 'explicit',
      usableMemberCount: 4,
      schemaStatusSummary: {
        valid: 3,
        repaired: 1,
        invalid_fallback: 0,
      },
      budget: expect.objectContaining({
        status: 'within_budget',
        usedRoles: 4,
      }),
    });
    expect(result?.structuredVerdict?.replaySummary).toContain('Verdict=block');
    expect(
      result?.structuredVerdict?.replayArtifact?.memberStatuses.find(
        (member) => member.memberId === 'gemini_cloud',
      ),
    ).toMatchObject({ schemaStatus: 'repaired' });
    expect(finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          structured_verdict_status: 'block',
          structured_verdict_action: 'block',
          council_approval_need: 'explicit',
          council_schema_repaired_count: '1',
          council_budget_status: 'within_budget',
        }),
      }),
    );
  });

  it('guards repeated verifier failures and reports budget degradation without retry loops', async () => {
    const runGemini = vi
      .fn()
      .mockResolvedValueOnce({
        providerFailure: 'Gemini verifier outage.',
      })
      .mockResolvedValueOnce({
        providerFailure: 'Gemini verifier outage.',
      });

    const result = await runObservableProviderCouncil(
      {
        goal: 'Deeply verify a risky operator decision.',
        taskFamily: 'operator',
        channel: 'system',
        correlationId: 'turn-council-repeat-guard',
        requestedMode: 'max_iq_council',
      },
      {
        emitProviderCouncil: vi.fn(async () => ({
          councilRunId: 'council-repeat-guard',
          mode: 'max_iq_council' as const,
          traceId: 'turn-council-repeat-guard',
        })),
        emitCouncilEvent: vi.fn(async () => ({})),
        emitMemberResult: vi.fn(async () => ({})),
        finalizeCouncil: vi.fn(async () => ({})),
        searchBrave: vi.fn(async () => ({
          query: 'q',
          results: [],
        })),
        runOpenAi: vi.fn(async () => ({
          text: JSON.stringify({
            verdict: 'pass',
            confidence: 0.8,
            evidence_grade: 'partial',
            recommended_action: 'answer',
            answer_direction: 'Proceed with caution.',
            uncertainty: 'Verifier may be unavailable.',
            risk_flags: [],
            evidence_ids: ['intent:turn-council-repeat-guard'],
            approval_need: 'none',
          }),
          model: 'gpt-5.4',
        })),
        runAnthropic: vi.fn(async () => ({
          text: JSON.stringify({
            verdict: 'warn',
            confidence: 0.7,
            evidence_grade: 'partial',
            recommended_action: 'answer',
            answer_direction: 'Name verifier uncertainty.',
            uncertainty: 'Verifier needed.',
            risk_flags: ['verifier_gap'],
            evidence_ids: ['intent:turn-council-repeat-guard'],
            approval_need: 'none',
          }),
          model: 'claude-test-sonnet',
        })),
        runMiniMax: vi.fn(async () => ({
          text: JSON.stringify({
            verdict: 'warn',
            confidence: 0.68,
            evidence_grade: 'partial',
            recommended_action: 'answer',
            answer_direction: 'Avoid overclaiming.',
            uncertainty: 'Verifier missing.',
            risk_flags: ['verifier_gap'],
            evidence_ids: ['intent:turn-council-repeat-guard'],
            approval_need: 'none',
          }),
          model: 'MiniMax-M2.7',
        })),
        runGemini,
      },
    );

    expect(runGemini).toHaveBeenCalledTimes(2);
    expect(result?.structuredVerdict?.budget).toMatchObject({
      retryCount: 1,
      loopGuardTriggered: true,
      status: 'degraded',
    });
    expect(result?.providerFailures?.join('|')).toContain(
      'repeated_failure_signature:',
    );
    expect(result?.structuredVerdict?.replaySummary).toContain(
      'Loop/failure guard triggered',
    );
  });

  it('redacts secrets and contact identifiers across observable council surfaces', async () => {
    const events: Array<Record<string, unknown>> = [];
    const members: Array<Record<string, unknown>> = [];
    const finalize = vi.fn(async () => ({}));
    const fakeSecret = 'sk-proj-testSecretValue1234567890abcdef';
    const rawEmail = 'jeff@example.com';
    const rawPhone = '+1 469 540 5551';

    const result = await runObservableProviderCouncil(
      {
        goal: `Investigate ${rawEmail} at ${rawPhone} with key ${fakeSecret}.`,
        taskFamily: 'assistant',
        channel: 'telegram',
        correlationId: 'turn-council-redaction',
        requestedMode: 'dual_review',
        metadata: {
          api_key: fakeSecret,
          contact: `${rawEmail} ${rawPhone}`,
        },
      },
      {
        emitProviderCouncil: vi.fn(async () => ({
          councilRunId: 'council-redaction',
          mode: 'dual_review' as const,
          traceId: 'turn-council-redaction',
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
        runOpenAi: vi.fn(async () => ({
          text: `{"verdict":"pass","confidence":0.8,"answer_direction":"Do not expose ${fakeSecret} or ${rawEmail}.","uncertainty":"none","risk_flags":[]}`,
          model: 'gpt-5.4',
        })),
        runAnthropic: vi.fn(async () => ({
          text: `Keep ${rawPhone} private and answer normally.`,
          model: 'claude-test-sonnet',
        })),
        runMiniMax: vi.fn(async () => ({
          text: 'No safety issue beyond redaction.',
          model: 'MiniMax-M2.7',
        })),
        runGemini: vi.fn(async () => ({
          text: 'Verifier verdict: pass with redaction.',
          model: 'gemini-2.5-pro',
        })),
      },
    );

    const observable = JSON.stringify({
      events,
      members,
      result,
      finalize: finalize.mock.calls,
    });
    expect(observable).not.toContain(fakeSecret);
    expect(observable).not.toContain(rawEmail);
    expect(observable).not.toContain(rawPhone);
    expect(observable).toContain('[REDACTED_SECRET]');
    expect(observable).toContain('[redacted-email]');
    expect(observable).toContain('[redacted-phone]');
    expect(
      result?.structuredVerdict?.schemaStatusSummary?.invalid_fallback,
    ).toBe(0);
    expect(
      result?.structuredVerdict?.schemaStatusSummary?.repaired,
    ).toBeGreaterThan(0);
    expect(
      result?.structuredVerdict?.replayArtifact?.replaySummary,
    ).toBeTruthy();
  });
});
