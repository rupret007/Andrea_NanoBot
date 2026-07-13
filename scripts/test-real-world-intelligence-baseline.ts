import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import './test-network-guard.mjs';

import { RuntimeToolEvidenceCollector } from '../container/agent-runner/src/runtime-tool-evidence.js';
import type { AndreaPlatformProviderCouncilResult } from '../src/andrea-platform-bridge.js';
import { assessCouncilLiveProof } from '../src/council-live-proof.js';
import { _closeDatabase, _initTestDatabase } from '../src/db.js';
import {
  buildAssistantMetricSnapshot,
  recordAssistantMetric,
} from '../src/personal-assistant-metrics.js';
import {
  beginVerifiedDeepWorkForTurn,
  reconcileVerifiedDeepWorkExecution,
} from '../src/verified-deep-work.js';
import type {
  RuntimeToolActionEvidence,
  RuntimeToolEvidenceV1,
} from '../src/types.js';

type LatencyTargetClass = 'local_command' | 'ordinary_response';

interface LatencyScenario {
  id: string;
  routeKey: string;
  latencyMs: number;
  expectedTargetClass: LatencyTargetClass;
  metadataTargetClass?: string;
  harnessMs: number;
  responsePreparationMs: number;
  channelDeliveryMs: number;
}

interface CouncilScenario {
  id: string;
  expectedPassed: boolean;
  expectedReason?: string;
  expectedTerminal?: 'completed' | 'completed_degraded' | 'blocked';
  mutate?: (result: AndreaPlatformProviderCouncilResult) => void;
}

interface ExecutionTruthScenario {
  id: string;
  taskFamily: 'code' | 'operator';
  objective: string;
  expectedCompleted: boolean;
  runtimeStatus?: 'success' | 'error';
  evidence?: RuntimeToolEvidenceV1;
}

const HELDOUT_REPOSITORY_HEAD = 'b'.repeat(40);
const HELDOUT_REPOSITORY_HEAD_FINGERPRINT = `sha256:${createHash('sha256')
  .update(HELDOUT_REPOSITORY_HEAD)
  .digest('hex')}`;

function heldoutRepositorySnapshot() {
  return {
    root: '/heldout/repository',
    branch: 'main',
    headSha: HELDOUT_REPOSITORY_HEAD,
    dirtyPaths: [],
    capturedAt: '2026-07-12T22:31:00.000Z',
  };
}

function executionEvidence(
  evidenceId: string,
  actions: RuntimeToolActionEvidence[],
  collectorStatus: RuntimeToolEvidenceV1['collectorStatus'] = 'complete',
  state?: RuntimeToolEvidenceV1['state'],
): RuntimeToolEvidenceV1 {
  const hasRepositoryWrite = actions.some(
    (action) => action.class === 'repository_write',
  );
  const resolvedState =
    state ||
    (hasRepositoryWrite
      ? {
          preStateFingerprint: `sha256:${'3'.repeat(64)}`,
          postStateFingerprint: `sha256:${'4'.repeat(64)}`,
          repositoryHeadFingerprint: HELDOUT_REPOSITORY_HEAD_FINGERPRINT,
        }
      : {
          preStateFingerprint: null,
          postStateFingerprint: null,
          repositoryHeadFingerprint: null,
        });
  const normalizedActions =
    hasRepositoryWrite &&
    !actions.some((action) => action.class === 'repository_state')
      ? [
          ...actions,
          {
            class: 'repository_state' as const,
            observed: 2,
            succeeded: 2,
            failed: 0,
            unresolved: 0,
            succeededAfterLastRepositoryWrite: 1,
            lastOutcome: 'succeeded' as const,
            recovered: false,
          },
        ]
      : actions;
  const calls = normalizedActions.reduce(
    (total, action) => ({
      observed: total.observed + action.observed,
      succeeded: total.succeeded + action.succeeded,
      failed: total.failed + action.failed,
      unresolved: total.unresolved + action.unresolved,
    }),
    { observed: 0, succeeded: 0, failed: 0, unresolved: 0 },
  );
  return {
    version: 1,
    evidenceId,
    cumulative: true,
    attempts: Math.max(1, calls.observed),
    collectorStatus,
    calls,
    actions: normalizedActions,
    state: resolvedState,
    privacy: {
      metadataOnly: true,
      rawInputsStored: false,
      resultBodiesStored: false,
      toolUseIdsStored: false,
    },
  };
}

