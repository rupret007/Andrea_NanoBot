import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChannelHealthSnapshot, RuntimeBackendStatus } from './types.js';

describe('andrea platform shell bridge', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('posts shell intent and health events when the bridge is enabled', async () => {
    vi.stubEnv('ANDREA_PLATFORM_SHELL_GATEWAY_URL', 'http://127.0.0.1:4401/');

    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: String(input),
          body: init?.body,
        });
        return new Response(null, { status: 202 });
      },
    );
    vi.stubGlobal('fetch', fetchImpl as unknown as typeof fetch);

    const bridge = await import('./andrea-platform-bridge.js');

    expect(bridge.isAndreaPlatformShellBridgeEnabled()).toBe(true);

    await bridge.emitAndreaPlatformIntentRequest({
      channel: 'telegram',
      actorId: 'user-1',
      groupFolder: 'main',
      text: 'What matters today?',
      routeHint: 'chief_of_staff',
      metadata: { source: 'test' },
    });
    await bridge.emitAndreaPlatformIntentResponse({
      channel: 'telegram',
      actorId: 'user-1',
      groupFolder: 'main',
      summary: 'Shared the current priorities.',
      outcome: 'handled',
      metadata: { source: 'test' },
    });
    await bridge.emitAndreaPlatformShellHealth({
      severity: 'healthy',
      summary: 'Shell is healthy.',
      detail: 'Loopback backend reachable.',
      metadata: { source: 'test' },
    });
    await bridge.emitAndreaPlatformShellConfigSnapshot({
      component: 'andrea.memory',
      configName: 'memory_freshness_rollup',
      snapshot: { semanticMemory: '12 subjects' },
    });
    await bridge.emitAndreaPlatformProofEvent({
      surface: 'telegram',
      journey: 'smoke',
      state: 'LIVE_PROVEN',
      summary: 'Telegram smoke is live-proven.',
      metadata: { source: 'test' },
    });
    await bridge.emitAndreaPlatformTransportEvent({
      transportId: 'telegram',
      transportKind: 'telegram',
      state: 'healthy',
      summary: 'Telegram transport is healthy.',
      deliverySemantics: 'long_polling',
      fallbackTarget: 'none',
      metadata: { source: 'test' },
    });
    await bridge.emitAndreaPlatformTraceEvent({
      traceId: 'feedback-1',
      traceKind: 'feedback',
      title: 'Response feedback captured',
      summary: 'Feedback entered the platform trace chain.',
      refs: { feedbackId: 'feedback-1' },
      metadata: { source: 'test' },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(7);
    expect(calls[0]?.url).toBe('http://127.0.0.1:4401/intent/request');
    expect(calls[1]?.url).toBe('http://127.0.0.1:4401/intent/response');
    expect(calls[2]?.url).toBe('http://127.0.0.1:4401/system/health');
    expect(calls[3]?.url).toBe('http://127.0.0.1:4401/config/snapshot');
    expect(calls[4]?.url).toBe('http://127.0.0.1:4401/proof/event');
    expect(calls[5]?.url).toBe('http://127.0.0.1:4401/transport/event');
    expect(calls[6]?.url).toBe('http://127.0.0.1:4401/trace/event');

    const firstBody = JSON.parse(String(calls[0]?.body ?? '{}'));
    const secondBody = JSON.parse(String(calls[1]?.body ?? '{}'));
    const thirdBody = JSON.parse(String(calls[2]?.body ?? '{}'));
    const fourthBody = JSON.parse(String(calls[3]?.body ?? '{}'));
    const fifthBody = JSON.parse(String(calls[4]?.body ?? '{}'));
    const sixthBody = JSON.parse(String(calls[5]?.body ?? '{}'));
    const seventhBody = JSON.parse(String(calls[6]?.body ?? '{}'));

    expect(firstBody).toMatchObject({
      source: 'andrea_nanobot',
      channel: 'telegram',
      actor_id: 'user-1',
      group_folder: 'main',
      text: 'What matters today?',
      route_hint: 'chief_of_staff',
      metadata: { source: 'test' },
    });
    expect(secondBody).toMatchObject({
      source: 'andrea_nanobot',
      channel: 'telegram',
      actor_id: 'user-1',
      group_folder: 'main',
      summary: 'Shared the current priorities.',
      outcome: 'handled',
      metadata: { source: 'test' },
    });
    expect(thirdBody).toMatchObject({
      source: 'andrea_nanobot',
      component: 'andrea.shell',
      owner: 'shell',
      severity: 'healthy',
      summary: 'Shell is healthy.',
      detail: 'Loopback backend reachable.',
      metadata: { source: 'test' },
    });
    expect(fourthBody).toMatchObject({
      source: 'andrea_nanobot',
      component: 'andrea.memory',
      config_name: 'memory_freshness_rollup',
    });
    expect(JSON.parse(String(fourthBody.snapshot_json))).toEqual({
      semanticMemory: '12 subjects',
    });
    expect(fifthBody).toMatchObject({
      source: 'andrea_nanobot',
      surface: 'telegram',
      journey: 'smoke',
      state: 'LIVE_PROVEN',
      summary: 'Telegram smoke is live-proven.',
      metadata: { source: 'test' },
    });
    expect(sixthBody).toMatchObject({
      source: 'andrea_nanobot',
      transport_id: 'telegram',
      transport_kind: 'telegram',
      state: 'healthy',
      summary: 'Telegram transport is healthy.',
      delivery_semantics: 'long_polling',
      fallback_target: 'none',
      metadata: { source: 'test' },
    });
    expect(seventhBody).toMatchObject({
      source: 'andrea_nanobot',
      trace_id: 'feedback-1',
      trace_kind: 'feedback',
      title: 'Response feedback captured',
      summary: 'Feedback entered the platform trace chain.',
      refs: { feedbackId: 'feedback-1' },
      metadata: { source: 'test' },
    });
  });

  it('maps runtime backend auth requirements to a near-live shell health state', async () => {
    const bridge = await import('./andrea-platform-bridge.js');
    const status: RuntimeBackendStatus = {
      state: 'auth_required',
      backend: 'andrea_openai',
      version: '1.0.0',
      transport: 'http',
      detail: 'Login still required.',
      meta: null,
    };

    expect(bridge.mapShellHealthFromBackendStatus(status)).toEqual({
      severity: 'near_live_only',
      summary:
        'NanoBot can reach the runtime backend, but local auth is still required.',
      detail: 'Login still required.',
    });
  });

  it('posts response-feedback reflections to the platform coordinator when enabled', async () => {
    vi.stubEnv('ANDREA_PLATFORM_COORDINATOR_ENABLED', 'true');
    vi.stubEnv('ANDREA_PLATFORM_COORDINATOR_URL', 'http://127.0.0.1:4400/');
    vi.stubEnv('ANDREA_PLATFORM_FALLBACK_TO_DIRECT_RUNTIME', 'false');

    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: String(input),
          body: init?.body,
        });
        return new Response(
          JSON.stringify({
            task: { task_ledger_id: 'task-1' },
            progress: { progress_ledger_id: 'progress-1' },
            reflection: { reflection_id: 'reflection-1' },
            evaluation: { evaluation_id: 'evaluation-1' },
            learning: { learning_id: 'learning-1' },
          }),
          { status: 200 },
        );
      },
    );
    vi.stubGlobal('fetch', fetchImpl as unknown as typeof fetch);

    const bridge = await import('./andrea-platform-bridge.js');
    const result = await bridge.emitAndreaPlatformFeedbackReflection({
      feedbackId: 'feedback-1',
      issueId: 'issue-1',
      status: 'awaiting_confirmation',
      classification: 'repo_side_rough_edge',
      taskFamily: 'calendar',
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'telegram:main',
      routeKey: 'calendar_local_fast_path',
      capabilityId: 'calendar.local_lookup',
      blockerOwner: 'repo_side',
      platformMessageId: 'msg-1',
      userMessageId: 'user-msg-1',
      summary: 'User downvoted a calendar answer.',
      originalUserPreview: 'Do I have anything at 3pm tomorrow?',
      assistantReplyPreview: "I don't see anything at 3 PM tomorrow.",
    });

    expect(result).toMatchObject({
      feedbackId: 'feedback-1',
      taskLedgerId: 'task-1',
      progressLedgerId: 'progress-1',
      reflectionId: 'reflection-1',
      evaluationId: 'evaluation-1',
      learningId: 'learning-1',
    });
    expect(calls[0]?.url).toBe('http://127.0.0.1:4400/feedback/reflection');
    expect(JSON.parse(String(calls[0]?.body ?? '{}'))).toMatchObject({
      feedbackId: 'feedback-1',
      correlationId: 'feedback-1',
      taskFamily: 'calendar',
      sentiment: 'negative',
      outcome: 'degraded',
      metadata: {
        issueId: 'issue-1',
        routeKey: 'calendar_local_fast_path',
        capabilityId: 'calendar.local_lookup',
      },
    });
  });

  it('posts and reads skill-evolution records through the platform coordinator', async () => {
    vi.stubEnv('ANDREA_PLATFORM_COORDINATOR_ENABLED', 'true');
    vi.stubEnv('ANDREA_PLATFORM_COORDINATOR_URL', 'http://127.0.0.1:4400/');
    vi.stubEnv('ANDREA_PLATFORM_FALLBACK_TO_DIRECT_RUNTIME', 'false');

    const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: String(input),
          method: init?.method,
          body: init?.body,
        });
        if (init?.method === 'GET') {
          return new Response(
            JSON.stringify({
              active_skills: [
                {
                  candidate_id: 'candidate-1',
                  skill_id: 'calendar.narrow_availability',
                  task_family: 'calendar',
                  lifecycle_status: 'active',
                  summary: 'Use narrow calendar wording.',
                  evidence_count: 3,
                  risk_level: 'low',
                  approval_required: false,
                },
                {
                  candidate_id: 'candidate-2',
                  skill_id: 'communication.approval_gate',
                  task_family: 'communication',
                  lifecycle_status: 'active',
                  summary: 'Require approval before send claims.',
                  evidence_count: 4,
                  risk_level: 'high',
                  approval_required: true,
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            candidate: {
              candidate_id: 'candidate-3',
              skill_id: 'calendar.narrow_availability',
              task_family: 'calendar',
              lifecycle_status: 'staged',
              summary: 'Stage narrow calendar wording.',
              evidence_count: 1,
              risk_level: 'low',
              approval_required: false,
            },
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    );

    const bridge = await import('./andrea-platform-bridge.js');
    const created = await bridge.emitAndreaPlatformSkillCandidate({
      skillId: 'calendar.narrow_availability',
      taskFamily: 'calendar',
      sourceKind: 'eval_failure',
      summary: 'Stage narrow calendar wording.',
      riskLevel: 'low',
      linkedTraceIds: ['trace-1'],
      linkedEvaluationIds: ['evaluation-1'],
    });
    const activeCalendarSkills =
      await bridge.listAndreaPlatformActiveSkillCandidates('calendar');

    expect(created?.candidate).toMatchObject({
      candidateId: 'candidate-3',
      skillId: 'calendar.narrow_availability',
      lifecycleStatus: 'staged',
    });
    expect(activeCalendarSkills).toHaveLength(1);
    expect(activeCalendarSkills[0]).toMatchObject({
      candidateId: 'candidate-1',
      skillId: 'calendar.narrow_availability',
    });
    expect(calls[0]?.url).toBe('http://127.0.0.1:4400/skill-candidate');
    expect(JSON.parse(String(calls[0]?.body ?? '{}'))).toMatchObject({
      skillId: 'calendar.narrow_availability',
      taskFamily: 'calendar',
      sourceKind: 'eval_failure',
      metadata: {
        sourceSystem: 'andrea_nanobot',
        raw_content_policy: 'metadata_only',
      },
    });
    expect(calls[1]?.url).toBe('http://127.0.0.1:4400/skill-evolution-report');
  });

  it('posts deliberation and repair requests to the platform coordinator when enabled', async () => {
    vi.stubEnv('ANDREA_PLATFORM_COORDINATOR_ENABLED', 'true');
    vi.stubEnv('ANDREA_PLATFORM_COORDINATOR_URL', 'http://127.0.0.1:4400/');
    vi.stubEnv('ANDREA_PLATFORM_FALLBACK_TO_DIRECT_RUNTIME', 'false');

    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: String(input),
          body: init?.body,
        });
        if (String(input).endsWith('/deliberate')) {
          return new Response(
            JSON.stringify({
              task: { task_ledger_id: 'task-1' },
              progress: { progress_ledger_id: 'progress-1' },
              evaluation: { evaluation_id: 'evaluation-1' },
              plan: {
                plan_id: 'plan-1',
                route: 'local_capability',
                selected_workers: ['andrea_shell'],
                confidence: 0.82,
              },
              decision: {
                decision_id: 'decision-1',
                selected_route: 'local_capability',
                selected_worker: 'andrea_shell',
                execution_posture: 'execute_now',
                answer_strategy: 'direct_answer',
                selected_policy_id: 'local_capability',
                required_approval: false,
                confidence: 0.82,
                expected_evidence: 'partial',
              },
            }),
            { status: 200 },
          );
        }
        if (String(input).endsWith('/diagnose')) {
          return new Response(
            JSON.stringify({
              diagnosis: {
                diagnosis_id: 'diagnosis-1',
                status: 'diagnosed',
                suspected_cause: 'route_miss',
              },
              repair_run: { repair_run_id: 'repair-run-1' },
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            diagnosis: { diagnosis_id: 'diagnosis-1' },
            repair_plan: {
              repair_plan_id: 'repair-plan-1',
              status: 'awaiting_approval',
              worker_id: 'codex_cloud',
              cloud_worker_id: 'cursor_cloud',
              approval_summary: 'One approval lets Andrea repair this.',
            },
            repair_run: { repair_run_id: 'repair-run-1' },
          }),
          { status: 200 },
        );
      },
    );
    vi.stubGlobal('fetch', fetchImpl as unknown as typeof fetch);

    const bridge = await import('./andrea-platform-bridge.js');
    const decision = await bridge.emitAndreaPlatformDeliberation({
      goal: 'Fix this downvoted reply.',
      taskFamily: 'assistant',
      groupFolder: 'main',
      correlationId: 'feedback-1',
      routeCandidates: ['local_capability', 'clarify_first'],
      memoryMetadata: { memory_read_tiers: 'working' },
    });
    const diagnosis = await bridge.emitAndreaPlatformDiagnosis({
      goal: 'Diagnose response feedback feedback-1.',
      correlationId: 'feedback-1',
      taskFamily: 'assistant',
      signals: [{ signalKind: 'downvote', severity: 'warn' }],
    });
    const repairPlan = await bridge.emitAndreaPlatformRepairPlan({
      goal: 'Repair response feedback feedback-1.',
      diagnosisId: diagnosis?.diagnosisId,
      correlationId: 'feedback-1',
      workerId: 'codex_cloud',
      cloudWorkerId: 'cursor_cloud',
      affectedRepos: ['Andrea_NanoBot'],
      testsRequired: ['npm test'],
    });

    expect(decision).toMatchObject({
      taskLedgerId: 'task-1',
      progressLedgerId: 'progress-1',
      evaluationId: 'evaluation-1',
      planId: 'plan-1',
      decisionId: 'decision-1',
      selectedRoute: 'local_capability',
      executionPosture: 'execute_now',
      selectedPolicyId: 'local_capability',
      requiredApproval: false,
      confidence: 0.82,
    });
    expect(diagnosis).toMatchObject({
      diagnosisId: 'diagnosis-1',
      status: 'diagnosed',
      repairRunId: 'repair-run-1',
    });
    expect(repairPlan).toMatchObject({
      diagnosisId: 'diagnosis-1',
      repairPlanId: 'repair-plan-1',
      repairRunId: 'repair-run-1',
      workerId: 'codex_cloud',
      cloudWorkerId: 'cursor_cloud',
    });

    expect(calls.map((call) => call.url)).toEqual([
      'http://127.0.0.1:4400/deliberate',
      'http://127.0.0.1:4400/diagnose',
      'http://127.0.0.1:4400/repair/plan',
    ]);
    expect(JSON.parse(String(calls[0]?.body ?? '{}'))).toMatchObject({
      goal: 'Fix this downvoted reply.',
      category: 'assistant',
      correlationId: 'feedback-1',
      metadata: {
        sourceSystem: 'andrea_nanobot',
        turn_intelligence_version: 'v10',
        memory_read_tiers: 'working',
      },
    });
    expect(JSON.parse(String(calls[2]?.body ?? '{}'))).toMatchObject({
      diagnosisId: 'diagnosis-1',
      workerId: 'codex_cloud',
      cloudWorkerId: 'cursor_cloud',
      affectedRepos: ['Andrea_NanoBot'],
    });
  });

  it('posts scoped repair approval and external execution evidence', async () => {
    vi.stubEnv('ANDREA_PLATFORM_COORDINATOR_ENABLED', 'true');
    vi.stubEnv('ANDREA_PLATFORM_COORDINATOR_URL', 'http://127.0.0.1:4400/');
    vi.stubEnv('ANDREA_PLATFORM_FALLBACK_TO_DIRECT_RUNTIME', 'false');

    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), body: init?.body });
        if (String(input).endsWith('/repair/approve')) {
          return new Response(
            JSON.stringify({
              approval: { approval_id: 'approval-1' },
              repair_run: { repair_run_id: 'repair-run-1' },
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            repair_plan: { repair_plan_id: 'repair-plan-1' },
            execution: { execution_id: 'execution-1' },
            verification: { evidence_id: 'evidence-1' },
            repair_run: { repair_run_id: 'repair-run-1' },
            trace_grade: {
              trace_grade_id: 'trace-grade-1',
              status: 'pass',
            },
          }),
          { status: 200 },
        );
      },
    );
    vi.stubGlobal('fetch', fetchImpl as unknown as typeof fetch);

    const bridge = await import('./andrea-platform-bridge.js');
    const approval = await bridge.emitAndreaPlatformRepairApproval({
      repairPlanId: 'repair-plan-1',
      approvedBy: 'Jeff',
      metadata: { approvalScope: 'feedback:1; repo:Andrea_NanoBot' },
    });
    const execution = await bridge.emitAndreaPlatformRepairExecution({
      repairPlanId: 'repair-plan-1',
      approvalId: approval?.approvalId,
      externalJobId: 'cursor-job-1',
      externalLaneId: 'cursor',
      workerId: 'cursor_cloud',
      jobStatus: 'queued',
    });

    expect(approval).toEqual({
      approvalId: 'approval-1',
      repairRunId: 'repair-run-1',
    });
    expect(execution).toMatchObject({
      repairPlanId: 'repair-plan-1',
      repairRunId: 'repair-run-1',
      executionId: 'execution-1',
      verificationEvidenceId: 'evidence-1',
      traceGradeId: 'trace-grade-1',
      traceGradeStatus: 'pass',
    });
    expect(calls.map((call) => call.url)).toEqual([
      'http://127.0.0.1:4400/repair/approve',
      'http://127.0.0.1:4400/repair/execute',
    ]);
    expect(JSON.parse(String(calls[1]?.body ?? '{}'))).toMatchObject({
      repairPlanId: 'repair-plan-1',
      approvalId: 'approval-1',
      externalJobId: 'cursor-job-1',
      externalLaneId: 'cursor',
      workerId: 'cursor_cloud',
      metadata: { sourceSystem: 'andrea_nanobot' },
    });
  });

  it('posts repair verification, deployment, and completion evidence', async () => {
    vi.stubEnv('ANDREA_PLATFORM_COORDINATOR_ENABLED', 'true');
    vi.stubEnv('ANDREA_PLATFORM_COORDINATOR_URL', 'http://127.0.0.1:4400/');
    vi.stubEnv('ANDREA_PLATFORM_FALLBACK_TO_DIRECT_RUNTIME', 'false');

    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), body: init?.body });
        if (String(input).endsWith('/repair/evidence')) {
          return new Response(
            JSON.stringify({
              repair_plan: { repair_plan_id: 'repair-plan-1' },
              execution: { execution_id: 'execution-1' },
              verification: { evidence_id: 'evidence-1' },
              repair_run: { repair_run_id: 'repair-run-1' },
              trace_grade: {
                trace_grade_id: 'trace-grade-1',
                status: 'pass',
              },
            }),
            { status: 200 },
          );
        }
        if (String(input).endsWith('/repair/deployment')) {
          return new Response(
            JSON.stringify({
              deployment: { deployment_id: 'deployment-1' },
              repair_run: { repair_run_id: 'repair-run-1' },
              trace_grade: {
                trace_grade_id: 'trace-grade-2',
                status: 'pass',
              },
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            repair_run: { repair_run_id: 'repair-run-1' },
            skill_candidate: { candidate_id: 'skill-1' },
            trace_grade: {
              trace_grade_id: 'trace-grade-3',
              status: 'pass',
            },
          }),
          { status: 200 },
        );
      },
    );
    vi.stubGlobal('fetch', fetchImpl as unknown as typeof fetch);

    const bridge = await import('./andrea-platform-bridge.js');
    const evidence = await bridge.emitAndreaPlatformRepairEvidence({
      repairPlanId: 'repair-plan-1',
      executionId: 'execution-1',
      evidenceKind: 'test',
      command: 'npm test',
      passed: true,
      summary: 'Tests passed.',
      final: true,
      metadata: { workerResultStatus: 'verified' },
    });
    const deployment = await bridge.emitAndreaPlatformRepairDeployment({
      repairPlanId: 'repair-plan-1',
      executionId: 'execution-1',
      commitSha: 'abcdef1',
      services: ['nanobot'],
      status: 'deployed',
      verificationEvidenceIds: ['evidence-1'],
      summary: 'Pushed and restarted.',
    });
    const completed = await bridge.emitAndreaPlatformRepairComplete({
      repairPlanId: 'repair-plan-1',
      executionId: 'execution-1',
      deploymentId: deployment?.deploymentId,
      status: 'completed',
      finalHealthState: 'running_ready',
      summary: 'Repair verified.',
    });

    expect(evidence).toMatchObject({
      repairPlanId: 'repair-plan-1',
      repairRunId: 'repair-run-1',
      executionId: 'execution-1',
      verificationEvidenceId: 'evidence-1',
      traceGradeId: 'trace-grade-1',
    });
    expect(deployment).toMatchObject({
      deploymentId: 'deployment-1',
      traceGradeId: 'trace-grade-2',
    });
    expect(completed).toMatchObject({
      repairRunId: 'repair-run-1',
      skillCandidateId: 'skill-1',
      traceGradeId: 'trace-grade-3',
    });
    expect(calls.map((call) => call.url)).toEqual([
      'http://127.0.0.1:4400/repair/evidence',
      'http://127.0.0.1:4400/repair/deployment',
      'http://127.0.0.1:4400/repair/complete',
    ]);
    expect(JSON.parse(String(calls[0]?.body ?? '{}'))).toMatchObject({
      repairPlanId: 'repair-plan-1',
      executionId: 'execution-1',
      evidenceKind: 'test',
      passed: true,
      final: true,
      metadata: {
        sourceSystem: 'andrea_nanobot',
        workerResultStatus: 'verified',
      },
    });
  });

  it('maps configured ready channels to a healthy shell state', async () => {
    const bridge = await import('./andrea-platform-bridge.js');
    const channelHealth: ChannelHealthSnapshot[] = [
      {
        name: 'telegram',
        configured: true,
        state: 'ready',
        updatedAt: '2026-04-17T14:00:00.000Z',
        detail: 'Telegram is ready.',
      },
      {
        name: 'bluebubbles',
        configured: true,
        state: 'ready',
        updatedAt: '2026-04-17T14:00:00.000Z',
        detail: 'BlueBubbles is ready.',
      },
    ];

    expect(bridge.mapShellHealthFromChannelHealth(channelHealth)).toEqual({
      severity: 'healthy',
      summary:
        'NanoBot shell is running and all configured channels are ready.',
      detail: 'telegram, bluebubbles',
      metadata: {
        configuredChannels: '2',
        readyChannels: '2',
      },
    });
  });

  it('maps not-ready configured channels to a degraded shell state', async () => {
    const bridge = await import('./andrea-platform-bridge.js');
    const channelHealth: ChannelHealthSnapshot[] = [
      {
        name: 'telegram',
        configured: true,
        state: 'ready',
        updatedAt: '2026-04-17T14:00:00.000Z',
      },
      {
        name: 'bluebubbles',
        configured: true,
        state: 'starting',
        updatedAt: '2026-04-17T14:00:00.000Z',
        detail: 'Awaiting webhook traffic.',
      },
    ];

    expect(bridge.mapShellHealthFromChannelHealth(channelHealth)).toEqual({
      severity: 'degraded',
      summary:
        'NanoBot shell is running, but one or more configured channels are not ready yet.',
      detail: 'bluebubbles: Awaiting webhook traffic.',
      metadata: {
        configuredChannels: '2',
        readyChannels: '1',
      },
    });
  });
});
