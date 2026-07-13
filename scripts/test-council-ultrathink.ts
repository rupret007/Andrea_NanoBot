import assert from 'node:assert/strict';

import { _initTestDatabase } from '../src/db.js';
import { runObservableProviderCouncil } from '../src/provider-council-runner.js';

_initTestDatabase();

const correlationId = `council-ultrathink-${Date.now().toString(36)}`;

const result = await runObservableProviderCouncil(
  {
    goal: 'Handle operator turn from telegram via direct_assistant. Safe user intent: ultrathink a repair plan without side effects.',
    taskFamily: 'operator',
    channel: 'telegram',
    correlationId,
    requestedMode: 'max_iq_council',
    riskLevel: 'high',
    requiredEvidence: 'partial',
    allowedSideEffects: 'approval_required',
    metadata: {
      thinking_control: 'deep',
      thinking_trigger: 'ultrathink',
      test_surface: 'test_council_ultrathink',
    },
  },
  {
    emitProviderCouncil: async () => ({
      councilRunId: correlationId,
      mode: 'max_iq_council',
      traceId: correlationId,
      status: 'completed',
      finalRoute: 'max_iq_council',
    }),
    emitCouncilEvent: async () => ({}),
    emitMemberResult: async () => ({}),
    finalizeCouncil: async () => ({}),
    searchBrave: async () => ({
      query: 'operator repair plan approval-first',
      results: [
        {
          title: 'Approval-first repair pattern',
          url: 'https://example.com/approval-first',
          description: 'Repair plans should avoid side effects until approved.',
        },
      ],
    }),
    runOpenAi: async () => ({
      text: JSON.stringify({
        verdict: 'pass',
        confidence: 0.88,
        evidence_grade: 'partial',
        recommended_action: 'draft_only',
        answer_direction: 'Produce an approval-first repair plan.',
        uncertainty: 'Live runtime is not mutated in this test.',
        risk_flags: ['approval_required'],
        evidence_ids: [`intent:${correlationId}`],
        approval_need: 'explicit',
      }),
      model: 'gpt-test',
    }),
    runAnthropic: async () => ({
      text: JSON.stringify({
        verdict: 'warn',
        confidence: 0.82,
        evidence_grade: 'partial',
        recommended_action: 'draft_only',
        answer_direction: 'Check ambiguity and keep side effects gated.',
        uncertainty: 'No mutation approval is present.',
        risk_flags: ['approval_required'],
        evidence_ids: [`intent:${correlationId}`],
        approval_need: 'explicit',
      }),
      model: 'claude-opus-4-8',
      thinkingTrace: {
        requested: true,
        trigger: 'ultrathink',
        mode: 'max_iq_council',
        providerId: 'anthropic_cloud',
        model: 'claude-opus-4-8',
        adaptiveThinkingRequested: true,
        adaptiveThinkingSupported: true,
        effortRequested: 'max',
        effortSent: 'max',
        display: 'omitted',
        rawThinkingStored: false,
        hiddenReasoningExposed: false,
      },
    }),
    runMiniMax: async () => ({
      text: JSON.stringify({
        verdict: 'warn',
        confidence: 0.78,
        evidence_grade: 'partial',
        recommended_action: 'draft_only',
        answer_direction: 'Critic confirms approval-first posture.',
        uncertainty: 'Operator must approve mutation.',
        risk_flags: ['approval_required'],
        evidence_ids: ['policy:sanitized_snippets'],
        approval_need: 'explicit',
      }),
      model: 'minimax-test',
    }),
    runGemini: async () => ({
      text: JSON.stringify({
        verdict: 'pass',
        confidence: 0.84,
        evidence_grade: 'partial',
        recommended_action: 'draft_only',
        answer_direction: 'Verifier allows a draft only.',
        uncertainty: 'No side effects may happen.',
        risk_flags: ['approval_required'],
        evidence_ids: ['policy:sanitized_snippets'],
        approval_need: 'explicit',
      }),
      model: 'gemini-test',
    }),
  },
);

assert.ok(result, 'council should return a result');
assert.equal(result.mode, 'max_iq_council');
assert.equal(
  result.structuredVerdict?.schemaStatusSummary?.invalid_fallback,
  0,
);
assert.ok(
  result.structuredVerdict?.actionDirectives?.some(
    (directive) => directive.directive === 'require_approval',
  ),
  'ultrathink council should preserve approval-first directive',
);
assert.equal(result.structuredVerdict?.ultrathinkTrace?.requested, true);
assert.equal(result.structuredVerdict?.ultrathinkTrace?.trigger, 'ultrathink');
assert.equal(
  result.structuredVerdict?.ultrathinkTrace?.rawThinkingStored,
  false,
);
assert.equal(
  result.structuredVerdict?.ultrathinkTrace?.hiddenReasoningExposed,
  false,
);
assert.ok(
  (result.structuredVerdict?.evidenceIds || []).length > 0,
  'council should preserve evidence IDs',
);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      councilRunId: result.councilRunId,
      mode: result.mode,
      verdict: result.structuredVerdict?.status,
      confidence: result.structuredVerdict?.confidence,
      directives: result.structuredVerdict?.actionDirectives?.map(
        (directive) => directive.directive,
      ),
      ultrathinkTrace: result.structuredVerdict?.ultrathinkTrace,
      privacy: {
        rawThinkingStored: false,
        hiddenReasoningExposed: false,
      },
    },
    null,
    2,
  ),
);
