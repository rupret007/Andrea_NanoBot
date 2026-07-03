import {
  buildCouncilDoctorReport,
  buildCouncilReplayReport,
  formatCouncilDoctorReport,
  formatCouncilReplayReport,
} from '../src/council-quality.js';
import {
  buildCouncilMetricGlossaryMeta,
  renderCouncilMetricGlossaryMarkdown,
} from '../src/council-metric-glossary.js';
import {
  buildCouncilTaskEaseReport,
  formatCouncilTaskEaseReport,
} from '../src/council-task-drills.js';
import { initDatabase, listCouncilRunLedger } from '../src/db.js';

initDatabase();

const json = process.argv.slice(2).includes('--json');
const tasks = process.argv.slice(2).includes('--tasks');
const metrics = process.argv.slice(2).includes('--metrics');
const evidence = process.argv.slice(2).includes('--evidence');
const replay = process.argv.slice(2).includes('--replay');

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function buildEvidenceReport() {
  const latest = listCouncilRunLedger({ limit: 1 })[0] || null;
  const scorecard = latest ? parseJsonObject(latest.evidenceScorecardJson) : {};
  const replay = latest ? latest.replaySummary : 'No council run recorded yet.';
  return {
    generatedAt: new Date().toISOString(),
    latestRunId: latest?.councilRunId || null,
    taskFamily: latest?.taskFamily || null,
    mode: latest?.chosenMode || null,
    finalStatus: latest?.finalStatus || null,
    evidenceScorecard: scorecard,
    metricGlossary: buildCouncilMetricGlossaryMeta([
      'evidence_gap_count',
      'average_source_priority',
      'citation_coverage',
      'create_safety_exists',
      'schema_invalid_runs',
    ]),
    replaySummary: replay,
    privacy: {
      redactedMetadataOnly: true,
      rawPromptsStored: false,
      rawPrivateBodiesStored: false,
    },
  };
}

if (metrics) {
  if (json) {
    console.log(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          glossary: buildCouncilMetricGlossaryMeta([
            'confidence',
            'schema_invalid_runs',
            'schema_repaired_count',
            'evidence_gap_count',
            'average_source_priority',
            'citation_coverage',
            'create_safety_exists',
            'provider_failure_rate',
            'outcome_signal_count',
            'task_ease_score',
          ]),
        },
        null,
        2,
      ),
    );
  } else {
    console.log(renderCouncilMetricGlossaryMarkdown());
  }
  process.exit(0);
}

if (evidence) {
  const report = buildEvidenceReport();
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const scorecard = report.evidenceScorecard as Record<string, unknown>;
    console.log(
      [
        'Council Evidence',
        '',
        `Latest run: ${report.latestRunId || 'none'}`,
        `Task/mode: ${report.taskFamily || 'none'} / ${report.mode || 'none'}`,
        `Final status: ${report.finalStatus || 'none'}`,
        `Available/required: ${scorecard.availableGrade || 'unknown'} / ${scorecard.requiredGrade || 'unknown'}`,
        `Gaps: ${scorecard.gapCount ?? 'unknown'}`,
        `Average source priority: ${scorecard.averageSourcePriority ?? 'unknown'}`,
        `Replay: ${report.replaySummary}`,
        'Privacy: redacted metadata only; raw prompts/private bodies stored=false',
      ].join('\n'),
    );
  }
  process.exit(0);
}

if (replay) {
  const report = buildCouncilReplayReport();
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatCouncilReplayReport(report));
  }
  process.exit(0);
}

if (tasks) {
  const report = buildCouncilTaskEaseReport();
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatCouncilTaskEaseReport(report));
  }
  process.exit(0);
}

const report = buildCouncilDoctorReport();

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(formatCouncilDoctorReport(report));
}