function executionAction(
  actionClass: RuntimeToolActionEvidence['class'],
  status: 'succeeded' | 'failed' | 'unresolved',
  options: {
    failed?: number;
    recovered?: boolean;
    succeededAfterLastRepositoryWrite?: number;
  } = {},
): RuntimeToolActionEvidence {
  const failed = options.failed ?? (status === 'failed' ? 1 : 0);
  return {
    class: actionClass,
    observed: 1 + (options.recovered ? failed : 0),
    succeeded: status === 'succeeded' ? 1 : 0,
    failed,
    unresolved: status === 'unresolved' ? 1 : 0,
    succeededAfterLastRepositoryWrite:
      options.succeededAfterLastRepositoryWrite ?? 0,
    lastOutcome: status,
    recovered: options.recovered === true,
  };
}

const executionTruthScenarios: ExecutionTruthScenario[] = [
  {
    id: 'confident-answer-without-tools',
    taskFamily: 'code',
    objective: 'Implement the held-out repository repair.',
    expectedCompleted: false,
  },
  {
    id: 'failed-write-with-confident-answer',
    taskFamily: 'code',
    objective: 'Implement the held-out parser repair.',
    expectedCompleted: false,
    runtimeStatus: 'error',
    evidence: executionEvidence('heldout-execution-failed', [
      executionAction('repository_write', 'failed'),
      executionAction('verification_test', 'succeeded', {
        succeededAfterLastRepositoryWrite: 1,
      }),
    ]),
  },
  {
    id: 'unresolved-write-result',
    taskFamily: 'code',
    objective: 'Implement the held-out state repair.',
    expectedCompleted: false,
    runtimeStatus: 'error',
    evidence: executionEvidence(
      'heldout-execution-unresolved',
      [executionAction('repository_write', 'unresolved')],
      'partial',
    ),
  },
  {
    id: 'successful-edit-and-test',
    taskFamily: 'code',
    objective: 'Implement the held-out queue repair.',
    expectedCompleted: false,
    evidence: executionEvidence('heldout-execution-success', [
      executionAction('repository_write', 'succeeded'),
      executionAction('verification_test', 'succeeded', {
        succeededAfterLastRepositoryWrite: 1,
      }),
    ]),
  },
  {
    id: 'unapproved-external-action',
    taskFamily: 'operator',
    objective: 'Restart and verify the held-out remote service.',
    expectedCompleted: false,
    evidence: executionEvidence('heldout-execution-unapproved', [
      executionAction('external_side_effect', 'succeeded'),
      executionAction('verification_test', 'succeeded'),
    ]),
  },
  {
    id: 'failed-edit-replanned-and-verified',
    taskFamily: 'code',
    objective: 'Implement the unfamiliar held-out adapter repair.',
    expectedCompleted: false,
    evidence: executionEvidence('heldout-execution-recovered', [
      executionAction('repository_write', 'succeeded', {
        failed: 1,
        recovered: true,
      }),
      executionAction('verification_typecheck', 'succeeded', {
        succeededAfterLastRepositoryWrite: 1,
      }),
    ]),
  },
];

const latencyScenarios: LatencyScenario[] = [
  {
    id: 'local-review-over-target-with-nonzero-harness',
    routeKey: 'learning.outcome_review',
    latencyMs: 2_501,
    expectedTargetClass: 'local_command',
    metadataTargetClass: 'local_command',
    harnessMs: 80,
    responsePreparationMs: 2_300,
    channelDeliveryMs: 121,
  },
  {
    id: 'ordinary-response-under-target-with-zero-harness',
    routeKey: 'assistant.direct',
    latencyMs: 9_000,
    expectedTargetClass: 'ordinary_response',
    metadataTargetClass: 'ordinary_response',
    harnessMs: 0,
    responsePreparationMs: 8_700,
    channelDeliveryMs: 300,
  },
  {
    id: 'malformed-target-defaults-to-ordinary',
    routeKey: 'assistant.malformed_target',
    latencyMs: 2_501,
    expectedTargetClass: 'ordinary_response',
    metadataTargetClass: 'LOCAL_COMMAND',
    harnessMs: 0,
    responsePreparationMs: 2_400,
    channelDeliveryMs: 101,
  },
  {
    id: 'ordinary-response-over-target',
    routeKey: 'assistant.tool_free_slow',
    latencyMs: 10_001,
    expectedTargetClass: 'ordinary_response',
    metadataTargetClass: 'ordinary_response',
    harnessMs: 4_000,
    responsePreparationMs: 5_500,
    channelDeliveryMs: 501,
  },
  {
    id: 'local-control-under-target',
    routeKey: 'control.council_doctor',
    latencyMs: 1_900,
    expectedTargetClass: 'local_command',
    metadataTargetClass: 'local_command',
    harnessMs: 40,
    responsePreparationMs: 1_600,
    channelDeliveryMs: 260,
  },
];

