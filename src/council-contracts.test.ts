import { describe, expect, it } from 'vitest';

import {
  buildCouncilVerdict,
  parseCouncilMemberArtifact,
  type CouncilEvidencePack,
  type CouncilRunBudget,
} from './council-contracts.js';

const baseBudget: CouncilRunBudget = {
  mode: 'dual_review',
  maxRoles: 4,
  roleTimeoutMs: 20_000,
  maxRetries: 0,
  maxConcurrency: 2,
  fallbackAllowed: false,
  estimatedCostTier: 'medium',
  usedRoles: 2,
  retryCount: 0,
  loopGuardTriggered: false,
  status: 'within_budget',
};

const baseEvidencePack: CouncilEvidencePack = {
  packId: 'pack-1',
  taskFamily: 'assistant',
  requiredEvidence: 'partial',
  overallGrade: 'partial',
  rawContentPolicy: 'sanitized_snippets',
  cards: [
    {
      evidenceId: 'intent:test',
      sourceClass: 'user_input',
      evidenceGrade: 'partial',
      freshness: 'fresh',
      sensitivity: 'private',
      summary: 'Sanitized intent.',
    },
  ],
  gaps: [],
  scorecard: {
    requiredGrade: 'partial',
    availableGrade: 'partial',
    freshnessCoverage: {
      total: 1,
      fresh: 1,
      stale: 0,
      unknown: 0,
      notApplicable: 0,
    },
    sourceCoverage: { user_input: 1 },
    createSafetyCoverage: { exists: 1 },
    citationCoverage: {
      total: 1,
      cited: 1,
      missing: 0,
    },
    averageSourcePriority: 100,
    privateContentPolicy: 'sanitized_snippets',
    gapCount: 0,
    gapIds: [],
    sourceClasses: ['user_input'],
    confidencePenalty: 0,
  },
};

describe('council contracts', () => {
  it('distinguishes valid, repaired, and invalid fallback schema artifacts', () => {
    const valid = parseCouncilMemberArtifact({
      memberId: 'openai_cloud',
      providerId: 'openai_cloud',
      role: 'planner',
      status: 'completed',
      defaultConfidence: 0.8,
      text: JSON.stringify({
        verdict: 'pass',
        confidence: 0.8,
        evidence_grade: 'partial',
        recommended_action: 'answer',
        answer_direction: 'Answer concisely.',
        uncertainty: 'Low uncertainty.',
        risk_flags: [],
        evidence_ids: ['intent:test'],
        approval_need: 'none',
      }),
    });
    const repaired = parseCouncilMemberArtifact({
      memberId: 'gemini_cloud',
      providerId: 'gemini_cloud',
      role: 'verifier',
      status: 'completed',
      defaultConfidence: 0.8,
      text: "```json\n{'verdict':'warn','confidence':0.7,'evidence_grade':'partial','recommended_action':'answer','answer_direction':'Name uncertainty.','uncertainty':'One gap remains.','risk_flags':['gap'],'evidence_ids':['intent:test',],'approval_need':'none'}\n```",
    });
    const invalid = parseCouncilMemberArtifact({
      memberId: 'minimax_cloud',
      providerId: 'minimax_cloud',
      role: 'critic',
      status: 'completed',
      defaultConfidence: 0.8,
      text: 'This is useful but not JSON.',
    });

    expect(valid.schemaStatus).toBe('valid');
    expect(valid.schemaIssues).toEqual([]);
    expect(repaired.schemaStatus).toBe('repaired');
    expect(repaired.schemaIssues).toEqual([]);
    expect(invalid.schemaStatus).toBe('repaired');
    expect(invalid.schemaIssues.length).toBeGreaterThan(0);
    expect(invalid.riskFlags).not.toContain('schema_invalid:minimax_cloud');
    expect(invalid.confidence).toBeLessThan(0.8);
  });

  it('does not count blocked providers as schema invalid artifacts', () => {
    const blocked = parseCouncilMemberArtifact({
      memberId: 'anthropic_cloud',
      providerId: 'anthropic_cloud',
      role: 'synthesizer',
      status: 'blocked',
      defaultConfidence: 0,
      defaultRiskFlags: ['anthropic_reasoner_unavailable'],
      text: 'Anthropic reasoner unavailable.',
    });

    const verdict = buildCouncilVerdict({
      councilRunId: 'council-blocked-provider',
      mode: 'dual_review',
      artifacts: [blocked],
      evidencePack: baseEvidencePack,
      providerFailures: ['anthropic_reasoner_unavailable'],
      runBudget: {
        ...baseBudget,
        usedRoles: 1,
      },
    });

    expect(blocked.schemaStatus).toBe('valid');
    expect(blocked.schemaIssues).toContain(
      'schema_not_required_for_non_completed_member',
    );
    expect(blocked.riskFlags).not.toContain('schema_invalid:anthropic_cloud');
    expect(verdict.schemaStatusSummary.invalid_fallback).toBe(0);
  });

  it('builds a redacted replay artifact with scorecard and confidence math', () => {
    const artifact = parseCouncilMemberArtifact({
      memberId: 'openai_cloud',
      providerId: 'openai_cloud',
      role: 'planner',
      status: 'completed',
      defaultConfidence: 0.8,
      text: JSON.stringify({
        verdict: 'pass',
        confidence: 0.8,
        evidence_grade: 'partial',
        recommended_action: 'answer',
        answer_direction:
          'Do not expose sk-proj-testSecretValue1234567890abcdef.',
        uncertainty: 'Low uncertainty.',
        risk_flags: [],
        evidence_ids: ['intent:test'],
        approval_need: 'none',
      }),
    });

    const verdict = buildCouncilVerdict({
      councilRunId: 'council-replay',
      mode: 'dual_review',
      artifacts: [artifact],
      evidencePack: baseEvidencePack,
      providerFailures: [],
      runBudget: baseBudget,
    });

    const serialized = JSON.stringify(verdict.replayArtifact);
    expect(verdict.replayArtifact?.replaySummary).toContain('council-replay');
    expect(verdict.confidenceMath.final).toBe(verdict.confidence);
    expect(verdict.schemaStatusSummary.valid).toBe(1);
    expect(verdict.actionDirectives.length).toBeGreaterThan(0);
    expect(serialized).toContain('[REDACTED_SECRET]');
    expect(serialized).not.toContain('sk-proj-testSecretValue1234567890abcdef');
  });
});
