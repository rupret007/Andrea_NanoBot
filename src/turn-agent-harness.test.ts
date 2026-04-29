import { afterEach, describe, expect, it, vi } from 'vitest';

describe('turn agent harness', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('skips simple greetings instead of deliberating every turn', async () => {
    vi.stubEnv('ANDREA_PLATFORM_COORDINATOR_ENABLED', 'true');
    vi.stubEnv('ANDREA_PLATFORM_FALLBACK_TO_DIRECT_RUNTIME', 'false');
    vi.stubEnv('ANDREA_PLATFORM_COORDINATOR_URL', 'http://127.0.0.1:4400');
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl as unknown as typeof fetch);

    const { beginTurnAgentHarness } = await import('./turn-agent-harness.js');
    const context = await beginTurnAgentHarness({
      turnId: 'turn-hello',
      channel: 'telegram',
      groupFolder: 'main',
      text: 'hi',
      requestRoute: 'direct_assistant',
    });

    expect(context).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('compiles memory and skill metadata before platform deliberation', async () => {
    vi.stubEnv('ANDREA_PLATFORM_COORDINATOR_ENABLED', 'true');
    vi.stubEnv('ANDREA_PLATFORM_FALLBACK_TO_DIRECT_RUNTIME', 'false');
    vi.stubEnv('ANDREA_PLATFORM_COORDINATOR_URL', 'http://127.0.0.1:4400');
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: String(input),
          body: JSON.parse(String(init?.body || '{}')) as Record<
            string,
            unknown
          >,
        });
        if (String(input).endsWith('/skill-evolution-report')) {
          return new Response(
            JSON.stringify({
              active_skills: [
                {
                  candidate_id: 'candidate-1',
                  skill_id: 'assistant.daily_guidance.confirmed_focus',
                  task_family: 'assistant',
                  lifecycle_status: 'active',
                  summary: 'Prefer a short focus-first daily answer.',
                  evidence_count: 3,
                  risk_level: 'low',
                  approval_required: false,
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            task: { task_ledger_id: 'task-1' },
            progress: { progress_ledger_id: 'progress-1' },
            plan: { plan_id: 'plan-1', route: 'local_capability' },
            evaluation: { evaluation_id: 'evaluation-1' },
            decision: {
              decision_id: 'decision-1',
              selected_route: 'local_capability',
              execution_posture: 'execute_now',
              answer_strategy: 'narrow_claim',
              selected_policy_id: 'local_capability',
              confidence: 0.81,
              expected_evidence: 'partial',
              route_scores: [
                {
                  route_id: 'local_capability',
                  score: 0.82,
                  confidence: 0.8,
                  evidence_requirement: 'partial',
                  reason: 'local capability fits',
                },
              ],
              evidence_cards: [
                {
                  route_id: 'local_capability',
                  source_class: 'local_memory',
                  expected_level: 'partial',
                  actual_level: 'unknown',
                  freshness: 'unknown',
                  summary: 'metadata-only expectation',
                },
              ],
            },
            trace_grade: { grade_id: 'grade-1', status: 'pass' },
          }),
          { status: 200 },
        );
      },
    );
    vi.stubGlobal('fetch', fetchImpl as unknown as typeof fetch);

    const { beginTurnAgentHarness } = await import('./turn-agent-harness.js');
    const context = await beginTurnAgentHarness({
      turnId: 'turn-1',
      channel: 'telegram',
      groupFolder: 'main',
      text: 'what am I forgetting tonight',
      requestRoute: 'direct_assistant',
    });

    expect(context?.taskFamily).toBe('assistant');
    expect(context?.selectedSkill.skillId).toBe('assistant.daily_guidance');
    expect(context?.contextCompile.memoryTiers).toEqual([
      'working',
      'semantic',
      'procedural',
    ]);
    expect(context?.deliberation).toMatchObject({
      taskLedgerId: 'task-1',
      selectedPolicyId: 'local_capability',
      traceGradeId: 'grade-1',
      traceGradeStatus: 'pass',
    });
    expect(context?.deliberation?.routeScores?.[0]).toMatchObject({
      routeId: 'local_capability',
      score: 0.82,
    });
    expect(calls[0]).toMatchObject({
      url: 'http://127.0.0.1:4400/skill-evolution-report',
    });
    expect(calls[1]).toMatchObject({
      url: 'http://127.0.0.1:4400/deliberate',
    });
    expect(calls[1]?.body).toMatchObject({
      goal: 'Handle assistant turn from telegram via direct_assistant.',
      category: 'assistant',
      correlationId: 'turn-1',
      metadata: {
        sourceSystem: 'andrea_nanobot',
        turn_intelligence_version: 'v10',
        turn_agent_harness: 'v10',
        skill_id: 'assistant.daily_guidance',
        active_skill_candidate_count: '1',
        skill_evolution_mode: 'active_verified_only',
        memory_read_tiers: 'working,semantic,procedural',
        raw_content_policy: 'local_only',
      },
    });
  });

  it('turns platform hold decisions into visible hold replies', async () => {
    vi.stubEnv('ANDREA_PLATFORM_COORDINATOR_ENABLED', 'true');
    vi.stubEnv('ANDREA_PLATFORM_FALLBACK_TO_DIRECT_RUNTIME', 'false');
    vi.stubEnv('ANDREA_PLATFORM_COORDINATOR_URL', 'http://127.0.0.1:4400');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            task: { task_ledger_id: 'task-hold' },
            progress: { progress_ledger_id: 'progress-hold' },
            plan: { plan_id: 'plan-hold', route: 'clarify_first' },
            decision: {
              decision_id: 'decision-hold',
              selected_route: 'clarify_first',
              execution_posture: 'clarify_first',
              missing_information: ['Which thread should I use?'],
              selected_policy_id: 'clarify_first',
            },
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    );

    const { beginTurnAgentHarness } = await import('./turn-agent-harness.js');
    const context = await beginTurnAgentHarness({
      turnId: 'turn-hold',
      channel: 'telegram',
      groupFolder: 'main',
      text: 'send that message',
      requestRoute: 'protected_assistant',
    });

    expect(context?.platformHoldReply).toContain('Which thread should I use?');
  });

  it('repairs risky wording before the reply is sent', async () => {
    const { evaluateTurnReply } = await import('./turn-agent-harness.js');

    const evaluation = evaluateTurnReply({
      context: {
        turnId: 'turn-calendar',
        channel: 'telegram',
        groupFolder: 'main',
        requestRoute: 'direct_assistant',
        taskFamily: 'calendar',
        meaningful: true,
        selectedSkill: {
          skillId: 'calendar.availability',
          taskFamily: 'calendar',
          purpose: 'calendar',
          inputs: [],
          outputs: [],
          evidenceLevel: 'strong',
          sideEffectRisk: 'medium',
          approvalNeed: 'conditional',
          failureModes: [],
          examples: [],
        },
        contextCompile: {
          readPlan: {
            taskFamily: 'calendar',
            readTiers: ['working'],
            hotPath: true,
            safeWriteClasses: ['episode_record'],
            reason: 'calendar',
            sources: [],
          },
          selectedSkill: {
            skillId: 'calendar.availability',
            taskFamily: 'calendar',
            purpose: 'calendar',
            inputs: [],
            outputs: [],
            evidenceLevel: 'strong',
            sideEffectRisk: 'medium',
            approvalNeed: 'conditional',
            failureModes: [],
            examples: [],
          },
          memoryTiers: ['working'],
          metadata: {},
        },
        deliberation: {
          selectedRoute: 'direct_integration',
          expectedEvidence: 'strong',
        },
        platformHoldReply: null,
      },
      text: 'You look free at 3 PM tomorrow. codex_local can check the task_ledger.',
      routeKey: 'calendar_lookup',
      responseSource: 'local_companion',
    });

    expect(evaluation.safeRewriteApplied).toBe(true);
    expect(evaluation.rewrittenText).toContain("I don't see anything");
    expect(evaluation.rewrittenText).not.toContain('codex_local');
    expect(evaluation.evaluatorFlags).toContain('calendar_certainty_repaired');
    expect(evaluation.evaluatorFlags).toContain('operator_leakage_repaired');
  });

  it('reflects handled turns back to the platform without raw message content', async () => {
    vi.stubEnv('ANDREA_PLATFORM_COORDINATOR_ENABLED', 'true');
    vi.stubEnv('ANDREA_PLATFORM_FALLBACK_TO_DIRECT_RUNTIME', 'false');
    vi.stubEnv('ANDREA_PLATFORM_COORDINATOR_URL', 'http://127.0.0.1:4400');
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: String(input),
          body: JSON.parse(String(init?.body || '{}')) as Record<
            string,
            unknown
          >,
        });
        return new Response(
          JSON.stringify({
            reflection: { reflection_id: 'reflection-1' },
            evaluation: { evaluation_id: 'evaluation-2' },
            learning: { learning_id: 'learning-1' },
            trace_grade: { grade_id: 'grade-2', status: 'pass' },
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    );

    const { evaluateTurnReply, reflectTurnAgentOutcome } =
      await import('./turn-agent-harness.js');
    const context = {
      turnId: 'turn-reflect',
      channel: 'telegram' as const,
      groupFolder: 'main',
      requestRoute: 'direct_assistant',
      taskFamily: 'assistant' as const,
      meaningful: true,
      selectedSkill: {
        skillId: 'assistant.daily_guidance',
        taskFamily: 'assistant' as const,
        purpose: 'guidance',
        inputs: [],
        outputs: [],
        evidenceLevel: 'partial' as const,
        sideEffectRisk: 'none' as const,
        approvalNeed: 'none' as const,
        failureModes: [],
        examples: [],
      },
      contextCompile: {
        readPlan: {
          taskFamily: 'assistant' as const,
          readTiers: ['working', 'semantic', 'procedural'] as const,
          hotPath: true,
          safeWriteClasses: ['episode_record', 'outcome_learning'] as const,
          reason: 'guidance',
          sources: ['open loops'],
        },
        selectedSkill: {
          skillId: 'assistant.daily_guidance',
          taskFamily: 'assistant' as const,
          purpose: 'guidance',
          inputs: [],
          outputs: [],
          evidenceLevel: 'partial' as const,
          sideEffectRisk: 'none' as const,
          approvalNeed: 'none' as const,
          failureModes: [],
          examples: [],
        },
        memoryTiers: ['working', 'semantic', 'procedural'] as const,
        metadata: {},
      },
      deliberation: {
        taskLedgerId: 'task-reflect',
        progressLedgerId: 'progress-reflect',
        planId: 'plan-reflect',
        selectedRoute: 'local_capability',
        selectedPolicyId: 'local_capability',
        expectedEvidence: 'partial',
      },
      platformHoldReply: null,
    };
    const evaluation = evaluateTurnReply({
      context: context as any,
      text: 'Here is the plan.',
      routeKey: 'daily.what_matters',
    });
    const reflection = await reflectTurnAgentOutcome({
      context: context as any,
      evaluation,
      routeUsed: 'daily.what_matters',
      answerClass: 'handled',
    });

    expect(reflection.reflection).toMatchObject({
      reflectionId: 'reflection-1',
      evaluationId: 'evaluation-2',
      learningId: 'learning-1',
      traceGradeId: 'grade-2',
    });
    expect(calls[0]).toMatchObject({
      url: 'http://127.0.0.1:4400/reflect',
    });
    expect(calls[0]?.body).toMatchObject({
      taskLedgerId: 'task-reflect',
      progressLedgerId: 'progress-reflect',
      planId: 'plan-reflect',
      trigger: 'turn_agent_harness',
      metadata: {
        sourceSystem: 'andrea_nanobot',
        turn_intelligence_version: 'v10',
        route_used: 'daily.what_matters',
        actual_evidence: 'partial',
      },
    });
    expect(JSON.stringify(calls[0]?.body)).not.toContain('Here is the plan.');
    expect(calls[1]).toMatchObject({
      url: 'http://127.0.0.1:4400/skill-candidate',
    });
    expect(calls[1]?.body).toMatchObject({
      skillId: 'assistant.daily_guidance',
      taskFamily: 'assistant',
      sourceKind: 'repeated_success',
    });
  });
});
