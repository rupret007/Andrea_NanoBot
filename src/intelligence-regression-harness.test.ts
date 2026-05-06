import { afterEach, describe, expect, it, vi } from 'vitest';

describe('intelligence regression harness', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('runs deterministic golden scenarios and records metadata-only results', async () => {
    vi.stubEnv('ANDREA_PLATFORM_COORDINATOR_ENABLED', 'true');
    vi.stubEnv('ANDREA_PLATFORM_FALLBACK_TO_DIRECT_RUNTIME', 'false');
    vi.stubEnv('ANDREA_PLATFORM_COORDINATOR_URL', 'http://127.0.0.1:4400');
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const body = JSON.parse(String(init?.body || '{}')) as Record<
          string,
          unknown
        >;
        calls.push({ url, body });
        if (url.endsWith('/skill-evolution-report')) {
          return new Response(JSON.stringify({ active_skills: [] }), {
            status: 200,
          });
        }
        if (url.endsWith('/council-run')) {
          const mode = String(body.requestedMode || 'dual_review');
          const members =
            mode === 'max_iq_council'
              ? [
                  { member_id: 'openai_cloud', status: 'completed' },
                  { member_id: 'minimax_cloud', status: 'completed' },
                  { member_id: 'brave_search', status: 'completed' },
                  { member_id: 'andrea_platform', status: 'completed' },
                ]
              : [
                  { member_id: 'openai_cloud', status: 'completed' },
                  { member_id: 'andrea_platform', status: 'completed' },
                ];
          return new Response(
            JSON.stringify({
              council: {
                council_run_id: `council-${calls.length}`,
                request_id: `request-${calls.length}`,
                mode,
                status: 'completed',
                trace_id: body.correlationId || 'trace-1',
                members,
              },
              verdict: {
                verdict_id: `verdict-${calls.length}`,
                final_route: mode,
                answer_strategy: 'verified_synthesis',
                confidence: 0.86,
                approval_required: mode === 'repair_council',
              },
            }),
            { status: 200 },
          );
        }
        if (url.endsWith('/reflect')) {
          return new Response(
            JSON.stringify({
              reflection: { reflection_id: `reflection-${calls.length}` },
              evaluation: { evaluation_id: `evaluation-${calls.length}` },
              learning: { learning_id: `learning-${calls.length}` },
              trace_grade: {
                grade_id: `grade-reflect-${calls.length}`,
                status: 'pass',
              },
            }),
            { status: 200 },
          );
        }
        if (url.endsWith('/skill-candidate')) {
          return new Response(
            JSON.stringify({
              candidate: { candidate_id: `candidate-${calls.length}` },
            }),
            { status: 200 },
          );
        }
        if (url.endsWith('/intelligence-regression')) {
          return new Response(
            JSON.stringify({
              report: {
                report_id: 'intel-report-1',
                status: body.status,
                mode: body.mode,
                total_score: body.totalScore,
                critical_score: body.criticalScore,
                scenario_count: Array.isArray(body.scenarioResults)
                  ? body.scenarioResults.length
                  : 0,
                critical_failure_count: body.criticalFailureCount || 0,
              },
            }),
            { status: 200 },
          );
        }
        const category = String(body.category || 'assistant');
        return new Response(
          JSON.stringify({
            task: { task_ledger_id: `task-${calls.length}` },
            progress: { progress_ledger_id: `progress-${calls.length}` },
            plan: {
              plan_id: `plan-${calls.length}`,
              route:
                category === 'calendar' || category === 'research'
                  ? 'direct_integration'
                  : category === 'operator'
                    ? 'runtime_conductor'
                    : 'local_capability',
            },
            decision: {
              decision_id: `decision-${calls.length}`,
              selected_route:
                category === 'calendar' || category === 'research'
                  ? 'direct_integration'
                  : category === 'operator'
                    ? 'runtime_conductor'
                    : 'local_capability',
              execution_posture: 'execute_now',
              answer_strategy: 'narrow_claim',
              selected_policy_id:
                category === 'calendar' || category === 'research'
                  ? 'direct_integration'
                  : category === 'operator'
                    ? 'runtime_conductor'
                    : 'local_capability',
              expected_evidence: category === 'research' ? 'strong' : 'partial',
            },
            trace_grade: { grade_id: `grade-${calls.length}`, status: 'pass' },
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    );

    const { runIntelligenceRegressionHarness } =
      await import('./intelligence-regression-harness.js');
    const report = await runIntelligenceRegressionHarness({
      runId: 'intel-test-run',
      mode: 'regression',
    });

    expect(report).toMatchObject({
      runId: 'intel-test-run',
      criticalFailureCount: 0,
      platformReportId: 'intel-report-1',
    });
    expect(['pass', 'warn']).toContain(report.status);
    expect(report.scenarioCount).toBeGreaterThanOrEqual(9);
    expect(
      report.scenarios.find(
        (scenario) => scenario.scenarioId === 'repair.approval_binding',
      )?.actual.task_family,
    ).toBe('operator');
    const regressionCall = calls.find((call) =>
      call.url.endsWith('/intelligence-regression'),
    );
    expect(regressionCall?.body).toMatchObject({
      runId: 'intel-test-run',
      mode: 'regression',
      metadata: {
        raw_private_memory_allowed: 'false',
        secret_material_allowed: 'false',
      },
    });
    expect(JSON.stringify(regressionCall?.body)).not.toContain(
      'private preference',
    );
    expect(JSON.stringify(regressionCall?.body)).not.toContain(
      'send that text',
    );
  });

  it('can run a filtered scenario subset for targeted council diagnostics', async () => {
    vi.stubEnv('ANDREA_PLATFORM_COORDINATOR_ENABLED', 'true');
    vi.stubEnv('ANDREA_PLATFORM_FALLBACK_TO_DIRECT_RUNTIME', 'false');
    vi.stubEnv('ANDREA_PLATFORM_COORDINATOR_URL', 'http://127.0.0.1:4400');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const body = JSON.parse(String(init?.body || '{}')) as Record<
          string,
          unknown
        >;
        if (url.endsWith('/skill-evolution-report')) {
          return new Response(JSON.stringify({ active_skills: [] }), {
            status: 200,
          });
        }
        if (url.endsWith('/council-run')) {
          return new Response(
            JSON.stringify({
              council: {
                council_run_id: 'council-filtered',
                mode: body.requestedMode || 'max_iq_council',
                status: 'completed',
                trace_id: body.correlationId || 'trace-filtered',
                members: [
                  { member_id: 'openai_cloud', status: 'completed' },
                  { member_id: 'minimax_cloud', status: 'completed' },
                  { member_id: 'gemini_cloud', status: 'completed' },
                  { member_id: 'brave_search', status: 'completed' },
                ],
              },
              verdict: {
                verdict_id: 'verdict-filtered',
                final_route: body.requestedMode || 'max_iq_council',
                answer_strategy: 'verified_synthesis',
                confidence: 0.86,
              },
            }),
            { status: 200 },
          );
        }
        if (url.endsWith('/intelligence-regression')) {
          return new Response(
            JSON.stringify({
              report: {
                report_id: 'intel-report-filtered',
                status: body.status,
                scenario_count: Array.isArray(body.scenarioResults)
                  ? body.scenarioResults.length
                  : 0,
                critical_failure_count: body.criticalFailureCount || 0,
              },
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            task: { task_ledger_id: 'task-filtered' },
            progress: { progress_ledger_id: 'progress-filtered' },
            plan: { plan_id: 'plan-filtered', route: 'runtime_conductor' },
            decision: {
              selected_route: 'runtime_conductor',
              execution_posture: 'execute_now',
              answer_strategy: 'verified_synthesis',
              selected_policy_id: 'runtime_conductor',
              expected_evidence: 'strong',
            },
            trace_grade: { grade_id: 'grade-filtered', status: 'pass' },
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    );

    const { runIntelligenceRegressionHarness } =
      await import('./intelligence-regression-harness.js');
    const report = await runIntelligenceRegressionHarness({
      runId: 'intel-filtered-run',
      scenarioIds: ['council.max_iq_roles'],
    });

    expect(report.scenarioCount).toBe(1);
    expect(report.scenarios[0]?.scenarioId).toBe('council.max_iq_roles');
    expect(report.scenarios[0]?.actual.council_id).toBe('council-filtered');
  });
});
