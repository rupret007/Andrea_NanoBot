import {
  buildOpenBubblesFeasibilityReport,
} from '../src/channels/openbubbles-feasibility.js';

function printBlock(title: string, lines: string[]): void {
  process.stdout.write(`${title}\n`);
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }
  process.stdout.write('\n');
}

async function main(): Promise<void> {
  const report = buildOpenBubblesFeasibilityReport();

  printBlock('OPENBUBBLES FEASIBILITY', [
    `provider: ${report.providerName}`,
    `checked_at: ${report.checkedAt}`,
    `verdict: ${report.verdict}`,
    `summary: ${report.summary}`,
    `detected_install_paths: ${
      report.detectedInstallPaths.length > 0
        ? report.detectedInstallPaths.join(' | ')
        : 'none'
    }`,
    `supported_windows_surface_detected: ${
      report.supportedWindowsSurfaceDetected ? 'yes' : 'no'
    }`,
  ]);

  printBlock(
    'OPENBUBBLES GATE',
    report.criteria.map((criterion) => {
      const nextAction = criterion.nextAction
        ? ` | next=${criterion.nextAction}`
        : '';
      return `${criterion.id}: ${criterion.status} | ${criterion.detail}${nextAction}`;
    }),
  );

  printBlock(
    'OPENBUBBLES REFERENCES',
    report.officialReferences.map((reference) => `- ${reference}`),
  );
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack || error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
