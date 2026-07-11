import { pathToFileURL } from 'node:url';

import {
  buildAssistantIntelligenceReport,
  formatAssistantIntelligenceReport,
} from '../src/assistant-intelligence-report.js';
import { initDatabase } from '../src/db.js';
import { saveReviewedAssistantMetricBaseline } from '../src/personal-assistant-metrics.js';

function readValue(name: string): string | undefined {
  const prefix = `${name}=`;
  return process.argv
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length);
}

async function main(): Promise<void> {
  initDatabase();
  const report = buildAssistantIntelligenceReport({
    groupFolder: readValue('--group') || 'main',
  });
  if (process.argv.includes('--save-baseline')) {
    saveReviewedAssistantMetricBaseline(report.metrics);
  }
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatAssistantIntelligenceReport(report));
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
