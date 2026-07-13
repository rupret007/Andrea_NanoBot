import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildCouncilEvidencePack,
  buildCouncilEvidenceScorecard,
  summarizeCouncilEvidencePack,
} from './council-evidence.js';
import { _closeDatabase, _initTestDatabase } from './db.js';

describe('council evidence scorecard', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    _closeDatabase();
  });

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

  it('does not inject personal-assistant memory into research evidence', () => {
    const pack = buildCouncilEvidencePack({
      goal: 'Compare public approaches to provider observability.',
      taskFamily: 'research',
      groupFolder: 'main',
      requiredEvidence: 'partial',
      rawContentPolicy: 'sanitized_snippets',
      correlationId: 'research-scope-proof',
    });

    expect(pack.cards.some((card) => card.sourceClass === 'local_memory')).toBe(
      false,
    );
    expect(pack.gaps).not.toContain('no_profile_facts');
    expect(pack.gaps).not.toContain('no_active_life_threads');
    expect(
      pack.cards.some((card) =>
        card.evidenceId.startsWith('integration_status:'),
      ),
    ).toBe(false);
  });

  it('keeps the intent and privacy policy in bounded evidence summaries', () => {
    const pack = buildCouncilEvidencePack({
      goal: 'Review local runtime status.',
      taskFamily: 'operator',
      groupFolder: 'main',
      correlationId: 'bounded-summary-proof',
    });
    for (let index = 0; index < 10; index += 1) {
      pack.cards.push({
        evidenceId: `extra:${index}`,
        sourceClass: 'runtime',
        evidenceGrade: 'partial',
        freshness: 'fresh',
        sensitivity: 'normal',
        summary: `Extra runtime evidence ${index}.`,
        sourcePriority: 120,
      });
    }

    const summary = summarizeCouncilEvidencePack(pack);

    expect(summary).toContain('intent:bounded-summary-proof');
    expect(summary).toContain('policy:sanitized_snippets');
  });

  it('uses injected live provider evidence without configuration-only unknown gaps', () => {
    const checkedAt = '2026-07-12T22:00:00.000Z';
    const pack = buildCouncilEvidencePack({
      goal: 'Review local runtime status.',
      taskFamily: 'operator',
      correlationId: 'live-provider-evidence',
      providerHealthSnapshots: [
        {
          providerId: 'openai_cloud',
          kind: 'llm',
          state: 'healthy',
          lastHealthyAt: checkedAt,
          lastCheckedAt: checkedAt,
          failureClass: 'none',
          quotaState: 'unknown',
          credentialState: 'configured',
          knownExpiresAt: null,
          rotationDueAt: null,
          blocker: '',
          nextAction: '',
          metadata: { healthEvidence: 'live_probe', liveProbe: 'ok' },
        },
      ],
    });

    expect(pack.gaps).not.toContain('provider_openai_cloud_unknown');
    expect(
      pack.cards.find(
        (card) => card.evidenceId === 'provider_health:openai_cloud',
      ),
    ).toMatchObject({ evidenceGrade: 'partial', gap: null });
  });
});
