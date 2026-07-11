import { pathToFileURL } from 'node:url';

import {
  formatAgiScorecardMarkdown,
  runAgiScorecard,
  writeAgiScorecardArtifacts,
} from '../src/agi-scorecard.js';

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

async function main(): Promise<void> {
  const mode = hasFlag('--live') ? 'live' : 'deterministic';
  const maxCostUsd = Number(readValue('--max-cost-usd') ?? '0');
  const minScore = Number(readValue('--min-score') ?? '0.8');
  const failOnAnyFailure = hasFlag('--fail-on-any-failure');
  const timeoutMs = Math.max(
    10_000,
    Number(readValue('--timeout-ms') ?? (mode === 'live' ? '180000' : '60000')),
  );
  const startedAt = new Date().toISOString();
  process.stderr.write(
    `[agi-scorecard] started mode=${mode} max_cost_usd=${maxCostUsd.toFixed(4)} timeout_ms=${timeoutMs}\n`,
  );
  let timeout: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    runAgiScorecard({
      mode,
      maxCostUsd,
      includeDogfood: !hasFlag('--no-dogfood'),
    }),
    new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () =>
          reject(
            new Error(
              `AGI scorecard timed out after ${timeoutMs}ms without a terminal result.`,
            ),
          ),
        timeoutMs,
      );
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
  const artifacts = hasFlag('--no-write')
    ? undefined
    : await writeAgiScorecardArtifacts(result, {
        stateDir: readValue('--state-dir'),
      });

  if (hasFlag('--json')) {
    console.log(
      JSON.stringify(
        {
          terminal: {
            status: 'completed',
            startedAt,
            completedAt: new Date().toISOString(),
            mode,
            maxCostUsd,
            estimatedCostUsd: result.estimatedCostUsd,
          },
          result,
          artifacts,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(formatAgiScorecardMarkdown(result));
    if (artifacts) {
      console.log(`Artifacts: ${artifacts.dir}`);
    }
    console.log(
      `Terminal: completed | mode=${mode} | estimated_cost_usd=${result.estimatedCostUsd.toFixed(4)} | max_cost_usd=${maxCostUsd.toFixed(4)}`,
    );
  }

  const hasAnyFailure = result.scenarioResults.some(
    (scenario) => !scenario.passed,
  );
  if (
    result.overallScore < minScore ||
    result.regressions.length > 0 ||
    (failOnAnyFailure && hasAnyFailure)
  ) {
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        terminal: {
          status: 'failed',
          completedAt: new Date().toISOString(),
          message,
        },
      }),
    );
    process.exit(1);
  });
}
