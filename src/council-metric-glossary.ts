/*
 * Council metric glossary.
 *
 * Pattern adapted from garrytan/gbrain/src/core/eval/metric-glossary.ts
 * (MIT, commit 9a0bae8d62cdd1e0dd6655e24e082fe6c69c5dac).
 * Andrea keeps a smaller glossary tuned to council/task doctor output.
 */

export interface CouncilMetricGlossaryEntry {
  industryTerm: string;
  plainEnglish: string;
  range: string;
}

export const COUNCIL_METRIC_GLOSSARY: Readonly<
  Record<string, Readonly<CouncilMetricGlossaryEntry>>
> = Object.freeze({
  confidence: Object.freeze({
    industryTerm: 'Council Confidence',
    plainEnglish:
      'How strongly Andrea should trust the final council verdict after provider participation, evidence, schema, and safety penalties.',
    range: '0..1, higher is better.',
  }),
  schema_invalid_runs: Object.freeze({
    industryTerm: 'Schema Invalid Runs',
    plainEnglish:
      'Recent council runs where provider output could not be repaired into Andrea’s structured artifact contract.',
    range: '0..N, lower is better.',
  }),
  schema_repaired_count: Object.freeze({
    industryTerm: 'Schema Repaired Count',
    plainEnglish:
      'Provider artifacts that were usable after JSON/prose repair. Repaired is useful, but a rising count means prompts should get stricter.',
    range: '0..member count.',
  }),
  evidence_gap_count: Object.freeze({
    industryTerm: 'Evidence Gap Count',
    plainEnglish:
      'How many required evidence sources were missing or degraded when the council made its decision.',
    range: '0..N, lower is better.',
  }),
  average_source_priority: Object.freeze({
    industryTerm: 'Average Source Priority',
    plainEnglish:
      'The average trust weight of evidence cards. Direct user/local memory outranks public web and provider-status metadata.',
    range: '0..120, higher is stronger source grounding.',
  }),
  citation_coverage: Object.freeze({
    industryTerm: 'Citation Coverage',
    plainEnglish:
      'How many evidence cards carry a safe source label the council can cite without exposing raw private content.',
    range: '0..1, higher is better.',
  }),
  create_safety_exists: Object.freeze({
    industryTerm: 'Create-Safety Exists Rate',
    plainEnglish:
      'Fraction of evidence that strongly indicates Andrea should rely on or update existing knowledge instead of creating duplicate assumptions.',
    range: '0..1, higher means stronger existing-source grounding.',
  }),
  provider_failure_rate: Object.freeze({
    industryTerm: 'Provider Failure Rate',
    plainEnglish:
      'How often a provider/role recently blocked or skipped instead of producing a usable artifact.',
    range: '0..1, lower is better.',
  }),
  outcome_signal_count: Object.freeze({
    industryTerm: 'Outcome Signal Count',
    plainEnglish:
      'How many post-answer outcomes are linked to council runs, so Andrea can learn which routes actually helped.',
    range: '0..N, higher is better up to the recent run count.',
  }),
  task_ease_score: Object.freeze({
    industryTerm: 'Task-Ease Score',
    plainEnglish:
      'A composite of whether council runs are usable, outcome-linked, source-pattern-covered, and privacy-safe.',
    range: '0..1, higher is better.',
  }),
});

export function getCouncilMetricGloss(
  metric: string,
): CouncilMetricGlossaryEntry | null {
  const normalized = metric.trim().toLowerCase();
  return COUNCIL_METRIC_GLOSSARY[normalized] || null;
}

export function buildCouncilMetricGlossaryMeta(
  metrics: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const metric of metrics) {
    const gloss = getCouncilMetricGloss(metric);
    if (gloss) out[metric] = gloss.plainEnglish;
  }
  return out;
}

export function renderCouncilMetricGlossaryMarkdown(): string {
  const lines = [
    '# Andrea Council Metric Glossary',
    '',
    'Generated from `src/council-metric-glossary.ts`. Keep this in sync with `/council` and `debug:council` surfaces.',
    '',
  ];
  for (const [metric, gloss] of Object.entries(COUNCIL_METRIC_GLOSSARY)) {
    lines.push(`## ${gloss.industryTerm}`);
    lines.push('');
    lines.push(`**Key:** \`${metric}\``);
    lines.push('');
    lines.push(`**Plain English:** ${gloss.plainEnglish}`);
    lines.push('');
    lines.push(`**Range:** ${gloss.range}`);
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
