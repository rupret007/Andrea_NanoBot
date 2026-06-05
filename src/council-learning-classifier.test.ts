import { describe, expect, it } from 'vitest';

import {
  classifyCouncilLearningCandidate,
  jaccardTextSimilarity,
} from './council-learning-classifier.js';

describe('council learning classifier', () => {
  it('uses a deterministic text fast-path for duplicates', () => {
    const result = classifyCouncilLearningCandidate({
      summary: 'Council-guided calendar turn should name provider uncertainty.',
      candidates: [
        {
          id: 'prior-1',
          summary:
            'Council-guided calendar turn should name provider uncertainty.',
        },
      ],
    });

    expect(result).toMatchObject({
      decision: 'duplicate',
      matchedId: 'prior-1',
      reason: 'text_fast_path',
    });
  });

  it('detects correction-shaped supersedes', () => {
    const result = classifyCouncilLearningCandidate({
      summary:
        'Correction: council-guided calendar turn should instead ask before claiming availability.',
      candidates: [
        {
          id: 'prior-1',
          summary:
            'Council-guided calendar turn should claim availability when calendar is partial.',
        },
      ],
      supersedeThreshold: 0.2,
    });

    expect(result).toMatchObject({
      decision: 'supersede',
      matchedId: 'prior-1',
      reason: 'correction_signal',
    });
  });

  it('redacts secrets before similarity scoring', () => {
    const score = jaccardTextSimilarity(
      'Use key sk-proj-secretValue1234567890abcdef for provider.',
      'Use key sk-proj-otherSecret1234567890abcdef for provider.',
    );

    expect(score).toBeGreaterThan(0);
  });
});