function targetMs(targetClass: LatencyTargetClass): number {
  return targetClass === 'local_command' ? 2_000 : 10_000;
}

// This reproduces the superseded heuristic for before/after evidence. It is
// deliberately kept inside the evaluation and is never used by production.
function legacyTargetClass(scenario: LatencyScenario): LatencyTargetClass {
  return scenario.harnessMs === 0 ? 'local_command' : 'ordinary_response';
}

function makeCouncilResult(): AndreaPlatformProviderCouncilResult {
  const providerIds = [
    'openai_cloud',
    'anthropic_cloud',
    'gemini_cloud',
    'minimax_cloud',
  ];
  const roles = ['planner', 'critic', 'evidence_scout', 'verifier'];
  const memberStatuses = roles.map((role, index) => ({
    memberId: `heldout-${role}`,
    providerId: providerIds[index]!,
    role,
    status: 'completed',
    verdict: 'pass',
    confidence: 0.82,
    schemaStatus: 'valid',
    schemaIssues: [],
    evidenceIds: [`heldout:${role}`],
    riskFlags: [],
  }));
  return {
    councilRunId: 'local-council:heldout-evaluation',
    mode: 'max_iq_council',
    status: 'local_only',
    approvalRequired: false,
    memberCount: 4,
    skippedMemberCount: 0,
    blockedMemberCount: 0,
    confidence: 0.72,
    riskFlags: ['platform_council_record_local_runtime'],
    providerFailures: [],
    answerGuidance: {
      status: 'warn',
      visibleVerdict: 'Proceed carefully with cited evidence.',
      answerDirection: 'Answer only from the evidence packet.',
      confidence: 0.72,
      uncertainty: 'Some uncertainty remains.',
      sourceMemberIds: memberStatuses.map((member) => member.memberId),
      recommendedAction: 'answer',
      approvalNeed: 'none',
      evidenceGrade: 'strong',
      evidenceIds: ['heldout:objective', 'heldout:provider-health'],
      riskFlags: [],
      actionDirectives: [
        {
          directive: 'answer_constraint',
          priority: 'low',
          reason: 'Answer only from the evidence packet.',
        },
        {
          directive: 'memory_learning_candidate',
          priority: 'low',
          reason: 'Retain only a sanitized confirmed outcome.',
        },
      ],
    },
    structuredVerdict: {
      status: 'warn',
      recommendedAction: 'answer',
      confidence: 0.72,
      evidenceGrade: 'strong',
      approvalNeed: 'none',
      riskFlags: [],
      evidenceIds: ['heldout:objective', 'heldout:provider-health'],
      actionDirectives: [
        {
          directive: 'answer_constraint',
          priority: 'low',
          reason: 'Answer only from the evidence packet.',
        },
        {
          directive: 'memory_learning_candidate',
          priority: 'low',
          reason: 'Retain only a sanitized confirmed outcome.',
        },
      ],
      usableMemberCount: 4,
      blockedMemberCount: 0,
      confidenceMath: {
        base: 0.78,
        degradedParticipationPenalty: 0,
        providerFailurePenalty: 0,
        evidencePenalty: 0.06,
        verdictPenalty: 0,
        schemaPenalty: 0,
        final: 0.72,
      },
      schemaStatusSummary: { valid: 4, repaired: 0, invalid_fallback: 0 },
      evidenceScorecard: {
        requiredGrade: 'partial',
        availableGrade: 'strong',
        freshnessCoverage: {
          total: 4,
          fresh: 4,
          stale: 0,
          unknown: 0,
          notApplicable: 0,
        },
        sourceCoverage: { provider_health: 4 },
        privateContentPolicy: 'metadata_only',
        gapCount: 0,
        gapIds: [],
        sourceClasses: ['provider_health'],
        confidencePenalty: 0.06,
      },
      budget: {
        mode: 'max_iq_council',
        maxRoles: 5,
        roleTimeoutMs: 45_000,
        maxRetries: 1,
        maxConcurrency: 2,
        fallbackAllowed: true,
        estimatedCostTier: 'high',
        usedRoles: 4,
        retryCount: 0,
        loopGuardTriggered: false,
        status: 'within_budget',
      },
      providerParticipation: {
        status: 'full',
        generatedAt: '2026-07-12T22:30:00.000Z',
        skippedProviderIds: [],
        substitutedRoles: [],
        riskFlags: [],
        nextAction: '',
        roles: memberStatuses.map((member) => ({
          role: member.role,
          providerId: member.providerId,
          memberId: member.memberId,
          required: true,
          action: 'call',
          substituteProviderId: null,
          reason: 'Healthy configured provider.',
          riskFlag: '',
          healthState: 'healthy',
          failureClass: 'none',
        })),
      },
      replayArtifact: {
        replaySummary: 'Held-out deterministic council evidence.',
        memberStatuses,
      },
      ultrathinkTrace: {
        requested: true,
        trigger: 'ultrathink',
        mode: 'max_iq_council',
        adaptiveThinkingRequested: true,
        adaptiveThinkingSupported: true,
        display: 'omitted',
        rawThinkingStored: false,
        hiddenReasoningExposed: false,
      },
      quality: {
        ledgerVersion: 'v3',
        retention: '90d_or_1000_runs',
        rawPromptsStored: false,
        rawPrivateBodiesStored: false,
        outcomeSignalCount: 0,
      },
    },
  };
}

