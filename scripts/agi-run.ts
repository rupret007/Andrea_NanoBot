import { pathToFileURL } from 'node:url';

import { bootstrapAgi } from '../src/agi-bootstrap.js';
import type { AskResult } from '../src/agi-runtime.js';

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

function promptFromArgs(): string {
  const explicit = readValue('--prompt');
  if (explicit) return explicit;
  const positional = process.argv
    .slice(2)
    .filter((arg) => !arg.startsWith('--'))
    .join(' ')
    .trim();
  return positional || 'edge intelligence smoke';
}

function stableFailure(error: unknown): AskResult & { ok: false } {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    reply: `AGI runtime unavailable: ${message}`,
    trace: {
      goal: 'agi:run',
      startedAt: Date.now(),
      finishedAt: Date.now(),
      nodes: [],
      acceptedPath: [],
      tokens: { input: 0, output: 0 },
      latencyMs: 0,
      costUsd: 0,
    },
    failed: true,
    liveProofTags: ['cli', 'runtime_boot_failed'],
  } as AskResult & { ok: false };
}

async function main(): Promise<void> {
  const prompt = promptFromArgs();
  const scope = readValue('--scope') || 'operator';
  const source = readValue('--source') || 'cli:agi-run';
  let result: AskResult | (AskResult & { ok: false });
  try {
    const runtime = await bootstrapAgi({}, { skipSignalHooks: true, force: true });
    result = await runtime.ask({
      scope,
      source,
      text: prompt,
      initiatedByUser: true,
    });
    await runtime.shutdown();
  } catch (err) {
    result = stableFailure(err);
  }

  if (hasFlag('--json')) {
    console.log(JSON.stringify({ ok: !result.failed, result }, null, 2));
  } else {
    console.log(result.reply);
    if (result.runId) console.log(`\nRun: ${result.runId}`);
    if (result.truth) {
      console.log(
        `Truth: ${result.truth.status} ${result.truth.supportGrade} confidence=${result.truth.confidence.toFixed(2)}`,
      );
    }
  }

  if (hasFlag('--fail-on-error') && result.failed) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
