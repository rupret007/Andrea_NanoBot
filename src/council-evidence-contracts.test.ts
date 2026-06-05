import { describe, expect, it } from 'vitest';

import {
  attachCouncilEvidenceContract,
  attachCouncilEvidenceContracts,
} from './council-evidence-contracts.js';
import type { CouncilEvidenceCard } from './council-contracts.js';

describe('council evidence contracts', () => {
  it('attaches source priority, citation labels, and create-safety hints', () => {
    const card: CouncilEvidenceCard = {
      evidenceId: 'profile_fact:123',
      sourceClass: 'local_memory',
      evidenceGrade: 'partial',
      freshness: 'fresh',
      sensitivity: 'private',
      summary: 'Sanitized profile fact.',
    };

    const enriched = attachCouncilEvidenceContract(card);

    expect(enriched.evidence).toBe('local_compiled_truth');
    expect(enriched.createSafety).toBe('exists');
    expect(enriched.sourcePriority).toBeGreaterThan(90);
    expect(enriched.citationLabel).toContain('[Source: local memory');
    expect(enriched.availableToCouncil).toBe(true);
  });

  it('redacts contact identifiers in citation labels', () => {
    const enriched = attachCouncilEvidenceContract({
      evidenceId: 'knowledge:user@example.com:+14695405551',
      sourceClass: 'knowledge',
      evidenceGrade: 'partial',
      freshness: 'unknown',
      sensitivity: 'private',
      summary: 'Sanitized knowledge hit.',
    } satisfies CouncilEvidenceCard);

    expect(enriched.citationLabel).toContain('[redacted-email]');
    expect(enriched.citationLabel).toContain('[redacted-phone]');
    expect(enriched.citationLabel).not.toContain('user@example.com');
  });

  it('keeps a stable contract on batches', () => {
    const cards = attachCouncilEvidenceContracts([
      {
        evidenceId: 'intent:test',
        sourceClass: 'user_input',
        evidenceGrade: 'partial',
        freshness: 'fresh',
        sensitivity: 'private',
        summary: 'Sanitized user goal.',
      },
      {
        evidenceId: 'provider_health:gemini_cloud',
        sourceClass: 'provider_health',
        evidenceGrade: 'weak',
        freshness: 'fresh',
        sensitivity: 'normal',
        summary: 'Provider degraded.',
        gap: 'provider_gemini_cloud_degraded',
      },
    ]);

    expect(cards.map((card) => card.evidence)).toEqual([
      'user_direct',
      'provider_health',
    ]);
    expect(cards.map((card) => card.createSafety)).toEqual([
      'exists',
      'unknown',
    ]);
  });
});