const councilScenarios: CouncilScenario[] = [
  {
    id: 'intentional-local-runtime-with-completed-verifier',
    expectedPassed: true,
    expectedTerminal: 'completed',
  },
  {
    id: 'fresh-approval-required',
    expectedPassed: false,
    expectedReason: 'approval_boundary_not_clean',
    expectedTerminal: 'blocked',
    mutate(result) {
      result.approvalRequired = true;
      result.structuredVerdict!.approvalNeed = 'explicit';
    },
  },
  {
    id: 'non-metadata-privacy-policy',
    expectedPassed: false,
    expectedReason: 'privacy_boundary_not_clean',
    expectedTerminal: 'blocked',
    mutate(result) {
      result.structuredVerdict!.evidenceScorecard!.privateContentPolicy =
        'sanitized_snippets';
    },
  },
  {
    id: 'loop-guard-triggered',
    expectedPassed: false,
    expectedReason: 'run_budget_not_clean',
    expectedTerminal: 'blocked',
    mutate(result) {
      result.structuredVerdict!.budget!.loopGuardTriggered = true;
    },
  },
  {
    id: 'malformed-participation-collections',
    expectedPassed: false,
    expectedReason: 'proof_shape_invalid',
    expectedTerminal: 'blocked',
    mutate(result) {
      const participation = result.structuredVerdict!
        .providerParticipation as unknown as Record<string, unknown>;
      participation.substitutedRoles = null;
    },
  },
  {
    id: 'blocked-verifier',
    expectedPassed: false,
    expectedReason: 'completed_verifier_missing',
    expectedTerminal: 'blocked',
    mutate(result) {
      result.structuredVerdict!.replayArtifact!.memberStatuses[3]!.status =
        'blocked';
    },
  },
  {
    id: 'blocking-verifier-outcome',
    expectedPassed: false,
    expectedReason: 'completed_verifier_missing',
    expectedTerminal: 'blocked',
    mutate(result) {
      result.structuredVerdict!.replayArtifact!.memberStatuses[3]!.verdict =
        'block';
    },
  },
  {
    id: 'duplicate-provider-provenance',
    expectedPassed: false,
    expectedReason: 'provider_provenance_incomplete',
    expectedTerminal: 'blocked',
    mutate(result) {
      for (const member of result.structuredVerdict!.replayArtifact!
        .memberStatuses) {
        member.providerId = 'openai_cloud';
      }
    },
  },
  {
    id: 'unclassified-provider-failure',
    expectedPassed: false,
    expectedReason: 'provider_failure',
    expectedTerminal: 'blocked',
    mutate(result) {
      result.providerFailures = ['minimax_cloud_transport_error'];
    },
  },
  {
    id: 'provider-substitution',
    expectedPassed: false,
    expectedReason: 'provider_participation_degraded',
    expectedTerminal: 'completed_degraded',
    mutate(result) {
      result.structuredVerdict!.providerParticipation!.status = 'degraded';
      result.structuredVerdict!.providerParticipation!.substitutedRoles = [
        'verifier:gemini_cloud->openai_cloud',
      ];
    },
  },
  {
    id: 'unexpected-platform-record-fallback',
    expectedPassed: false,
    expectedReason: 'platform_record_fallback',
    expectedTerminal: 'completed_degraded',
    mutate(result) {
      result.riskFlags = ['platform_council_record_local_fallback'];
    },
  },
  {
    id: 'material-non-provider-evidence-gap',
    expectedPassed: false,
    expectedReason: 'evidence_gaps_present',
    expectedTerminal: 'blocked',
    mutate(result) {
      result.structuredVerdict!.evidenceScorecard!.gapCount = 1;
      result.structuredVerdict!.evidenceScorecard!.gapIds = [
        'integration_calendar_stale',
      ];
    },
  },
  {
    id: 'malformed-missing-verdict',
    expectedPassed: false,
    expectedReason: 'schema_invalid_fallback',
    expectedTerminal: 'blocked',
    mutate(result) {
      result.structuredVerdict = undefined;
    },
  },
];

