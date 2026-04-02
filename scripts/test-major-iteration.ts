import { spawnSync } from 'child_process';

type Step = {
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
};

function runStep(step: Step): void {
  const pretty = `${step.command} ${step.args.join(' ')}`.trim();
  console.log(`\n[major-test] START ${step.name}: ${pretty}`);

  const startedAt = Date.now();
  const result = spawnSync(step.command, step.args, {
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
  });
  const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);

  if (result.error) {
    throw new Error(
      `[major-test] ${step.name} failed after ${durationSeconds}s: ${result.error.message}`,
    );
  }

  if (result.status !== 0) {
    throw new Error(
      `[major-test] ${step.name} exited with code ${result.status} after ${durationSeconds}s`,
    );
  }

  console.log(`[major-test] PASS ${step.name} (${durationSeconds}s)`);
}

function main(): void {
  const args = new Set(process.argv.slice(2));
  const skipLiveVerify = args.has('--skip-live-verify');
  const nodeCommand = process.execPath;

  const runNodeScript = (
    name: string,
    scriptPath: string,
    extraArgs: string[] = [],
    enabled = true,
  ): Step => ({
    name,
    command: nodeCommand,
    args: [scriptPath, ...extraArgs],
    enabled,
  });

  const steps: Step[] = [
    runNodeScript('format-check', './node_modules/prettier/bin/prettier.cjs', [
      '--check',
      'src/**/*.ts',
    ]),
    runNodeScript('typecheck', './node_modules/typescript/bin/tsc', [
      '--noEmit',
    ]),
    runNodeScript('lint', './node_modules/eslint/bin/eslint.js', ['src/']),
    runNodeScript('unit-tests', './node_modules/vitest/vitest.mjs', ['run']),
    runNodeScript('build', './node_modules/typescript/bin/tsc'),
    runNodeScript(
      'live-verify',
      './node_modules/tsx/dist/cli.mjs',
      ['./setup/index.ts', '--step', 'verify'],
      !skipLiveVerify,
    ),
  ];

  for (const step of steps) {
    if (!step.enabled) {
      console.log(`\n[major-test] SKIP ${step.name}`);
      continue;
    }
    runStep(step);
  }

  console.log('\n[major-test] COMPLETE');
}

main();
