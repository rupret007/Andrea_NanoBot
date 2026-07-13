import { afterEach, describe, expect, it, vi } from 'vitest';

describe('turn agent harness', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('distinguishes repository changes from runtime operator work', async () => {
    const { classifyTurnTaskFamily } = await import('./turn-agent-harness.js');

    expect(
      classifyTurnTaskFamily({
        text: 'Implement the repository test fix and run typecheck.',
        requestRoute: 'direct_assistant',
      }),
    ).toBe('code');
    expect(
      classifyTurnTaskFamily({
        text: 'Restart the service and check runtime status.',
        requestRoute: 'direct_assistant',
      }),
    ).toBe('operator');
    expect(
      classifyTurnTaskFamily({
        text: 'Push this repository to main, restart all services, and check health.',
        requestRoute: 'direct_assistant',
      }),
    ).toBe('operator');
  });

  it('routes ordinary work to one model and reserves council for explicit evidence', async () => {
    const {
      classifyTurnTaskFamily,
      decideProviderCouncil,
      selectSkillAffordance,
    } = await import('./turn-agent-harness.js');
    const decide = (text: string) => {
      const taskFamily = classifyTurnTaskFamily({
        text,
        requestRoute: 'direct_assistant',
      });
      return {
        taskFamily,
        skill: selectSkillAffordance({ taskFamily, text }),
      };
    };

    for (const text of [
      'How do you write code for a game, maybe give me some ideas?',
      'Explain what this TypeScript function does.',
      'quick answer: explain the build',
      'Check service status and summarize the logs.',
      'Draft a friendly reply saying Friday works.',
    ]) {
      const selected = decide(text);
      expect(
        decideProviderCouncil({
          text,
          taskFamily: selected.taskFamily,
          selectedSkill: selected.skill,
        }).run,
      ).toBe(false);
    }

    const game = decide(
      'How do you write code for a game, maybe give me some ideas?',
    );
    expect(game.taskFamily).toBe('code');
    expect(game.skill.skillId).toBe('code.assistance');

    const calendar = decide("ultrathink: what's on my schedule tomorrow?");
    expect(
      decideProviderCouncil({
        text: "ultrathink: what's on my schedule tomorrow?",
        taskFamily: calendar.taskFamily,
        selectedSkill: calendar.skill,
      }),
    ).toMatchObject({
      run: true,
      reason: 'explicit_deep',
      mode: 'max_iq_council',
    });

    const highRisk = decide(
      'quick answer: plan a production database migration',
    );
    expect(
      decideProviderCouncil({
        text: 'quick answer: plan a production database migration',
        taskFamily: highRisk.taskFamily,
        selectedSkill: highRisk.skill,
      }),
    ).toMatchObject({
      run: true,
      reason: 'high_risk_plan',
      mode: 'max_iq_council',
    });

    const disagreement = decide('Help me choose the best safe route.');
    expect(
      decideProviderCouncil({
        text: 'Help me choose the best safe route.',
        taskFamily: disagreement.taskFamily,
        selectedSkill: disagreement.skill,
        deliberation: {
          routeScores: [
            { routeId: 'local_capability', score: 0.72, confidence: 0.8 },
            { routeId: 'direct_integration', score: 0.68, confidence: 0.75 },
          ],
        },
      }),
    ).toMatchObject({
      run: true,
      reason: 'material_route_disagreement',
      mode: 'dual_review',
    });
  });

  it('classifies high-risk planning before broad research keywords', async () => {
    const {
      classifyTurnTaskFamily,
      decideProviderCouncil,
      selectSkillAffordance,
    } = await import('./turn-agent-harness.js');
    const assertHighRiskCouncil = (text: string) => {
      const taskFamily = classifyTurnTaskFamily({
        text,
        requestRoute: 'direct_assistant',
      });
      const selectedSkill = selectSkillAffordance({ taskFamily, text });

      expect(taskFamily).toBe('operator');
      expect(
        decideProviderCouncil({ text, taskFamily, selectedSkill }),
      ).toMatchObject({
        run: true,
        reason: 'high_risk_plan',
        mode: 'max_iq_council',
      });
    };

    assertHighRiskCouncil(
      'recommend the safest production database migration rollout',
    );
    assertHighRiskCouncil('review the latest production security architecture');
    assertHighRiskCouncil(
      'quick answer: recommend the safest production database migration rollout',
    );
  });

  it('does not await council for the real ordinary game-idea shape', async () => {
    vi.stubEnv('ANDREA_PLATFORM_COORDINATOR_ENABLED', 'true');
    vi.stubEnv('ANDREA_PLATFORM_FALLBACK_TO_DIRECT_RUNTIME', 'false');
    vi.stubEnv('ANDREA_PLATFORM_COORDINATOR_URL', 'http://127.0.0.1:4400');
    const calls: string[] = [];
    const timeoutSpy = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation(() => new AbortController().signal);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        calls.push(String(input));
        if (String(input).endsWith('/skill-evolution-report')) {
          return new Response(JSON.stringify({ active_skills: [] }), {
            status: 200,
          });
        }
        if (String(input).endsWith('/council-run')) {
          return new Promise<Response>(() => undefined);
        }
        return new Response(
          JSON.stringify({
            decision: {
              selected_route: 'runtime_conductor',
              execution_posture: 'execute_now',
              selected_policy_id: 'runtime_conductor',
            },
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    );

    const { beginTurnAgentHarness } = await import('./turn-agent-harness.js');
    const context = await beginTurnAgentHarness({
      turnId: 'turn-game-ideas',
      channel: 'telegram',
      groupFolder: 'main',
      text: 'How do you write code for a game, maybe give me some ideas?',
      requestRoute: 'direct_assistant',
    });

    expect(context?.selectedSkill.skillId).toBe('code.assistance');
    expect(context?.providerCouncil).toBeNull();
    expect(context?.contextCompile.metadata.provider_council_gate_reason).toBe(
      'ordinary_single_model',
    );
    expect(calls.some((url) => url.endsWith('/council-run'))).toBe(false);
    expect(timeoutSpy).toHaveBeenNthCalledWith(1, 1_000);
    expect(timeoutSpy).toHaveBeenNthCalledWith(2, 1_000);
    expect(
      context?.contextCompile.metadata.platform_coordinator_timeout_class,
    ).toBe('ordinary_1000ms');
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

  it('keeps proof/replay turns out of live deliberation, council, runtime, and learning', async () => {
    vi.stubEnv('ANDREA_PLATFORM_COORDINATOR_ENABLED', 'true');
    vi.stubEnv('ANDREA_PLATFORM_COORDINATOR_URL', 'http://127.0.0.1:4400');
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl as unknown as typeof fetch);
    const { _initTestDatabase, _closeDatabase, listCognitiveRuns } =
      await import('./db.js');
    _initTestDatabase();
    try {
      const { beginTurnAgentHarness } = await import('./turn-agent-harness.js');
      const context = await beginTurnAgentHarness({
        turnId: 'proof-drill-deferred-decision',
        channel: 'bluebubbles',
        groupFolder: 'main',
        text: 'send it later tonight',
        requestRoute: 'direct_assistant',
        runOrigin: 'replay',
      });

      expect(context).toMatchObject({
        runOrigin: 'replay',
        deliberation: null,
        providerCouncil: null,
        logicRun: null,
        runtimeSpine: null,
        personalContextPacket: null,
        verifiedDeepWorkPacket: null,
      });
      expect(context?.cognitiveRun?.run.runOrigin).toBe('replay');
      expect(context?.cognitiveRun?.run.linkedSkillCardId).toBeNull();
      expect(listCognitiveRuns({ runOrigin: 'live' })).toEqual([]);
      expect(listCognitiveRuns({ runOrigin: 'replay' })).toHaveLength(1);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      _closeDatabase();
    }
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
      goal: 'Handle assistant turn from telegram via direct_assistant. Safe user intent: what am I forgetting tonight.',
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
    vi.stubEnv('ANDREA_PLATFORM_BRIDGE_TIMEOUT_MS', '15000');
    const timeoutSpy = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation(() => new AbortController().signal);
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
    expect(timeoutSpy).toHaveBeenNthCalledWith(1, 15_000);
    expect(timeoutSpy).toHaveBeenNthCalledWith(2, 15_000);
    expect(
      context?.contextCompile.metadata.platform_coordinator_timeout_class,
    ).toBe('safety_default');
  });

  it('recognizes read-only calendar lookup asks as safe local-first turns', async () => {
    const { isSafeReadOnlyCalendarLookupAsk } =
      await import('./turn-agent-harness.js');

    expect(isSafeReadOnlyCalendarLookupAsk("what's on my schedule")).toBe(true);
    expect(
      isSafeReadOnlyCalendarLookupAsk("what's on my schedule tomorrow"),
    ).toBe(true);
    expect(
      isSafeReadOnlyCalendarLookupAsk("What's on my agenda for today?"),
    ).toBe(true);
    expect(isSafeReadOnlyCalendarLookupAsk('add that to my calendar')).toBe(
      false,
    );
  });

  it('does not run provider council for safe read-only calendar lookups', async () => {
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
        if (String(input).endsWith('/skill-evolution-report')) {
          return new Response(JSON.stringify({ active_skills: [] }), {
            status: 200,
          });
        }
        if (String(input).endsWith('/council-run')) {
          throw new Error('safe calendar lookup should not call council');
        }
        return new Response(
          JSON.stringify({
            task: { task_ledger_id: 'task-calendar' },
            progress: { progress_ledger_id: 'progress-calendar' },
            plan: { plan_id: 'plan-calendar', route: 'direct_integration' },
            decision: {
              decision_id: 'decision-calendar',
              selected_route: 'direct_integration',
              execution_posture: 'execute_now',
              answer_strategy: 'narrow_claim',
              selected_policy_id: 'direct_integration',
              expected_evidence: 'strong',
            },
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    );

    const { beginTurnAgentHarness } = await import('./turn-agent-harness.js');
    const context = await beginTurnAgentHarness({
      turnId: 'turn-calendar-read',
      channel: 'telegram',
      groupFolder: 'main',
      text: "what's on my schedule tomorrow",
      requestRoute: 'protected_assistant',
    });

    expect(context?.taskFamily).toBe('calendar');
    expect(context?.providerCouncil).toBeNull();
    expect(context?.platformHoldReply).toBeNull();
    expect(calls.some((call) => call.url.endsWith('/council-run'))).toBe(false);
  });

  it('keeps routine daily guidance local-first instead of council-held', async () => {
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
        if (String(input).endsWith('/skill-evolution-report')) {
          return new Response(JSON.stringify({ active_skills: [] }), {
            status: 200,
          });
        }
        if (String(input).endsWith('/council-run')) {
          throw new Error('routine daily guidance should not call council');
        }
        return new Response(
          JSON.stringify({
            task: { task_ledger_id: 'task-daily' },
            progress: { progress_ledger_id: 'progress-daily' },
            plan: { plan_id: 'plan-daily', route: 'local_capability' },
            decision: {
              decision_id: 'decision-daily',
              selected_route: 'local_capability',
              execution_posture: 'execute_now',
              selected_policy_id: 'local_capability',
              expected_evidence: 'partial',
            },
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    );

    const { beginTurnAgentHarness } = await import('./turn-agent-harness.js');
    const context = await beginTurnAgentHarness({
      turnId: 'turn-daily-guidance-read',
      channel: 'telegram',
      groupFolder: 'main',
      text: 'what am I forgetting',
      requestRoute: 'direct_assistant',
    });

    expect(context?.taskFamily).toBe('assistant');
    expect(context?.selectedSkill.skillId).toBe('assistant.daily_guidance');
    expect(context?.providerCouncil).toBeNull();
    expect(context?.platformHoldReply).toBeNull();
    expect(calls.some((call) => call.url.endsWith('/council-run'))).toBe(false);
  });

  it('runs provider council for explicit deep research', async () => {
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
        if (String(input).endsWith('/skill-evolution-report')) {
          return new Response(JSON.stringify({ active_skills: [] }), {
            status: 200,
          });
        }
        if (String(input).endsWith('/council-run')) {
          return new Response(
            JSON.stringify({
              council: {
                council_run_id: 'council-1',
                request_id: 'request-1',
                mode: 'max_iq_council',
                status: 'completed',
                trace_id: 'turn-research',
                members: [
                  { member_id: 'openai_cloud', status: 'completed' },
                  { member_id: 'minimax_cloud', status: 'completed' },
                  { member_id: 'andrea_platform', status: 'completed' },
                ],
              },
              verdict: {
                verdict_id: 'verdict-1',
                final_route: 'max_iq_council',
                answer_strategy: 'verified_synthesis',
                confidence: 0.86,
                approval_required: false,
              },
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            task: { task_ledger_id: 'task-research' },
            progress: { progress_ledger_id: 'progress-research' },
            plan: { plan_id: 'plan-research', route: 'direct_integration' },
            decision: {
              decision_id: 'decision-research',
              selected_route: 'direct_integration',
              execution_posture: 'execute_now',
              answer_strategy: 'narrow_claim',
              selected_policy_id: 'direct_integration',
              expected_evidence: 'strong',
            },
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    );

    const { beginTurnAgentHarness } = await import('./turn-agent-harness.js');
    const context = await beginTurnAgentHarness({
      turnId: 'turn-research',
      channel: 'telegram',
      groupFolder: 'main',
      text: 'deep dive: research and compare the latest model council options',
      requestRoute: 'direct_assistant',
    });

    expect(context?.providerCouncil).toMatchObject({
      councilRunId: 'council-1',
      mode: 'max_iq_council',
      finalRoute: 'max_iq_council',
    });
    const councilCall = calls.find((call) => call.url.endsWith('/council-run'));
    expect(councilCall?.body).toMatchObject({
      goal: 'Handle research turn from telegram via direct_assistant. Safe user intent: deep dive: research and compare the latest model council options.',
      taskFamily: 'research',
      requestedMode: 'max_iq_council',
      requiredEvidence: 'strong',
      metadata: {
        turn_agent_harness: 'v16_empirical_council_gate',
        council_gate_reason: 'explicit_deep',
        raw_content_policy: 'sanitized_snippets',
      },
    });
  });

  it('honors natural quick/deep thinking controls and applies council guidance visibly', async () => {
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
        if (String(input).endsWith('/skill-evolution-report')) {
          return new Response(JSON.stringify({ active_skills: [] }), {
            status: 200,
          });
        }
        if (String(input).endsWith('/council-run')) {
          return new Response(
            JSON.stringify({
              council: {
                council_run_id: 'council-thinking',
                mode: calls.at(-1)?.body.requestedMode || 'max_iq_council',
                status: 'completed',
                trace_id: calls.at(-1)?.body.correlationId || 'trace-thinking',
                members: [
                  { member_id: 'openai_cloud', status: 'completed' },
                  { member_id: 'anthropic_cloud', status: 'completed' },
                  { member_id: 'minimax_cloud', status: 'completed' },
                  { member_id: 'gemini_cloud', status: 'completed' },
                ],
              },
              verdict: {
                verdict_id: 'verdict-thinking',
                final_route: calls.at(-1)?.body.requestedMode,
                answer_strategy: 'verified_synthesis',
                confidence: 0.86,
              },
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            task: { task_ledger_id: 'task-thinking' },
            progress: { progress_ledger_id: 'progress-thinking' },
            plan: { plan_id: 'plan-thinking', route: 'local_capability' },
            decision: {
              decision_id: 'decision-thinking',
              selected_route: 'local_capability',
              execution_posture: 'execute_now',
              selected_policy_id: 'local_capability',
              expected_evidence: 'partial',
            },
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    );

    const { beginTurnAgentHarness, evaluateTurnReply } =
      await import('./turn-agent-harness.js');
    const quick = await beginTurnAgentHarness({
      turnId: 'turn-quick',
      channel: 'telegram',
      groupFolder: 'main',
      text: 'quick answer: what should I remember tonight',
      requestRoute: 'direct_assistant',
    });
    const deep = await beginTurnAgentHarness({
      turnId: 'turn-deep',
      channel: 'telegram',
      groupFolder: 'main',
      text: 'think harder about what I should prioritize tomorrow',
      requestRoute: 'direct_assistant',
    });

    expect(quick?.providerCouncil).toBeNull();
    expect(deep?.providerCouncil?.mode).toBe('max_iq_council');
    expect(
      calls.find(
        (call) =>
          call.url.endsWith('/council-run') &&
          call.body.correlationId === 'turn-deep',
      )?.body,
    ).toMatchObject({
      rawContentPolicy: 'sanitized_snippets',
      metadata: { thinking_control: 'deep' },
    });

    const guided = evaluateTurnReply({
      context: {
        ...deep!,
        providerCouncil: {
          ...deep!.providerCouncil!,
          answerGuidance: {
            status: 'warn',
            visibleVerdict: 'Proceed carefully and name the priority tradeoff.',
            answerDirection: 'Lead with the most practical next step.',
            confidence: 0.64,
            uncertainty: 'A time constraint is still unknown.',
            sourceMemberIds: ['openai_cloud', 'anthropic_cloud'],
          },
        },
      },
      text: 'Start with the deadline that matters most.',
      routeKey: 'daily.priority',
    });

    expect(guided.rewrittenText).toContain('Quick check:');
    expect(guided.rewrittenText).not.toContain('Council check:');
    expect(guided.evaluatorFlags).toContain(
      'provider_council_guidance_applied',
    );
  });

  it('does not prepend provider-participation boilerplate to normal replies', async () => {
    const { evaluateTurnReply } = await import('./turn-agent-harness.js');

    const evaluation = evaluateTurnReply({
      context: {
        turnId: 'turn-weather',
        channel: 'telegram',
        groupFolder: 'main',
        requestRoute: 'protected_assistant',
        taskFamily: 'research',
        meaningful: true,
        selectedSkill: {
          skillId: 'research.web',
          taskFamily: 'research',
          purpose: 'Answer live lookup questions.',
          inputs: ['query'],
          outputs: ['answer'],
          evidenceLevel: 'partial',
          sideEffectRisk: 'none',
          approvalNeed: 'none',
          failureModes: [],
          examples: [],
        },
        contextCompile: {
          readPlan: {} as never,
          selectedSkill: {
            skillId: 'research.web',
            taskFamily: 'research',
            purpose: 'Answer live lookup questions.',
            inputs: ['query'],
            outputs: ['answer'],
            evidenceLevel: 'partial',
            sideEffectRisk: 'none',
            approvalNeed: 'none',
            failureModes: [],
            examples: [],
          },
          metadata: {},
          memoryTiers: [],
          effectiveDirectives: [],
        },
        providerCouncil: {
          councilRunId: 'council-weather',
          mode: 'fast',
          answerGuidance: {
            status: 'warn',
            visibleVerdict:
              'I cannot say every provider participated from the current proof.',
            confidence: 0.7,
            uncertainty: 'One provider skipped.',
            sourceMemberIds: ['openai_cloud'],
          },
        } as never,
      },
      text: '*Research Summary*\nOklahoma City is warm and mostly cloudy.',
      routeKey: 'research.topic',
      capabilityId: 'research.topic',
      handlerKind: 'research',
      responseSource: 'research_local',
    });

    expect(evaluation.rewrittenText).toMatch(/^\*Research Summary\*/);
    expect(evaluation.rewrittenText).not.toContain('provider participated');
    expect(evaluation.rewrittenText).not.toContain('providers participated');
    expect(evaluation.evaluatorFlags).not.toContain(
      'provider_council_guidance_applied',
    );
  });

  it('keeps visible council guidance concise before user-facing answers', async () => {
    const { evaluateTurnReply } = await import('./turn-agent-harness.js');
    const longVerdict = Array.from(
      { length: 60 },
      (_, index) => `word${index}`,
    ).join(' ');

    const evaluation = evaluateTurnReply({
      context: {
        turnId: 'turn-long-council-guidance',
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
          evidenceLevel: 'partial',
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
            safeWriteClasses: [],
            reason: 'calendar',
            sources: [],
          },
          selectedSkill: {
            skillId: 'calendar.availability',
            taskFamily: 'calendar',
            purpose: 'calendar',
            inputs: [],
            outputs: [],
            evidenceLevel: 'partial',
            sideEffectRisk: 'medium',
            approvalNeed: 'conditional',
            failureModes: [],
            examples: [],
          },
          memoryTiers: ['working'],
          metadata: { raw_content_policy: 'local_only' },
          effectiveDirectives: [],
        },
        deliberation: {
          selectedRoute: 'direct_integration',
          expectedEvidence: 'partial',
        },
        platformHoldReply: null,
        providerCouncil: {
          councilRunId: 'council-long-visible',
          mode: 'dual_review',
          finalRoute: 'dual_review',
          approvalRequired: false,
          answerGuidance: {
            status: 'warn',
            visibleVerdict: longVerdict,
            answerDirection: 'Answer briefly.',
            confidence: 0.7,
            uncertainty: 'none',
            sourceMemberIds: ['openai_cloud'],
          },
        },
      },
      text: "I don't see anything at 3 PM tomorrow.",
      routeKey: 'calendar_lookup',
    });

    const firstLine = evaluation.rewrittenText.split('\n')[0] || '';
    expect(firstLine.split(/\s+/).length).toBeLessThanOrEqual(34);
    expect(firstLine).toMatch(/\.\.\.$/);
    expect(evaluation.rewrittenText).toContain(
      "I don't see anything at 3 PM tomorrow.",
    );
  });

  it('hides council hold jargon from user-facing block replies', async () => {
    const { evaluateTurnReply } = await import('./turn-agent-harness.js');

    const evaluation = evaluateTurnReply({
      context: {
        turnId: 'turn-block-council-guidance',
        channel: 'telegram',
        groupFolder: 'main',
        requestRoute: 'protected_assistant',
        taskFamily: 'calendar',
        meaningful: true,
        selectedSkill: {
          skillId: 'calendar.availability',
          taskFamily: 'calendar',
          purpose: 'calendar',
          inputs: [],
          outputs: [],
          evidenceLevel: 'strong',
          sideEffectRisk: 'none',
          approvalNeed: 'none',
          failureModes: [],
          examples: [],
        },
        contextCompile: {
          readPlan: {
            taskFamily: 'calendar',
            readTiers: ['working'],
            hotPath: true,
            safeWriteClasses: [],
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
            sideEffectRisk: 'none',
            approvalNeed: 'none',
            failureModes: [],
            examples: [],
          },
          memoryTiers: ['working'],
          metadata: {},
          effectiveDirectives: [],
        },
        deliberation: {
          selectedRoute: 'direct_integration',
          expectedEvidence: 'strong',
        },
        platformHoldReply: null,
        providerCouncil: {
          councilRunId: 'council-block',
          mode: 'dual_review',
          finalRoute: 'dual_review',
          approvalRequired: false,
          answerGuidance: {
            status: 'block',
            visibleVerdict:
              'Hold or block until the missing requirement is resolved.',
            answerDirection:
              'Use the local calendar lookup path before blocking.',
            confidence: 0.3,
            uncertainty: 'missing proof',
            blocker: 'calendar evidence is missing',
            sourceMemberIds: ['openai_cloud'],
          },
        },
      },
      text: 'Calendar answer placeholder.',
      routeKey: 'calendar_local_fast_path',
    });

    expect(evaluation.rewrittenText).toContain(
      'From the signals I can verify right now',
    );
    expect(evaluation.rewrittenText).not.toMatch(
      /Council check|Hold or block/i,
    );
  });

  it('hides council clarify jargon from user-facing clarification replies', async () => {
    const { evaluateTurnReply } = await import('./turn-agent-harness.js');

    const evaluation = evaluateTurnReply({
      context: {
        turnId: 'turn-clarify-council-guidance',
        channel: 'telegram',
        groupFolder: 'main',
        requestRoute: 'direct_assistant',
        taskFamily: 'assistant',
        meaningful: true,
        selectedSkill: {
          skillId: 'assistant.daily_guidance',
          taskFamily: 'assistant',
          purpose: 'guidance',
          inputs: [],
          outputs: [],
          evidenceLevel: 'partial',
          sideEffectRisk: 'none',
          approvalNeed: 'none',
          failureModes: [],
          examples: [],
        },
        contextCompile: {
          readPlan: {
            taskFamily: 'assistant',
            readTiers: ['working'],
            hotPath: true,
            safeWriteClasses: [],
            reason: 'guidance',
            sources: [],
          },
          selectedSkill: {
            skillId: 'assistant.daily_guidance',
            taskFamily: 'assistant',
            purpose: 'guidance',
            inputs: [],
            outputs: [],
            evidenceLevel: 'partial',
            sideEffectRisk: 'none',
            approvalNeed: 'none',
            failureModes: [],
            examples: [],
          },
          memoryTiers: ['working'],
          metadata: {},
          effectiveDirectives: [],
        },
        deliberation: {
          selectedRoute: 'local_capability',
          expectedEvidence: 'partial',
        },
        platformHoldReply: null,
        providerCouncil: {
          councilRunId: 'council-clarify',
          mode: 'dual_review',
          finalRoute: 'dual_review',
          approvalRequired: false,
          answerGuidance: {
            status: 'clarify',
            visibleVerdict:
              'Ask one clarifying question before acting. Ask what context the user wants checked.',
            answerDirection: 'Ask what context the user wants checked.',
            confidence: 0.45,
            uncertainty: 'missing context',
            sourceMemberIds: ['openai_cloud'],
          },
        },
      },
      text: 'I need a little more context.',
      routeKey: 'daily_guidance',
    });

    expect(evaluation.rewrittenText).toBe(
      'Ask what context the user wants checked.',
    );
    expect(evaluation.rewrittenText).not.toMatch(
      /Council check|Ask one clarifying question before acting|Hold or block/i,
    );
    expect(evaluation.evaluatorFlags).toContain('provider_council_clarify');
  });

  it('keeps a grounded local capability reply instead of replacing it with a council clarify question', async () => {
    const { evaluateTurnReply } = await import('./turn-agent-harness.js');

    const groundedSummary =
      'I found 12 synced Messages messages across 3 chats over the last 3 days.';
    const evaluation = evaluateTurnReply({
      context: {
        turnId: 'turn-clarify-grounded-local-reply',
        channel: 'bluebubbles',
        groupFolder: 'main',
        requestRoute: 'direct_assistant',
        taskFamily: 'communication',
        meaningful: true,
        selectedSkill: {
          skillId: 'communication.summarize_thread',
          taskFamily: 'communication',
          purpose: 'summary',
          inputs: [],
          outputs: [],
          evidenceLevel: 'partial',
          sideEffectRisk: 'none',
          approvalNeed: 'none',
          failureModes: [],
          examples: [],
        },
        contextCompile: {
          readPlan: {
            taskFamily: 'communication',
            readTiers: ['working'],
            hotPath: true,
            safeWriteClasses: [],
            reason: 'summary',
            sources: [],
          },
          selectedSkill: {
            skillId: 'communication.summarize_thread',
            taskFamily: 'communication',
            purpose: 'summary',
            inputs: [],
            outputs: [],
            evidenceLevel: 'partial',
            sideEffectRisk: 'none',
            approvalNeed: 'none',
            failureModes: [],
            examples: [],
          },
          memoryTiers: ['working'],
          metadata: {},
          effectiveDirectives: [],
        },
        deliberation: {
          selectedRoute: 'local_capability',
          expectedEvidence: 'partial',
        },
        platformHoldReply: null,
        providerCouncil: {
          councilRunId: 'council-clarify-grounded',
          mode: 'dual_review',
          finalRoute: 'dual_review',
          approvalRequired: false,
          answerGuidance: {
            status: 'clarify',
            visibleVerdict:
              'Ask one clarifying question before acting. Ask what context the user wants checked.',
            answerDirection: 'Ask what context the user wants checked.',
            confidence: 0.45,
            uncertainty: 'missing context',
            sourceMemberIds: ['openai_cloud'],
          },
        },
      },
      text: groundedSummary,
      routeKey: 'communication.summarize_thread',
      capabilityId: 'communication.summarize_thread',
      handlerKind: 'local',
      responseSource: 'local_companion',
    });

    expect(evaluation.rewrittenText).toContain(groundedSummary);
    expect(evaluation.rewrittenText).not.toMatch(
      /Ask what context the user wants checked/i,
    );
    expect(evaluation.evaluatorFlags).toContain(
      'provider_council_clarify_skipped_for_grounded_reply',
    );
  });

  it('keeps approval-first message sending even when council guidance sounds permissive', async () => {
    const { evaluateTurnReply } = await import('./turn-agent-harness.js');

    const evaluation = evaluateTurnReply({
      context: {
        turnId: 'turn-approval-first',
        channel: 'bluebubbles',
        groupFolder: 'main',
        requestRoute: 'direct_assistant',
        taskFamily: 'communication',
        meaningful: true,
        selectedSkill: {
          skillId: 'communication.reply_draft',
          taskFamily: 'communication',
          purpose: 'communication',
          inputs: [],
          outputs: [],
          evidenceLevel: 'partial',
          sideEffectRisk: 'high',
          approvalNeed: 'explicit',
          failureModes: [],
          examples: [],
        },
        contextCompile: {
          readPlan: {
            taskFamily: 'communication',
            readTiers: ['working'],
            hotPath: true,
            safeWriteClasses: ['episode_record'],
            reason: 'communication',
            sources: [],
          },
          selectedSkill: {
            skillId: 'communication.reply_draft',
            taskFamily: 'communication',
            purpose: 'communication',
            inputs: [],
            outputs: [],
            evidenceLevel: 'partial',
            sideEffectRisk: 'high',
            approvalNeed: 'explicit',
            failureModes: [],
            examples: [],
          },
          memoryTiers: ['working'],
          metadata: {},
          effectiveDirectives: ['require_send_approval'],
        },
        deliberation: {
          selectedRoute: 'local_capability',
          expectedEvidence: 'partial',
        },
        platformHoldReply: null,
        providerCouncil: {
          councilRunId: 'council-approval',
          mode: 'max_iq_council',
          finalRoute: 'max_iq_council',
          approvalRequired: false,
          answerGuidance: {
            status: 'pass',
            visibleVerdict: "Proceed; I'll send it now.",
            answerDirection: 'Send the message.',
            confidence: 0.9,
            uncertainty: 'none',
            sourceMemberIds: ['gemini_cloud'],
            recommendedAction: 'answer',
            approvalNeed: 'none',
          },
        },
      },
      text: "I'll send it now.",
      routeKey: 'communication.reply',
    });

    expect(evaluation.rewrittenText).toContain(
      'I drafted it for your approval',
    );
    expect(evaluation.rewrittenText).not.toContain("I'll send it now");
    expect(evaluation.evaluatorFlags).toEqual(
      expect.arrayContaining([
        'provider_council_guidance_applied',
        'communication_send_repaired',
        'directive:require_send_approval',
      ]),
    );
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
      text: 'You look free at 3 PM tomorrow. codex_local can check the task_ledger; route_calibration is repo_side and manual_sync_only.',
      routeKey: 'calendar_lookup',
      responseSource: 'local_companion',
    });

    expect(evaluation.safeRewriteApplied).toBe(true);
    expect(evaluation.rewrittenText).toContain("I don't see anything");
    expect(evaluation.rewrittenText).not.toContain('codex_local');
    expect(evaluation.rewrittenText).not.toContain('route_calibration');
    expect(evaluation.rewrittenText).not.toContain('repo_side');
    expect(evaluation.rewrittenText).not.toContain('manual_sync_only');
    expect(evaluation.evaluatorFlags).toContain('calendar_certainty_repaired');
    expect(evaluation.evaluatorFlags).toContain('operator_leakage_repaired');
  });

  it('does not append platform proof debt to handled local communication summaries', async () => {
    const { evaluateTurnReply } = await import('./turn-agent-harness.js');
    const now = '2026-07-06T12:00:00.000Z';

    const evaluation = evaluateTurnReply({
      context: {
        turnId: 'turn-comm-summary-no-episode',
        channel: 'telegram',
        groupFolder: 'main',
        requestRoute: 'direct_assistant',
        taskFamily: 'communication',
        meaningful: true,
        selectedSkill: {
          skillId: 'bluebubbles.continuity',
          taskFamily: 'communication',
          purpose: 'communication',
          inputs: [],
          outputs: [],
          evidenceLevel: 'partial',
          sideEffectRisk: 'high',
          approvalNeed: 'explicit',
          failureModes: [],
          examples: [],
        },
        contextCompile: {
          readPlan: {
            taskFamily: 'communication',
            readTiers: ['working'],
            hotPath: true,
            safeWriteClasses: ['episode_record'],
            reason: 'communication',
            sources: [],
          },
          selectedSkill: {
            skillId: 'bluebubbles.continuity',
            taskFamily: 'communication',
            purpose: 'communication',
            inputs: [],
            outputs: [],
            evidenceLevel: 'partial',
            sideEffectRisk: 'high',
            approvalNeed: 'explicit',
            failureModes: [],
            examples: [],
          },
          memoryTiers: ['working'],
          metadata: {},
          effectiveDirectives: [],
        },
        deliberation: { selectedRoute: 'local_capability' },
        logicRun: {
          report: {
            generatedAt: now,
            ok: true,
            subject: 'communication summary',
            beliefState: null,
            claims: [],
            evidenceLinks: [],
            contradictions: [],
            hypotheses: [],
            missingPremises: [
              {
                premiseId: 'premise-missing-episode',
                subject: 'communication summary',
                episodeId: null,
                createdAt: now,
                updatedAt: now,
                status: 'open',
                question:
                  'No Agent OS episode is available yet. Run a task drill or a real task turn first.',
                blockerClass: 'missing_episode',
                requiredEvidenceJson: '["agent_os_episode"]',
                nextAction:
                  'Run npm run debug:agent-os -- --task-drill --json.',
                privacyJson: '{}',
              },
            ],
            usefulnessScores: [],
            decision: null,
            confidence: 0.58,
            selectedNextAction: 'Answer with the local capability result.',
            summary: 'No Agent OS episode exists yet.',
            privacy: {} as never,
          },
          beliefState: null,
          decision: null,
        } as never,
        platformHoldReply: null,
      },
      text: 'I did not find any synced Messages activity across your chats over the last 48 hours.',
      routeKey: 'communication.review_recent_texts',
      capabilityId: 'communication.review_recent_texts',
      handlerKind: 'assistant_capability',
      responseSource: 'local_companion',
    });

    expect(evaluation.rewrittenText).toBe(
      'I did not find any synced Messages activity across your chats over the last 48 hours.',
    );
    expect(evaluation.rewrittenText).not.toContain('Agent OS episode');
    expect(evaluation.rewrittenText).not.toContain('task drill');
    expect(evaluation.evaluatorFlags).toContain(
      'logic:platform_proof_debt_suppressed',
    );
  });

  it('strips Agent OS proof debt caveats from user-facing local replies', async () => {
    const { evaluateTurnReply } = await import('./turn-agent-harness.js');

    const evaluation = evaluateTurnReply({
      context: null,
      text: [
        'Research Summary',
        'I do not have saved material on that yet.',
        '',
        'Before I treat that as certain: No Agent OS episode is available yet. Run a task drill or a real task turn first.',
      ].join('\n'),
      routeKey: 'knowledge.summarize_saved',
      capabilityId: 'knowledge.summarize_saved',
      handlerKind: 'assistant_capability',
      responseSource: 'local_companion',
    });

    expect(evaluation.rewrittenText).toContain('Research Summary');
    expect(evaluation.rewrittenText).not.toContain('Agent OS episode');
    expect(evaluation.rewrittenText).not.toContain('task drill');
    expect(evaluation.evaluatorFlags).toContain('operator_leakage_repaired');
  });

  it('filters high-risk active skills from hot-path directives but exposes low-risk directives', async () => {
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
        if (String(input).endsWith('/skill-evolution-report')) {
          return new Response(
            JSON.stringify({
              active_skills: [
                {
                  candidate_id: 'low-risk-candidate',
                  skill_id: 'calendar.narrow_certainty',
                  task_family: 'calendar',
                  lifecycle_status: 'active',
                  summary: 'Use narrow calendar wording.',
                  evidence_count: 4,
                  risk_level: 'low',
                  approval_required: false,
                  metadata: {
                    directives:
                      'narrow_calendar_wording,strip_internal_leakage',
                  },
                },
                {
                  candidate_id: 'high-risk-candidate',
                  skill_id: 'communication.unsafe_send',
                  task_family: 'calendar',
                  lifecycle_status: 'active',
                  summary: 'Should not influence hot path because high risk.',
                  evidence_count: 5,
                  risk_level: 'high',
                  approval_required: true,
                  metadata: {
                    directives: 'require_send_approval',
                  },
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            task: { task_ledger_id: 'task-cal' },
            progress: { progress_ledger_id: 'progress-cal' },
            plan: { plan_id: 'plan-cal', route: 'direct_integration' },
            decision: {
              decision_id: 'decision-cal',
              selected_route: 'direct_integration',
              execution_posture: 'execute_now',
              answer_strategy: 'narrow_claim',
              selected_policy_id: 'direct_integration',
              expected_evidence: 'strong',
            },
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    );

    const { beginTurnAgentHarness } = await import('./turn-agent-harness.js');
    const context = await beginTurnAgentHarness({
      turnId: 'turn-cal-directives',
      channel: 'telegram',
      groupFolder: 'main',
      text: 'do I have anything at 3 tomorrow',
      requestRoute: 'direct_assistant',
    });

    expect(context?.contextCompile.effectiveDirectives).toEqual([
      'narrow_calendar_wording',
      'strip_internal_leakage',
    ]);
    expect(context?.contextCompile.metadata.active_skill_directives).toBe(
      'narrow_calendar_wording,strip_internal_leakage',
    );
    expect(context?.contextCompile.metadata.active_skill_directive_mode).toBe(
      'low_risk_read_only',
    );
    const deliberationCall = calls.find((call) =>
      call.url.endsWith('/deliberate'),
    );
    expect(deliberationCall?.body).toMatchObject({
      metadata: {
        active_skill_directives:
          'narrow_calendar_wording,strip_internal_leakage',
        active_skill_directive_mode: 'low_risk_read_only',
      },
    });
    const directivesString = String(
      (deliberationCall?.body as { metadata?: Record<string, unknown> })
        ?.metadata?.active_skill_directives ?? '',
    );
    expect(directivesString).not.toContain('require_send_approval');
  });

  it('honors active narrow_calendar_wording directive for broader phrasing', async () => {
    const { evaluateTurnReply } = await import('./turn-agent-harness.js');

    const evaluation = evaluateTurnReply({
      context: {
        turnId: 'turn-cal-broad',
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
          effectiveDirectives: ['narrow_calendar_wording'],
        },
        deliberation: {
          selectedRoute: 'direct_integration',
          expectedEvidence: 'strong',
        },
        platformHoldReply: null,
      },
      text: 'Your calendar is clear all afternoon.',
      routeKey: 'calendar_lookup',
      responseSource: 'local_companion',
    });

    expect(evaluation.safeRewriteApplied).toBe(true);
    expect(evaluation.rewrittenText).toContain(
      "I don't see anything in the calendar evidence",
    );
    expect(evaluation.evaluatorFlags).toContain(
      'directive:narrow_calendar_wording',
    );
  });

  it('honors require_send_approval directive on communication drafts', async () => {
    const { evaluateTurnReply } = await import('./turn-agent-harness.js');

    const evaluation = evaluateTurnReply({
      context: {
        turnId: 'turn-comm-directive',
        channel: 'telegram',
        groupFolder: 'main',
        requestRoute: 'direct_assistant',
        taskFamily: 'communication',
        meaningful: true,
        selectedSkill: {
          skillId: 'communication.reply_help',
          taskFamily: 'communication',
          purpose: 'communication',
          inputs: [],
          outputs: [],
          evidenceLevel: 'partial',
          sideEffectRisk: 'high',
          approvalNeed: 'explicit',
          failureModes: [],
          examples: [],
        },
        contextCompile: {
          readPlan: {
            taskFamily: 'communication',
            readTiers: ['working'],
            hotPath: true,
            safeWriteClasses: ['episode_record'],
            reason: 'communication',
            sources: [],
          },
          selectedSkill: {
            skillId: 'communication.reply_help',
            taskFamily: 'communication',
            purpose: 'communication',
            inputs: [],
            outputs: [],
            evidenceLevel: 'partial',
            sideEffectRisk: 'high',
            approvalNeed: 'explicit',
            failureModes: [],
            examples: [],
          },
          memoryTiers: ['working'],
          metadata: {},
          effectiveDirectives: ['require_send_approval'],
        },
        deliberation: { selectedRoute: 'local_capability' },
        platformHoldReply: null,
      },
      text: "I'll send it now.",
      routeKey: 'message.reply',
      responseSource: 'local_companion',
    });

    expect(evaluation.safeRewriteApplied).toBe(true);
    expect(evaluation.rewrittenText).toContain('drafted it for your approval');
    expect(evaluation.evaluatorFlags).toContain(
      'directive:require_send_approval',
    );
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