function sdkToolUse(id: string, name: string, input: unknown) {
  return {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name, input }] },
  };
}

function sdkToolResult(id: string, isError: boolean, content: string) {
  return {
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: id, is_error: isError, content },
      ],
    },
  };
}

function runDisposableRepositoryExecutionProof() {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'andrea-execution-truth-'));
  const runNode = (args: string[]) =>
    execFileSync(process.execPath, args, {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 512 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  try {
    writeFileSync(
      path.join(repoRoot, 'package.json'),
      `${JSON.stringify({
        private: true,
        scripts: { test: 'node --check fixture.js' },
      })}\n`,
    );
    writeFileSync(path.join(repoRoot, 'fixture.js'), 'module.exports = 1;\n');
    const headSha = createHash('sha1')
      .update('heldout disposable repository fixture v1')
      .digest('hex');

    const collector = new RuntimeToolEvidenceCollector(
      'heldout-disposable-repository',
    );
    collector.beginAttempt();
    collector.observeSdkMessage(
      sdkToolUse('state-before', 'Bash', { command: 'git status --short' }),
    );
    collector.observeSdkMessage(sdkToolResult('state-before', false, ''));
    collector.observeSdkMessage(
      sdkToolUse('head-before', 'Bash', { command: 'git rev-parse HEAD' }),
    );
    collector.observeSdkMessage(
      sdkToolResult('head-before', false, `${headSha}\n`),
    );

    collector.observeSdkMessage(
      sdkToolUse('write-failed', 'Edit', { file_path: repoRoot }),
    );
    let observedWriteFailure = false;
    try {
      writeFileSync(repoRoot, 'cannot replace a directory');
    } catch (error) {
      observedWriteFailure = true;
      collector.observeSdkMessage(
        sdkToolResult(
          'write-failed',
          true,
          error instanceof Error ? error.name : 'write failure',
        ),
      );
    }
    assert.equal(observedWriteFailure, true, 'expected a real write failure');

    collector.beginAttempt();
    collector.observeSdkMessage(
      sdkToolUse('write-recovered', 'Edit', {
        file_path: path.join(repoRoot, 'fixture.js'),
      }),
    );
    writeFileSync(
      path.join(repoRoot, 'fixture.js'),
      'module.exports = { answer: 42 };\n',
    );
    collector.observeSdkMessage(
      sdkToolResult('write-recovered', false, 'updated'),
    );
    collector.observeSdkMessage(
      sdkToolUse('state-after', 'Bash', { command: 'git status --short' }),
    );
    collector.observeSdkMessage(
      sdkToolResult('state-after', false, ' M fixture.js\n'),
    );
    collector.observeSdkMessage(
      sdkToolUse('verification', 'Bash', {
        command: 'node --check fixture.js',
      }),
    );
    const verificationOutput = runNode(['--check', 'fixture.js']);
    collector.observeSdkMessage(
      sdkToolResult('verification', false, verificationOutput || 'passed'),
    );

    const evidence = collector.snapshot();
    const turnId = 'heldout-disposable-repository-turn';
    const packet = beginVerifiedDeepWorkForTurn({
      groupFolder: 'heldout-real-world-intelligence',
      turnId,
      taskFamily: 'code',
      objective: 'Implement the disposable repository fixture repair.',
      approvalRequired: false,
      repositorySnapshotProvider: () => ({
        root: repoRoot,
        branch: 'main',
        headSha,
        dirtyPaths: [],
        capturedAt: '2026-07-12T22:31:30.000Z',
      }),
      now: new Date('2026-07-12T22:31:30.000Z'),
    });
    assert.ok(packet, 'expected a disposable repository execution packet');
    const reconciled = reconcileVerifiedDeepWorkExecution({
      packetId: packet.packetId,
      turnId,
      runtimeToolEvidence: evidence,
      runtimeStatus: 'success',
      evaluationStatus: 'pass',
      evidenceGap: 'none',
      outcomeSummary:
        'The real failed write was recovered and the post-write syntax test passed.',
      now: new Date('2026-07-12T22:31:31.000Z'),
    });
    assert.equal(reconciled.status, 'blocked');
    assert.ok(
      reconciled.unresolvedRisks.includes('runtime_repository_scope_unbound'),
      `disposable proof must remain blocked until the host binds the execution scope: ${reconciled.unresolvedRisks.join(',')}`,
    );
    assert.equal(
      evidence.actions.find((action) => action.class === 'repository_write')
        ?.recovered,
      true,
    );
    assert.equal(
      evidence.actions.find((action) => action.class === 'verification_test')
        ?.succeededAfterLastRepositoryWrite,
      1,
    );
    return {
      status: reconciled.status,
      scopeBinding: 'intentionally_blocked',
      realWriteFailureObserved: observedWriteFailure,
      repositoryTransitionObserved:
        evidence.state.preStateFingerprint !== null &&
        evidence.state.postStateFingerprint !== null &&
        evidence.state.preStateFingerprint !==
          evidence.state.postStateFingerprint,
      postWriteVerificationObserved: true,
      productionStateTouched: false,
    };
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await assert.rejects(
    fetch('https://example.invalid/heldout-network-deny'),
    /External network access is disabled for deterministic tests/,
  );

  _initTestDatabase();
  try {
    // A legacy, unattributed production sample must remain visible as debt but
    // must not replace the new attributed held-out measurements.
    recordAssistantMetric({
      eventId: 'heldout-legacy-latency',
      groupFolder: 'heldout-real-world-intelligence',
      kind: 'latency_sample',
      value: 35_616,
      metadata: {
        latencyClass: 'interaction_delivery',
        runOrigin: 'live',
        routeKey: 'legacy.unknown',
      },
      now: new Date('2026-07-12T22:29:00.000Z'),
    });

    for (const [index, scenario] of latencyScenarios.entries()) {
      recordAssistantMetric({
        eventId: `heldout-latency-${scenario.id}`,
        groupFolder: 'heldout-real-world-intelligence',
        kind: 'latency_sample',
        value: scenario.latencyMs,
        metadata: {
          latencyClass: 'interaction_delivery',
          runOrigin: 'live',
          routeKey: scenario.routeKey,
          handlerId: `heldout-handler-${index}`,
          providerId:
            scenario.expectedTargetClass === 'local_command'
              ? 'local_runtime'
              : 'heldout_provider',
          ...(scenario.expectedTargetClass === 'ordinary_response'
            ? { modelId: 'heldout_model' }
            : {}),
          toolClass: `heldout:${scenario.routeKey}`,
          preprocessingMs: 0,
          harnessMs: scenario.harnessMs,
          responsePreparationMs: scenario.responsePreparationMs,
          channelDeliveryMs: scenario.channelDeliveryMs,
          latencyTargetClass: scenario.metadataTargetClass || '',
        },
        now: new Date(`2026-07-12T22:30:0${index}.000Z`),
      });
    }

    const snapshot = buildAssistantMetricSnapshot({
      groupFolder: 'heldout-real-world-intelligence',
      now: new Date('2026-07-12T22:31:00.000Z'),
    });
    const routeByKey = new Map(
      snapshot.interactionLatencyByRoute.map((route) => [
        route.routeKey,
        route,
      ]),
    );
    const latencyOutcomes = latencyScenarios.map((scenario) => {
      const route = routeByKey.get(scenario.routeKey);
      assert.ok(route, `missing current route result for ${scenario.id}`);
      const expectedTargetMs = targetMs(scenario.expectedTargetClass);
      const expectedMeetsTarget = scenario.latencyMs <= expectedTargetMs;
      const legacyTargetMs = targetMs(legacyTargetClass(scenario));
      return {
        id: scenario.id,
        expectedTargetMs,
        legacyTargetMs,
        currentTargetMs: route.targetMs,
        expectedMeetsTarget,
        legacyMeetsTarget: scenario.latencyMs <= legacyTargetMs,
        currentMeetsTarget: route.meetsTarget,
      };
    });

    const legacyTargetCorrect = latencyOutcomes.filter(
      (outcome) => outcome.legacyTargetMs === outcome.expectedTargetMs,
    ).length;
    const currentTargetCorrect = latencyOutcomes.filter(
      (outcome) => outcome.currentTargetMs === outcome.expectedTargetMs,
    ).length;
    const legacyOutcomeCorrect = latencyOutcomes.filter(
      (outcome) => outcome.legacyMeetsTarget === outcome.expectedMeetsTarget,
    ).length;
    const currentOutcomeCorrect = latencyOutcomes.filter(
      (outcome) => outcome.currentMeetsTarget === outcome.expectedMeetsTarget,
    ).length;

    assert.equal(legacyTargetCorrect, 1);
    assert.equal(currentTargetCorrect, latencyScenarios.length);
    assert.equal(legacyOutcomeCorrect, 2);
    assert.equal(currentOutcomeCorrect, latencyScenarios.length);
    assert.equal(snapshot.legacyInteractionLatencySampleCount, 1);
    assert.equal(snapshot.interactionLatencySampleCount, 5);
    assert.equal(snapshot.p50LatencyMs, 2_501);
    assert.equal(snapshot.p95LatencyMs, 10_001);
    assert.equal(snapshot.slowestLatencyStage, 'response_preparation');
    assert.equal(snapshot.slowestLatencyRoute, 'assistant.tool_free_slow');
    assert.equal(
      snapshot.worstBreachingLatencyRoute,
      'learning.outcome_review',
    );
    assert.equal(snapshot.interactionLatencyTargetBreaches, 2);

    const councilOutcomes = councilScenarios.map((scenario) => {
      const result = makeCouncilResult();
      scenario.mutate?.(result);
      const assessment = assessCouncilLiveProof(result);
      assert.equal(
        assessment.passed,
        scenario.expectedPassed,
        `${scenario.id}: pass/fail mismatch`,
      );
      if (scenario.expectedReason) {
        assert.ok(
          assessment.reasons.includes(scenario.expectedReason),
          `${scenario.id}: expected ${scenario.expectedReason}, got ${assessment.reasons.join(',')}`,
        );
      }
      if (scenario.expectedTerminal) {
        assert.equal(
          assessment.terminal,
          scenario.expectedTerminal,
          `${scenario.id}: terminal mismatch`,
        );
      }
      return {
        id: scenario.id,
        passed: assessment.passed,
        terminal: assessment.terminal,
        reasons: assessment.reasons,
      };
    });

    const executionTruthOutcomes = executionTruthScenarios.map(
      (scenario, index) => {
        const turnId = `heldout-execution-turn-${index}`;
        const packet = beginVerifiedDeepWorkForTurn({
          groupFolder: 'heldout-real-world-intelligence',
          turnId,
          taskFamily: scenario.taskFamily,
          objective: scenario.objective,
          approvalRequired: false,
          repositorySnapshotProvider:
            scenario.taskFamily === 'code'
              ? heldoutRepositorySnapshot
              : undefined,
          now: new Date(`2026-07-12T22:32:0${index}.000Z`),
        });
        assert.ok(packet, `${scenario.id}: expected an execution packet`);
        const reconciled = reconcileVerifiedDeepWorkExecution({
          packetId: packet.packetId,
          turnId,
          runtimeToolEvidence: scenario.evidence,
          runtimeStatus: scenario.runtimeStatus || 'success',
          evaluationStatus: 'pass',
          evidenceGap: 'none',
          outcomeSummary: `Held-out outcome for ${scenario.id}.`,
          now: new Date(`2026-07-12T22:33:0${index}.000Z`),
        });
        const currentCompleted = reconciled.status === 'completed';
        assert.equal(
          currentCompleted,
          scenario.expectedCompleted,
          `${scenario.id}: execution-truth completion mismatch`,
        );
        // Superseded production behavior treated the answer evaluator as the
        // execution verifier, so every confident scenario would close.
        const legacyCompleted = true;
        return {
          id: scenario.id,
          expectedCompleted: scenario.expectedCompleted,
          legacyCompleted,
          currentCompleted,
          terminalStatus: reconciled.status,
          risks: reconciled.unresolvedRisks,
        };
      },
    );
    const legacyExecutionTruthCorrect = executionTruthOutcomes.filter(
      (outcome) => outcome.legacyCompleted === outcome.expectedCompleted,
    ).length;
    const currentExecutionTruthCorrect = executionTruthOutcomes.filter(
      (outcome) => outcome.currentCompleted === outcome.expectedCompleted,
    ).length;
    assert.equal(legacyExecutionTruthCorrect, 0);
    assert.equal(currentExecutionTruthCorrect, executionTruthScenarios.length);
    const disposableRepositoryProof = runDisposableRepositoryExecutionProof();

    const report = {
      evaluation: 'real-world-intelligence-heldout-v1',
      execution: {
        storage: 'isolated_in_memory',
        externalNetwork: 'denied_and_asserted',
        productionStateTouched: false,
      },
      beforeAfter: {
        latencyTargetClassification: {
          scenarioCount: latencyScenarios.length,
          beforeLegacyCorrect: legacyTargetCorrect,
          afterCurrentCorrect: currentTargetCorrect,
        },
        latencyBehavioralOutcome: {
          scenarioCount: latencyScenarios.length,
          beforeLegacyCorrect: legacyOutcomeCorrect,
          afterCurrentCorrect: currentOutcomeCorrect,
        },
        executionTruth: {
          scenarioCount: executionTruthScenarios.length,
          beforeLegacyCorrect: legacyExecutionTruthCorrect,
          afterCurrentCorrect: currentExecutionTruthCorrect,
        },
      },
      latency: {
        outcomes: latencyOutcomes,
        attributedSampleCount: snapshot.interactionLatencySampleCount,
        legacyDebtSampleCount: snapshot.legacyInteractionLatencySampleCount,
        p50Ms: snapshot.p50LatencyMs,
        p95Ms: snapshot.p95LatencyMs,
        slowestStage: snapshot.slowestLatencyStage,
        slowestRoute: snapshot.slowestLatencyRoute,
        worstBreachingRoute: snapshot.worstBreachingLatencyRoute,
        breachCount: snapshot.interactionLatencyTargetBreaches,
        providers: snapshot.interactionLatencyByProvider,
        tools: snapshot.interactionLatencyByTool,
      },
      council: {
        scenarioCount: councilOutcomes.length,
        passedExpectations: councilOutcomes.length,
        outcomes: councilOutcomes,
      },
      executionTruth: {
        scenarioCount: executionTruthOutcomes.length,
        passedExpectations: currentExecutionTruthCorrect,
        outcomes: executionTruthOutcomes,
        disposableRepositoryProof,
      },
      status: 'pass',
    };

    console.log(JSON.stringify(report, null, 2));
  } finally {
    _closeDatabase();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
