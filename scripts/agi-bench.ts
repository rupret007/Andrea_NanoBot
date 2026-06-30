import { pathToFileURL } from 'node:url';

import {
  runAndreaBench,
  type AndreaBenchSuite,
} from '../src/andrea-bench.js';

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(name);
}

function readValue(name: string): string | undefined {
  const prefix = `${name}=`;
  return process.argv
    .slice(2)
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length);
}

function suiteFromArgs(): AndreaBenchSuite | 'external' {
  const raw =
    readValue('--suite') ||
    process.argv
      .slice(2)
      .find((arg) => ['gaia', 'bfcl', 'swe-lite', 'tau', 'external'].includes(arg));
  if (raw === 'gaia' || raw === 'bfcl' || raw === 'swe-lite' || raw === 'tau') {
    return raw;
  }
  return 'external';
}

function printMarkdown(report: ReturnType<typeof runAndreaBench>): void {
  console.log(`# AndreaBench ${report.suite}`);
  console.log('');
  console.log(`Generated: ${report.generatedAt}`);
  console.log(`Mode: ${report.mode}`);
  console.log(`Overall: ${(report.overallScore * 100).toFixed(1)}%`);
  console.log('');
  for (const result of report.scenarioResults) {
    console.log(
      `- ${result.suite}:${result.id} ${(result.score * 100).toFixed(1)}% - ${result.detail}`,
    );
  }
  console.log('');
  console.log('Recommendations:');
  for (const recommendation of report.recommendations) {
    console.log(`- ${recommendation}`);
  }
  console.log('');
  console.log(report.note);
}

async function main(): Promise<void> {
  const report = runAndreaBench({
    suite: suiteFromArgs(),
    dryRun: !hasFlag('--live'),
  });
  if (hasFlag('--json')) {
    console.log(JSON.stringify({ result: report }, null, 2));
  } else {
    printMarkdown(report);
  }
  const failUnder = readValue('--fail-under');
  if (failUnder !== undefined) {
    const threshold = Number(failUnder);
    if (Number.isFinite(threshold) && report.overallScore < threshold) {
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
