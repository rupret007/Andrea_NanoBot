import { describe, expect, it } from 'vitest';

import {
  buildCouncilMetricGlossaryMeta,
  getCouncilMetricGloss,
  renderCouncilMetricGlossaryMarkdown,
} from './council-metric-glossary.js';

describe('council metric glossary', () => {
  it('returns stable plain-English metric metadata', () => {
    const gloss = getCouncilMetricGloss('schema_invalid_runs');

    expect(gloss?.industryTerm).toBe('Schema Invalid Runs');
    expect(gloss?.plainEnglish).toContain('structured artifact');
    expect(gloss?.range).toContain('lower is better');
  });

  it('builds compact metadata blocks for debug reports', () => {
    expect(
      buildCouncilMetricGlossaryMeta([
        'confidence',
        'citation_coverage',
        'unknown_metric',
      ]),
    ).toEqual({
      confidence: expect.stringContaining('trust'),
      citation_coverage: expect.stringContaining('safe source label'),
    });
  });

  it('renders deterministic markdown', () => {
    const markdown = renderCouncilMetricGlossaryMarkdown();

    expect(markdown).toContain('# Andrea Council Metric Glossary');
    expect(markdown).toContain('**Key:** `task_ease_score`');
  });
});
