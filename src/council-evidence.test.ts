import { describe, expect, it } from 'vitest';

import { buildCouncilEvidenceScorecard } from './council-evidence.js';

describe('council evidence scorecard', () => {
  it('summarizes evidence coverage and applies deterministic penalties', () => {
    const scorecard = buildCouncilEvidenceScorecard({
      requiredEvidence: 'strong',
      rawContentPolicy: 'sanitized_snippets',
      overallGrade: 'partial',
      gaps: ['provider_gemini_cloud_not_configured', 'no_saved_knowledge_hits'],
      cards: [
        {
          evidenceId: 'intent:test',
          sourceClass: 'user_input',
          evidenceGrade: 'partial',
          freshness: 'fresh',
          sensitivity: 'private',
          summary: 'Sanitized goal.',
        },
        {
          evidenceId: 'provider_health:gemini_cloud',
          sourceClass: 'provider_health',
          evidenceGrade: 'weak',
          freshness: 'fresh',
          sensitivity: 'normal',
          summary: 'Provider is not configured.',
        },
        {
          evidenceId: 'policy:sanitized_snippets',
          sourceClass: 'policy',
          evidenceGrade: 'partial',
          freshness: 'not_applicable',
          sensitivity: 'normal',
          summary: 'No raw private bodies.',
        },
      ],
    });

    expect(scorecard.requiredGrade).toBe('strong');
    expect(scorecard.availableGrade).toBe('partial');
    expect(scorecard.gapCount).toBe(2);
    expect(scorecard.sourceCoverage).toMatchObject({
      user_input: 1,
      provider_health: 1,
      policy: 1,
    });
    expect(scorecard.createSafetyCoverage).toMatchObject({
      unknown: 3,
    });
    expect(scorecard.citationCoverage).toMatchObject({
      total: 3,
      cited: 0,
      missing: 3,
    });
    expect(scorecard.averageSourcePriority).toBe(0);
    expect(scorecard.freshnessCoverage).toMatchObject({
      total: 3,
      fresh: 2,
      notApplicable: 1,
    });
    expect(scorecard.confidencePenalty).toBeGreaterThan(0);
  });
});
